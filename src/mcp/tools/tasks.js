import { reindex, setTags, touchProject } from "../../db/memories.js";
import { OPEN_STATUSES, TASK_SELECT, TASK_STATUSES, applyTaskUpdate, defaultLevelId, defaultTypeId, findByName, parisNow, shortDate, taskFields, taskLine } from "../../db/tasks.js";
import { readOnlyError, resolvePlacement } from "../placement.js";
import { RO, WR, groupeArg, int, str, strList } from "../tool-helpers.js";
import { normTags, now } from "../../util.js";

// Réponses volontairement très courtes : chaque caractère renvoyé coûte des tokens à Claude.
const ECHEANCE = "AAAA-MM-JJ ou AAAA-MM-JJ HH:MM (heure de Paris)";

export const TASKS_TOOLS = {
  add_task: {
    description: `Crée une tâche (rappel) quand l'utilisateur le demande. \`echeance\` : ${ECHEANCE}. \`criticite\` et \`type\` : noms définis dans /admin (défaut si absents). \`recurrence\` : « 1 mois », « 2 semaines »… (échéance requise). Rangement comme remember.`,
    annotations: WR,
    inputSchema: { type: "object", required: ["titre"], properties: { titre: str("Intitulé court"), detail: str("Détail facultatif"), echeance: str("Échéance"), criticite: str("Niveau de criticité"), type: str("Type de tâche"), recurrence: str("Récurrence"), projet: str("Projet"), groupe: groupeArg(), tags: strList("Tags") } },
    async run(db, a, { acl }) {
      const titre = String(a.titre || "").trim();
      if (!titre) return "Erreur : titre obligatoire.";
      const f = await taskFields(db, { ...a, statut: undefined });
      if (f.error) return f.error;
      if (f.recur_unit && !f.due_date) return "Erreur : une tâche récurrente doit avoir une échéance.";
      const place = await resolvePlacement(db, acl, a);
      if (place.error) return place.error;
      const ts = now(), detail = String(a.detail || "").trim();
      const r = await db.prepare("INSERT INTO memories(title, content, kind, project_id, group_id, source, created_at, updated_at) VALUES (?,?,'tache',?,?,'',?,?)")
        .bind(titre, detail || titre, place.projectId, place.groupId, ts, ts).run();
      const id = r.meta.last_row_id;
      const typeId = f.type_id ?? await defaultTypeId(db);
      await db.prepare("INSERT INTO tasks(memory_id, type_id, level_id, status, due_date, due_time, recur_every, recur_unit, gcal_dirty, created_at, updated_at) VALUES (?,?,?,'a_faire',?,?,?,?,(SELECT sync = 'google' FROM task_types WHERE id = ?),?,?)")
        .bind(id, typeId, f.level_id ?? await defaultLevelId(db), f.due_date ?? null, f.due_time ?? null, f.recur_every ?? null, f.recur_unit ?? null, typeId, ts, ts).run();
      const tags = normTags(a.tags);
      if (tags.length) await setTags(db, id, tags);
      await reindex(db, id);
      await touchProject(db, place.projectId);
      return `ok #${id}` + (place.created ? ` (projet ${place.projectName} créé)` : "");
    },
  },

  update_task: {
    description: `Modifie une tâche : seuls les champs fournis changent. \`statut\` : a_faire | silencieux (plus aucun rappel) | fait | annule. Une tâche récurrente passée à « fait » crée l'occurrence suivante. \`echeance\` (${ECHEANCE}) ou \`recurrence\` vides = retirées.`,
    annotations: WR,
    inputSchema: { type: "object", required: ["id"], properties: { id: int("Numéro de la tâche"), statut: str("Statut"), titre: str("Nouvel intitulé"), detail: str("Nouveau détail"), echeance: str("Échéance"), criticite: str("Criticité"), type: str("Type"), recurrence: str("Récurrence") } },
    async run(db, a, { acl }) {
      const t = await db.prepare(`${TASK_SELECT} WHERE t.memory_id = ? AND ${acl.sqlIn("m.group_id")}`).bind(a.id).first();
      if (!t) return `Tâche #${a.id} introuvable.`;
      if (!acl.canWrite(t.group_id)) return readOnlyError(acl, t.group_id);
      const r = await applyTaskUpdate(db, t, a);
      if (r.error) return r.error;
      if (r.next) return `ok #${t.memory_id} → #${r.next.id} ${shortDate(r.next.due, parisNow().date)}`;
      return `ok #${t.memory_id}`;
    },
  },

  list_tasks: {
    description: "Liste les tâches, une ligne chacune. `statut` : ouvertes (défaut : a_faire + silencieux) | a_faire | silencieux | fait | annule | toutes. `jours` : échéance d'ici N jours (retards compris). Filtres : `criticite`, `projet`, `groupe`. `detail: true` ajoute niveau, projet et texte.",
    annotations: RO,
    inputSchema: { type: "object", properties: { statut: str("Statut"), jours: int("Échéance d'ici N jours"), criticite: str("Criticité"), projet: str("Projet"), groupe: groupeArg("Limiter à ce groupe et ses sous-groupes"), detail: { type: "boolean", description: "Plus de détails" }, limite: int("Nombre max (défaut 20, max 100)") } },
    async run(db, a, { acl }) {
      let scope = acl.readable;
      if (a.groupe) {
        const g = acl.resolve(a.groupe);
        if (g.error) return g.error;
        scope = acl.readableSubtree(g.group.id);
      }
      const statut = String(a.statut || "ouvertes").trim();
      const statuses = statut === "ouvertes" ? OPEN_STATUSES : statut === "toutes" ? TASK_STATUSES : [statut];
      if (!statuses.every((s) => TASK_STATUSES.includes(s))) return `Erreur : statut invalide (ouvertes, toutes, ${TASK_STATUSES.join(", ")}).`;
      const today = parisNow().date;
      const where = [acl.sqlIn("m.group_id", scope), `t.status IN (${statuses.map(() => "?").join(",")})`], params = [...statuses];
      if (a.jours != null) { where.push("t.due_date IS NOT NULL AND t.due_date <= date(?, '+' || ? || ' days')"); params.push(today, Math.max(0, parseInt(a.jours) || 0)); }
      if (a.criticite) {
        const lid = await findByName(db, "task_levels", a.criticite, "criticité");
        if (lid.error) return lid.error;
        where.push("t.level_id = ?"); params.push(lid);
      }
      if (a.projet) { where.push("p.name = ? COLLATE NOCASE"); params.push(String(a.projet).trim()); }
      const limite = Math.max(1, Math.min(parseInt(a.limite ?? 20) || 20, 100));
      const order = statuses.every((s) => s === "fait" || s === "annule") ? "COALESCE(t.done_at, t.updated_at) DESC"
        : "t.due_date IS NULL, t.due_date, COALESCE(t.due_time, ''), l.position";
      const rows = (await db.prepare(`${TASK_SELECT} WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ?`).bind(...params, limite + 1).all()).results;
      if (!rows.length) return "Aucune tâche.";
      const dt = await defaultTypeId(db);
      const lines = rows.slice(0, limite).map((t) => taskLine(t, today, { defaultTypeId: dt, detail: !!a.detail }));
      if (rows.length > limite) lines.push(`+ d'autres (limite ${limite})`);
      return lines.join("\n");
    },
  },
};

import { memoryTags, reindex, setTags, touchProject } from "../../db/memories.js";
import { OPEN_STATUSES, TASK_SELECT, TASK_STATUSES, defaultLevelId, defaultTypeId, findByName, nextDue, parisNow, parseDue, parseRecurrence, shortDate, taskLine } from "../../db/tasks.js";
import { readOnlyError, resolvePlacement } from "../placement.js";
import { RO, WR, groupeArg, int, str, strList } from "../tool-helpers.js";
import { normTags, now } from "../../util.js";

// Réponses volontairement très courtes : chaque caractère renvoyé coûte des tokens à Claude.
const ECHEANCE = "AAAA-MM-JJ ou AAAA-MM-JJ HH:MM (heure de Paris)";

// Valide et résout les champs communs à add_task et update_task. Renvoie les valeurs ou { error }.
async function taskFields(db, a) {
  const out = {};
  if (a.echeance != null) {
    const d = parseDue(a.echeance);
    if (d.error) return d;
    out.due_date = d.date; out.due_time = d.time;
  }
  if (a.recurrence != null) {
    const r = parseRecurrence(a.recurrence);
    if (r.error) return r;
    out.recur_every = r.every; out.recur_unit = r.unit;
  }
  if (a.criticite != null && String(a.criticite).trim()) {
    const id = await findByName(db, "task_levels", a.criticite, "criticité");
    if (id.error) return id;
    out.level_id = id;
  }
  if (a.type != null && String(a.type).trim()) {
    const id = await findByName(db, "task_types", a.type, "type");
    if (id.error) return id;
    out.type_id = id;
  }
  if (a.statut != null) {
    if (!TASK_STATUSES.includes(a.statut)) return { error: `Erreur : statut invalide (${TASK_STATUSES.join(", ")}).` };
    out.status = a.statut;
  }
  return out;
}

// Crée l'occurrence suivante d'une tâche récurrente (nouveau souvenir, mêmes projet, groupe, tags, type et niveau).
async function createNextOccurrence(db, t) {
  const due = nextDue(t.due_date, t.recur_every, t.recur_unit), ts = now();
  const m = await db.prepare("SELECT * FROM memories WHERE id = ?").bind(t.memory_id).first();
  const r = await db.prepare("INSERT INTO memories(title, content, kind, project_id, group_id, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .bind(m.title, m.content, m.kind, m.project_id, m.group_id, m.source, ts, ts).run();
  const id = r.meta.last_row_id;
  await db.prepare("INSERT INTO tasks(memory_id, type_id, level_id, status, due_date, due_time, recur_every, recur_unit, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .bind(id, t.type_id, t.level_id, "a_faire", due, t.due_time, t.recur_every, t.recur_unit, ts, ts).run();
  await setTags(db, id, await memoryTags(db, t.memory_id));
  await reindex(db, id);
  return { id, due };
}

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
      await db.prepare("INSERT INTO tasks(memory_id, type_id, level_id, status, due_date, due_time, recur_every, recur_unit, created_at, updated_at) VALUES (?,?,?,'a_faire',?,?,?,?,?,?)")
        .bind(id, f.type_id ?? await defaultTypeId(db), f.level_id ?? await defaultLevelId(db), f.due_date ?? null, f.due_time ?? null, f.recur_every ?? null, f.recur_unit ?? null, ts, ts).run();
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
      const f = await taskFields(db, a);
      if (f.error) return f.error;
      const n = { ...t, ...f };
      if (n.recur_unit && !n.due_date) return "Erreur : une tâche récurrente doit avoir une échéance.";
      const ts = now();
      const becomesDone = n.status === "fait" && t.status !== "fait";
      n.done_at = n.status === "fait" ? (becomesDone ? ts : t.done_at) : null;
      await db.prepare("UPDATE tasks SET type_id=?, level_id=?, status=?, due_date=?, due_time=?, recur_every=?, recur_unit=?, done_at=?, updated_at=? WHERE memory_id=?")
        .bind(n.type_id, n.level_id, n.status, n.due_date, n.due_time, n.recur_every, n.recur_unit, n.done_at, ts, t.memory_id).run();
      if (a.titre || a.detail != null) {
        await db.prepare("UPDATE memories SET title=?, content=?, updated_at=? WHERE id=?")
          .bind(a.titre ? String(a.titre).trim() : t.title, a.detail != null ? (String(a.detail).trim() || String(a.titre || t.title).trim()) : t.content, ts, t.memory_id).run();
        await reindex(db, t.memory_id);
      }
      await touchProject(db, t.project_id);
      if (becomesDone && n.recur_unit && n.due_date) {
        const next = await createNextOccurrence(db, n);
        return `ok #${t.memory_id} → #${next.id} ${shortDate(next.due, parisNow().date)}`;
      }
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

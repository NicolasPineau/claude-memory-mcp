import { createProject, findProject, moveProject, reindexProject, summary } from "../../db/memories.js";
import { readOnlyError } from "../placement.js";
import { RO, WR, groupeArg, int, str } from "../tool-helpers.js";
import { day, now } from "../../util.js";

export const PROJECTS_TOOLS = {
  list_projects: {
    description: "Liste les projets (nom, statut, description, nombre de souvenirs, dernière activité). Avec `noms_seulement: true`, renvoie seulement les noms des projets actifs, rangés par groupe, et des tags (réponse très courte, à utiliser en début de conversation). `groupe` limite à un groupe et ses sous-groupes.",
    annotations: RO,
    inputSchema: { type: "object", properties: { noms_seulement: { type: "boolean", description: "Ne renvoyer que les noms des projets et des tags" }, inclure_archives: { type: "boolean", description: "Inclure les projets archivés" }, groupe: groupeArg("Limiter à ce groupe et ses sous-groupes") } },
    async run(db, a, { acl }) {
      let scope = acl.readable;
      if (a.groupe) {
        const g = acl.resolve(a.groupe);
        if (g.error) return g.error;
        scope = acl.readableSubtree(g.group.id);
      }
      const inScope = acl.sqlIn("group_id", scope);
      if (a.noms_seulement) {
        const ps = (await db.prepare(`SELECT name, group_id FROM projects WHERE status != 'archive' AND ${inScope} ORDER BY updated_at DESC`).all()).results;
        const ts = (await db.prepare(`SELECT t.name FROM tags t JOIN memory_tags mt ON mt.tag_id = t.id JOIN memories m ON m.id = mt.memory_id WHERE ${acl.sqlIn("m.group_id", scope)} GROUP BY t.id ORDER BY COUNT(*) DESC, t.name`).all()).results;
        const byGroup = new Map();
        for (const p of ps) {
          if (!byGroup.has(p.group_id)) byGroup.set(p.group_id, []);
          byGroup.get(p.group_id).push(p.name);
        }
        const lines = acl.tree.ordered().filter((g) => byGroup.has(g.id)).map((g) => `${acl.label(g.id)} : ${byGroup.get(g.id).join(", ")}`);
        return (lines.length ? lines.join("\n") : "Projets : (aucun)") + `\nTags : ${ts.length ? ts.map((r) => r.name).join(", ") : "(aucun)"}`;
      }
      let sql = `SELECT p.*, COUNT(m.id) AS n FROM projects p LEFT JOIN memories m ON m.project_id = p.id WHERE ${acl.sqlIn("p.group_id", scope)} `;
      if (!a.inclure_archives) sql += "AND p.status != 'archive' ";
      sql += "GROUP BY p.id ORDER BY p.updated_at DESC";
      const rows = (await db.prepare(sql).all()).results;
      if (!rows.length) return "Aucun projet pour l'instant.";
      return rows.map((r) => `• ${r.name} [${r.status}] — ${acl.label(r.group_id)} — ${r.n} souvenir(s), activité ${day(r.updated_at)}` + (r.description ? `\n  ${r.description}` : "")).join("\n");
    },
  },

  set_project: {
    description: "Crée ou met à jour un projet. `description` = résumé vivant du projet (objectif, état, prochaines étapes) : garde-le à jour, c'est ce qui est lu en premier. `statut` : actif | en pause | termine | archive. `groupe` est obligatoire à la création ; sur un projet existant, un autre `groupe` le déplace avec ses souvenirs et ses fichiers.",
    annotations: WR,
    inputSchema: { type: "object", required: ["nom"], properties: { nom: str("Nom du projet"), description: str("Résumé"), statut: str("Statut"), nouveau_nom: str("Renommer"), groupe: groupeArg("Groupe du projet : obligatoire à la création, sinon le déplace") } },
    async run(db, a, { acl }) {
      const nom = String(a.nom || "").trim();
      if (!nom) return "Erreur : nom obligatoire.";
      let target = null;
      if (a.groupe) {
        const g = acl.resolve(a.groupe);
        if (g.error) return g.error;
        target = g.group.id;
      }
      let r = await findProject(db, nom);
      if (r && !acl.canRead(r.group_id)) return `Erreur : le nom de projet « ${nom} » n'est pas disponible.`;
      let moved = false;
      if (!r) {
        if (!target) return `Erreur : précise le groupe du nouveau projet « ${nom} » (\`groupe\`, voir list_groups).`;
        if (!acl.canWrite(target)) return readOnlyError(acl, target);
        r = await db.prepare("SELECT * FROM projects WHERE id = ?").bind(await createProject(db, nom, target)).first();
      } else {
        if (!acl.canWrite(r.group_id)) return readOnlyError(acl, r.group_id);
        if (target && target !== r.group_id) {
          if (!acl.canWrite(target)) return readOnlyError(acl, target);
          await moveProject(db, r.id, target);
          moved = true;
        }
      }
      try {
        await db.prepare("UPDATE projects SET name=?, description=?, status=?, updated_at=? WHERE id=?")
          .bind(String(a.nouveau_nom || r.name).trim(), a.description != null ? a.description : r.description, a.statut || r.status, now(), r.id).run();
      } catch (e) {
        return `Erreur : le nom de projet « ${a.nouveau_nom} » n'est pas disponible.`;
      }
      if (a.nouveau_nom) await reindexProject(db, r.id);
      return `Projet « ${a.nouveau_nom || r.name} » enregistré (groupe ${acl.tree.path(target || r.group_id)}).` + (moved ? " Projet déplacé avec ses souvenirs et ses fichiers." : "");
    },
  },

  project_context: {
    description: "Charge tout le contexte d'un projet : description, tags fréquents, fichiers et derniers souvenirs. À appeler quand l'utilisateur reprend un projet.",
    annotations: RO,
    inputSchema: { type: "object", required: ["nom"], properties: { nom: str("Nom du projet"), nb_souvenirs: int("Nombre de souvenirs (défaut 15)") } },
    async run(db, a, { acl }) {
      const nom = String(a.nom || "").trim();
      const p = await db.prepare("SELECT * FROM projects WHERE name = ? COLLATE NOCASE AND " + acl.sqlIn("group_id")).bind(nom).first();
      if (!p) {
        const like = (await db.prepare("SELECT name FROM projects WHERE name LIKE ? AND " + acl.sqlIn("group_id") + " LIMIT 5").bind(`%${nom}%`).all()).results;
        return `Projet « ${nom} » introuvable.` + (like.length ? " Projets proches : " + like.map((r) => r.name).join(", ") : "");
      }
      const n = Math.max(1, Math.min(parseInt(a.nb_souvenirs ?? 15), 50));
      const mems = (await db.prepare("SELECT m.*, ? AS project FROM memories m WHERE project_id = ? ORDER BY updated_at DESC LIMIT ?").bind(p.name, p.id, n).all()).results;
      const tags = (await db.prepare("SELECT t.name, COUNT(*) n FROM tags t JOIN memory_tags mt ON mt.tag_id=t.id JOIN memories m ON m.id = mt.memory_id WHERE m.project_id = ? GROUP BY t.id ORDER BY n DESC LIMIT 15").bind(p.id).all()).results;
      const files = (await db.prepare("SELECT f.id, f.filename, f.size, f.description FROM files f LEFT JOIN memories m ON m.id = f.memory_id WHERE (f.project_id = ? OR m.project_id = ?) AND " + acl.sqlIn("f.group_id") + " ORDER BY f.created_at DESC").bind(p.id, p.id).all()).results;
      const out = [`# Projet : ${p.name}  [${p.status}]`, `Groupe : ${acl.label(p.group_id)}`, `Créé ${day(p.created_at)}, dernière activité ${day(p.updated_at)}`, "", p.description || "(pas encore de description — pense à `set_project`)"];
      if (tags.length) out.push("", "Tags : " + tags.map((t) => `${t.name} (${t.n})`).join(", "));
      if (files.length) out.push("", "Fichiers :", ...files.map((f) => `- ${f.filename} (${f.size} o) id=${f.id} ${f.description}`));
      out.push("", `Derniers souvenirs (${mems.length}) :`, "");
      if (!mems.length) out.push("(aucun)");
      for (const m of mems) out.push(await summary(db, m, 400));
      return out.join("\n");
    },
  },

  list_tags: {
    description: "Liste les tags avec leur nombre d'utilisations (dans les groupes visibles par ce connecteur).",
    annotations: RO,
    inputSchema: { type: "object", properties: {} },
    async run(db, a, { acl }) {
      const rows = (await db.prepare("SELECT t.name, COUNT(*) n FROM tags t JOIN memory_tags mt ON mt.tag_id = t.id JOIN memories m ON m.id = mt.memory_id WHERE " + acl.sqlIn("m.group_id") + " GROUP BY t.id ORDER BY n DESC, t.name").all()).results;
      return rows.length ? rows.map((r) => `${r.name} (${r.n})`).join(", ") : "Aucun tag.";
    },
  },
};

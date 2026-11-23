import { deleteMemory, ftsQuery, getOrCreateProject, memoryTags, reindex, setTags, summary, touchProject } from "../../db/memories.js";
import { DE, RO, WR, int, str, strList } from "../tool-helpers.js";
import { day, normTags, now } from "../../util.js";

export const MEMORIES_TOOLS = {
  recall: {
    description: "Cherche dans la mémoire. `requete` = mots-clés ou phrase libre (ex. « après-midi zoo »). Filtres optionnels : `projet` (nom) et `tags` (tous requis). Requête vide = derniers souvenirs. Renvoie des extraits ; utilise `read_memory` pour le texte complet.",
    annotations: RO,
    inputSchema: { type: "object", properties: { requete: str("Mots-clés ou phrase"), projet: str("Nom du projet"), tags: strList("Tags requis"), limite: int("Nombre max (défaut 10, max 50)") } },
    async run(db, a) {
      const limite = Math.max(1, Math.min(parseInt(a.limite ?? 10), 50));
      const tags = normTags(a.tags);
      const where = [], params = [];
      if (a.projet) { where.push("p.name = ? COLLATE NOCASE"); params.push(String(a.projet).trim()); }
      for (const t of tags) {
        where.push("EXISTS (SELECT 1 FROM memory_tags mt JOIN tags tg ON tg.id = mt.tag_id WHERE mt.memory_id = m.id AND tg.name = ?)");
        params.push(t);
      }
      const base = "SELECT m.*, p.name AS project FROM memories m LEFT JOIN projects p ON p.id = m.project_id ";
      let rows;
      const q = String(a.requete || "").trim();
      if (q) {
        let sql = base + "JOIN memories_fts f ON f.rowid = m.id WHERE memories_fts MATCH ? ";
        if (where.length) sql += "AND " + where.join(" AND ") + " ";
        sql += "ORDER BY bm25(memories_fts, 5.0, 1.0, 3.0, 2.0), m.updated_at DESC LIMIT ?";
        rows = (await db.prepare(sql).bind(ftsQuery(q), ...params, limite).all()).results;
      } else {
        let sql = base + (where.length ? "WHERE " + where.join(" AND ") + " " : "") + "ORDER BY m.updated_at DESC LIMIT ?";
        rows = (await db.prepare(sql).bind(...params, limite).all()).results;
      }
      if (!rows.length) return "Aucun souvenir trouvé. Essaie d'autres mots-clés, ou `list_projects` / `list_tags`.";
      const parts = [];
      for (const r of rows) parts.push(await summary(db, r));
      return `${rows.length} souvenir(s) :\n\n` + parts.join("\n\n");
    },
  },

  remember: {
    description: "Enregistre un nouveau souvenir. À n'appeler qu'une fois en fin de conversation, après accord explicite de l'utilisateur. `contenu` doit être autonome et compréhensible plus tard. `projet` : nom du projet (créé s'il n'existe pas). `tags` : thèmes libres (ex. [\"bricolage\"]). `type` : note | decision | fait | idee | resume | tache | evenement. `source` : d'où ça vient (ex. « compte perso, mobile »).",
    annotations: WR,
    inputSchema: { type: "object", required: ["titre", "contenu"], properties: { titre: str("Titre court"), contenu: str("Texte du souvenir"), projet: str("Projet"), tags: strList("Tags"), type: str("Type de souvenir"), source: str("Origine") } },
    async run(db, a) {
      const titre = String(a.titre || "").trim(), contenu = String(a.contenu || "").trim();
      if (!titre || !contenu) return "Erreur : titre et contenu sont obligatoires.";
      const tags = normTags(a.tags), ts = now();
      const pid = await getOrCreateProject(db, a.projet);
      const r = await db.prepare("INSERT INTO memories(title, content, kind, project_id, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
        .bind(titre, contenu, String(a.type || "note").trim() || "note", pid, String(a.source || ""), ts, ts).run();
      const id = r.meta.last_row_id;
      await setTags(db, id, tags);
      await reindex(db, id);
      await touchProject(db, pid);
      return `Souvenir #${id} enregistré.` + (a.projet ? ` Projet : ${a.projet}.` : "") + (tags.length ? ` Tags : ${tags.join(", ")}.` : "");
    },
  },

  read_memory: {
    description: "Lit un souvenir en entier (avec ses tags et fichiers joints).",
    annotations: RO,
    inputSchema: { type: "object", required: ["id"], properties: { id: int("Numéro du souvenir") } },
    async run(db, a) {
      const r = await db.prepare("SELECT m.*, p.name AS project FROM memories m LEFT JOIN projects p ON p.id = m.project_id WHERE m.id = ?").bind(a.id).first();
      if (!r) return `Souvenir #${a.id} introuvable.`;
      const tags = await memoryTags(db, r.id);
      const files = (await db.prepare("SELECT id, filename, size, description FROM files WHERE memory_id = ?").bind(r.id).all()).results;
      const out = [`# ${r.title}  (#${r.id})`, `Type : ${r.kind} | Créé : ${day(r.created_at)} | Modifié : ${day(r.updated_at)}`];
      if (r.project) out.push(`Projet : ${r.project}`);
      if (tags.length) out.push("Tags : " + tags.join(", "));
      if (r.source) out.push(`Source : ${r.source}`);
      out.push("", r.content);
      if (files.length) out.push("", "Fichiers joints :", ...files.map((f) => `- ${f.filename} (${f.size} o) id=${f.id} ${f.description}`));
      return out.join("\n");
    },
  },

  update_memory: {
    description: "Met à jour un souvenir. Seuls les champs fournis changent. `contenu` remplace le texte ; `ajouter_au_contenu` ajoute un paragraphe daté à la fin. `tags` remplace tous les tags ; `ajouter_tags` en ajoute. `projet=\"\"` retire du projet.",
    annotations: WR,
    inputSchema: { type: "object", required: ["id"], properties: { id: int("Numéro"), titre: str("Nouveau titre"), contenu: str("Nouveau contenu"), ajouter_au_contenu: str("Texte à ajouter"), projet: str("Projet"), tags: strList("Remplace les tags"), ajouter_tags: strList("Tags à ajouter"), type: str("Type") } },
    async run(db, a) {
      const r = await db.prepare("SELECT * FROM memories WHERE id = ?").bind(a.id).first();
      if (!r) return `Souvenir #${a.id} introuvable.`;
      let content = a.contenu != null ? String(a.contenu).trim() : r.content;
      if (a.ajouter_au_contenu) content += `\n\n[${day(now())}] ${String(a.ajouter_au_contenu).trim()}`;
      let pid = r.project_id;
      if (a.projet != null) pid = await getOrCreateProject(db, a.projet);
      await db.prepare("UPDATE memories SET title=?, content=?, kind=?, project_id=?, updated_at=? WHERE id=?")
        .bind(a.titre ? String(a.titre).trim() : r.title, content, a.type || r.kind, pid, now(), r.id).run();
      if (a.tags != null || (a.ajouter_tags && a.ajouter_tags.length)) {
        const cur = a.tags != null ? normTags(a.tags) : await memoryTags(db, r.id);
        await setTags(db, r.id, normTags([...cur, ...(a.ajouter_tags || [])]));
      }
      await reindex(db, r.id);
      await touchProject(db, pid);
      return `Souvenir #${r.id} mis à jour.`;
    },
  },

  forget: {
    description: "Supprime définitivement un souvenir (les fichiers joints restent, détachés).",
    annotations: DE,
    inputSchema: { type: "object", required: ["id"], properties: { id: int("Numéro") } },
    async run(db, a) {
      return (await deleteMemory(db, a.id)) ? `Souvenir #${a.id} supprimé.` : `Souvenir #${a.id} introuvable.`;
    },
  },
};

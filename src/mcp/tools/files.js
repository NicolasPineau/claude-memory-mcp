import { CHUNK, DL_TTL_MS, MAX_BYTES, MAX_FILE_MB, UP_TTL_MS } from "../../config.js";
import { createToken, deleteFile, storeFile } from "../../files/storage.js";
import { DE, RO, WR, int, str } from "../tool-helpers.js";
import { b64Size, b64ToBytes, cleanName, day, guessMime, utf8ToB64 } from "../../util.js";

export const FILES_TOOLS = {
  attach_file: {
    description: "Conserve un petit fichier dans la mémoire en passant son contenu : `contenu_texte` (texte, code, markdown, csv…) ou `contenu_base64`. Pour un fichier binaire ou volumineux, préfère `prepare_upload` (le contenu ne passe pas par la conversation). Rattache-le à un `souvenir_id` et/ou un `projet`.",
    annotations: WR,
    inputSchema: { type: "object", required: ["nom_fichier"], properties: { nom_fichier: str("Nom du fichier"), contenu_texte: str("Contenu texte"), contenu_base64: str("Contenu binaire en base64"), description: str("Description"), souvenir_id: int("Souvenir lié"), projet: str("Projet lié") } },
    async run(db, a) {
      const hasT = a.contenu_texte != null, hasB = a.contenu_base64 != null;
      if (hasT === hasB) return "Erreur : fournis soit contenu_texte, soit contenu_base64.";
      let b64;
      if (hasT) b64 = utf8ToB64(String(a.contenu_texte));
      else {
        b64 = String(a.contenu_base64).replace(/\s+/g, "");
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return "Erreur : base64 invalide.";
      }
      const size = b64Size(b64);
      if (size > MAX_BYTES) return `Erreur : fichier trop gros (max ${MAX_FILE_MB} Mo).`;
      if (a.souvenir_id && !(await db.prepare("SELECT 1 FROM memories WHERE id = ?").bind(a.souvenir_id).first()))
        return `Souvenir #${a.souvenir_id} introuvable.`;
      const name = cleanName(a.nom_fichier);
      const chunks = [];
      for (let i = 0; i < b64.length; i += CHUNK) chunks.push(b64.slice(i, i + CHUNK));
      const f = await storeFile(db, { name, mime: guessMime(name, hasT), size, chunks, description: a.description, memoryId: a.souvenir_id, projet: a.projet });
      return `Fichier « ${f.name} » enregistré (id=${f.id}, ${f.size} octets).`;
    },
  },

  prepare_upload: {
    description: "Prépare un lien d'envoi à usage unique (valable 10 min) pour stocker un fichier SANS faire passer son contenu par la conversation. Envoie ensuite le fichier avec la commande renvoyée (`curl -T <fichier> <url>`), depuis une machine qui peut joindre le serveur. Max 20 Mo.",
    annotations: WR,
    inputSchema: { type: "object", required: ["nom_fichier"], properties: { nom_fichier: str("Nom du fichier"), description: str("Description"), souvenir_id: int("Souvenir lié"), projet: str("Projet lié") } },
    async run(db, a, ctx) {
      if (a.souvenir_id && !(await db.prepare("SELECT 1 FROM memories WHERE id = ?").bind(a.souvenir_id).first()))
        return `Souvenir #${a.souvenir_id} introuvable.`;
      const meta = { nom: cleanName(a.nom_fichier), description: a.description || "", souvenir_id: a.souvenir_id || null, projet: a.projet || null };
      const t = await createToken(db, "upload", { meta, ttl: UP_TTL_MS });
      const url = `${ctx.origin}/upload/${t.jeton}`;
      return `Lien d'envoi prêt (usage unique, expire le ${t.expire_le}) :\n${url}\n\nCommande :\ncurl -sS -T "${meta.nom}" "${url}"`;
    },
  },

  read_file: {
    description: "Récupère un fichier joint. Par défaut (`mode`=\"lien\") renvoie ses infos et un lien de téléchargement valable 1 h, sans le contenu. `mode`=\"contenu\" renvoie le contenu (texte en clair, sinon base64) : à réserver aux petits fichiers texte à lire.",
    annotations: RO,
    inputSchema: { type: "object", required: ["id"], properties: { id: str("Identifiant du fichier"), mode: { type: "string", enum: ["lien", "contenu"], description: "lien (défaut) ou contenu" } } },
    async run(db, a, ctx) {
      const f = await db.prepare("SELECT f.*, p.name AS project FROM files f LEFT JOIN projects p ON p.id = f.project_id WHERE f.id = ?").bind(a.id).first();
      if (!f) return `Fichier ${a.id} introuvable.`;
      const head = `Fichier : ${f.filename} (${f.mime}, ${f.size} octets)` + (f.project ? `\nProjet : ${f.project}` : "") + (f.memory_id ? `\nSouvenir : #${f.memory_id}` : "") + (f.description ? `\nDescription : ${f.description}` : "") + "\n";
      if ((a.mode || "lien") !== "contenu") {
        const t = await createToken(db, "download", { fichierId: f.id, ttl: DL_TTL_MS });
        return head + `Lien de téléchargement (expire le ${t.expire_le}) :\n${ctx.origin}/dl/${t.jeton}`;
      }
      const chunks = (await db.prepare("SELECT data FROM file_chunks WHERE file_id = ? ORDER BY idx").bind(f.id).all()).results;
      const b64 = chunks.map((c) => c.data).join("");
      if (f.mime.startsWith("text/") || f.mime === "application/json" || f.mime === "application/xml") {
        try {
          return head + "\n" + new TextDecoder("utf-8", { fatal: true }).decode(b64ToBytes(b64));
        } catch (_) { // binaire
        }
      }
      return head + "Contenu base64 :\n" + b64;
    },
  },

  delete_file: {
    description: "Supprime définitivement un fichier conservé (son contenu et ses liens de téléchargement). Irréversible : demande confirmation à l'utilisateur avant. Les souvenirs liés ne sont pas touchés.",
    annotations: DE,
    inputSchema: { type: "object", required: ["id"], properties: { id: str("Identifiant du fichier (voir list_files)") } },
    async run(db, a) {
      const f = await deleteFile(db, String(a.id || "").trim());
      return f ? `Fichier « ${f.filename} » (id=${f.id}) supprimé.` : `Fichier ${a.id} introuvable.`;
    },
  },

  list_files: {
    description: "Liste les fichiers conservés (optionnellement ceux d'un projet).",
    annotations: RO,
    inputSchema: { type: "object", properties: { projet: str("Projet") } },
    async run(db, a) {
      let sql = "SELECT f.*, p.name AS project FROM files f LEFT JOIN projects p ON p.id = f.project_id ";
      const params = [];
      if (a.projet) { sql += "WHERE p.name = ? COLLATE NOCASE "; params.push(a.projet); }
      const rows = (await db.prepare(sql + "ORDER BY f.created_at DESC LIMIT 100").bind(...params).all()).results;
      if (!rows.length) return "Aucun fichier.";
      return rows.map((r) => `• ${r.filename} (${r.size} o) id=${r.id} ${day(r.created_at)}` + (r.project ? ` projet: ${r.project}` : "") + (r.memory_id ? ` souvenir #${r.memory_id}` : "") + (r.description ? ` — ${r.description}` : "")).join("\n");
    },
  },
};

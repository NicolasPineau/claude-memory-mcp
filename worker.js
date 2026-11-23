// Mémoire partagée pour Claude — connecteur MCP sur Cloudflare Workers + D1.
// URL du connecteur MCP : https://<worker>.workers.dev/<MEMORY_SECRET>/mcp
// Interface d'administration : https://<worker>.workers.dev/admin (protégée par Cloudflare Access)
//
// Liaisons requises :
//   - base D1 nommée "DB"
//   - secret "MEMORY_SECRET" (24 caractères min.) : clé du connecteur MCP
//   - variable "ACCESS_TEAM_DOMAIN" : ex. https://mon-equipe.cloudflareaccess.com
//   - variable "ACCESS_AUD"         : « Application Audience (AUD) Tag » de l'application Access
//   - variable "ADMIN_EMAILS"       : e-mail(s) autorisé(s), séparés par des virgules
// Sans les trois variables Access, /admin reste fermé (erreur 503).

const VERSION = "2.0.0";
const CHUNK = 900_000; // taille d'un morceau de fichier stocké en base (base64, multiple de 4)
const CHUNK_BYTES = (CHUNK / 4) * 3; // octets bruts par morceau (multiple de 3)
const MAX_FILE_MB = 20;
const MAX_BYTES = MAX_FILE_MB * 1024 * 1024;
const DL_TTL_MS = 60 * 60 * 1000; // lien de téléchargement : 1 h
const UP_TTL_MS = 10 * 60 * 1000; // lien d'envoi : 10 min

const INSTRUCTIONS = `Ce connecteur est la mémoire à long terme de l'utilisateur, partagée entre tous ses comptes, appareils et conversations. Utilise-le comme le ferait une personne qui se souvient.
1. Au début de la conversation SEULEMENT : appelle une fois \`lister_projets\` avec \`noms_seulement: true\` (noms des projets et des tags, très court). Si, d'après ces seuls noms, la demande de l'utilisateur semble liée à un projet ou un thème existant, charge-le avec \`contexte_projet\` (ou \`rappeler\` pour un tag). Sinon, n'insiste pas. Ensuite, ne consulte plus la mémoire de ta propre initiative pendant la conversation : seulement si l'utilisateur le demande (« regarde dans ta mémoire », « tu te souviens… », « on reprend le projet X »).
2. N'enregistre rien en cours de conversation. Une seule fois, à la fin (quand l'utilisateur dit « merci », « au revoir », « c'est tout », « on a fini » ou conclut autrement), si l'échange a produit quelque chose qui mérite d'être retenu (décisions, avancement d'un projet, faits utiles, idées), propose en une phrase d'en garder un résumé (ex. « Je garde un résumé de cette session dans ta mémoire ? ») et n'appelle \`memoriser\` qu'après son accord. Écris un souvenir autonome (compréhensible sans la conversation), avec un titre clair, un projet si pertinent et des tags thématiques (ex. bricolage, scoutisme).
3. À ce même moment, si l'échange est conséquent et qu'aucun projet n'a été identifié au début, propose de créer un projet (nom + courte description) avec \`definir_projet\` et d'y rattacher le résumé. Si un souvenir existant devient faux ou incomplet, propose de le mettre à jour (\`modifier_souvenir\`) plutôt que d'en créer un doublon.
4. Les fichiers importants peuvent être conservés avec \`joindre_fichier\` (petits textes). Pour un fichier binaire ou volumineux, n'envoie pas son contenu : utilise \`preparer_upload\` (lien d'envoi pour curl) ou propose à l'utilisateur son interface d'administration (/admin), où il peut envoyer des fichiers. \`lire_fichier\` renvoie par défaut un lien de téléchargement. \`supprimer_fichier\` efface un fichier (demande confirmation à l'utilisateur avant).
Ne stocke jamais de mots de passe ou secrets.`;

// ------------------------------------------------------------------ schéma
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'actif', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'note', project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL, source TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE)`,
  `CREATE TABLE IF NOT EXISTS memory_tags (memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE, tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY (memory_id, tag_id))`,
  `CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, filename TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, description TEXT NOT NULL DEFAULT '', memory_id INTEGER REFERENCES memories(id) ON DELETE SET NULL, project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS file_chunks (file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE, idx INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (file_id, idx))`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(title, content, tags, project, tokenize = 'unicode61 remove_diacritics 2')`,
  `CREATE TABLE IF NOT EXISTS jetons (jeton TEXT PRIMARY KEY, type TEXT NOT NULL, fichier_id TEXT, meta TEXT, expire_le INTEGER NOT NULL, utilise INTEGER NOT NULL DEFAULT 0)`,
];
let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch(SCHEMA.map((s) => db.prepare(s)));
  schemaReady = true;
}

// ------------------------------------------------------------------ utilitaires
const now = () => new Date().toISOString().slice(0, 19) + "Z";
const day = (iso) => (iso || "").slice(0, 10);
const STATUTS = ["actif", "en pause", "termine", "archive"];

function normTags(tags) {
  const out = [];
  for (let t of tags || []) {
    t = String(t).trim().replace(/^#+/, "").replace(/\s+/g, " ").toLowerCase();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

const STOP = new Set("le la les un une des de du et ou a à au aux en on nous notre nos tu te toi je me moi se que qui quoi est sur pour par avec dans ce cet cette ces il elle ils elles the of and souviens rappelles rappelle".split(" "));
function ftsQuery(text) {
  const words = (text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []);
  let terms = words.filter((w) => !STOP.has(w) && w.length > 1);
  if (!terms.length) terms = words;
  return terms.slice(0, 20).map((w) => `"${w}"*`).join(" OR ");
}

async function getOrCreateProject(db, name) {
  if (!name || !String(name).trim()) return null;
  name = String(name).trim();
  const row = await db.prepare("SELECT id FROM projects WHERE name = ?").bind(name).first();
  if (row) return row.id;
  const ts = now();
  const r = await db.prepare("INSERT INTO projects(name, created_at, updated_at) VALUES (?,?,?)").bind(name, ts, ts).run();
  return r.meta.last_row_id;
}

async function memoryTags(db, id) {
  const { results } = await db.prepare(
    "SELECT t.name FROM tags t JOIN memory_tags mt ON mt.tag_id = t.id WHERE mt.memory_id = ? ORDER BY t.name"
  ).bind(id).all();
  return results.map((r) => r.name);
}

async function setTags(db, id, tags) {
  const stmts = [db.prepare("DELETE FROM memory_tags WHERE memory_id = ?").bind(id)];
  for (const t of tags) {
    stmts.push(db.prepare("INSERT OR IGNORE INTO tags(name) VALUES (?)").bind(t));
    stmts.push(db.prepare("INSERT OR IGNORE INTO memory_tags SELECT ?, id FROM tags WHERE name = ?").bind(id, t));
  }
  await db.batch(stmts);
}

async function reindex(db, id) {
  const m = await db.prepare(
    "SELECT m.title, m.content, p.name AS project FROM memories m LEFT JOIN projects p ON p.id = m.project_id WHERE m.id = ?"
  ).bind(id).first();
  const stmts = [db.prepare("DELETE FROM memories_fts WHERE rowid = ?").bind(id)];
  if (m) {
    const tags = (await memoryTags(db, id)).join(" ");
    stmts.push(db.prepare("INSERT INTO memories_fts(rowid, title, content, tags, project) VALUES (?,?,?,?,?)")
      .bind(id, m.title, m.content, tags, m.project || ""));
  }
  await db.batch(stmts);
}

async function reindexProject(db, pid) {
  const ids = (await db.prepare("SELECT id FROM memories WHERE project_id = ?").bind(pid).all()).results;
  for (const { id } of ids) await reindex(db, id);
}

const touchProject = (db, pid) =>
  pid ? db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").bind(now(), pid).run() : null;

async function deleteMemory(db, id) {
  const [del] = await db.batch([
    db.prepare("DELETE FROM memories WHERE id = ?").bind(id),
    db.prepare("DELETE FROM memory_tags WHERE memory_id = ?").bind(id),
    db.prepare("UPDATE files SET memory_id = NULL WHERE memory_id = ?").bind(id),
    db.prepare("DELETE FROM memories_fts WHERE rowid = ?").bind(id),
  ]);
  return del.meta.changes > 0;
}

async function summary(db, r, max = 280) {
  const tags = await memoryTags(db, r.id);
  let c = String(r.content).trim().replace(/\n/g, " ");
  if (c.length > max) c = c.slice(0, max).trimEnd() + "…";
  const meta = [`#${r.id}`, day(r.updated_at), r.kind];
  if (r.project) meta.push(`projet: ${r.project}`);
  if (tags.length) meta.push("tags: " + tags.join(", "));
  return `• ${r.title}  [${meta.join(" | ")}]\n  ${c}`;
}

function guessMime(name, isText) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  const map = { txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json", html: "text/html", xml: "application/xml", js: "text/javascript", py: "text/x-python", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", heic: "image/heic", svg: "image/svg+xml", pdf: "application/pdf", zip: "application/zip", mp4: "video/mp4", mov: "video/quicktime", mp3: "audio/mpeg", m4a: "audio/mp4", doc: "application/msword", xls: "application/vnd.ms-excel", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation" };
  return map[ext] || (isText ? "text/plain" : "application/octet-stream");
}

function bytesToB64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const utf8ToB64 = (s) => bytesToB64(new TextEncoder().encode(s));
function b64Size(b64) {
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}
const b64urlToBytes = (s) => b64ToBytes(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));

function cleanName(n) {
  return String(n || "").split(/[\\/]/).pop().replace(/[^\p{L}\p{N}_.\- ]+/gu, "_").trim() || "fichier";
}

function randomToken() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return bytesToB64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ------------------------------------------------------------------ stockage des fichiers
// Enregistre un fichier (morceaux base64 déjà découpés). `projectId` prime sur `projet` (nom).
async function storeFile(db, { name, mime, size, chunks, description = "", memoryId = null, projet = null, projectId = null }) {
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const pid = projectId || await getOrCreateProject(db, projet);
  const stmts = [db.prepare("INSERT INTO files(id, filename, mime, size, description, memory_id, project_id, created_at) VALUES (?,?,?,?,?,?,?,?)")
    .bind(id, name, mime, size, String(description || ""), memoryId || null, pid, now())];
  if (!chunks.length) chunks = [""];
  chunks.forEach((data, k) => stmts.push(db.prepare("INSERT INTO file_chunks(file_id, idx, data) VALUES (?,?,?)").bind(id, k, data)));
  await db.batch(stmts);
  await touchProject(db, pid);
  return { id, name, size, projet: projet || null };
}

function bytesToChunks(bytes) {
  const chunks = [];
  for (let i = 0; i < bytes.length; i += CHUNK_BYTES) chunks.push(bytesToB64(bytes.subarray(i, i + CHUNK_BYTES)));
  return chunks;
}

function fileStream(db, fileId) {
  let idx = 0;
  return new ReadableStream({
    async pull(ctrl) {
      const row = await db.prepare("SELECT data FROM file_chunks WHERE file_id = ? AND idx = ?").bind(fileId, idx++).first();
      if (!row) return ctrl.close();
      if (row.data) ctrl.enqueue(b64ToBytes(row.data));
    },
  });
}

function downloadResponse(db, f) {
  return new Response(fileStream(db, f.id), {
    headers: {
      "Content-Type": f.mime,
      "Content-Length": String(f.size),
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(f.filename)}`,
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
    },
  });
}

async function createToken(db, type, { fichierId = null, meta = null, ttl }) {
  const t = randomToken(), exp = Date.now() + ttl;
  await db.batch([
    db.prepare("DELETE FROM jetons WHERE expire_le < ?").bind(Date.now()),
    db.prepare("INSERT INTO jetons(jeton, type, fichier_id, meta, expire_le) VALUES (?,?,?,?,?)").bind(t, type, fichierId, meta ? JSON.stringify(meta) : null, exp),
  ]);
  return { jeton: t, expire_le: new Date(exp).toISOString() };
}

async function deleteFile(db, id) {
  const f = await db.prepare("SELECT id, filename FROM files WHERE id = ?").bind(id).first();
  if (!f) return null;
  await db.batch([
    db.prepare("DELETE FROM file_chunks WHERE file_id = ?").bind(f.id),
    db.prepare("DELETE FROM jetons WHERE fichier_id = ?").bind(f.id),
    db.prepare("DELETE FROM files WHERE id = ?").bind(f.id),
  ]);
  return f;
}

// ------------------------------------------------------------------ outils MCP
const RO = { readOnlyHint: true, openWorldHint: false };
const WR = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const DE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };
const str = (description) => ({ type: "string", description });
const int = (description) => ({ type: "integer", description });
const strList = (description) => ({ type: "array", items: { type: "string" }, description });

const TOOLS = {
  rappeler: {
    description: "Cherche dans la mémoire. `requete` = mots-clés ou phrase libre (ex. « après-midi zoo »). Filtres optionnels : `projet` (nom) et `tags` (tous requis). Requête vide = derniers souvenirs. Renvoie des extraits ; utilise `lire_souvenir` pour le texte complet.",
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
      if (!rows.length) return "Aucun souvenir trouvé. Essaie d'autres mots-clés, ou `lister_projets` / `lister_tags`.";
      const parts = [];
      for (const r of rows) parts.push(await summary(db, r));
      return `${rows.length} souvenir(s) :\n\n` + parts.join("\n\n");
    },
  },

  memoriser: {
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

  lire_souvenir: {
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

  modifier_souvenir: {
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

  oublier: {
    description: "Supprime définitivement un souvenir (les fichiers joints restent, détachés).",
    annotations: DE,
    inputSchema: { type: "object", required: ["id"], properties: { id: int("Numéro") } },
    async run(db, a) {
      return (await deleteMemory(db, a.id)) ? `Souvenir #${a.id} supprimé.` : `Souvenir #${a.id} introuvable.`;
    },
  },

  lister_projets: {
    description: "Liste les projets (nom, statut, description, nombre de souvenirs, dernière activité). Avec `noms_seulement: true`, renvoie seulement les noms des projets actifs et des tags (réponse très courte, à utiliser en début de conversation).",
    annotations: RO,
    inputSchema: { type: "object", properties: { noms_seulement: { type: "boolean", description: "Ne renvoyer que les noms des projets et des tags" }, inclure_archives: { type: "boolean", description: "Inclure les projets archivés" } } },
    async run(db, a) {
      if (a.noms_seulement) {
        const ps = (await db.prepare("SELECT name FROM projects WHERE status != 'archive' ORDER BY updated_at DESC").all()).results;
        const ts = (await db.prepare("SELECT t.name FROM tags t JOIN memory_tags mt ON mt.tag_id = t.id GROUP BY t.id ORDER BY COUNT(*) DESC, t.name").all()).results;
        return `Projets : ${ps.length ? ps.map((r) => r.name).join(", ") : "(aucun)"}\nTags : ${ts.length ? ts.map((r) => r.name).join(", ") : "(aucun)"}`;
      }
      let sql = "SELECT p.*, COUNT(m.id) AS n FROM projects p LEFT JOIN memories m ON m.project_id = p.id ";
      if (!a.inclure_archives) sql += "WHERE p.status != 'archive' ";
      sql += "GROUP BY p.id ORDER BY p.updated_at DESC";
      const rows = (await db.prepare(sql).all()).results;
      if (!rows.length) return "Aucun projet pour l'instant.";
      return rows.map((r) => `• ${r.name} [${r.status}] — ${r.n} souvenir(s), activité ${day(r.updated_at)}` + (r.description ? `\n  ${r.description}` : "")).join("\n");
    },
  },

  definir_projet: {
    description: "Crée ou met à jour un projet. `description` = résumé vivant du projet (objectif, état, prochaines étapes) : garde-le à jour, c'est ce qui est lu en premier. `statut` : actif | en pause | termine | archive.",
    annotations: WR,
    inputSchema: { type: "object", required: ["nom"], properties: { nom: str("Nom du projet"), description: str("Résumé"), statut: str("Statut"), nouveau_nom: str("Renommer") } },
    async run(db, a) {
      const pid = await getOrCreateProject(db, a.nom);
      if (!pid) return "Erreur : nom obligatoire.";
      const r = await db.prepare("SELECT * FROM projects WHERE id = ?").bind(pid).first();
      try {
        await db.prepare("UPDATE projects SET name=?, description=?, status=?, updated_at=? WHERE id=?")
          .bind(String(a.nouveau_nom || r.name).trim(), a.description != null ? a.description : r.description, a.statut || r.status, now(), pid).run();
      } catch (e) {
        return `Un projet nommé « ${a.nouveau_nom} » existe déjà.`;
      }
      if (a.nouveau_nom) await reindexProject(db, pid);
      return `Projet « ${a.nouveau_nom || a.nom} » enregistré.`;
    },
  },

  contexte_projet: {
    description: "Charge tout le contexte d'un projet : description, tags fréquents, fichiers et derniers souvenirs. À appeler quand l'utilisateur reprend un projet.",
    annotations: RO,
    inputSchema: { type: "object", required: ["nom"], properties: { nom: str("Nom du projet"), nb_souvenirs: int("Nombre de souvenirs (défaut 15)") } },
    async run(db, a) {
      const nom = String(a.nom || "").trim();
      const p = await db.prepare("SELECT * FROM projects WHERE name = ? COLLATE NOCASE").bind(nom).first();
      if (!p) {
        const like = (await db.prepare("SELECT name FROM projects WHERE name LIKE ? LIMIT 5").bind(`%${nom}%`).all()).results;
        return `Projet « ${nom} » introuvable.` + (like.length ? " Projets proches : " + like.map((r) => r.name).join(", ") : "");
      }
      const n = Math.max(1, Math.min(parseInt(a.nb_souvenirs ?? 15), 50));
      const mems = (await db.prepare("SELECT m.*, ? AS project FROM memories m WHERE project_id = ? ORDER BY updated_at DESC LIMIT ?").bind(p.name, p.id, n).all()).results;
      const tags = (await db.prepare("SELECT t.name, COUNT(*) n FROM tags t JOIN memory_tags mt ON mt.tag_id=t.id JOIN memories m ON m.id = mt.memory_id WHERE m.project_id = ? GROUP BY t.id ORDER BY n DESC LIMIT 15").bind(p.id).all()).results;
      const files = (await db.prepare("SELECT f.id, f.filename, f.size, f.description FROM files f LEFT JOIN memories m ON m.id = f.memory_id WHERE f.project_id = ? OR m.project_id = ? ORDER BY f.created_at DESC").bind(p.id, p.id).all()).results;
      const out = [`# Projet : ${p.name}  [${p.status}]`, `Créé ${day(p.created_at)}, dernière activité ${day(p.updated_at)}`, "", p.description || "(pas encore de description — pense à `definir_projet`)"];
      if (tags.length) out.push("", "Tags : " + tags.map((t) => `${t.name} (${t.n})`).join(", "));
      if (files.length) out.push("", "Fichiers :", ...files.map((f) => `- ${f.filename} (${f.size} o) id=${f.id} ${f.description}`));
      out.push("", `Derniers souvenirs (${mems.length}) :`, "");
      if (!mems.length) out.push("(aucun)");
      for (const m of mems) out.push(await summary(db, m, 400));
      return out.join("\n");
    },
  },

  lister_tags: {
    description: "Liste tous les tags avec leur nombre d'utilisations.",
    annotations: RO,
    inputSchema: { type: "object", properties: {} },
    async run(db) {
      const rows = (await db.prepare("SELECT t.name, COUNT(mt.memory_id) n FROM tags t LEFT JOIN memory_tags mt ON mt.tag_id = t.id GROUP BY t.id ORDER BY n DESC, t.name").all()).results;
      return rows.length ? rows.map((r) => `${r.name} (${r.n})`).join(", ") : "Aucun tag.";
    },
  },

  joindre_fichier: {
    description: "Conserve un petit fichier dans la mémoire en passant son contenu : `contenu_texte` (texte, code, markdown, csv…) ou `contenu_base64`. Pour un fichier binaire ou volumineux, préfère `preparer_upload` (le contenu ne passe pas par la conversation). Rattache-le à un `souvenir_id` et/ou un `projet`.",
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

  preparer_upload: {
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

  lire_fichier: {
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

  supprimer_fichier: {
    description: "Supprime définitivement un fichier conservé (son contenu et ses liens de téléchargement). Irréversible : demande confirmation à l'utilisateur avant. Les souvenirs liés ne sont pas touchés.",
    annotations: DE,
    inputSchema: { type: "object", required: ["id"], properties: { id: str("Identifiant du fichier (voir lister_fichiers)") } },
    async run(db, a) {
      const f = await deleteFile(db, String(a.id || "").trim());
      return f ? `Fichier « ${f.filename} » (id=${f.id}) supprimé.` : `Fichier ${a.id} introuvable.`;
    },
  },

  lister_fichiers: {
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

// ------------------------------------------------------------------ protocole MCP (JSON-RPC, Streamable HTTP sans état)
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

async function handleRpc(msg, env, ctx) {
  const { id, method, params = {} } = msg || {};
  const isNotification = id === undefined || id === null;
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  const err = (code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
  if (!msg || msg.jsonrpc !== "2.0" || typeof method !== "string") return err(-32600, "Requête invalide");
  if (isNotification) return null;

  switch (method) {
    case "initialize": {
      const asked = params.protocolVersion;
      return ok({
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[1],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "memoire", title: "Mémoire partagée", version: VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({
        tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })),
      });
    case "tools/call": {
      const tool = TOOLS[params.name];
      if (!tool) return err(-32602, `Outil inconnu : ${params.name}`);
      try {
        await ensureSchema(env.DB);
        const text = await tool.run(env.DB, params.arguments || {}, ctx);
        return ok({ content: [{ type: "text", text }], isError: /^Erreur/.test(text) });
      } catch (e) {
        return ok({ content: [{ type: "text", text: `Erreur interne : ${e.message}` }], isError: true });
      }
    }
    case "resources/list":
      return ok({ resources: [] });
    case "prompts/list":
      return ok({ prompts: [] });
    default:
      return err(-32601, `Méthode inconnue : ${method}`);
  }
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ------------------------------------------------------------------ authentification Cloudflare Access
// Cloudflare Access bloque les visiteurs non connectés avant le Worker ; le Worker vérifie en plus
// le jeton signé (en-tête Cf-Access-Jwt-Assertion), son audience, son émetteur et l'e-mail.
let accessCerts = { url: "", at: 0, keys: [] };
async function accessKeys(team, force = false) {
  if (!force && accessCerts.url === team && Date.now() - accessCerts.at < 3600_000) return accessCerts.keys;
  const r = await fetch(`${team}/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error(`certificats Access indisponibles (${r.status})`);
  const j = await r.json();
  accessCerts = { url: team, at: Date.now(), keys: j.keys || [] };
  return accessCerts.keys;
}

async function verifyAccess(request, env) {
  let team = String(env.ACCESS_TEAM_DOMAIN || "").trim().replace(/\/+$/, "");
  if (team && !/^https:\/\//.test(team)) team = "https://" + team;
  const aud = String(env.ACCESS_AUD || "").trim();
  const emails = String(env.ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!team || !aud || !emails.length) return { status: 503, error: "Configuration incomplète : ACCESS_TEAM_DOMAIN, ACCESS_AUD et ADMIN_EMAILS sont requis." };
  const deny = { status: 403, error: "Accès refusé." };
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return deny;
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) return deny;
  let header, payload;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)));
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));
  } catch { return deny; }
  if (header.alg !== "RS256" || !header.kid) return deny;
  let jwk = (await accessKeys(team)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await accessKeys(team, true)).find((k) => k.kid === header.kid);
  if (!jwk) return deny;
  const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(s), new TextEncoder().encode(`${h}.${p}`));
  if (!valid) return deny;
  const t = Date.now() / 1000;
  if (typeof payload.exp !== "number" || payload.exp < t) return deny;
  if (payload.nbf && payload.nbf > t + 60) return deny;
  if (payload.iss !== team) return deny;
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) return deny;
  const email = String(payload.email || "").toLowerCase();
  if (!emails.includes(email)) return deny;
  return { email };
}

// ------------------------------------------------------------------ API d'administration
const NO_STORE = { "Cache-Control": "no-store" };
const jsonOk = (data) => Response.json(data, { headers: NO_STORE });
const jsonErr = (status, erreur) => Response.json({ ok: false, erreur }, { status, headers: NO_STORE });
const likeArg = (q) => `%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`;

async function tagsByMemory(db, ids) {
  const map = {};
  if (!ids.length) return map;
  const rows = (await db.prepare(`SELECT mt.memory_id, t.name FROM memory_tags mt JOIN tags t ON t.id = mt.tag_id WHERE mt.memory_id IN (${ids.map(() => "?").join(",")}) ORDER BY t.name`).bind(...ids).all()).results;
  for (const r of rows) (map[r.memory_id] ||= []).push(r.name);
  return map;
}

async function projectIdFrom(db, v) {
  if (v === null || v === "" || v === undefined || Number(v) === 0) return null;
  const p = await db.prepare("SELECT id FROM projects WHERE id = ?").bind(Number(v)).first();
  if (!p) throw new ApiError(404, "Projet introuvable.");
  return p.id;
}

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function readJson(request) {
  try { return await request.json(); }
  catch { throw new ApiError(400, "JSON invalide."); }
}

async function adminApi(request, db, path, url) {
  const m = request.method;
  const [res, idRaw] = path;
  const id = idRaw;

  // --- projets
  if (res === "projets" && !id && m === "GET") {
    const rows = (await db.prepare("SELECT p.*, (SELECT COUNT(*) FROM memories WHERE project_id = p.id) AS n_souvenirs, (SELECT COUNT(*) FROM files WHERE project_id = p.id) AS n_fichiers FROM projects p ORDER BY p.status = 'archive', p.updated_at DESC").all()).results;
    const orphans = await db.prepare("SELECT (SELECT COUNT(*) FROM memories WHERE project_id IS NULL) AS n_souvenirs, (SELECT COUNT(*) FROM files WHERE project_id IS NULL) AS n_fichiers").first();
    return jsonOk({ projets: rows, sans_projet: orphans });
  }
  if (res === "projets" && !id && m === "POST") {
    const b = await readJson(request);
    const nom = String(b.nom || "").trim();
    if (!nom) throw new ApiError(400, "Le nom est obligatoire.");
    if (await db.prepare("SELECT 1 FROM projects WHERE name = ?").bind(nom).first()) throw new ApiError(409, `Un projet « ${nom} » existe déjà.`);
    const statut = STATUTS.includes(b.statut) ? b.statut : "actif", ts = now();
    const r = await db.prepare("INSERT INTO projects(name, description, status, created_at, updated_at) VALUES (?,?,?,?,?)").bind(nom, String(b.description || ""), statut, ts, ts).run();
    return jsonOk({ ok: true, id: r.meta.last_row_id });
  }
  if (res === "projets" && id && m === "GET") {
    const pid = Number(id);
    let projet = null;
    if (pid) {
      projet = await db.prepare("SELECT * FROM projects WHERE id = ?").bind(pid).first();
      if (!projet) throw new ApiError(404, "Projet introuvable.");
    }
    const cond = pid ? "project_id = ?" : "project_id IS NULL";
    const args = pid ? [pid] : [];
    const souvenirs = (await db.prepare(`SELECT id, title, content, kind, source, created_at, updated_at FROM memories WHERE ${cond} ORDER BY updated_at DESC`).bind(...args).all()).results;
    const tags = await tagsByMemory(db, souvenirs.map((s) => s.id));
    for (const s of souvenirs) s.tags = tags[s.id] || [];
    const fichiers = (await db.prepare(`SELECT id, filename, mime, size, description, memory_id, created_at FROM files WHERE ${cond} ORDER BY created_at DESC`).bind(...args).all()).results;
    return jsonOk({ projet, souvenirs, fichiers });
  }
  if (res === "projets" && id && m === "PATCH") {
    const pid = Number(id);
    const r = await db.prepare("SELECT * FROM projects WHERE id = ?").bind(pid).first();
    if (!r) throw new ApiError(404, "Projet introuvable.");
    const b = await readJson(request);
    const nom = b.nom != null ? String(b.nom).trim() : r.name;
    if (!nom) throw new ApiError(400, "Le nom ne peut pas être vide.");
    if (nom.toLowerCase() !== r.name.toLowerCase() && await db.prepare("SELECT 1 FROM projects WHERE name = ?").bind(nom).first())
      throw new ApiError(409, `Un projet « ${nom} » existe déjà.`);
    const statut = b.statut != null ? (STATUTS.includes(b.statut) ? b.statut : null) : r.status;
    if (!statut) throw new ApiError(400, "Statut invalide.");
    await db.prepare("UPDATE projects SET name=?, description=?, status=?, updated_at=? WHERE id=?")
      .bind(nom, b.description != null ? String(b.description) : r.description, statut, now(), pid).run();
    if (nom !== r.name) await reindexProject(db, pid);
    return jsonOk({ ok: true });
  }
  if (res === "projets" && id && m === "DELETE") {
    const pid = Number(id);
    const ids = (await db.prepare("SELECT id FROM memories WHERE project_id = ?").bind(pid).all()).results;
    const [, , del] = await db.batch([
      db.prepare("UPDATE memories SET project_id = NULL WHERE project_id = ?").bind(pid),
      db.prepare("UPDATE files SET project_id = NULL WHERE project_id = ?").bind(pid),
      db.prepare("DELETE FROM projects WHERE id = ?").bind(pid),
    ]);
    if (!del.meta.changes) throw new ApiError(404, "Projet introuvable.");
    for (const r of ids) await reindex(db, r.id);
    return jsonOk({ ok: true });
  }

  // --- souvenirs
  if (res === "souvenirs" && !id && m === "POST") {
    const b = await readJson(request);
    const titre = String(b.titre || "").trim(), contenu = String(b.contenu || "").trim();
    if (!titre || !contenu) throw new ApiError(400, "Titre et contenu sont obligatoires.");
    const pid = await projectIdFrom(db, b.projet_id), ts = now();
    const r = await db.prepare("INSERT INTO memories(title, content, kind, project_id, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
      .bind(titre, contenu, String(b.type || "note").trim() || "note", pid, "interface web", ts, ts).run();
    const mid = r.meta.last_row_id;
    await setTags(db, mid, normTags(b.tags));
    await reindex(db, mid);
    await touchProject(db, pid);
    return jsonOk({ ok: true, id: mid });
  }
  if (res === "souvenirs" && id && m === "PATCH") {
    const r = await db.prepare("SELECT * FROM memories WHERE id = ?").bind(Number(id)).first();
    if (!r) throw new ApiError(404, "Souvenir introuvable.");
    const b = await readJson(request);
    const titre = b.titre != null ? String(b.titre).trim() : r.title;
    const contenu = b.contenu != null ? String(b.contenu).trim() : r.content;
    if (!titre || !contenu) throw new ApiError(400, "Titre et contenu ne peuvent pas être vides.");
    const pid = "projet_id" in b ? await projectIdFrom(db, b.projet_id) : r.project_id;
    await db.prepare("UPDATE memories SET title=?, content=?, kind=?, project_id=?, updated_at=? WHERE id=?")
      .bind(titre, contenu, b.type ? String(b.type).trim() : r.kind, pid, now(), r.id).run();
    if (b.tags != null) await setTags(db, r.id, normTags(b.tags));
    await reindex(db, r.id);
    await touchProject(db, pid);
    return jsonOk({ ok: true });
  }
  if (res === "souvenirs" && id && m === "DELETE") {
    if (!(await deleteMemory(db, Number(id)))) throw new ApiError(404, "Souvenir introuvable.");
    return jsonOk({ ok: true });
  }

  // --- fichiers
  if (res === "fichiers" && !id && m === "POST") {
    const len = parseInt(request.headers.get("Content-Length") || "0");
    if (len > MAX_BYTES * 5 + 1_000_000) throw new ApiError(413, `Envoi trop gros (max ${MAX_FILE_MB} Mo par fichier).`);
    let form;
    try { form = await request.formData(); }
    catch { throw new ApiError(400, "Formulaire invalide."); }
    const files = form.getAll("fichier").filter((f) => f && typeof f === "object" && "arrayBuffer" in f);
    if (!files.length) throw new ApiError(400, "Aucun fichier reçu.");
    for (const f of files) if (f.size > MAX_BYTES) throw new ApiError(413, `« ${f.name} » est trop gros (max ${MAX_FILE_MB} Mo).`);
    const pid = await projectIdFrom(db, form.get("projet_id"));
    const description = String(form.get("description") || "").trim();
    const out = [];
    for (const f of files) {
      const name = cleanName(f.name);
      const bytes = new Uint8Array(await f.arrayBuffer());
      const mime = f.type && f.type !== "application/octet-stream" ? f.type : guessMime(name, false);
      const r = await storeFile(db, { name, mime, size: bytes.length, chunks: bytesToChunks(bytes), description, projectId: pid });
      out.push({ id: r.id, nom: r.name, taille: r.size });
    }
    return jsonOk({ ok: true, fichiers: out });
  }
  if (res === "fichiers" && id && m === "PATCH") {
    const f = await db.prepare("SELECT * FROM files WHERE id = ?").bind(id).first();
    if (!f) throw new ApiError(404, "Fichier introuvable.");
    const b = await readJson(request);
    const pid = "projet_id" in b ? await projectIdFrom(db, b.projet_id) : f.project_id;
    const nom = b.nom != null ? cleanName(b.nom) : f.filename;
    await db.prepare("UPDATE files SET filename=?, description=?, project_id=? WHERE id=?")
      .bind(nom, b.description != null ? String(b.description) : f.description, pid, f.id).run();
    await touchProject(db, pid);
    return jsonOk({ ok: true });
  }
  if (res === "fichiers" && id && m === "DELETE") {
    const f = await deleteFile(db, id);
    if (!f) throw new ApiError(404, "Fichier introuvable.");
    return jsonOk({ ok: true });
  }

  // --- tags
  if (res === "tags" && !id && m === "GET") {
    const rows = (await db.prepare("SELECT t.name, COUNT(mt.memory_id) n FROM tags t JOIN memory_tags mt ON mt.tag_id = t.id GROUP BY t.id ORDER BY n DESC, t.name").all()).results;
    return jsonOk({ tags: rows });
  }

  // --- recherche transverse
  if (res === "recherche" && !id && m === "GET") {
    const q = String(url.searchParams.get("q") || "").trim();
    const tag = normTags([url.searchParams.get("tag") || ""])[0] || null;
    if (!q && !tag) return jsonOk({ souvenirs: [], projets: [], fichiers: [] });
    const where = [], params = [];
    if (tag) {
      where.push("EXISTS (SELECT 1 FROM memory_tags mt JOIN tags tg ON tg.id = mt.tag_id WHERE mt.memory_id = m.id AND tg.name = ?)");
      params.push(tag);
    }
    let souvenirs;
    if (q) {
      const sql = "SELECT m.id, m.title, m.kind, m.updated_at, m.project_id, p.name AS projet, snippet(memories_fts, 1, char(1), char(2), '…', 24) AS extrait " +
        "FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid LEFT JOIN projects p ON p.id = m.project_id " +
        "WHERE memories_fts MATCH ? " + (where.length ? "AND " + where.join(" AND ") + " " : "") +
        "ORDER BY bm25(memories_fts, 5.0, 1.0, 3.0, 2.0), m.updated_at DESC LIMIT 60";
      souvenirs = (await db.prepare(sql).bind(ftsQuery(q), ...params).all()).results;
    } else {
      const sql = "SELECT m.id, m.title, m.kind, m.updated_at, m.project_id, p.name AS projet, substr(m.content, 1, 200) AS extrait FROM memories m LEFT JOIN projects p ON p.id = m.project_id WHERE " + where.join(" AND ") + " ORDER BY m.updated_at DESC LIMIT 60";
      souvenirs = (await db.prepare(sql).bind(...params).all()).results;
    }
    const tags = await tagsByMemory(db, souvenirs.map((s) => s.id));
    for (const s of souvenirs) s.tags = tags[s.id] || [];
    let projets = [], fichiers = [];
    if (q) {
      const l = likeArg(q);
      projets = (await db.prepare("SELECT id, name, description, status FROM projects WHERE name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT 20").bind(l, l).all()).results;
      fichiers = (await db.prepare("SELECT f.id, f.filename, f.size, f.description, f.project_id, p.name AS projet FROM files f LEFT JOIN projects p ON p.id = f.project_id WHERE f.filename LIKE ? ESCAPE '\\' OR f.description LIKE ? ESCAPE '\\' ORDER BY f.created_at DESC LIMIT 30").bind(l, l).all()).results;
    }
    return jsonOk({ souvenirs, projets, fichiers });
  }

  throw new ApiError(404, "Route inconnue.");
}

async function handleAdmin(request, env, url, parts) {
  const auth = await verifyAccess(request, env);
  if (auth.error) return new Response(auth.error, { status: auth.status, headers: { "Content-Type": "text/plain; charset=utf-8", ...NO_STORE } });
  const db = env.DB;
  await ensureSchema(db);

  // Protection CSRF : toute écriture doit venir de la page elle-même.
  if (!["GET", "HEAD"].includes(request.method) && request.headers.get("Origin") !== url.origin)
    return jsonErr(403, "Origine refusée.");

  if (parts.length === 1) {
    if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
    return new Response(adminPage(auth.email), { headers: PAGE_HEADERS });
  }
  if (parts[1] === "fichiers" && parts.length === 3 && request.method === "GET") {
    const f = await db.prepare("SELECT * FROM files WHERE id = ?").bind(parts[2]).first();
    return f ? downloadResponse(db, f) : new Response("Not found", { status: 404 });
  }
  if (parts[1] === "api" && parts.length >= 3 && parts.length <= 4) {
    try {
      return await adminApi(request, db, parts.slice(2), url);
    } catch (e) {
      if (e instanceof ApiError) return jsonErr(e.status, e.message);
      return jsonErr(500, `Erreur interne : ${e.message}`);
    }
  }
  return new Response("Not found", { status: 404 });
}

// ------------------------------------------------------------------ page d'administration
const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

const escHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function adminPage(email) {
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Mémoire — administration</title>
<style>
:root{color-scheme:light dark;--bg:#f6f6f4;--card:#fff;--txt:#1d1d1b;--mut:#6b6b66;--acc:#c96442;--bd:#e3e2dd;--ko:#c62828;--ok:#2e7d32}
@media(prefers-color-scheme:dark){:root{--bg:#1c1c1a;--card:#262624;--txt:#eceae4;--mut:#9b9a94;--bd:#3a3936}}
*{box-sizing:border-box}body{margin:0;font:15px/1.45 system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--txt)}
header{position:sticky;top:0;z-index:2;display:flex;gap:12px;align-items:center;padding:10px 16px;background:var(--card);border-bottom:1px solid var(--bd)}
header h1{font-size:1.05rem;margin:0;white-space:nowrap;cursor:pointer}header form{flex:1;display:flex;gap:8px}header small{color:var(--mut);white-space:nowrap}
.wrap{display:grid;grid-template-columns:260px 1fr;gap:16px;max-width:1200px;margin:0 auto;padding:16px}
@media(max-width:760px){.wrap{grid-template-columns:1fr}header small{display:none}}
aside,section.card,.item{background:var(--card);border:1px solid var(--bd);border-radius:12px}
aside{padding:8px;align-self:start}aside ul{list-style:none;margin:0;padding:0}
aside li{padding:8px 10px;border-radius:8px;cursor:pointer;display:flex;justify-content:space-between;gap:8px}
aside li:hover{background:var(--bg)}aside li.sel{background:var(--acc);color:#fff}aside li.sel .n{color:#fff}aside li.arch{opacity:.55}
.n{color:var(--mut);font-size:.8rem;white-space:nowrap}aside h3{font-size:.75rem;text-transform:uppercase;letter-spacing:.04em;color:var(--mut);margin:10px 10px 4px}
section.card{padding:16px;margin-bottom:16px}h2{font-size:1.15rem;margin:0 0 12px}h3{font-size:1rem;margin:20px 0 8px}
label{display:block;font-size:.82rem;color:var(--mut);margin:10px 0 4px}
input,select,textarea{width:100%;font:inherit;padding:8px 10px;border:1px solid var(--bd);border-radius:8px;background:var(--bg);color:var(--txt)}
textarea{min-height:90px;resize:vertical}textarea.big{min-height:160px}
button{font:inherit;padding:8px 14px;border:1px solid var(--bd);border-radius:8px;background:var(--card);color:var(--txt);cursor:pointer;white-space:nowrap}
button.p{background:var(--acc);border-color:var(--acc);color:#fff;font-weight:600}button.d{color:var(--ko)}button:disabled{opacity:.5}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.row>*{flex:1}.row>button{flex:0}
.item{padding:12px 14px;margin:8px 0}.item .t{font-weight:600}.meta{color:var(--mut);font-size:.8rem}
.item pre{white-space:pre-wrap;word-break:break-word;font:inherit;margin:8px 0 0}
.tag{display:inline-block;font-size:.75rem;padding:1px 8px;border-radius:99px;background:var(--bg);border:1px solid var(--bd);margin:2px 4px 0 0;cursor:pointer}
.acts{display:flex;gap:6px;margin-top:8px}.acts button{padding:4px 10px;font-size:.85rem}
a{color:var(--acc)}mark{background:#f6d365;color:#1d1d1b;border-radius:3px;padding:0 2px}
#toast{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);padding:10px 16px;border-radius:8px;background:var(--txt);color:var(--bg);display:none;z-index:9}
.empty{color:var(--mut);font-style:italic}progress{width:100%;margin-top:8px;display:none}
details summary{cursor:pointer;color:var(--acc);font-weight:600;margin:4px 0}
</style></head><body>
<header><h1 id="home">🧠 Mémoire</h1><form id="sf"><input id="sq" type="search" placeholder="Rechercher dans tous les projets…"><button class="p">Chercher</button></form><small>${escHtml(email)}</small></header>
<div class="wrap"><aside><button class="p" id="newp" style="width:100%">+ Nouveau projet</button><div id="plist"></div></aside><main id="main"></main></div>
<div id="toast"></div>
<script>
const $=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>[...r.querySelectorAll(s)];
const esc=(s)=>String(s??"").replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const STATUTS=["actif","en pause","termine","archive"],TYPES=["note","decision","fait","idee","resume","tache","evenement"],MAX=${MAX_BYTES};
const fmt=(n)=>n<1024?n+" o":n<1048576?Math.round(n/1024)+" Ko":(n/1048576).toFixed(1)+" Mo";
const day=(s)=>(s||"").slice(0,10);
let state={projets:[],cur:null};
function toast(m,ko){const t=$("#toast");t.textContent=m;t.style.background=ko?"var(--ko)":"";t.style.display="block";clearTimeout(t._h);t._h=setTimeout(()=>t.style.display="none",ko?5000:2200)}
async function api(method,path,body){const o={method,headers:{}};if(body instanceof FormData)o.body=body;else if(body!==undefined){o.headers["Content-Type"]="application/json";o.body=JSON.stringify(body)}
const r=await fetch("/admin/api/"+path,o);let j;try{j=await r.json()}catch(_){j={ok:false,erreur:"Réponse inattendue ("+r.status+"). Session expirée ? Recharge la page."}}
if(!r.ok||j.ok===false){toast(j.erreur||"Erreur",true);throw new Error(j.erreur)}return j}
const opts=(list,cur)=>list.map((v)=>'<option'+(v===cur?" selected":"")+">"+esc(v)+"</option>").join("");
const projOpts=(cur)=>'<option value="">— aucun projet —</option>'+state.projets.map((p)=>'<option value="'+p.id+'"'+(p.id===cur?" selected":"")+">"+esc(p.name)+"</option>").join("");

async function loadProjets(){const j=await api("GET","projets");state.projets=j.projets;state.sans=j.sans_projet;renderList()}
function renderList(){const act=state.projets.filter((p)=>p.status!=="archive"),arc=state.projets.filter((p)=>p.status==="archive");
const li=(p)=>'<li data-id="'+p.id+'" class="'+(state.cur===p.id?"sel ":"")+(p.status==="archive"?"arch":"")+'"><span>'+esc(p.name)+'</span><span class="n">'+p.n_souvenirs+(p.n_fichiers?" · "+p.n_fichiers+" 📎":"")+"</span></li>";
let h="<h3>Projets</h3><ul>"+(act.map(li).join("")||'<li class="empty">Aucun</li>')+'</ul><h3>Autres</h3><ul><li data-id="0" class="'+(state.cur===0?"sel":"")+'"><span>Sans projet</span><span class="n">'+(state.sans?.n_souvenirs||0)+(state.sans?.n_fichiers?" · "+state.sans.n_fichiers+" 📎":"")+"</span></li></ul>";
if(arc.length)h+="<h3>Archivés</h3><ul>"+arc.map(li).join("")+"</ul>";$("#plist").innerHTML=h;
$$("#plist li[data-id]").forEach((l)=>l.onclick=()=>openProjet(Number(l.dataset.id)))}

function memForm(m,pid){m=m||{};return '<label>Titre</label><input name="titre" value="'+esc(m.title)+'" required><label>Contenu</label><textarea name="contenu" class="big" required>'+esc(m.content)+'</textarea>'+
'<div class="row"><div><label>Tags (séparés par des virgules)</label><input name="tags" value="'+esc((m.tags||[]).join(", "))+'"></div><div><label>Type</label><select name="type">'+opts(TYPES,m.kind||"note")+'</select></div><div><label>Projet</label><select name="projet_id">'+projOpts(pid)+"</select></div></div>"}
const memData=(f)=>({titre:f.titre.value,contenu:f.contenu.value,type:f.type.value,projet_id:f.projet_id.value?Number(f.projet_id.value):null,tags:f.tags.value.split(",").map((s)=>s.trim()).filter(Boolean)});

function memItem(s,pid){return '<div class="item" data-mid="'+s.id+'"><div class="t">'+esc(s.title)+'</div><div class="meta">#'+s.id+" · "+esc(s.kind)+" · modifié "+day(s.updated_at)+(s.source?" · "+esc(s.source):"")+"</div>"+
(s.tags.length?"<div>"+s.tags.map((t)=>'<span class="tag" data-tag="'+esc(t)+'">'+esc(t)+"</span>").join("")+"</div>":"")+
"<pre>"+esc(s.content)+'</pre><div class="acts"><button data-a="edit">Modifier</button><button data-a="del" class="d">Supprimer</button></div></div>'}

function fileItem(f){return '<div class="item" data-fid="'+esc(f.id)+'"><div class="row"><div><a href="/admin/fichiers/'+encodeURIComponent(f.id)+'">'+esc(f.filename)+'</a> <span class="meta">'+fmt(f.size)+" · "+day(f.created_at)+(f.memory_id?" · souvenir #"+f.memory_id:"")+" · id "+esc(f.id)+"</span>"+
(f.description?'<div class="meta">'+esc(f.description)+"</div>":"")+'</div></div><div class="acts"><button data-a="fedit">Modifier</button><button data-a="fdel" class="d">Supprimer</button></div></div>'}

async function openProjet(pid){state.cur=pid;renderList();const j=await api("GET","projets/"+pid);const p=j.projet;
let h='<section class="card">';
if(p){h+='<h2>'+esc(p.name)+'</h2><form id="pf"><div class="row"><div><label>Nom</label><input name="nom" value="'+esc(p.name)+'" required></div><div><label>Statut</label><select name="statut">'+opts(STATUTS,p.status)+'</select></div></div>'+
'<label>Description (résumé vivant du projet, lu en premier par Claude)</label><textarea name="description" class="big">'+esc(p.description)+'</textarea>'+
'<div class="acts"><button class="p">Enregistrer</button><button type="button" id="pdel" class="d">Supprimer le projet</button></div><div class="meta" style="margin-top:6px">Créé '+day(p.created_at)+" · dernière activité "+day(p.updated_at)+"</div></form>"}
else h+='<h2>Sans projet</h2><p class="meta">Souvenirs et fichiers rattachés à aucun projet.</p>';
h+='</section><section class="card"><details><summary>+ Ajouter un souvenir (texte)</summary><form id="mf">'+memForm(null,p?p.id:null)+'<div class="acts"><button class="p">Ajouter</button></div></form></details>'+
'<details><summary>+ Joindre des fichiers</summary><form id="ff"><label>Fichier(s) — '+(MAX/1048576)+' Mo max chacun</label><input type="file" name="fichier" multiple required><label>Description</label><input name="description" placeholder="Facultatif"><div class="acts"><button class="p">Envoyer</button></div><progress max="100" value="0"></progress></form></details></section>'+
'<section class="card"><h3 style="margin-top:0">Souvenirs ('+j.souvenirs.length+')</h3><div id="mems">'+(j.souvenirs.map((s)=>memItem(s,p?p.id:null)).join("")||'<p class="empty">Aucun souvenir.</p>')+"</div>"+
"<h3>Fichiers ("+j.fichiers.length+')</h3><div id="files">'+(j.fichiers.map(fileItem).join("")||'<p class="empty">Aucun fichier.</p>')+"</div></section>";
$("#main").innerHTML=h;const mems=Object.fromEntries(j.souvenirs.map((s)=>[s.id,s])),files=Object.fromEntries(j.fichiers.map((f)=>[f.id,f]));
if(p){$("#pf").onsubmit=async(e)=>{e.preventDefault();const f=e.target;await api("PATCH","projets/"+p.id,{nom:f.nom.value,statut:f.statut.value,description:f.description.value});toast("Projet enregistré");await loadProjets();openProjet(p.id)};
$("#pdel").onclick=async()=>{if(!confirm("Supprimer le projet « "+p.name+" » ?\\nSes souvenirs et fichiers sont conservés, sans projet."))return;await api("DELETE","projets/"+p.id);toast("Projet supprimé");await loadProjets();openProjet(0)}}
$("#mf").onsubmit=async(e)=>{e.preventDefault();await api("POST","souvenirs",memData(e.target));toast("Souvenir ajouté");await loadProjets();openProjet(pid)};
$("#ff").onsubmit=(e)=>{e.preventDefault();const f=e.target,fd=new FormData();const list=[...f.fichier.files];
for(const x of list)if(x.size>MAX)return toast("« "+x.name+" » dépasse "+(MAX/1048576)+" Mo",true);
list.forEach((x)=>fd.append("fichier",x));fd.append("description",f.description.value);if(pid)fd.append("projet_id",pid);
const pg=$("progress",f),bt=$("button",f);pg.style.display="block";bt.disabled=true;const x=new XMLHttpRequest();x.open("POST","/admin/api/fichiers");
x.upload.onprogress=(ev)=>ev.lengthComputable&&(pg.value=ev.loaded/ev.total*100);
x.onload=async()=>{bt.disabled=false;let r;try{r=JSON.parse(x.responseText)}catch(_){r={ok:false,erreur:"Réponse inattendue ("+x.status+")"}}
if(!r.ok)return toast(r.erreur,true);toast(r.fichiers.length+" fichier(s) envoyé(s)");await loadProjets();openProjet(pid)};
x.onerror=()=>{bt.disabled=false;toast("Erreur réseau",true)};x.send(fd)};
bindItems(mems,files,()=>openProjet(pid))}

function bindItems(mems,files,reload){
$$("#main [data-mid]").forEach((el)=>{const s=mems[el.dataset.mid];if(!s)return;
$('[data-a="edit"]',el)&&($('[data-a="edit"]',el).onclick=()=>{el.innerHTML='<form>'+memForm(s,s.project_id!==undefined?s.project_id:state.cur||null)+'<div class="acts"><button class="p">Enregistrer</button><button type="button" data-a="cancel">Annuler</button></div></form>';
$("form",el).onsubmit=async(e)=>{e.preventDefault();await api("PATCH","souvenirs/"+s.id,memData(e.target));toast("Souvenir modifié");await loadProjets();reload()};$('[data-a="cancel"]',el).onclick=reload});
$('[data-a="del"]',el)&&($('[data-a="del"]',el).onclick=async()=>{if(!confirm("Supprimer définitivement « "+s.title+" » ?"))return;await api("DELETE","souvenirs/"+s.id);toast("Souvenir supprimé");await loadProjets();reload()})});
$$("#main [data-fid]").forEach((el)=>{const f=files[el.dataset.fid];if(!f)return;
$('[data-a="fedit"]',el).onclick=()=>{el.innerHTML='<form><div class="row"><div><label>Nom</label><input name="nom" value="'+esc(f.filename)+'"></div><div><label>Projet</label><select name="projet_id">'+projOpts(f.project_id!==undefined?f.project_id:state.cur||null)+'</select></div></div><label>Description</label><input name="description" value="'+esc(f.description)+'"><div class="acts"><button class="p">Enregistrer</button><button type="button" data-a="cancel">Annuler</button></div></form>';
$("form",el).onsubmit=async(e)=>{e.preventDefault();const t=e.target;await api("PATCH","fichiers/"+encodeURIComponent(f.id),{nom:t.nom.value,description:t.description.value,projet_id:t.projet_id.value?Number(t.projet_id.value):null});toast("Fichier modifié");await loadProjets();reload()};$('[data-a="cancel"]',el).onclick=reload};
$('[data-a="fdel"]',el).onclick=async()=>{if(!confirm("Supprimer définitivement « "+f.filename+" » ?"))return;await api("DELETE","fichiers/"+encodeURIComponent(f.id));toast("Fichier supprimé");await loadProjets();reload()}});
$$("#main .tag").forEach((t)=>t.onclick=()=>search("",t.dataset.tag))}

const hl=(s)=>esc(s).replace(/\\u0001/g,"<mark>").replace(/\\u0002/g,"</mark>");
async function search(q,tag){state.cur=null;renderList();const qs=new URLSearchParams();if(q)qs.set("q",q);if(tag)qs.set("tag",tag);
const j=await api("GET","recherche?"+qs);
let h='<section class="card"><h2>Recherche : '+esc(q||"")+(tag?' <span class="tag">'+esc(tag)+"</span>":"")+"</h2>";
if(j.projets.length)h+="<h3>Projets ("+j.projets.length+")</h3>"+j.projets.map((p)=>'<div class="item"><a href="#" data-p="'+p.id+'" class="t">'+esc(p.name)+'</a> <span class="meta">'+esc(p.status)+"</span>"+(p.description?'<div class="meta">'+esc(p.description.slice(0,200))+"</div>":"")+"</div>").join("");
h+="<h3>Souvenirs ("+j.souvenirs.length+")</h3>"+(j.souvenirs.map((s)=>'<div class="item"><div class="t">'+esc(s.title)+'</div><div class="meta">#'+s.id+" · "+esc(s.kind)+" · "+day(s.updated_at)+" · "+(s.project_id?'<a href="#" data-p="'+s.project_id+'">'+esc(s.projet)+"</a>":"sans projet")+"</div>"+
(s.tags.length?"<div>"+s.tags.map((t)=>'<span class="tag" data-tag="'+esc(t)+'">'+esc(t)+"</span>").join("")+"</div>":"")+"<pre>"+hl(s.extrait)+"</pre></div>").join("")||'<p class="empty">Aucun souvenir.</p>');
if(j.fichiers.length)h+="<h3>Fichiers ("+j.fichiers.length+")</h3>"+j.fichiers.map((f)=>'<div class="item"><a href="/admin/fichiers/'+encodeURIComponent(f.id)+'">'+esc(f.filename)+'</a> <span class="meta">'+fmt(f.size)+" · "+(f.project_id?'<a href="#" data-p="'+f.project_id+'">'+esc(f.projet)+"</a>":"sans projet")+"</span>"+(f.description?'<div class="meta">'+esc(f.description)+"</div>":"")+"</div>").join("");
$("#main").innerHTML=h+"</section>";$$("#main [data-p]").forEach((a)=>a.onclick=(e)=>{e.preventDefault();openProjet(Number(a.dataset.p))});$$("#main .tag[data-tag]").forEach((t)=>t.onclick=()=>search("",t.dataset.tag))}

async function home(){state.cur=null;renderList();const t=await api("GET","tags");
$("#main").innerHTML='<section class="card"><h2>Bienvenue</h2><p>Choisis un projet à gauche, ou cherche dans toute la mémoire.</p><h3>Tags</h3><div>'+(t.tags.map((x)=>'<span class="tag" data-tag="'+esc(x.name)+'">'+esc(x.name)+" ("+x.n+")</span>").join("")||'<span class="empty">Aucun tag.</span>')+"</div></section>";
$$("#main .tag").forEach((x)=>x.onclick=()=>search("",x.dataset.tag))}

$("#sf").onsubmit=(e)=>{e.preventDefault();const q=$("#sq").value.trim();if(q)search(q)};
$("#home").onclick=home;
$("#newp").onclick=()=>{state.cur=null;renderList();$("#main").innerHTML='<section class="card"><h2>Nouveau projet</h2><form id="np"><label>Nom</label><input name="nom" required><label>Statut</label><select name="statut">'+opts(STATUTS,"actif")+'</select><label>Description</label><textarea name="description" class="big"></textarea><div class="acts"><button class="p">Créer</button></div></form></section>';
$("#np").onsubmit=async(e)=>{e.preventDefault();const f=e.target;const r=await api("POST","projets",{nom:f.nom.value,statut:f.statut.value,description:f.description.value});toast("Projet créé");await loadProjets();openProjet(r.id)}};
loadProjets().then(home).catch(()=>{});
</script></body></html>`;
}

// ------------------------------------------------------------------ envoi par lien à usage unique (curl -T)
async function handlePutUpload(request, db, jeton) {
  const len = parseInt(request.headers.get("Content-Length") || "0");
  if (len > MAX_BYTES) return jsonErr(413, `Fichier trop gros (max ${MAX_FILE_MB} Mo).`);
  const used = await db.prepare("UPDATE jetons SET utilise = 1 WHERE jeton = ? AND type = 'upload' AND utilise = 0 AND expire_le > ?").bind(jeton, Date.now()).run();
  if (!used.meta.changes) return new Response("Not found", { status: 404 });
  const row = await db.prepare("SELECT meta FROM jetons WHERE jeton = ?").bind(jeton).first();
  const meta = JSON.parse(row.meta || "{}");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > MAX_BYTES) return jsonErr(413, `Fichier trop gros (max ${MAX_FILE_MB} Mo).`);
  const ct = (request.headers.get("Content-Type") || "").split(";")[0].trim();
  const mime = ct && ct !== "application/octet-stream" && ct !== "application/x-www-form-urlencoded" ? ct : guessMime(meta.nom, false);
  const r = await storeFile(db, { name: meta.nom, mime, size: bytes.length, chunks: bytesToChunks(bytes), description: meta.description, memoryId: meta.souvenir_id, projet: meta.projet });
  return Response.json({ ok: true, id: r.id, nom: r.name, taille: r.size });
}

// ------------------------------------------------------------------ routage
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const secret = env.MEMORY_SECRET || "";
    if (secret.length < 24) return new Response("Configuration incomplète : secret MEMORY_SECRET manquant.", { status: 500 });
    if (!env.DB) return new Response("Configuration incomplète : base D1 « DB » non liée.", { status: 500 });
    const notFound = () => new Response("Not found", { status: 404 });
    const db = env.DB;

    // Interface d'administration (Cloudflare Access + vérification du jeton).
    if (parts[0] === "admin") {
      if (url.pathname.endsWith("/") && parts.length === 1) return Response.redirect(url.origin + "/admin", 301);
      return handleAdmin(request, env, url, parts);
    }

    // Liens par jeton (sans la clé secrète).
    if (parts.length === 2 && parts[0] === "dl") {
      if (request.method !== "GET") return notFound();
      await ensureSchema(db);
      const t = await db.prepare("SELECT fichier_id FROM jetons WHERE jeton = ? AND type = 'download' AND expire_le > ?").bind(parts[1], Date.now()).first();
      const f = t && await db.prepare("SELECT * FROM files WHERE id = ?").bind(t.fichier_id).first();
      return f ? downloadResponse(db, f) : notFound();
    }
    if (parts.length === 2 && parts[0] === "upload") {
      if (request.method !== "PUT") return notFound();
      await ensureSchema(db);
      return handlePutUpload(request, db, parts[1]);
    }

    // Connecteur MCP, protégé par la clé. L'ancienne page /<clé>/fichiers est supprimée : tout passe par /admin.
    if (parts.length !== 2 || parts[1] !== "mcp" || !timingSafeEqual(parts[0], secret)) return notFound();

    if (request.method === "GET") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

    let body;
    try { body = await request.json(); }
    catch { return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON invalide" } }, { status: 400 }); }

    const ctx = { origin: url.origin };
    const batch = Array.isArray(body);
    const replies = (await Promise.all((batch ? body : [body]).map((m) => handleRpc(m, env, ctx)))).filter(Boolean);
    if (!replies.length) return new Response(null, { status: 202 });
    return Response.json(batch ? replies : replies[0]);
  },
};
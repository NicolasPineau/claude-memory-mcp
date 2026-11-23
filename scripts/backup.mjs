// Sauvegarde hebdomadaire : export complet de la base D1, compressé, envoyé dans un bucket R2 privé (db/AAAA-MM-JJ.sql.gz),
// puis copie des fichiers joints pas encore sauvegardés (files/<id>, une seule fois par fichier : ils ne changent jamais).
// Lancé par .github/workflows/backup.yml. Ne journalise que des tailles et des noms de fichiers, jamais le contenu.
//
// Variables d'environnement :
//   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID  jeton (Analytics : lecture, D1 : modification, R2 : écriture) et compte
//   BACKUP_DATABASE   nom de la base D1 (défaut : memoire)
//   BACKUP_BUCKET     bucket R2 des sauvegardes (défaut : memoire-sauvegardes)
//   FILES_BUCKET      bucket R2 des fichiers (défaut : memoire-fichiers)
//   QUOTA_*           seuils de consommation (voir src/quota/limits.js)
//   BACKUP_FILES_KEEP_DAYS  jours de conservation de la copie d'un fichier supprimé (défaut : 60)
//   BACKUP_DRY_RUN=1  exporte et vérifie les seuils, sans rien envoyer
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { fetchUsage } from "../src/quota/analytics.js";
import { planPrune } from "./lib/prune.js";
import { thresholds } from "../src/quota/limits.js";

const env = process.env;
const DATABASE = env.BACKUP_DATABASE || "memoire";
const BUCKET = env.BACKUP_BUCKET || "memoire-sauvegardes";
const FILES_BUCKET = env.FILES_BUCKET || "memoire-fichiers";
const WHERE = env.BACKUP_LOCAL === "1" ? "--local" : "--remote";
const mo = (n) => (n / 1e6).toFixed(2) + " Mo";

// Tables exportées. L'export D1 ne gère pas les tables virtuelles (index FTS5) : l'index est reconstruit
// par les instructions ajoutées à la fin du fichier. Les jetons temporaires et le cache de consommation sont ignorés.
export const EXPORT_TABLES = ["groups", "projects", "memories", "tags", "memory_tags", "files", "file_chunks", "api_keys", "api_key_rules", "schema_meta", "backup_orphans"];
export const FTS_REBUILD = `
-- Index (non repris par l'export par table).
CREATE UNIQUE INDEX IF NOT EXISTS groups_sibling_name ON groups(COALESCE(parent_id, 0), name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS projects_group ON projects(group_id);
CREATE INDEX IF NOT EXISTS memories_group ON memories(group_id);
CREATE INDEX IF NOT EXISTS files_group ON files(group_id);
-- Index de recherche plein texte, reconstruit à partir des souvenirs (non exportable par D1).
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(title, content, tags, project, tokenize = 'unicode61 remove_diacritics 2');
DELETE FROM memories_fts;
INSERT INTO memories_fts(rowid, title, content, tags, project)
  SELECT m.id, m.title, m.content,
    COALESCE((SELECT group_concat(name, ' ') FROM (SELECT t.name FROM memory_tags mt JOIN tags t ON t.id = mt.tag_id WHERE mt.memory_id = m.id ORDER BY t.name)), ''),
    COALESCE(p.name, '')
  FROM memories m LEFT JOIN projects p ON p.id = m.project_id;
`;

function wrangler(args) {
  // stdout ignoré : wrangler n'y affiche que de la progression ; les erreurs passent par stderr.
  execFileSync("npx", ["wrangler", ...args], { stdio: ["ignore", "ignore", "inherit"], env });
}

function sql(command) {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", DATABASE, WHERE, "--json", "--command", command], { env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] });
  return JSON.parse(out.slice(out.indexOf("["))).flatMap((r) => r.results || []);
}

// Clés déjà présentes dans un bucket, sous un préfixe (API R2 de Cloudflare ; wrangler ne sait pas lister).
async function listKeys(bucket, prefix) {
  const keys = new Set();
  let cursor = "";
  do {
    const url = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${bucket}/objects?prefix=${encodeURIComponent(prefix)}&per_page=1000${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` } });
    const j = await res.json();
    if (!j.success) throw new Error(`liste du bucket ${bucket} : ${(j.errors || []).map((e) => e.message).join(" ; ") || res.status}`);
    for (const o of j.result || []) keys.add(o.key);
    cursor = j.result_info?.is_truncated ? j.result_info.cursor : "";
  } while (cursor);
  return keys;
}

if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) {
  console.log("::warning::Sauvegarde non configurée : ajoute les secrets CLOUDFLARE_API_TOKEN et CLOUDFLARE_ACCOUNT_ID au dépôt.");
  process.exit(0);
}

// 1. Consommation du compte : sans chiffres fiables, on n'écrit rien dans R2 (seul service facturable).
let usage;
try {
  usage = await fetchUsage({ accountId: env.CLOUDFLARE_ACCOUNT_ID, token: env.CLOUDFLARE_API_TOKEN });
} catch (e) {
  console.error(`Sauvegarde annulée : consommation non vérifiable (${e.message}).`);
  process.exit(1);
}
const lim = thresholds(env);
if (usage.r2_class_a_month + 1 > lim.r2_class_a_month) {
  console.error(`Sauvegarde annulée : opérations R2 classe A ${usage.r2_class_a_month} / ${lim.r2_class_a_month} ce mois-ci.`);
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "sauvegarde-"));
try {
  // 2. Export (schéma et données, fichiers joints compris) + reconstruction de l'index, puis compression.
  // Schéma puis données en deux exports : dans un export unique, Wrangler mélange tables et insertions
  // dans un ordre qui casse les clés étrangères à la réimportation.
  const schemaFile = join(dir, "schema.sql"), data = join(dir, "data.sql"), gz = join(dir, "export.sql.gz");
  const base = ["d1", "export", DATABASE, WHERE, "--table", ...EXPORT_TABLES];
  wrangler([...base, "--no-data", "--output", schemaFile]);
  wrangler([...base, "--no-schema", "--output", data]);
  const raw = Buffer.concat([readFileSync(schemaFile), Buffer.from("\n"), readFileSync(data), Buffer.from(FTS_REBUILD)]);
  if (!raw.length) throw new Error("export vide");
  const packed = gzipSync(raw, { level: 9 });
  writeFileSync(gz, packed);
  console.log(`Export : ${mo(raw.length)}, compressé : ${mo(packed.length)}.`);

  // 3. Le stockage R2 après envoi doit rester sous le seuil.
  const after = usage.r2_storage_gb + packed.length / 1e9;
  if (after > lim.r2_storage_gb) throw new Error(`annulée, le stockage R2 passerait à ${after.toFixed(3)} Go pour un seuil de ${lim.r2_storage_gb} Go.`);

  // 4. Envoi.
  const key = `db/${new Date().toISOString().slice(0, 10)}.sql.gz`;
  if (env.BACKUP_OUTPUT) {
    writeFileSync(env.BACKUP_OUTPUT, packed); // tests : garde le fichier au lieu de l'envoyer
    console.log(`Écrit dans ${env.BACKUP_OUTPUT}.`);
  } else if (env.BACKUP_DRY_RUN === "1") {
    console.log(`Essai à blanc : ${BUCKET}/${key} n'est pas envoyé.`);
  } else {
    wrangler(["r2", "object", "put", `${BUCKET}/${key}`, "--file", gz, "--content-type", "application/gzip", "--remote"]);
    console.log(`Sauvegarde envoyée : ${BUCKET}/${key}.`);
  }

  // 5. Fichiers joints : copie de ceux qui ne sont pas encore dans le bucket de sauvegarde.
  if (env.BACKUP_LOCAL !== "1") {
    const files = sql("SELECT id, size, mime FROM files WHERE storage = 'r2'");
    const saved = await listKeys(BUCKET, "files/");
    const missing = files.filter((f) => /^[a-f0-9]{12}$/.test(f.id) && !saved.has(`files/${f.id}`));
    const bytes = missing.reduce((n, f) => n + f.size, 0);
    console.log(`Fichiers joints : ${files.length} au total, ${missing.length} à copier (${mo(bytes)}).`);
    if (missing.length) {
      if (usage.r2_class_a_month + 1 + missing.length > lim.r2_class_a_month || usage.r2_class_b_month + missing.length > lim.r2_class_b_month || after + bytes / 1e9 > lim.r2_storage_gb)
        throw new Error("annulée pour les fichiers joints : la copie ferait dépasser un seuil R2 (l'export de la base, lui, est fait).");
      if (env.BACKUP_DRY_RUN === "1") {
        console.log("Essai à blanc : les fichiers ne sont pas copiés.");
      } else {
        let n = 0;
        for (const f of missing) {
          const tmp = join(dir, f.id);
          wrangler(["r2", "object", "get", `${FILES_BUCKET}/f/${f.id}`, "--file", tmp, "--remote"]);
          if (statSync(tmp).size !== f.size) throw new Error(`fichier ${f.id} : taille copiée différente de la taille attendue`);
          wrangler(["r2", "object", "put", `${BUCKET}/files/${f.id}`, "--file", tmp, "--content-type", f.mime || "application/octet-stream", "--remote"]);
          rmSync(tmp, { force: true });
          n++;
        }
        console.log(`${n} fichier(s) copié(s).`);
      }
    }

    // 6. Copies de fichiers supprimés : notées à leur première détection, effacées après BACKUP_FILES_KEEP_DAYS jours.
    const keepDays = Number(env.BACKUP_FILES_KEEP_DAYS) > 0 ? Number(env.BACKUP_FILES_KEEP_DAYS) : 60;
    // La table est aussi créée par le Worker à sa première requête : on ne dépend pas de l'ordre des déploiements.
    sql("CREATE TABLE IF NOT EXISTS backup_orphans (id TEXT PRIMARY KEY, since INTEGER NOT NULL)");
    const plan = planPrune({ keys: saved, fileIds: files.map((f) => f.id), orphans: sql("SELECT id, since FROM backup_orphans"), keepDays });
    console.log(`Copies de fichiers supprimés : ${plan.toRecord.length} nouvelle(s), ${plan.toDelete.length} à effacer (plus de ${keepDays} jours).`);
    if (env.BACKUP_DRY_RUN !== "1") {
      for (const id of plan.toDelete) wrangler(["r2", "object", "delete", `${BUCKET}/files/${id}`, "--remote"]); // gratuit dans R2
      const stmts = [
        ...plan.toRecord.map((id) => `INSERT OR IGNORE INTO backup_orphans(id, since) VALUES ('${id}', ${Date.now()});`),
        ...plan.toForget.map((id) => `DELETE FROM backup_orphans WHERE id = '${id}';`),
      ];
      for (let i = 0; i < stmts.length; i += 50) sql(stmts.slice(i, i + 50).join(" "));
    }
  }
} catch (e) {
  console.error(`Sauvegarde ${e.message.startsWith("annulée") ? "" : "en échec : "}${e.message}`);
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}

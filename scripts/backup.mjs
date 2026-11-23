// Sauvegarde hebdomadaire : export complet de la base D1, compressé, envoyé dans un bucket R2 privé.
// Lancé par .github/workflows/backup.yml. Ne journalise que des tailles et des noms de fichiers, jamais le contenu.
//
// Variables d'environnement :
//   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID  jeton (Analytics : lecture, D1 : modification, R2 : écriture) et compte
//   BACKUP_DATABASE   nom de la base D1 (défaut : memoire)
//   BACKUP_BUCKET     bucket R2 (défaut : memoire-sauvegardes)
//   QUOTA_*           seuils de consommation (voir src/quota/limits.js)
//   BACKUP_DRY_RUN=1  exporte et vérifie les seuils, sans rien envoyer
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { fetchUsage } from "../src/quota/analytics.js";
import { thresholds } from "../src/quota/limits.js";

const env = process.env;
const DATABASE = env.BACKUP_DATABASE || "memoire";
const BUCKET = env.BACKUP_BUCKET || "memoire-sauvegardes";
const mo = (n) => (n / 1e6).toFixed(2) + " Mo";

// Tables exportées. L'export D1 ne gère pas les tables virtuelles (index FTS5) : l'index est reconstruit
// par les instructions ajoutées à la fin du fichier. Les jetons temporaires et le cache de consommation sont ignorés.
export const EXPORT_TABLES = ["groups", "projects", "memories", "tags", "memory_tags", "files", "file_chunks", "api_keys", "api_key_rules", "schema_meta"];
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
  const schema = join(dir, "schema.sql"), data = join(dir, "data.sql"), gz = join(dir, "export.sql.gz");
  const base = ["d1", "export", DATABASE, env.BACKUP_LOCAL === "1" ? "--local" : "--remote", "--table", ...EXPORT_TABLES];
  wrangler([...base, "--no-data", "--output", schema]);
  wrangler([...base, "--no-schema", "--output", data]);
  const raw = Buffer.concat([readFileSync(schema), Buffer.from("\n"), readFileSync(data), Buffer.from(FTS_REBUILD)]);
  if (!raw.length) throw new Error("export vide");
  const packed = gzipSync(raw, { level: 9 });
  writeFileSync(gz, packed);
  console.log(`Export : ${mo(raw.length)}, compressé : ${mo(packed.length)}.`);

  // 3. Le stockage R2 après envoi doit rester sous le seuil.
  const after = usage.r2_storage_gb + packed.length / 1e9;
  if (after > lim.r2_storage_gb) throw new Error(`annulée, le stockage R2 passerait à ${after.toFixed(3)} Go pour un seuil de ${lim.r2_storage_gb} Go.`);

  // 4. Envoi.
  const key = `${new Date().toISOString().slice(0, 10)}.sql.gz`;
  if (env.BACKUP_OUTPUT) {
    writeFileSync(env.BACKUP_OUTPUT, packed); // tests : garde le fichier au lieu de l'envoyer
    console.log(`Écrit dans ${env.BACKUP_OUTPUT}.`);
  } else if (env.BACKUP_DRY_RUN === "1") {
    console.log(`Essai à blanc : ${BUCKET}/${key} n'est pas envoyé.`);
  } else {
    wrangler(["r2", "object", "put", `${BUCKET}/${key}`, "--file", gz, "--content-type", "application/gzip", "--remote"]);
    console.log(`Sauvegarde envoyée : ${BUCKET}/${key}.`);
  }
} catch (e) {
  console.error(`Sauvegarde ${e.message.startsWith("annulée") ? "" : "en échec : "}${e.message}`);
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}

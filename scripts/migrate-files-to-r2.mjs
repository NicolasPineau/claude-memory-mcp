// Migration des fichiers joints de D1 (morceaux base64 dans file_chunks) vers le bucket R2 des fichiers.
// Lancée à la main par .github/workflows/migrate-files.yml. Idempotente : on peut la relancer après une interruption.
// Le Worker ne peut pas le faire lui-même : décoder des Mo de base64 dépasse ses 10 ms de CPU (plan gratuit).
// Ne journalise que des identifiants et des tailles, jamais les noms ni le contenu des fichiers.
//
// Variables d'environnement :
//   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID  jeton (Analytics : lecture, D1 : modification, R2 : écriture) et compte
//   BACKUP_DATABASE   nom de la base D1 (défaut : memoire)
//   FILES_BUCKET      bucket R2 des fichiers (défaut : memoire-fichiers)
//   QUOTA_*           seuils de consommation (voir src/quota/limits.js)
//   MIGRATE_DRY_RUN=1 liste ce qui serait migré, sans rien modifier
//   MIGRATE_LOCAL=1   travaille sur la base et le bucket locaux de wrangler (tests)
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchUsage } from "../src/quota/analytics.js";
import { thresholds } from "../src/quota/limits.js";

const env = process.env;
const DATABASE = env.BACKUP_DATABASE || "memoire";
const BUCKET = env.FILES_BUCKET || "memoire-fichiers";
const WHERE = env.MIGRATE_LOCAL === "1" ? "--local" : "--remote";
const mo = (n) => (n / 1e6).toFixed(2) + " Mo";

// Requête SQL via wrangler, résultat en JSON (rien n'est affiché).
function sql(command) {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", DATABASE, WHERE, "--json", "--command", command], { env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] });
  const json = JSON.parse(out.slice(out.indexOf("[")));
  return json.flatMap((r) => r.results || []);
}

function putObject(key, file, mime) {
  execFileSync("npx", ["wrangler", "r2", "object", "put", `${BUCKET}/${key}`, "--file", file, "--content-type", mime || "application/octet-stream", WHERE], { env, stdio: ["ignore", "ignore", "inherit"] });
}

if (env.MIGRATE_LOCAL !== "1" && (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID)) {
  console.error("Migration impossible : secrets CLOUDFLARE_API_TOKEN et CLOUDFLARE_ACCOUNT_ID manquants.");
  process.exit(1);
}

const todo = sql("SELECT id, mime, size FROM files WHERE storage = 'd1' ORDER BY size");
const total = todo.reduce((n, f) => n + f.size, 0);
console.log(`${todo.length} fichier(s) à migrer, ${mo(total)} au total.`);
if (!todo.length) process.exit(0);

// Garde-fous R2 : une écriture (classe A) par fichier, et le stockage après migration.
if (env.MIGRATE_LOCAL !== "1") {
  let usage;
  try {
    usage = await fetchUsage({ accountId: env.CLOUDFLARE_ACCOUNT_ID, token: env.CLOUDFLARE_API_TOKEN });
  } catch (e) {
    console.error(`Migration annulée : consommation non vérifiable (${e.message}).`);
    process.exit(1);
  }
  const lim = thresholds(env);
  if (usage.r2_class_a_month + todo.length > lim.r2_class_a_month || usage.r2_storage_gb + total / 1e9 > lim.r2_storage_gb) {
    console.error(`Migration annulée : elle ferait dépasser un seuil R2 (stockage ${usage.r2_storage_gb.toFixed(3)} Go + ${(total / 1e9).toFixed(3)} Go, seuil ${lim.r2_storage_gb} Go ; classe A ${usage.r2_class_a_month} + ${todo.length}, seuil ${lim.r2_class_a_month}).`);
    process.exit(1);
  }
}
if (env.MIGRATE_DRY_RUN === "1") {
  console.log("Essai à blanc : rien n'est modifié.");
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), "migration-"));
let done = 0, failed = 0;
try {
  for (const f of todo) {
    if (!/^[a-f0-9]{12}$/.test(f.id)) { console.error(`Identifiant inattendu, ignoré : ${f.id}`); failed++; continue; }
    try {
      const chunks = sql(`SELECT data FROM file_chunks WHERE file_id = '${f.id}' ORDER BY idx`);
      const bytes = Buffer.concat(chunks.map((c) => Buffer.from(c.data || "", "base64")));
      if (bytes.length !== f.size) throw new Error(`taille lue ${bytes.length} ≠ taille attendue ${f.size}`);
      const file = join(dir, f.id);
      writeFileSync(file, bytes);
      putObject(`f/${f.id}`, file, f.mime);
      // Le contenu n'est retiré de D1 qu'une fois l'objet écrit dans R2.
      sql(`UPDATE files SET storage = 'r2' WHERE id = '${f.id}'; DELETE FROM file_chunks WHERE file_id = '${f.id}';`);
      rmSync(file, { force: true });
      done++;
      console.log(`✓ ${f.id} (${mo(f.size)}) — ${done}/${todo.length}`);
    } catch (e) {
      failed++;
      console.error(`✗ ${f.id} : ${e.message}`);
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`Terminé : ${done} migré(s), ${failed} en échec.`);
if (failed) process.exitCode = 1;

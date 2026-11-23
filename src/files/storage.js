import { CHUNK_BYTES, MAX_BYTES, MAX_FILE_MB } from "../config.js";
import { defaultRootGroupId } from "../db/groups.js";
import { findProject, touchProject } from "../db/memories.js";
import { b64ToBytes, bytesToB64, guessMime, jsonErr, now, randomToken } from "../util.js";

// ------------------------------------------------------------------ stockage des fichiers
// Le contenu des fichiers est dans le bucket R2 lié en FILES (objet f/<id>), sans encodage.
// Les fichiers d'avant la v4 peuvent encore être dans D1 (morceaux base64 de file_chunks, storage = 'd1') :
// ils restent lisibles jusqu'à leur migration (scripts/migrate-files-to-r2.mjs).
export const r2Key = (id) => `f/${id}`;

export function bytesToChunks(bytes) {
  const chunks = [];
  for (let i = 0; i < bytes.length; i += CHUNK_BYTES) chunks.push(bytesToB64(bytes.subarray(i, i + CHUNK_BYTES)));
  return chunks;
}

// Enregistre un fichier dans un groupe, avec projet et souvenir facultatifs.
// Sans bucket lié (déploiement incomplet), il est rangé dans D1 comme avant la v4.
export async function storeFile(db, bucket, { name, mime, bytes, description = "", memoryId = null, projectId = null, groupId }) {
  if (!groupId) throw new Error("groupe manquant pour le fichier");
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const pid = projectId || null;
  const storage = bucket ? "r2" : "d1";
  if (bucket) await bucket.put(r2Key(id), bytes, { httpMetadata: { contentType: mime } });
  const stmts = [db.prepare("INSERT INTO files(id, filename, mime, size, description, memory_id, project_id, group_id, storage, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .bind(id, name, mime, bytes.length, String(description || ""), memoryId || null, pid, groupId, storage, now())];
  if (!bucket) {
    const chunks = bytes.length ? bytesToChunks(bytes) : [""];
    chunks.forEach((data, k) => stmts.push(db.prepare("INSERT INTO file_chunks(file_id, idx, data) VALUES (?,?,?)").bind(id, k, data)));
  }
  try {
    await db.batch(stmts);
  } catch (e) {
    if (bucket) await bucket.delete(r2Key(id)); // pas d'objet orphelin dans R2
    throw e;
  }
  await touchProject(db, pid);
  return { id, name, size: bytes.length };
}

function d1Stream(db, fileId) {
  let idx = 0;
  return new ReadableStream({
    async pull(ctrl) {
      const row = await db.prepare("SELECT data FROM file_chunks WHERE file_id = ? AND idx = ?").bind(fileId, idx++).first();
      if (!row) return ctrl.close();
      if (row.data) ctrl.enqueue(b64ToBytes(row.data));
    },
  });
}

// Contenu d'un fichier en flux, ou null s'il est introuvable.
export async function fileStream(db, bucket, f) {
  if (f.storage !== "r2") return d1Stream(db, f.id);
  if (!bucket) throw new Error("bucket de fichiers non lié (binding FILES)");
  const obj = await bucket.get(r2Key(f.id));
  return obj ? obj.body : null;
}

// Contenu complet d'un fichier (réservé aux petits fichiers).
export async function fileBytes(db, bucket, f) {
  if (f.storage === "r2") {
    if (!bucket) throw new Error("bucket de fichiers non lié (binding FILES)");
    const obj = await bucket.get(r2Key(f.id));
    return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
  }
  const chunks = (await db.prepare("SELECT data FROM file_chunks WHERE file_id = ? ORDER BY idx").bind(f.id).all()).results;
  return b64ToBytes(chunks.map((c) => c.data).join(""));
}

// Types qui peuvent exécuter du code s'ils sont ouverts dans le navigateur : toujours téléchargés.
const ACTIVE_TYPES = /html|svg|xml|javascript|ecmascript/i;

export async function downloadResponse(db, bucket, f, { inline = false } = {}) {
  const body = await fileStream(db, bucket, f);
  if (!body) return new Response("Not found", { status: 404 });
  const disposition = inline && !ACTIVE_TYPES.test(f.mime) ? "inline" : "attachment";
  return new Response(body, {
    headers: {
      "Content-Type": f.mime,
      "Content-Length": String(f.size),
      "Content-Disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(f.filename)}`,
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function createToken(db, type, { fichierId = null, meta = null, ttl }) {
  const t = randomToken(), exp = Date.now() + ttl;
  await db.batch([
    db.prepare("DELETE FROM jetons WHERE expire_le < ?").bind(Date.now()),
    db.prepare("INSERT INTO jetons(jeton, type, fichier_id, meta, expire_le) VALUES (?,?,?,?,?)").bind(t, type, fichierId, meta ? JSON.stringify(meta) : null, exp),
  ]);
  return { jeton: t, expire_le: new Date(exp).toISOString() };
}

export async function deleteFile(db, bucket, id) {
  const f = await db.prepare("SELECT id, filename, size, storage FROM files WHERE id = ?").bind(id).first();
  if (!f) return null;
  await db.batch([
    db.prepare("DELETE FROM file_chunks WHERE file_id = ?").bind(f.id),
    db.prepare("DELETE FROM jetons WHERE fichier_id = ?").bind(f.id),
    db.prepare("DELETE FROM files WHERE id = ?").bind(f.id),
  ]);
  if (f.storage === "r2" && bucket) await bucket.delete(r2Key(f.id)); // suppression gratuite dans R2
  return f;
}

// ------------------------------------------------------------------ envoi par lien à usage unique (curl -T)
export async function handlePutUpload(request, db, bucket, jeton) {
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
  // Le rangement (groupe, projet) est fixé et vérifié à la création du lien. Les liens créés avant la v3 n'ont qu'un nom de projet.
  let { group_id: groupId, project_id: projectId } = meta;
  if (!groupId) {
    const p = await findProject(db, meta.projet);
    projectId = p ? p.id : null;
    groupId = p ? p.group_id : await defaultRootGroupId(db);
  }
  const r = await storeFile(db, bucket, { name: meta.nom, mime, bytes, description: meta.description, memoryId: meta.souvenir_id, projectId, groupId });
  return Response.json({ ok: true, id: r.id, nom: r.name, taille: r.size });
}

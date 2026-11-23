import { CHUNK_BYTES, MAX_BYTES, MAX_FILE_MB } from "../config.js";
import { getOrCreateProject, touchProject } from "../db/memories.js";
import { b64ToBytes, bytesToB64, guessMime, jsonErr, now, randomToken } from "../util.js";

// ------------------------------------------------------------------ stockage des fichiers
// Enregistre un fichier (morceaux base64 déjà découpés). `projectId` prime sur `projet` (nom).
export async function storeFile(db, { name, mime, size, chunks, description = "", memoryId = null, projet = null, projectId = null }) {
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

export function bytesToChunks(bytes) {
  const chunks = [];
  for (let i = 0; i < bytes.length; i += CHUNK_BYTES) chunks.push(bytesToB64(bytes.subarray(i, i + CHUNK_BYTES)));
  return chunks;
}

export function fileStream(db, fileId) {
  let idx = 0;
  return new ReadableStream({
    async pull(ctrl) {
      const row = await db.prepare("SELECT data FROM file_chunks WHERE file_id = ? AND idx = ?").bind(fileId, idx++).first();
      if (!row) return ctrl.close();
      if (row.data) ctrl.enqueue(b64ToBytes(row.data));
    },
  });
}

export function downloadResponse(db, f) {
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

export async function createToken(db, type, { fichierId = null, meta = null, ttl }) {
  const t = randomToken(), exp = Date.now() + ttl;
  await db.batch([
    db.prepare("DELETE FROM jetons WHERE expire_le < ?").bind(Date.now()),
    db.prepare("INSERT INTO jetons(jeton, type, fichier_id, meta, expire_le) VALUES (?,?,?,?,?)").bind(t, type, fichierId, meta ? JSON.stringify(meta) : null, exp),
  ]);
  return { jeton: t, expire_le: new Date(exp).toISOString() };
}

export async function deleteFile(db, id) {
  const f = await db.prepare("SELECT id, filename FROM files WHERE id = ?").bind(id).first();
  if (!f) return null;
  await db.batch([
    db.prepare("DELETE FROM file_chunks WHERE file_id = ?").bind(f.id),
    db.prepare("DELETE FROM jetons WHERE fichier_id = ?").bind(f.id),
    db.prepare("DELETE FROM files WHERE id = ?").bind(f.id),
  ]);
  return f;
}

// ------------------------------------------------------------------ envoi par lien à usage unique (curl -T)
export async function handlePutUpload(request, db, jeton) {
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

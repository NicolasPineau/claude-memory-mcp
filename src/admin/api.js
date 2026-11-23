import { MAX_BYTES, MAX_FILE_MB, STATUTS } from "../config.js";
import { deleteMemory, ftsQuery, reindex, reindexProject, setTags, touchProject } from "../db/memories.js";
import { bytesToChunks, deleteFile, storeFile } from "../files/storage.js";
import { cleanName, guessMime, jsonOk, normTags, now } from "../util.js";

export const likeArg = (q) => `%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`;

export async function tagsByMemory(db, ids) {
  const map = {};
  if (!ids.length) return map;
  const rows = (await db.prepare(`SELECT mt.memory_id, t.name FROM memory_tags mt JOIN tags t ON t.id = mt.tag_id WHERE mt.memory_id IN (${ids.map(() => "?").join(",")}) ORDER BY t.name`).bind(...ids).all()).results;
  for (const r of rows) (map[r.memory_id] ||= []).push(r.name);
  return map;
}

export async function projectIdFrom(db, v) {
  if (v === null || v === "" || v === undefined || Number(v) === 0) return null;
  const p = await db.prepare("SELECT id FROM projects WHERE id = ?").bind(Number(v)).first();
  if (!p) throw new ApiError(404, "Projet introuvable.");
  return p.id;
}

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function readJson(request) {
  try { return await request.json(); }
  catch { throw new ApiError(400, "JSON invalide."); }
}

export async function adminApi(request, db, path, url) {
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

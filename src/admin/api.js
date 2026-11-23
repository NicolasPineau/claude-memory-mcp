import { MAX_BYTES, MAX_FILE_MB, STATUTS } from "../config.js";
import { generateKey, masterKeyEnabled, sha256hex } from "../auth/keys.js";
import { ACCESS, MAX_DEPTH, effectiveRights, loadGroups } from "../db/groups.js";
import { deleteMemory, ftsQuery, moveProject, reindex, reindexProject, setTags, syncMemoryFiles, touchProject } from "../db/memories.js";
import { deleteFile, storeFile } from "../files/storage.js";
import { cleanName, guessMime, jsonOk, normTags, now } from "../util.js";

export const likeArg = (q) => `%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`;

export async function tagsByMemory(db, ids) {
  const map = {};
  if (!ids.length) return map;
  const rows = (await db.prepare(`SELECT mt.memory_id, t.name FROM memory_tags mt JOIN tags t ON t.id = mt.tag_id WHERE mt.memory_id IN (${ids.map(() => "?").join(",")}) ORDER BY t.name`).bind(...ids).all()).results;
  for (const r of rows) (map[r.memory_id] ||= []).push(r.name);
  return map;
}

export async function projectFrom(db, v) {
  if (v === null || v === "" || v === undefined || Number(v) === 0) return null;
  const p = await db.prepare("SELECT id, group_id FROM projects WHERE id = ?").bind(Number(v)).first();
  if (!p) throw new ApiError(404, "Projet introuvable.");
  return p;
}

export async function groupIdFrom(db, v, required = true) {
  if (v === null || v === "" || v === undefined || Number(v) === 0) {
    if (required) throw new ApiError(400, "Le groupe est obligatoire.");
    return null;
  }
  const g = await db.prepare("SELECT id FROM groups WHERE id = ?").bind(Number(v)).first();
  if (!g) throw new ApiError(404, "Groupe introuvable.");
  return g.id;
}

// Rangement d'un élément : le groupe de son projet, sinon le groupe donné (obligatoire sans projet).
async function placementFrom(db, projetId, groupId) {
  const p = await projectFrom(db, projetId);
  if (p) return { projectId: p.id, groupId: p.group_id };
  return { projectId: null, groupId: await groupIdFrom(db, groupId) };
}

// Règles d'une clé : { group_id: "rw" | "ro" | "none" }, les groupes absents héritent de leur parent.
async function rulesFrom(db, regles) {
  const out = new Map();
  for (const [gid, acc] of Object.entries(regles || {})) {
    if (!acc) continue;
    if (!ACCESS.includes(acc)) throw new ApiError(400, `Droit invalide : ${acc}.`);
    out.set(await groupIdFrom(db, gid), acc);
  }
  return out;
}

async function checkDefaultGroup(db, defaultGroupId, rules) {
  const tree = await loadGroups(db);
  if (effectiveRights(tree, rules).get(defaultGroupId) !== "rw")
    throw new ApiError(400, "Le groupe par défaut doit être en lecture-écriture pour cette clé.");
}

const ruleStmts = (db, keyId, rules) => [
  db.prepare("DELETE FROM api_key_rules WHERE key_id = ?").bind(keyId),
  ...[...rules].map(([gid, acc]) => db.prepare("INSERT INTO api_key_rules(key_id, group_id, access) VALUES (?,?,?)").bind(keyId, gid, acc)),
];

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function readJson(request) {
  try { return await request.json(); }
  catch { throw new ApiError(400, "JSON invalide."); }
}

// Sauvegardes présentes dans le bucket R2 lié (binding BACKUPS), les plus récentes d'abord.
export async function listBackups(env) {
  if (!env.BACKUPS) return null;
  const out = [];
  let cursor;
  do {
    const page = await env.BACKUPS.list({ prefix: "db/", cursor, limit: 1000 });
    out.push(...page.objects.map((o) => ({ nom: o.key, taille: o.size, date: o.uploaded instanceof Date ? o.uploaded.toISOString() : String(o.uploaded) })));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out.sort((a, b) => b.nom.localeCompare(a.nom));
}

export async function adminApi(request, db, path, url, env = {}, quota = null) {
  const m = request.method;
  const [res, idRaw] = path;
  const id = idRaw;

  // --- consommation et sauvegardes
  if (res === "conso" && !id && m === "GET") {
    return jsonOk({
      configure: quota?.configured ?? false,
      verifie_le: quota?.verifiedAt ? new Date(quota.verifiedAt).toISOString() : null,
      erreur: quota?.error ?? null,
      metriques: quota?.rows ?? [],
      bloque: (quota?.blocked ?? []).map((r) => r.metric),
      sauvegardes: quota?.blocked.length ? null : await listBackups(env),
    });
  }

  // --- groupes
  if (res === "groupes" && !id && m === "GET") {
    const tree = await loadGroups(db);
    const count = async (sql) => new Map((await db.prepare(sql).all()).results.map((r) => [r.group_id, r.n]));
    const np = await count("SELECT group_id, COUNT(*) n FROM projects GROUP BY group_id");
    const nm = await count("SELECT group_id, COUNT(*) n FROM memories GROUP BY group_id");
    const nf = await count("SELECT group_id, COUNT(*) n FROM files GROUP BY group_id");
    const groupes = tree.ordered().map((g) => ({ id: g.id, parent_id: g.parent_id, nom: g.name, description: g.description, chemin: g.path, niveau: g.depth,
      hauteur: tree.height(g.id), n_projets: np.get(g.id) || 0, n_souvenirs: nm.get(g.id) || 0, n_fichiers: nf.get(g.id) || 0, n_enfants: (tree.children.get(g.id) || []).length }));
    return jsonOk({ groupes, profondeur_max: MAX_DEPTH });
  }
  if (res === "groupes" && !id && m === "POST") {
    const b = await readJson(request);
    const nom = String(b.nom || "").trim();
    if (!nom || /[\/›]/.test(nom)) throw new ApiError(400, "Nom de groupe invalide (obligatoire, sans « / » ni « › »).");
    const parent = await groupIdFrom(db, b.parent_id, false);
    if (parent && (await loadGroups(db)).depth(parent) >= MAX_DEPTH) throw new ApiError(400, `Profondeur maximale : ${MAX_DEPTH} niveaux.`);
    const ts = now();
    try {
      const r = await db.prepare("INSERT INTO groups(parent_id, name, description, created_at, updated_at) VALUES (?,?,?,?,?)").bind(parent, nom, String(b.description || ""), ts, ts).run();
      return jsonOk({ ok: true, id: r.meta.last_row_id });
    } catch (e) {
      throw new ApiError(409, `Un groupe « ${nom} » existe déjà à cet endroit.`);
    }
  }
  if (res === "groupes" && id && m === "PATCH") {
    const tree = await loadGroups(db);
    const g = tree.get(id);
    if (!g) throw new ApiError(404, "Groupe introuvable.");
    const b = await readJson(request);
    const nom = b.nom != null ? String(b.nom).trim() : g.name;
    if (!nom || /[\/›]/.test(nom)) throw new ApiError(400, "Nom de groupe invalide (obligatoire, sans « / » ni « › »).");
    let parent = g.parent_id;
    if ("parent_id" in b) {
      parent = await groupIdFrom(db, b.parent_id, false);
      if (parent && tree.descendants(g.id).includes(parent)) throw new ApiError(400, "Un groupe ne peut pas être déplacé sous lui-même ou sous un de ses sous-groupes.");
      if ((parent ? tree.depth(parent) : 0) + tree.height(g.id) > MAX_DEPTH) throw new ApiError(400, `Profondeur maximale : ${MAX_DEPTH} niveaux.`);
    }
    try {
      await db.prepare("UPDATE groups SET name=?, description=?, parent_id=?, updated_at=? WHERE id=?")
        .bind(nom, b.description != null ? String(b.description) : g.description, parent, now(), g.id).run();
    } catch (e) {
      throw new ApiError(409, `Un groupe « ${nom} » existe déjà à cet endroit.`);
    }
    return jsonOk({ ok: true });
  }
  if (res === "groupes" && id && m === "DELETE") {
    const gid = Number(id);
    const u = await db.prepare("SELECT (SELECT COUNT(*) FROM groups WHERE parent_id = ?1) + (SELECT COUNT(*) FROM projects WHERE group_id = ?1) + (SELECT COUNT(*) FROM memories WHERE group_id = ?1) + (SELECT COUNT(*) FROM files WHERE group_id = ?1) AS n, (SELECT COUNT(*) FROM api_keys WHERE default_group_id = ?1 AND revoked_at IS NULL) AS k").bind(gid).first();
    if (u.n) throw new ApiError(409, "Ce groupe n'est pas vide : déplace d'abord ses sous-groupes, projets, souvenirs et fichiers.");
    if (u.k) throw new ApiError(409, "Ce groupe est le groupe par défaut d'une clé : change-le d'abord.");
    const r = await db.batch([
      db.prepare("DELETE FROM api_key_rules WHERE group_id = ?").bind(gid),
      db.prepare("DELETE FROM groups WHERE id = ?").bind(gid),
    ]);
    if (!r[1].meta.changes) throw new ApiError(404, "Groupe introuvable.");
    return jsonOk({ ok: true });
  }

  // --- clés d'accès (une par compte Claude)
  if (res === "cles" && !id && m === "GET") {
    const keys = (await db.prepare("SELECT id, name, default_group_id, created_at, last_used_at, revoked_at FROM api_keys ORDER BY revoked_at IS NOT NULL, created_at").all()).results;
    const rules = (await db.prepare("SELECT key_id, group_id, access FROM api_key_rules").all()).results;
    for (const k of keys) k.regles = Object.fromEntries(rules.filter((r) => r.key_id === k.id).map((r) => [r.group_id, r.access]));
    return jsonOk({ cles: keys, cle_maitresse_active: masterKeyEnabled(env) });
  }
  if (res === "cles" && !id && m === "POST") {
    const b = await readJson(request);
    const nom = String(b.nom || "").trim();
    if (!nom) throw new ApiError(400, "Le nom est obligatoire.");
    const def = await groupIdFrom(db, b.groupe_defaut_id);
    const rules = await rulesFrom(db, b.regles);
    await checkDefaultGroup(db, def, rules);
    const key = generateKey();
    const r = await db.prepare("INSERT INTO api_keys(name, key_hash, default_group_id, created_at) VALUES (?,?,?,?)").bind(nom, await sha256hex(key), def, now()).run();
    const kid = r.meta.last_row_id;
    await db.batch(ruleStmts(db, kid, rules));
    return jsonOk({ ok: true, id: kid, cle: key, url: `${url.origin}/${key}/mcp` });
  }
  if (res === "cles" && id && m === "PATCH") {
    const k = await db.prepare("SELECT * FROM api_keys WHERE id = ?").bind(Number(id)).first();
    if (!k) throw new ApiError(404, "Clé introuvable.");
    if (k.revoked_at) throw new ApiError(409, "Cette clé est révoquée.");
    const b = await readJson(request);
    const nom = b.nom != null ? String(b.nom).trim() : k.name;
    if (!nom) throw new ApiError(400, "Le nom ne peut pas être vide.");
    const def = b.groupe_defaut_id != null ? await groupIdFrom(db, b.groupe_defaut_id) : k.default_group_id;
    const rules = b.regles != null ? await rulesFrom(db, b.regles)
      : new Map((await db.prepare("SELECT group_id, access FROM api_key_rules WHERE key_id = ?").bind(k.id).all()).results.map((r) => [r.group_id, r.access]));
    await checkDefaultGroup(db, def, rules);
    await db.batch([db.prepare("UPDATE api_keys SET name = ?, default_group_id = ? WHERE id = ?").bind(nom, def, k.id), ...ruleStmts(db, k.id, rules)]);
    return jsonOk({ ok: true });
  }
  if (res === "cles" && id && m === "DELETE") {
    const r = await db.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(now(), Number(id)).run();
    if (!r.meta.changes) throw new ApiError(404, "Clé introuvable ou déjà révoquée.");
    return jsonOk({ ok: true });
  }

  // --- projets
  if (res === "projets" && !id && m === "GET") {
    const rows = (await db.prepare("SELECT p.*, (SELECT COUNT(*) FROM memories WHERE project_id = p.id) AS n_souvenirs, (SELECT COUNT(*) FROM files WHERE project_id = p.id) AS n_fichiers FROM projects p ORDER BY p.status = 'archive', p.updated_at DESC").all()).results;
    const orphans = (await db.prepare("SELECT g.id AS group_id, (SELECT COUNT(*) FROM memories WHERE project_id IS NULL AND group_id = g.id) AS n_souvenirs, (SELECT COUNT(*) FROM files WHERE project_id IS NULL AND group_id = g.id) AS n_fichiers FROM groups g").all()).results
      .filter((o) => o.n_souvenirs || o.n_fichiers);
    return jsonOk({ projets: rows, sans_projet: orphans });
  }
  if (res === "projets" && !id && m === "POST") {
    const b = await readJson(request);
    const nom = String(b.nom || "").trim();
    if (!nom) throw new ApiError(400, "Le nom est obligatoire.");
    if (await db.prepare("SELECT 1 FROM projects WHERE name = ?").bind(nom).first()) throw new ApiError(409, `Un projet « ${nom} » existe déjà.`);
    const gid = await groupIdFrom(db, b.groupe_id);
    const statut = STATUTS.includes(b.statut) ? b.statut : "actif", ts = now();
    const r = await db.prepare("INSERT INTO projects(name, description, status, group_id, created_at, updated_at) VALUES (?,?,?,?,?,?)").bind(nom, String(b.description || ""), statut, gid, ts, ts).run();
    return jsonOk({ ok: true, id: r.meta.last_row_id });
  }
  if (res === "projets" && id && m === "GET") {
    const pid = Number(id);
    let projet = null;
    if (pid) {
      projet = await db.prepare("SELECT * FROM projects WHERE id = ?").bind(pid).first();
      if (!projet) throw new ApiError(404, "Projet introuvable.");
    }
    const gid = pid ? null : await groupIdFrom(db, url.searchParams.get("groupe"), false);
    const cond = pid ? "project_id = ?" : "project_id IS NULL" + (gid ? " AND group_id = ?" : "");
    const args = pid ? [pid] : gid ? [gid] : [];
    const souvenirs = (await db.prepare(`SELECT id, title, content, kind, source, group_id, project_id, created_at, updated_at FROM memories WHERE ${cond} ORDER BY updated_at DESC`).bind(...args).all()).results;
    const tags = await tagsByMemory(db, souvenirs.map((s) => s.id));
    for (const s of souvenirs) s.tags = tags[s.id] || [];
    const fichiers = (await db.prepare(`SELECT id, filename, mime, size, description, memory_id, project_id, group_id, created_at FROM files WHERE ${cond} ORDER BY created_at DESC`).bind(...args).all()).results;
    return jsonOk({ projet, groupe_id: projet ? projet.group_id : gid, souvenirs, fichiers });
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
    const gid = b.groupe_id != null ? await groupIdFrom(db, b.groupe_id) : r.group_id;
    await db.prepare("UPDATE projects SET name=?, description=?, status=?, updated_at=? WHERE id=?")
      .bind(nom, b.description != null ? String(b.description) : r.description, statut, now(), pid).run();
    if (gid !== r.group_id) await moveProject(db, pid, gid);
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
    const { projectId: pid, groupId } = await placementFrom(db, b.projet_id, b.groupe_id), ts = now();
    const r = await db.prepare("INSERT INTO memories(title, content, kind, project_id, group_id, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)")
      .bind(titre, contenu, String(b.type || "note").trim() || "note", pid, groupId, "interface web", ts, ts).run();
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
    const place = "projet_id" in b ? await placementFrom(db, b.projet_id, b.groupe_id ?? r.group_id) : { projectId: r.project_id, groupId: r.group_id };
    const pid = place.projectId;
    await db.prepare("UPDATE memories SET title=?, content=?, kind=?, project_id=?, group_id=?, updated_at=? WHERE id=?")
      .bind(titre, contenu, b.type ? String(b.type).trim() : r.kind, pid, place.groupId, now(), r.id).run();
    if (place.groupId !== r.group_id) await syncMemoryFiles(db, r.id, place.groupId);
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
  if (res === "fichiers" && !id && m === "GET") {
    const rows = (await db.prepare("SELECT f.id, f.filename, f.mime, f.size, f.description, f.memory_id, f.project_id, f.group_id, f.storage, f.created_at, p.name AS projet FROM files f LEFT JOIN projects p ON p.id = f.project_id ORDER BY f.size DESC").all()).results;
    return jsonOk({ fichiers: rows });
  }
  if (res === "fichiers" && id === "supprimer" && m === "POST") {
    const b = await readJson(request);
    const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(String))];
    if (!ids.length) throw new ApiError(400, "Aucun fichier sélectionné.");
    if (ids.length > 200) throw new ApiError(400, "200 fichiers au maximum par suppression.");
    let n = 0, octets = 0;
    for (const fid of ids) {
      const f = await deleteFile(db, env.FILES, fid);
      if (f) { n++; octets += f.size; }
    }
    return jsonOk({ ok: true, supprimes: n, octets });
  }
  if (res === "fichiers" && !id && m === "POST") {
    const len = parseInt(request.headers.get("Content-Length") || "0");
    if (len > MAX_BYTES * 5 + 1_000_000) throw new ApiError(413, `Envoi trop gros (max ${MAX_FILE_MB} Mo par fichier).`);
    let form;
    try { form = await request.formData(); }
    catch { throw new ApiError(400, "Formulaire invalide."); }
    const files = form.getAll("fichier").filter((f) => f && typeof f === "object" && "arrayBuffer" in f);
    if (!files.length) throw new ApiError(400, "Aucun fichier reçu.");
    for (const f of files) if (f.size > MAX_BYTES) throw new ApiError(413, `« ${f.name} » est trop gros (max ${MAX_FILE_MB} Mo).`);
    const { projectId: pid, groupId } = await placementFrom(db, form.get("projet_id"), form.get("groupe_id"));
    const description = String(form.get("description") || "").trim();
    const out = [];
    for (const f of files) {
      const name = cleanName(f.name);
      const bytes = new Uint8Array(await f.arrayBuffer());
      const mime = f.type && f.type !== "application/octet-stream" ? f.type : guessMime(name, false);
      const r = await storeFile(db, env.FILES, { name, mime, bytes, description, projectId: pid, groupId });
      out.push({ id: r.id, nom: r.name, taille: r.size });
    }
    return jsonOk({ ok: true, fichiers: out });
  }
  if (res === "fichiers" && id && m === "PATCH") {
    const f = await db.prepare("SELECT * FROM files WHERE id = ?").bind(id).first();
    if (!f) throw new ApiError(404, "Fichier introuvable.");
    const b = await readJson(request);
    const place = "projet_id" in b ? await placementFrom(db, b.projet_id, b.groupe_id ?? f.group_id) : { projectId: f.project_id, groupId: f.group_id };
    const pid = place.projectId;
    const nom = b.nom != null ? cleanName(b.nom) : f.filename;
    await db.prepare("UPDATE files SET filename=?, description=?, project_id=?, group_id=? WHERE id=?")
      .bind(nom, b.description != null ? String(b.description) : f.description, pid, place.groupId, f.id).run();
    await touchProject(db, pid);
    return jsonOk({ ok: true });
  }
  if (res === "fichiers" && id && m === "DELETE") {
    const f = await deleteFile(db, env.FILES, id);
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
      const sql = "SELECT m.id, m.title, m.kind, m.updated_at, m.project_id, m.group_id, p.name AS projet, snippet(memories_fts, 1, char(1), char(2), '…', 24) AS extrait " +
        "FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid LEFT JOIN projects p ON p.id = m.project_id " +
        "WHERE memories_fts MATCH ? " + (where.length ? "AND " + where.join(" AND ") + " " : "") +
        "ORDER BY bm25(memories_fts, 5.0, 1.0, 3.0, 2.0), m.updated_at DESC LIMIT 60";
      souvenirs = (await db.prepare(sql).bind(ftsQuery(q), ...params).all()).results;
    } else {
      const sql = "SELECT m.id, m.title, m.kind, m.updated_at, m.project_id, m.group_id, p.name AS projet, substr(m.content, 1, 200) AS extrait FROM memories m LEFT JOIN projects p ON p.id = m.project_id WHERE " + where.join(" AND ") + " ORDER BY m.updated_at DESC LIMIT 60";
      souvenirs = (await db.prepare(sql).bind(...params).all()).results;
    }
    const tags = await tagsByMemory(db, souvenirs.map((s) => s.id));
    for (const s of souvenirs) s.tags = tags[s.id] || [];
    let projets = [], fichiers = [];
    if (q) {
      const l = likeArg(q);
      projets = (await db.prepare("SELECT id, name, description, status, group_id FROM projects WHERE name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT 20").bind(l, l).all()).results;
      fichiers = (await db.prepare("SELECT f.id, f.filename, f.size, f.description, f.project_id, f.group_id, p.name AS projet FROM files f LEFT JOIN projects p ON p.id = f.project_id WHERE f.filename LIKE ? ESCAPE '\\' OR f.description LIKE ? ESCAPE '\\' ORDER BY f.created_at DESC LIMIT 30").bind(l, l).all()).results;
    }
    return jsonOk({ souvenirs, projets, fichiers });
  }

  throw new ApiError(404, "Route inconnue.");
}

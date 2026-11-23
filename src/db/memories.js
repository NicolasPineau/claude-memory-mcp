import { day, now } from "../util.js";

export const STOP = new Set("le la les un une des de du et ou a à au aux en on nous notre nos tu te toi je me moi se que qui quoi est sur pour par avec dans ce cet cette ces il elle ils elles the of and souviens rappelles rappelle".split(" "));

export function ftsQuery(text) {
  const words = (text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []);
  let terms = words.filter((w) => !STOP.has(w) && w.length > 1);
  if (!terms.length) terms = words;
  return terms.slice(0, 20).map((w) => `"${w}"*`).join(" OR ");
}

export async function getOrCreateProject(db, name) {
  if (!name || !String(name).trim()) return null;
  name = String(name).trim();
  const row = await db.prepare("SELECT id FROM projects WHERE name = ?").bind(name).first();
  if (row) return row.id;
  const ts = now();
  const r = await db.prepare("INSERT INTO projects(name, created_at, updated_at) VALUES (?,?,?)").bind(name, ts, ts).run();
  return r.meta.last_row_id;
}

export async function memoryTags(db, id) {
  const { results } = await db.prepare(
    "SELECT t.name FROM tags t JOIN memory_tags mt ON mt.tag_id = t.id WHERE mt.memory_id = ? ORDER BY t.name"
  ).bind(id).all();
  return results.map((r) => r.name);
}

export async function setTags(db, id, tags) {
  const stmts = [db.prepare("DELETE FROM memory_tags WHERE memory_id = ?").bind(id)];
  for (const t of tags) {
    stmts.push(db.prepare("INSERT OR IGNORE INTO tags(name) VALUES (?)").bind(t));
    stmts.push(db.prepare("INSERT OR IGNORE INTO memory_tags SELECT ?, id FROM tags WHERE name = ?").bind(id, t));
  }
  await db.batch(stmts);
}

export async function reindex(db, id) {
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

export async function reindexProject(db, pid) {
  const ids = (await db.prepare("SELECT id FROM memories WHERE project_id = ?").bind(pid).all()).results;
  for (const { id } of ids) await reindex(db, id);
}

export const touchProject = (db, pid) =>
  pid ? db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").bind(now(), pid).run() : null;

export async function deleteMemory(db, id) {
  const [del] = await db.batch([
    db.prepare("DELETE FROM memories WHERE id = ?").bind(id),
    db.prepare("DELETE FROM memory_tags WHERE memory_id = ?").bind(id),
    db.prepare("UPDATE files SET memory_id = NULL WHERE memory_id = ?").bind(id),
    db.prepare("DELETE FROM memories_fts WHERE rowid = ?").bind(id),
  ]);
  return del.meta.changes > 0;
}

export async function summary(db, r, max = 280) {
  const tags = await memoryTags(db, r.id);
  let c = String(r.content).trim().replace(/\n/g, " ");
  if (c.length > max) c = c.slice(0, max).trimEnd() + "…";
  const meta = [`#${r.id}`, day(r.updated_at), r.kind];
  if (r.project) meta.push(`projet: ${r.project}`);
  if (tags.length) meta.push("tags: " + tags.join(", "));
  return `• ${r.title}  [${meta.join(" | ")}]\n  ${c}`;
}

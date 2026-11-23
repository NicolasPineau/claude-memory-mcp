import { now } from "../util.js";

// ------------------------------------------------------------------ schéma
export const SCHEMA_VERSION = 3;

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'actif', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'note', project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL, source TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE)`,
  `CREATE TABLE IF NOT EXISTS memory_tags (memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE, tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY (memory_id, tag_id))`,
  `CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, filename TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, description TEXT NOT NULL DEFAULT '', memory_id INTEGER REFERENCES memories(id) ON DELETE SET NULL, project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS file_chunks (file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE, idx INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (file_id, idx))`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(title, content, tags, project, tokenize = 'unicode61 remove_diacritics 2')`,
  `CREATE TABLE IF NOT EXISTS jetons (jeton TEXT PRIMARY KEY, type TEXT NOT NULL, fichier_id TEXT, meta TEXT, expire_le INTEGER NOT NULL, utilise INTEGER NOT NULL DEFAULT 0)`,
  // v3 : groupes (arbre), clés d'accès par compte Claude, droits par groupe.
  `CREATE TABLE IF NOT EXISTS groups (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES groups(id), name TEXT NOT NULL COLLATE NOCASE, description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS groups_sibling_name ON groups(COALESCE(parent_id, 0), name COLLATE NOCASE)`,
  `CREATE TABLE IF NOT EXISTS api_keys (id INTEGER PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, default_group_id INTEGER NOT NULL REFERENCES groups(id), created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS api_key_rules (key_id INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE, group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE, access TEXT NOT NULL CHECK (access IN ('rw', 'ro', 'none')), PRIMARY KEY (key_id, group_id))`,
  `CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];

export const DEFAULT_GROUP = "Perso";

let schemaReady = false;

export async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch(SCHEMA.map((s) => db.prepare(s)));
  await migrate(db);
  schemaReady = true;
}

// Migration idempotente : peut tourner plusieurs fois, y compris en parallèle sur deux instances.
async function migrate(db) {
  const row = await db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").first();
  if (row && Number(row.value) >= SCHEMA_VERSION) return;

  for (const table of ["projects", "memories", "files"]) {
    const cols = (await db.prepare(`PRAGMA table_info(${table})`).all()).results.map((c) => c.name);
    if (!cols.includes("group_id")) {
      try {
        await db.prepare(`ALTER TABLE ${table} ADD COLUMN group_id INTEGER REFERENCES groups(id)`).run();
      } catch (e) {
        if (!/duplicate column/i.test(e.message)) throw e; // ajoutée entre-temps par une autre instance
      }
    }
  }
  const ts = now();
  await db.prepare("INSERT OR IGNORE INTO groups(parent_id, name, description, created_at, updated_at) VALUES (NULL, ?, '', ?, ?)")
    .bind(DEFAULT_GROUP, ts, ts).run();
  const perso = await db.prepare("SELECT id FROM groups WHERE parent_id IS NULL AND name = ?").bind(DEFAULT_GROUP).first();
  await db.batch([
    db.prepare("UPDATE projects SET group_id = ? WHERE group_id IS NULL").bind(perso.id),
    db.prepare("UPDATE memories SET group_id = COALESCE((SELECT group_id FROM projects p WHERE p.id = memories.project_id), ?) WHERE group_id IS NULL").bind(perso.id),
    db.prepare("UPDATE files SET group_id = COALESCE((SELECT group_id FROM projects p WHERE p.id = files.project_id), ?) WHERE group_id IS NULL").bind(perso.id),
    db.prepare("CREATE INDEX IF NOT EXISTS projects_group ON projects(group_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS memories_group ON memories(group_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS files_group ON files(group_id)"),
    db.prepare("INSERT INTO schema_meta(key, value) VALUES ('version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(String(SCHEMA_VERSION)),
  ]);
}

// Réservé aux tests : force une nouvelle vérification du schéma.
export function resetSchemaCache() {
  schemaReady = false;
}

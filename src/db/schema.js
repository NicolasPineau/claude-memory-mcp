import { now } from "../util.js";

// ------------------------------------------------------------------ schéma
export const SCHEMA_VERSION = 6;

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
  // Copies de fichiers orphelines dans le bucket de sauvegarde, depuis quand (scripts/lib/prune.js).
  `CREATE TABLE IF NOT EXISTS backup_orphans (id TEXT PRIMARY KEY, since INTEGER NOT NULL)`,
  // Cache de la consommation du compte (garde-fous, voir src/quota/).
  `CREATE TABLE IF NOT EXISTS usage_cache (metric TEXT PRIMARY KEY, value REAL NOT NULL, period TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL)`,
  // v5 : tâches. Types (comportement de synchro) et niveaux de criticité (affichage, alertes) administrables dans /admin.
  `CREATE TABLE IF NOT EXISTS task_types (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, sync TEXT NOT NULL DEFAULT '', is_default INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS task_levels (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, marker TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0, horizon_days INTEGER NOT NULL DEFAULT 0, alert TEXT NOT NULL DEFAULT 'aucune', alert_from TEXT NOT NULL DEFAULT '07:00', alert_to TEXT NOT NULL DEFAULT '24:00', repeat_minutes INTEGER NOT NULL DEFAULT 0, is_default INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  // Une ligne par tâche, liée à son souvenir (texte, projet, tags, groupe). Échéance en heure de Paris.
  `CREATE TABLE IF NOT EXISTS tasks (memory_id INTEGER PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE, type_id INTEGER NOT NULL REFERENCES task_types(id), level_id INTEGER NOT NULL REFERENCES task_levels(id), status TEXT NOT NULL DEFAULT 'a_faire' CHECK (status IN ('a_faire', 'silencieux', 'fait', 'annule')), due_date TEXT, due_time TEXT, recur_every INTEGER, recur_unit TEXT, done_at TEXT, alert_last TEXT, alert_ack INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS tasks_due ON tasks(status, due_date)`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];

export const DEFAULT_GROUP = "Perso";

let schemaReady = false;

export async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch(SCHEMA.map((s) => db.prepare(s)));
  await migrate(db);
  schemaReady = true;
}

async function addColumn(db, table, column, definition) {
  const cols = (await db.prepare(`PRAGMA table_info(${table})`).all()).results.map((c) => c.name);
  if (cols.includes(column)) return;
  try {
    await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) throw e; // ajoutée entre-temps par une autre instance
  }
}

// Migrations idempotentes : elles peuvent tourner plusieurs fois, y compris en parallèle sur deux instances.
async function migrate(db) {
  const row = await db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").first();
  const version = row ? Number(row.value) : 0;
  if (version >= SCHEMA_VERSION) return;

  // v3 : groupes. Les données existantes vont dans le groupe racine « Perso ».
  if (version < 3) {
    for (const table of ["projects", "memories", "files"]) await addColumn(db, table, "group_id", "INTEGER REFERENCES groups(id)");
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
    ]);
  }

  // v4 : où est rangé le contenu d'un fichier. « d1 » : morceaux base64 dans file_chunks ; « r2 » : objet f/<id> du bucket FILES.
  if (version < 4) await addColumn(db, "files", "storage", "TEXT NOT NULL DEFAULT 'd1'");

  // v5 : tâches. Types et niveaux par défaut (seulement si vides : ils sont ensuite administrables),
  // case « affiche les rappels » sur les clés, et reprise des souvenirs de type « tache » existants.
  if (version < 5) {
    await addColumn(db, "api_keys", "show_reminders", "INTEGER NOT NULL DEFAULT 1");
    const ts = now();
    if (!(await db.prepare("SELECT 1 FROM task_types LIMIT 1").first()))
      await db.batch([
        db.prepare("INSERT OR IGNORE INTO task_types(name, sync, is_default, position, created_at, updated_at) VALUES ('Tâche', '', 1, 1, ?1, ?1)").bind(ts),
        db.prepare("INSERT OR IGNORE INTO task_types(name, sync, is_default, position, created_at, updated_at) VALUES ('Rendez-vous', 'google', 0, 2, ?1, ?1)").bind(ts),
      ]);
    if (!(await db.prepare("SELECT 1 FROM task_levels LIMIT 1").first()))
      await db.batch([
        db.prepare("INSERT OR IGNORE INTO task_levels(name, marker, position, horizon_days, alert, alert_from, alert_to, repeat_minutes, is_default, created_at, updated_at) VALUES ('critique', '!!', 1, 7, 'alarme', '00:00', '24:00', 60, 0, ?1, ?1)").bind(ts),
        db.prepare("INSERT OR IGNORE INTO task_levels(name, marker, position, horizon_days, alert, alert_from, alert_to, repeat_minutes, is_default, created_at, updated_at) VALUES ('normale', '!', 2, 3, 'notification', '07:00', '24:00', 0, 1, ?1, ?1)").bind(ts),
        db.prepare("INSERT OR IGNORE INTO task_levels(name, marker, position, horizon_days, alert, alert_from, alert_to, repeat_minutes, is_default, created_at, updated_at) VALUES ('basse', '', 3, 0, 'aucune', '07:00', '24:00', 0, 0, ?1, ?1)").bind(ts),
      ]);
    await db.prepare(`INSERT OR IGNORE INTO tasks(memory_id, type_id, level_id, status, created_at, updated_at)
      SELECT id, (SELECT id FROM task_types ORDER BY is_default DESC, position, id LIMIT 1), (SELECT id FROM task_levels ORDER BY is_default DESC, position, id LIMIT 1), 'a_faire', created_at, updated_at
      FROM memories WHERE kind = 'tache'`).run();
  }

  // v6 : alertes ntfy. Dernier envoi (UTC) et accusé de réception (« Vu »), remis à zéro quand l'échéance ou le statut change.
  if (version < 6) {
    await addColumn(db, "tasks", "alert_last", "TEXT");
    await addColumn(db, "tasks", "alert_ack", "INTEGER NOT NULL DEFAULT 0");
  }

  await db.prepare("INSERT INTO schema_meta(key, value) VALUES ('version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(String(SCHEMA_VERSION)).run();
}

// Réservé aux tests : force une nouvelle vérification du schéma.
export function resetSchemaCache() {
  schemaReady = false;
}

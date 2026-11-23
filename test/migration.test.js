import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ensureSchema, resetSchemaCache } from "../src/db/schema.js";

// Base au format v2 (avant les groupes), avec des données.
const V2 = [
  "CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'actif', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE memories (id INTEGER PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'note', project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL, source TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE files (id TEXT PRIMARY KEY, filename TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, description TEXT NOT NULL DEFAULT '', memory_id INTEGER REFERENCES memories(id) ON DELETE SET NULL, project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL, created_at TEXT NOT NULL)",
  "INSERT INTO projects VALUES (1, 'Travaux', '', 'actif', '2026-01-01', '2026-01-01')",
  "INSERT INTO memories VALUES (1, 'Peinture', 'Blanc mat', 'note', 1, '', '2026-01-01', '2026-01-01')",
  "INSERT INTO memories VALUES (2, 'Idée', 'Sans projet', 'idee', NULL, '', '2026-01-01', '2026-01-01')",
  "INSERT INTO files VALUES ('abc123def456', 'plan.pdf', 'application/pdf', 10, '', NULL, 1, '2026-01-01')",
];

describe("migration v2 → v5", () => {
  it("rattache tout à Perso sans perte, et un second passage ne change rien", async () => {
    for (const q of V2) await env.DB.prepare(q).run();
    resetSchemaCache();
    await ensureSchema(env.DB);

    const perso = await env.DB.prepare("SELECT id FROM groups WHERE name = 'Perso' AND parent_id IS NULL").first();
    const snapshot = async () => ({
      groups: (await env.DB.prepare("SELECT id, name FROM groups").all()).results,
      projects: (await env.DB.prepare("SELECT id, name, group_id FROM projects").all()).results,
      memories: (await env.DB.prepare("SELECT id, title, project_id, group_id FROM memories ORDER BY id").all()).results,
      files: (await env.DB.prepare("SELECT id, group_id, storage FROM files").all()).results,
      version: (await env.DB.prepare("SELECT value FROM schema_meta WHERE key = 'version'").first()).value,
    });
    const first = await snapshot();
    expect(first).toEqual({
      groups: [{ id: perso.id, name: "Perso" }],
      projects: [{ id: 1, name: "Travaux", group_id: perso.id }],
      memories: [
        { id: 1, title: "Peinture", project_id: 1, group_id: perso.id },
        { id: 2, title: "Idée", project_id: null, group_id: perso.id },
      ],
      files: [{ id: "abc123def456", group_id: perso.id, storage: "d1" }], // contenu encore dans D1, à migrer vers R2
      version: "5",
    });

    resetSchemaCache();
    await ensureSchema(env.DB);
    await env.DB.prepare("DELETE FROM schema_meta").run(); // force la migration à repasser entièrement
    resetSchemaCache();
    await ensureSchema(env.DB);
    expect(await snapshot()).toEqual(first);
  });
});

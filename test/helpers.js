import { SELF, env } from "cloudflare:test";
import { adminApi } from "../src/admin/api.js";
import { sha256hex } from "../src/auth/keys.js";
import { ensureSchema, resetSchemaCache } from "../src/db/schema.js";
import { now } from "../src/util.js";

export const MASTER = "test-secret-0123456789abcdef";
let rpcId = 0;

export async function rpc(key, method, params = {}) {
  const res = await SELF.fetch(`https://memory.test/${key}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  return res.status === 200 ? res.json() : { status: res.status };
}

export async function call(key, name, args = {}) {
  const r = await rpc(key, "tools/call", { name, arguments: args });
  return r.result ? r.result.content[0].text : r.error?.message ?? `HTTP ${r.status}`;
}

// Base vide au schéma courant (les tests d'un même fichier partagent la base).
export async function schema() {
  resetSchemaCache();
  await ensureSchema(env.DB);
  for (const t of ["file_chunks", "jetons", "memory_tags", "memories_fts", "files", "memories", "projects", "tags", "api_key_rules", "api_keys", "schema_meta"])
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  // Groupes : des feuilles vers la racine, à cause de la clé étrangère parent_id.
  while ((await env.DB.prepare("DELETE FROM groups WHERE id NOT IN (SELECT parent_id FROM groups WHERE parent_id IS NOT NULL)").run()).meta.changes);
  resetSchemaCache();
  await ensureSchema(env.DB);
}

export async function group(name, parentId = null) {
  const ts = now();
  const r = await env.DB.prepare("INSERT INTO groups(parent_id, name, description, created_at, updated_at) VALUES (?,?,?,?,?)").bind(parentId, name, "", ts, ts).run();
  return r.meta.last_row_id;
}

export const groupId = async (name, parentId = null) =>
  (await env.DB.prepare("SELECT id FROM groups WHERE name = ? AND COALESCE(parent_id, 0) = ?").bind(name, parentId ?? 0).first()).id;

// Crée une clé avec ses règles ({ groupId: "rw" | "ro" | "none" }) et renvoie la clé en clair.
export async function apiKey(name, defaultGroupId, rules) {
  const key = `${name}-${crypto.randomUUID()}`;
  const r = await env.DB.prepare("INSERT INTO api_keys(name, key_hash, default_group_id, created_at) VALUES (?,?,?,?)")
    .bind(name, await sha256hex(key), defaultGroupId, now()).run();
  for (const [gid, acc] of Object.entries(rules))
    await env.DB.prepare("INSERT INTO api_key_rules(key_id, group_id, access) VALUES (?,?,?)").bind(r.meta.last_row_id, Number(gid), acc).run();
  return key;
}

export async function admin(method, path, body) {
  const url = new URL(`https://memory.test/admin/api/${path}`);
  const req = new Request(url, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  try {
    const res = await adminApi(req, env.DB, path.split("?")[0].split("/"), url, env);
    return { status: res.status, ...(await res.json()) };
  } catch (e) {
    return { status: e.status ?? 500, ok: false, erreur: e.message };
  }
}

export { env };

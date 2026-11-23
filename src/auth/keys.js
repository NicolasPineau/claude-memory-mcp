import { Acl, defaultRootGroupId, effectiveRights, loadGroups } from "../db/groups.js";
import { now, randomToken, timingSafeEqual } from "../util.js";

// ------------------------------------------------------------------ clés d'accès au connecteur MCP
export async function sha256hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Nouvelle clé : 32 octets aléatoires en base64url (43 caractères). Seul son hash est stocké.
export const generateKey = randomToken;

export const masterKeyEnabled = (env) => String(env.MASTER_KEY_ENABLED ?? "true").toLowerCase() !== "false";

// Identifie la clé passée dans l'URL. Renvoie null si elle est inconnue ou révoquée.
export async function authenticate(db, env, key) {
  if (!key) return null;
  const row = await db.prepare("SELECT id, name, default_group_id, last_used_at FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL")
    .bind(await sha256hex(key)).first();
  if (row) {
    const ts = now();
    if (!row.last_used_at || Date.parse(ts) - Date.parse(row.last_used_at) > 3600_000)
      await db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").bind(ts, row.id).run();
    return { keyId: row.id, name: row.name, isMaster: false, defaultGroupId: row.default_group_id };
  }
  if (masterKeyEnabled(env) && timingSafeEqual(key, env.MEMORY_SECRET || "")) {
    return { keyId: null, name: "clé maîtresse", isMaster: true, defaultGroupId: await defaultRootGroupId(db) };
  }
  return null;
}

export async function loadRules(db, keyId) {
  const rows = (await db.prepare("SELECT group_id, access FROM api_key_rules WHERE key_id = ?").bind(keyId).all()).results;
  return new Map(rows.map((r) => [r.group_id, r.access]));
}

export async function buildAcl(db, auth) {
  const tree = await loadGroups(db);
  const rules = auth.isMaster ? new Map() : await loadRules(db, auth.keyId);
  return new Acl(tree, effectiveRights(tree, rules, auth.isMaster), auth.defaultGroupId);
}

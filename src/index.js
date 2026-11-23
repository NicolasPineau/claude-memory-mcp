// Mémoire partagée pour Claude — connecteur MCP sur Cloudflare Workers + D1.
// URL du connecteur MCP : https://<worker>.workers.dev/<MEMORY_SECRET>/mcp
// Interface d'administration : https://<worker>.workers.dev/admin (protégée par Cloudflare Access)
//
// Liaisons requises :
//   - base D1 nommée "DB"
//   - secret "MEMORY_SECRET" (24 caractères min.) : clé maîtresse du connecteur MCP (accès à tout)
//   - variable "MASTER_KEY_ENABLED" (facultative) : "false" désactive la clé maîtresse ; les clés par compte
//     se créent dans /admin et donnent chacune accès à certains groupes.
//   - variable "ACCESS_TEAM_DOMAIN" : ex. https://mon-equipe.cloudflareaccess.com
//   - variable "ACCESS_AUD"         : « Application Audience (AUD) Tag » de l'application Access
//   - variable "ADMIN_EMAILS"       : e-mail(s) autorisé(s), séparés par des virgules
// Sans les trois variables Access, /admin reste fermé (erreur 503).

import { handleAdmin } from "./admin/index.js";
import { ensureSchema } from "./db/schema.js";
import { downloadResponse, handlePutUpload } from "./files/storage.js";
import { authenticate, buildAcl } from "./auth/keys.js";
import { blockedMessage, checkQuota } from "./quota/guard.js";
import { handleRpc } from "./mcp/protocol.js";

// ------------------------------------------------------------------ routage
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const secret = env.MEMORY_SECRET || "";
    if (secret.length < 24) return new Response("Configuration incomplète : secret MEMORY_SECRET manquant.", { status: 500 });
    if (!env.DB) return new Response("Configuration incomplète : base D1 « DB » non liée.", { status: 500 });
    const notFound = () => new Response("Not found", { status: 404 });
    const db = env.DB;

    // Interface d'administration (Cloudflare Access + vérification du jeton).
    if (parts[0] === "admin") {
      if (url.pathname.endsWith("/") && parts.length === 1) return Response.redirect(url.origin + "/admin", 301);
      return handleAdmin(request, env, url, parts);
    }

    // Liens par jeton (sans la clé secrète), refusés quand un seuil de consommation est atteint.
    const quotaRefusal = async () => {
      const q = await checkQuota(db, env);
      return q.blocked.length ? Response.json({ ok: false, erreur: blockedMessage(q) }, { status: 429 }) : null;
    };
    if (parts.length === 2 && parts[0] === "dl") {
      if (request.method !== "GET") return notFound();
      await ensureSchema(db);
      const refused = await quotaRefusal();
      if (refused) return refused;
      const t = await db.prepare("SELECT fichier_id FROM jetons WHERE jeton = ? AND type = 'download' AND expire_le > ?").bind(parts[1], Date.now()).first();
      const f = t && await db.prepare("SELECT * FROM files WHERE id = ?").bind(t.fichier_id).first();
      return f ? downloadResponse(db, env.FILES, f) : notFound();
    }
    if (parts.length === 2 && parts[0] === "upload") {
      if (request.method !== "PUT") return notFound();
      await ensureSchema(db);
      const refused = await quotaRefusal();
      if (refused) return refused;
      return handlePutUpload(request, db, env.FILES, parts[1]);
    }

    // Connecteur MCP : /<clé>/mcp, avec une clé de /admin ou la clé maîtresse (MEMORY_SECRET).
    if (parts.length !== 2 || parts[1] !== "mcp") return notFound();
    await ensureSchema(db);
    const auth = await authenticate(db, env, parts[0]);
    if (!auth) return notFound();

    if (request.method === "GET") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

    let body;
    try { body = await request.json(); }
    catch { return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON invalide" } }, { status: 400 }); }

    const ctx = { origin: url.origin, env, auth, acl: await buildAcl(db, auth), quota: await checkQuota(db, env) };
    const batch = Array.isArray(body);
    const replies = (await Promise.all((batch ? body : [body]).map((m) => handleRpc(m, env, ctx)))).filter(Boolean);
    if (!replies.length) return new Response(null, { status: 202 });
    return Response.json(batch ? replies : replies[0]);
  },
};

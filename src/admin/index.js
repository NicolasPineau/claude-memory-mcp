import { ApiError, adminApi } from "./api.js";
import { PAGE_HEADERS, adminPage } from "./page.js";
import { verifyAccess } from "../auth/access.js";
import { ensureSchema } from "../db/schema.js";
import { downloadResponse } from "../files/storage.js";
import { blockedMessage, checkQuota } from "../quota/guard.js";
import { NO_STORE, jsonErr } from "../util.js";

export async function handleAdmin(request, env, url, parts) {
  const auth = await verifyAccess(request, env);
  if (auth.error) return new Response(auth.error, { status: auth.status, headers: { "Content-Type": "text/plain; charset=utf-8", ...NO_STORE } });
  const db = env.DB;
  await ensureSchema(db);

  // Protection CSRF : toute écriture doit venir de la page elle-même.
  const isWrite = !["GET", "HEAD"].includes(request.method);
  if (isWrite && request.headers.get("Origin") !== url.origin)
    return jsonErr(403, "Origine refusée.");

  // Garde-fous : /admin reste consultable, mais les écritures sont refusées quand un seuil est atteint.
  const quota = await checkQuota(db, env);
  if (isWrite && quota.blocked.length) return jsonErr(429, blockedMessage(quota));

  if (parts.length === 1) {
    if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
    return new Response(adminPage(auth.email), { headers: PAGE_HEADERS });
  }
  if (parts[1] === "fichiers" && parts.length === 3 && request.method === "GET") {
    const f = await db.prepare("SELECT * FROM files WHERE id = ?").bind(parts[2]).first();
    return f ? downloadResponse(db, f) : new Response("Not found", { status: 404 });
  }
  if (parts[1] === "sauvegardes" && parts.length === 3 && request.method === "GET") {
    if (!env.BACKUPS) return new Response("Bucket de sauvegardes non lié (binding BACKUPS).", { status: 404 });
    if (quota.blocked.length) return jsonErr(429, blockedMessage(quota));
    const obj = await env.BACKUPS.get(decodeURIComponent(parts[2]));
    if (!obj) return new Response("Not found", { status: 404 });
    return new Response(obj.body, { headers: { "Content-Type": "application/gzip", "Content-Disposition": `attachment; filename="${obj.key.replace(/[^\w.-]/g, "_")}"`, ...NO_STORE } });
  }
  if (parts[1] === "api" && parts.length >= 3 && parts.length <= 4) {
    try {
      return await adminApi(request, db, parts.slice(2), url, env, quota);
    } catch (e) {
      if (e instanceof ApiError) return jsonErr(e.status, e.message);
      return jsonErr(500, `Erreur interne : ${e.message}`);
    }
  }
  return new Response("Not found", { status: 404 });
}

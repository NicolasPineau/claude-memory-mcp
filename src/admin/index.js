import { ApiError, adminApi } from "./api.js";
import { PAGE_HEADERS, adminPage } from "./page.js";
import { verifyAccess } from "../auth/access.js";
import { ensureSchema } from "../db/schema.js";
import { downloadResponse } from "../files/storage.js";
import { blockedMessage, checkQuota } from "../quota/guard.js";
import { NO_STORE, jsonErr, randomToken } from "../util.js";
import { authUrl, exchangeCode, getSync, googleConfigured, setSync } from "../google/calendar.js";

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
    return f ? downloadResponse(db, env.FILES, f, { inline: url.searchParams.has("voir") }) : new Response("Not found", { status: 404 });
  }
  if (parts[1] === "sauvegardes" && parts.length === 3 && request.method === "GET") {
    if (!env.BACKUPS) return new Response("Bucket de sauvegardes non lié (binding BACKUPS).", { status: 404 });
    if (quota.blocked.length) return jsonErr(429, blockedMessage(quota));
    const obj = await env.BACKUPS.get(decodeURIComponent(parts[2]));
    if (!obj) return new Response("Not found", { status: 404 });
    return new Response(obj.body, { headers: { "Content-Type": "application/gzip", "Content-Disposition": `attachment; filename="${obj.key.replace(/[^\w.-]/g, "_")}"`, ...NO_STORE } });
  }
  // Connexion à Google Agenda (OAuth) : /admin/google/connect redirige vers Google, qui revient sur /admin/google/callback.
  if (parts[1] === "google" && parts.length === 3 && request.method === "GET") {
    if (!googleConfigured(env)) return new Response("Synchro Google non configurée : ajoute GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET sur le Worker.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8", ...NO_STORE } });
    if (parts[2] === "connect") {
      if (quota.blocked.length) return jsonErr(429, blockedMessage(quota));
      const state = randomToken();
      await getSync(db);
      await setSync(db, { oauth_state: state, oauth_state_exp: Date.now() + 10 * 60_000 });
      return new Response(null, { status: 302, headers: { Location: authUrl(env, url.origin, state), ...NO_STORE } });
    }
    if (parts[2] === "callback") {
      const back = (msg) => new Response(null, { status: 302, headers: { Location: `/admin?google=${encodeURIComponent(msg)}`, ...NO_STORE } });
      const sync = await getSync(db);
      const state = url.searchParams.get("state") || "";
      if (!sync.oauth_state || state !== sync.oauth_state || Date.now() > sync.oauth_state_exp) return back("Lien de connexion expiré, recommence.");
      await setSync(db, { oauth_state: null, oauth_state_exp: null });
      if (url.searchParams.get("error")) return back("Connexion refusée.");
      try {
        const refresh = await exchangeCode(env, url.origin, url.searchParams.get("code") || "");
        await setSync(db, { refresh_token: refresh, last_error: null });
        return back("ok");
      } catch (e) {
        return back(e.message);
      }
    }
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

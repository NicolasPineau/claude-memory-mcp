import { ApiError, adminApi } from "./api.js";
import { PAGE_HEADERS, adminPage } from "./page.js";
import { verifyAccess } from "../auth/access.js";
import { ensureSchema } from "../db/schema.js";
import { downloadResponse } from "../files/storage.js";
import { NO_STORE, jsonErr } from "../util.js";

export async function handleAdmin(request, env, url, parts) {
  const auth = await verifyAccess(request, env);
  if (auth.error) return new Response(auth.error, { status: auth.status, headers: { "Content-Type": "text/plain; charset=utf-8", ...NO_STORE } });
  const db = env.DB;
  await ensureSchema(db);

  // Protection CSRF : toute écriture doit venir de la page elle-même.
  if (!["GET", "HEAD"].includes(request.method) && request.headers.get("Origin") !== url.origin)
    return jsonErr(403, "Origine refusée.");

  if (parts.length === 1) {
    if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
    return new Response(adminPage(auth.email), { headers: PAGE_HEADERS });
  }
  if (parts[1] === "fichiers" && parts.length === 3 && request.method === "GET") {
    const f = await db.prepare("SELECT * FROM files WHERE id = ?").bind(parts[2]).first();
    return f ? downloadResponse(db, f) : new Response("Not found", { status: 404 });
  }
  if (parts[1] === "api" && parts.length >= 3 && parts.length <= 4) {
    try {
      return await adminApi(request, db, parts.slice(2), url);
    } catch (e) {
      if (e instanceof ApiError) return jsonErr(e.status, e.message);
      return jsonErr(500, `Erreur interne : ${e.message}`);
    }
  }
  return new Response("Not found", { status: 404 });
}

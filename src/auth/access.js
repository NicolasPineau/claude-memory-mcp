import { b64urlToBytes } from "../util.js";

// ------------------------------------------------------------------ authentification Cloudflare Access
// Cloudflare Access bloque les visiteurs non connectés avant le Worker ; le Worker vérifie en plus
// le jeton signé (en-tête Cf-Access-Jwt-Assertion), son audience, son émetteur et l'e-mail.
export let accessCerts = { url: "", at: 0, keys: [] };

export async function accessKeys(team, force = false) {
  if (!force && accessCerts.url === team && Date.now() - accessCerts.at < 3600_000) return accessCerts.keys;
  const r = await fetch(`${team}/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error(`certificats Access indisponibles (${r.status})`);
  const j = await r.json();
  accessCerts = { url: team, at: Date.now(), keys: j.keys || [] };
  return accessCerts.keys;
}

export async function verifyAccess(request, env) {
  let team = String(env.ACCESS_TEAM_DOMAIN || "").trim().replace(/\/+$/, "");
  if (team && !/^https:\/\//.test(team)) team = "https://" + team;
  const aud = String(env.ACCESS_AUD || "").trim();
  const emails = String(env.ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!team || !aud || !emails.length) return { status: 503, error: "Configuration incomplète : ACCESS_TEAM_DOMAIN, ACCESS_AUD et ADMIN_EMAILS sont requis." };
  const deny = { status: 403, error: "Accès refusé." };
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return deny;
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) return deny;
  let header, payload;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)));
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));
  } catch { return deny; }
  if (header.alg !== "RS256" || !header.kid) return deny;
  let jwk = (await accessKeys(team)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await accessKeys(team, true)).find((k) => k.kid === header.kid);
  if (!jwk) return deny;
  const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(s), new TextEncoder().encode(`${h}.${p}`));
  if (!valid) return deny;
  const t = Date.now() / 1000;
  if (typeof payload.exp !== "number" || payload.exp < t) return deny;
  if (payload.nbf && payload.nbf > t + 60) return deny;
  if (payload.iss !== team) return deny;
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) return deny;
  const email = String(payload.email || "").toLowerCase();
  if (!emails.includes(email)) return deny;
  return { email };
}

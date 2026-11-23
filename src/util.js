// ------------------------------------------------------------------ utilitaires
export const now = () => new Date().toISOString().slice(0, 19) + "Z";

export const day = (iso) => (iso || "").slice(0, 10);

export function normTags(tags) {
  const out = [];
  for (let t of tags || []) {
    t = String(t).trim().replace(/^#+/, "").replace(/\s+/g, " ").toLowerCase();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

export function guessMime(name, isText) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  const map = { txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json", html: "text/html", xml: "application/xml", js: "text/javascript", py: "text/x-python", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", heic: "image/heic", svg: "image/svg+xml", pdf: "application/pdf", zip: "application/zip", mp4: "video/mp4", mov: "video/quicktime", mp3: "audio/mpeg", m4a: "audio/mp4", doc: "application/msword", xls: "application/vnd.ms-excel", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation" };
  return map[ext] || (isText ? "text/plain" : "application/octet-stream");
}

export function bytesToB64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const utf8ToB64 = (s) => bytesToB64(new TextEncoder().encode(s));

export function b64Size(b64) {
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

export const b64urlToBytes = (s) => b64ToBytes(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));

export function cleanName(n) {
  return String(n || "").split(/[\\/]/).pop().replace(/[^\p{L}\p{N}_.\- ]+/gu, "_").trim() || "fichier";
}

export function randomToken() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return bytesToB64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ------------------------------------------------------------------ API d'administration
export const NO_STORE = { "Cache-Control": "no-store" };

export const jsonOk = (data) => Response.json(data, { headers: NO_STORE });

export const jsonErr = (status, erreur) => Response.json({ ok: false, erreur }, { status, headers: NO_STORE });

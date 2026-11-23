import { TASK_SELECT, getSetting, parisNow, shortDate, shortTime } from "../db/tasks.js";

// ------------------------------------------------------------------ alertes ntfy (Cron du Worker, toutes les 15 min)
// Secrets et variables du Worker : NTFY_TOPIC (secret, topic ntfy privé), PUBLIC_URL (adresse du Worker, pour les liens),
// NTFY_URL (facultatif, défaut https://ntfy.sh), NTFY_TOKEN (facultatif, jeton d'accès ntfy).
export const LINK_TTL_S = 7 * 86400; // validité des liens des notifications : 7 jours
const MAX_PER_RUN = 20; // borne les sous-requêtes et le CPU d'une exécution du Cron

// ---- liens signés : « <id>.<expiration>.<signature> », limités à une tâche, sans connexion (HMAC du secret du Worker).
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function hmac(env, data) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("taches:" + (env.MEMORY_SECRET || "")), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url((await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data))).slice(0, 18));
}

export async function signTaskLink(env, id, at = Date.now()) {
  const exp = Math.floor(at / 1000) + LINK_TTL_S;
  return `${id}.${exp}.${await hmac(env, `${id}.${exp}`)}`;
}

// Renvoie l'id de la tâche, ou null si le lien est faux ou expiré.
export async function verifyTaskLink(env, token, at = Date.now()) {
  const m = /^(\d+)\.(\d+)\.([\w-]+)$/.exec(token || "");
  if (!m || Number(m[2]) * 1000 < at) return null;
  const expected = await hmac(env, `${m[1]}.${m[2]}`);
  if (expected.length !== m[3].length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ m[3].charCodeAt(i);
  return diff === 0 ? Number(m[1]) : null;
}

// ---- plage d'alerte « HH:MM »–« HH:MM » (fin exclue, « 24:00 » = minuit ; une plage qui passe minuit est gérée).
export function inWindow(time, from, to) {
  if (from === to || (from === "00:00" && to === "24:00")) return true;
  return from < to ? time >= from && time < to : time >= from || time < to;
}

// Échéance de l'alerte : la date à l'heure prévue, sinon à l'heure « alerte_matin ».
const dueKey = (t, morning) => `${t.due_date} ${t.due_time || morning}`;

export function ntfyMessage(env, t, today, token) {
  const late = t.due_date < today;
  const when = (late ? "En retard : " : "Échéance : ") + (t.due_date === today ? "aujourd'hui" : shortDate(t.due_date, today)) + (t.due_time ? " " + shortTime(t.due_time) : "");
  const detail = t.content && t.content.trim() !== t.title.trim() ? "\n" + t.content.trim().slice(0, 300) : "";
  const msg = {
    topic: env.NTFY_TOPIC,
    title: (t.marker ? t.marker + " " : "") + t.title,
    message: when + detail,
    priority: t.alert === "alarme" ? 5 : 4,
    tags: [t.alert === "alarme" ? "rotating_light" : "bell"],
  };
  const base = String(env.PUBLIC_URL || "").replace(/\/+$/, "");
  if (base && token) {
    const link = `${base}/t/${token}`;
    msg.click = link;
    msg.actions = [
      { action: "http", label: "Fait", url: `${link}/fait`, method: "POST", clear: true },
      { action: "http", label: "Vu", url: `${link}/vu`, method: "POST", clear: true },
      { action: "view", label: "Repousser…", url: `${link}#repousser`, clear: true },
    ];
  }
  return msg;
}

export async function sendNtfy(env, msg) {
  const headers = { "Content-Type": "application/json" };
  if (env.NTFY_TOKEN) headers.Authorization = `Bearer ${env.NTFY_TOKEN}`;
  const res = await fetch(String(env.NTFY_URL || "https://ntfy.sh").replace(/\/+$/, "") + "/", { method: "POST", headers, body: JSON.stringify(msg) });
  return res.ok;
}

// Envoie les alertes dues. Une tâche alerte quand son échéance est passée, dans la plage de son niveau, puis est relancée
// toutes les `repeat_minutes` (0 = jamais) tant qu'elle n'est ni « Vu », ni faite, ni repoussée. Renvoie le nombre envoyé.
export async function runAlerts(db, env, { at = new Date(), send = sendNtfy } = {}) {
  if (!env.NTFY_TOPIC) return 0;
  const p = parisNow(at), nowKey = `${p.date} ${p.time}`;
  const morning = await getSetting(db, "alerte_matin");
  const rows = (await db.prepare(`${TASK_SELECT} WHERE t.status = 'a_faire' AND l.alert != 'aucune' AND t.due_date IS NOT NULL
    AND t.due_date <= ? AND t.alert_ack = 0 AND (t.alert_last IS NULL OR l.repeat_minutes > 0)
    ORDER BY l.position, t.due_date, COALESCE(t.due_time, '')`).bind(p.date).all()).results;
  let sent = 0;
  for (const t of rows) {
    if (sent >= MAX_PER_RUN) break;
    if (dueKey(t, morning) > nowKey || !inWindow(p.time, t.alert_from, t.alert_to)) continue;
    // Tolérance d'une minute : le Cron ne tombe pas à la seconde près.
    if (t.alert_last && at.getTime() - Date.parse(t.alert_last) < t.repeat_minutes * 60_000 - 60_000) continue;
    let ok = false;
    try { ok = await send(env, ntfyMessage(env, t, p.date, await signTaskLink(env, t.memory_id, at.getTime()))); }
    catch { ok = false; }
    if (!ok) continue; // réessayé au prochain passage
    await db.prepare("UPDATE tasks SET alert_last = ? WHERE memory_id = ?").bind(new Date(at).toISOString().slice(0, 19) + "Z", t.memory_id).run();
    sent++;
  }
  return sent;
}


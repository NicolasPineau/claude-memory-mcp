import { defaultRootGroupId } from "../db/groups.js";
import { reindex } from "../db/memories.js";
import { TASK_SELECT, TZ, applyTaskUpdate, defaultLevelId, parisNow } from "../db/tasks.js";
import { now } from "../util.js";

// ------------------------------------------------------------------ synchro bidirectionnelle avec un agenda Google dédié
// Variables du Worker : GOOGLE_CLIENT_ID (variable), GOOGLE_CLIENT_SECRET (secret). Le jeton de rafraîchissement OAuth,
// l'agenda choisi et l'état de synchro sont dans la table google_sync (jamais sauvegardée).
// Le Cron (toutes les 15 min) lit d'abord les changements Google (synchro incrémentale, syncToken), puis envoie les
// changements locaux (tâches dont le type a la synchro « google », gcal_dirty = 1). En cas de conflit, la dernière
// modification gagne.
export const SCOPES = "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/calendar/v3";
const MAX_PAGES = 3; // pages lues par synchro (250 événements chacune)
const MAX_PUSH = 10; // envois par synchro : borne les sous-requêtes du Cron
const RECONNECT = "Autorisation Google expirée ou révoquée : reconnecte Google dans /admin (page Tâches).";

export const googleConfigured = (env) => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
export const redirectUri = (origin) => `${origin}/admin/google/callback`;

export async function getSync(db) {
  await db.prepare("INSERT OR IGNORE INTO google_sync(id) VALUES (1)").run();
  return db.prepare("SELECT * FROM google_sync WHERE id = 1").first();
}

export const setSync = (db, fields) => {
  const cols = Object.keys(fields);
  return db.prepare(`UPDATE google_sync SET ${cols.map((c) => c + " = ?").join(", ")} WHERE id = 1`).bind(...Object.values(fields)).run();
};

export function authUrl(env, origin, state) {
  const q = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri(origin), response_type: "code", scope: SCOPES, access_type: "offline", prompt: "consent", include_granted_scopes: "true", state });
  return `${AUTH_URL}?${q}`;
}

async function tokenRequest(env, params, fetchFn) {
  const res = await fetchFn(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, ...params }) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(j.error === "invalid_grant" ? RECONNECT : `Google OAuth : ${j.error_description || j.error || res.status}`);
    e.reconnect = j.error === "invalid_grant";
    throw e;
  }
  return j;
}

export async function exchangeCode(env, origin, code, fetchFn = fetch) {
  const j = await tokenRequest(env, { code, grant_type: "authorization_code", redirect_uri: redirectUri(origin) }, fetchFn);
  if (!j.refresh_token) throw new Error("Google n'a pas renvoyé de jeton de rafraîchissement : retire l'accès de l'app dans ton compte Google, puis reconnecte.");
  return j.refresh_token;
}

export async function accessToken(env, refreshToken, fetchFn = fetch) {
  return (await tokenRequest(env, { refresh_token: refreshToken, grant_type: "refresh_token" }, fetchFn)).access_token;
}

async function gapi(fetchFn, token, method, path, body) {
  const res = await fetchFn(API + path, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = res.status === 204 ? {} : await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, json };
}

const apiError = (r, what) => new Error(`Google Agenda (${what}) : ${r.json?.error?.message || r.status}`);

export async function listCalendars(env, refreshToken, fetchFn = fetch) {
  const token = await accessToken(env, refreshToken, fetchFn);
  const r = await gapi(fetchFn, token, "GET", "/users/me/calendarList?minAccessRole=writer&maxResults=250");
  if (!r.ok) throw apiError(r, "liste des agendas");
  return (r.json.items || []).map((c) => ({ id: c.id, nom: c.summaryOverride || c.summary, principal: !!c.primary }));
}

// ---- correspondance tâche ↔ événement
const pad = (n) => String(n).padStart(2, "0");
function addMinutes(date, time, minutes) {
  const [y, m, d] = date.split("-").map(Number), [h, mi] = time.split(":").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d, h, mi) + minutes * 60_000);
  return { date: t.toISOString().slice(0, 10), time: `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}` };
}

export function eventBody(t, durationMinutes = 60) {
  const body = {
    summary: t.title,
    description: t.content && t.content.trim() !== t.title.trim() ? t.content : "",
    extendedProperties: { private: { memoryId: String(t.memory_id) } },
  };
  if (t.due_time) {
    const end = addMinutes(t.due_date, t.due_time, durationMinutes);
    body.start = { dateTime: `${t.due_date}T${t.due_time}:00`, timeZone: TZ };
    body.end = { dateTime: `${end.date}T${end.time}:00`, timeZone: TZ };
  } else {
    body.start = { date: t.due_date };
    body.end = { date: addMinutes(t.due_date, "00:00", 1440).date };
  }
  return body;
}

// Échéance (heure de Paris) d'un événement Google.
export function eventDue(ev) {
  if (ev.start?.dateTime) return parisNow(new Date(ev.start.dateTime));
  return { date: ev.start?.date || null, time: null };
}

// ---- synchro
async function findTask(db, ev) {
  let t = await db.prepare(`${TASK_SELECT} WHERE t.gcal_event_id = ?`).bind(ev.id).first();
  const mid = Number(ev.extendedProperties?.private?.memoryId);
  if (!t && mid) t = await db.prepare(`${TASK_SELECT} WHERE t.memory_id = ? AND t.gcal_event_id IS NULL`).bind(mid).first();
  return t;
}

async function pullEvent(db, sync, ev) {
  const t = await findTask(db, ev);
  if (ev.status === "cancelled") {
    if (!t) return 0;
    await db.prepare("UPDATE tasks SET status = CASE WHEN status IN ('a_faire', 'silencieux') THEN 'annule' ELSE status END, gcal_event_id = NULL, gcal_updated = NULL, gcal_dirty = 0, alert_last = NULL, updated_at = ? WHERE memory_id = ?").bind(now(), t.memory_id).run();
    return 1;
  }
  const due = eventDue(ev);
  if (!due.date) return 0;
  const titre = String(ev.summary || "").trim() || "(sans titre)", detail = String(ev.description || "").trim();
  if (t) {
    if (ev.updated === t.gcal_updated) return 0; // écho de notre propre envoi
    if (t.gcal_dirty && Date.parse(t.updated_at) > Date.parse(ev.updated)) return 0; // la modification locale est plus récente : elle sera envoyée
    const r = await applyTaskUpdate(db, t, { titre, detail, echeance: due.time ? `${due.date} ${due.time}` : due.date, fromGoogle: true });
    if (r.error) return 0;
    await db.prepare("UPDATE tasks SET gcal_event_id = ?, gcal_updated = ?, gcal_dirty = 0 WHERE memory_id = ?").bind(ev.id, ev.updated, t.memory_id).run();
    return 1;
  }
  // Nouveau rendez-vous créé dans Google : rangé selon les réglages de /admin.
  const type = await db.prepare("SELECT id FROM task_types WHERE sync = 'google' ORDER BY is_default DESC, position, id LIMIT 1").first();
  if (!type) return 0;
  let groupId = sync.group_id, projectId = sync.project_id;
  if (projectId) {
    const p = await db.prepare("SELECT group_id FROM projects WHERE id = ?").bind(projectId).first();
    if (p) groupId = p.group_id; else projectId = null;
  }
  if (!groupId || !(await db.prepare("SELECT 1 FROM groups WHERE id = ?").bind(groupId).first())) groupId = await defaultRootGroupId(db);
  const levelId = (sync.level_id && (await db.prepare("SELECT id FROM task_levels WHERE id = ?").bind(sync.level_id).first())?.id) || await defaultLevelId(db);
  const ts = now();
  const m = await db.prepare("INSERT INTO memories(title, content, kind, project_id, group_id, source, created_at, updated_at) VALUES (?,?,'tache',?,?,'Google Agenda',?,?)")
    .bind(titre, detail || titre, projectId, groupId, ts, ts).run();
  const id = m.meta.last_row_id;
  await db.prepare("INSERT INTO tasks(memory_id, type_id, level_id, status, due_date, due_time, gcal_event_id, gcal_updated, gcal_dirty, created_at, updated_at) VALUES (?,?,?,'a_faire',?,?,?,?,0,?,?)")
    .bind(id, type.id, levelId, due.date, due.time, ev.id, ev.updated, ts, ts).run();
  await reindex(db, id);
  return 1;
}

async function pull(db, sync, token, fetchFn, at) {
  let pulled = 0, pageToken = null, syncToken = sync.sync_token;
  const cal = encodeURIComponent(sync.calendar_id);
  for (let page = 0; page < MAX_PAGES; page++) {
    const q = new URLSearchParams({ singleEvents: "true", showDeleted: "true", maxResults: "250" });
    if (pageToken) q.set("pageToken", pageToken);
    if (syncToken) q.set("syncToken", syncToken);
    else q.set("timeMin", new Date(at.getTime() - 86400_000).toISOString()); // première synchro : à partir d'hier
    const r = await gapi(fetchFn, token, "GET", `/calendars/${cal}/events?${q}`);
    if (r.status === 410) { // jeton de synchro périmé : resynchro complète
      syncToken = null; pageToken = null;
      await setSync(db, { sync_token: null });
      continue;
    }
    if (!r.ok) throw apiError(r, "lecture");
    for (const ev of r.json.items || []) pulled += await pullEvent(db, sync, ev);
    if (r.json.nextPageToken) { pageToken = r.json.nextPageToken; continue; }
    if (r.json.nextSyncToken) await setSync(db, { sync_token: r.json.nextSyncToken });
    break;
  }
  return pulled;
}

async function push(db, sync, token, fetchFn) {
  let pushed = 0;
  const cal = encodeURIComponent(sync.calendar_id);
  const del = async (calendarId, eventId) => {
    const r = await gapi(fetchFn, token, "DELETE", `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
    if (!r.ok && r.status !== 404 && r.status !== 410) throw apiError(r, "suppression");
  };
  for (const x of (await db.prepare("SELECT * FROM gcal_trash LIMIT ?").bind(MAX_PUSH).all()).results) {
    if (x.calendar_id) await del(x.calendar_id, x.event_id);
    await db.prepare("DELETE FROM gcal_trash WHERE event_id = ?").bind(x.event_id).run();
    pushed++;
  }
  const rows = (await db.prepare(`${TASK_SELECT} WHERE t.gcal_dirty = 1 ORDER BY t.updated_at LIMIT ?`).bind(MAX_PUSH).all()).results;
  const clear = (id, eventId = null, updated = null) =>
    db.prepare("UPDATE tasks SET gcal_event_id = ?, gcal_updated = ?, gcal_dirty = 0 WHERE memory_id = ?").bind(eventId, updated, id).run();
  for (const t of rows) {
    const wanted = t.type_sync === "google" && t.due_date && t.status !== "annule";
    if (!wanted) { // plus synchronisée (autre type, annulée, sans date) : l'événement disparaît de l'agenda
      if (t.gcal_event_id) { await del(sync.calendar_id, t.gcal_event_id); pushed++; }
      await clear(t.memory_id);
      continue;
    }
    const body = eventBody(t, sync.duration_minutes || 60);
    let r = t.gcal_event_id ? await gapi(fetchFn, token, "PATCH", `/calendars/${cal}/events/${encodeURIComponent(t.gcal_event_id)}`, body) : null;
    if (r && (r.status === 404 || r.status === 410)) { // supprimé dans Google entre-temps : la suppression gagne
      await db.prepare("UPDATE tasks SET status = 'annule', gcal_event_id = NULL, gcal_updated = NULL, gcal_dirty = 0, updated_at = ? WHERE memory_id = ?").bind(now(), t.memory_id).run();
      continue;
    }
    if (!r) r = await gapi(fetchFn, token, "POST", `/calendars/${cal}/events`, body);
    if (!r.ok) throw apiError(r, "envoi");
    await clear(t.memory_id, r.json.id, r.json.updated);
    pushed++;
  }
  return pushed;
}

// Une synchro complète. Ne lève pas d'exception : l'erreur est gardée dans google_sync.last_error (affichée dans /admin).
export async function syncGoogle(db, env, { fetchFn = fetch, at = new Date() } = {}) {
  if (!googleConfigured(env)) return { skipped: "non configuré" };
  const sync = await getSync(db);
  if (!sync.refresh_token || !sync.calendar_id) return { skipped: "non connecté" };
  try {
    const token = await accessToken(env, sync.refresh_token, fetchFn);
    const pulled = await pull(db, sync, token, fetchFn, at);
    const pushed = await push(db, sync, token, fetchFn);
    await setSync(db, { last_sync: now(), last_error: null });
    return { pulled, pushed };
  } catch (e) {
    await setSync(db, { last_error: e.message });
    return { error: e.message };
  }
}

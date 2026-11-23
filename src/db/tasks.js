import { now } from "../util.js";

// ------------------------------------------------------------------ tâches (souvenirs avec échéance, criticité, statut)
export const TASK_STATUSES = ["a_faire", "silencieux", "fait", "annule"];
export const OPEN_STATUSES = ["a_faire", "silencieux"];
export const ALERTS = ["aucune", "notification", "alarme"];
export const RECUR_UNITS = ["jour", "semaine", "mois", "an"];
export const TZ = "Europe/Paris";

export const DEFAULT_SETTINGS = { rappels_max: "5" };

// Date et heure courantes à Paris : { date: "AAAA-MM-JJ", time: "HH:MM" }.
export function parisNow(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

const validDate = (y, m, d) => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};
const pad = (n) => String(n).padStart(2, "0");

// « 2026-11-25 », « 2026-11-25 14:30 », « 2026-11-25T14h », « 25/11/2026 14h30 » → { date, time } ; "" → { date: null, time: null }.
export function parseDue(s) {
  s = String(s ?? "").trim();
  if (!s) return { date: null, time: null };
  const m = s.match(/^(?:(\d{4})-(\d{1,2})-(\d{1,2})|(\d{1,2})\/(\d{1,2})\/(\d{4}))(?:[ T]+(\d{1,2})(?:[:h](\d{2})?)?)?$/i);
  if (!m) return { error: "Erreur : échéance invalide (format AAAA-MM-JJ ou AAAA-MM-JJ HH:MM)." };
  const [y, mo, d] = m[1] ? [+m[1], +m[2], +m[3]] : [+m[6], +m[5], +m[4]];
  if (!validDate(y, mo, d)) return { error: "Erreur : échéance invalide (date inexistante)." };
  let time = null;
  if (m[7] != null) {
    const h = +m[7], mi = +(m[8] ?? 0);
    if (h > 23 || mi > 59) return { error: "Erreur : heure invalide." };
    time = `${pad(h)}:${pad(mi)}`;
  }
  return { date: `${y}-${pad(mo)}-${pad(d)}`, time };
}

// « 3 mois », « 1 semaine », « mois », « 2 ans » → { every, unit } ; "" → { every: null, unit: null }.
export function parseRecurrence(s) {
  s = String(s ?? "").trim().toLowerCase();
  if (!s) return { every: null, unit: null };
  const m = s.match(/^(?:tou(?:s|tes) les\s+)?(\d+)?\s*(jours?|semaines?|mois|ans?|ann[ée]es?)$/);
  if (!m) return { error: "Erreur : récurrence invalide (ex. « 1 mois », « 2 semaines », « 1 an »)." };
  const every = m[1] ? parseInt(m[1]) : 1;
  if (every < 1 || every > 999) return { error: "Erreur : récurrence invalide." };
  const unit = m[2].startsWith("jour") ? "jour" : m[2].startsWith("semaine") ? "semaine" : m[2] === "mois" ? "mois" : "an";
  return { every, unit };
}

// Prochaine occurrence : échéance + période (fin de mois si le jour n'existe pas, ex. 31/01 + 1 mois → 28/02).
export function nextDue(date, every, unit) {
  const [y, m, d] = date.split("-").map(Number);
  if (unit === "jour" || unit === "semaine") {
    const t = new Date(Date.UTC(y, m - 1, d + every * (unit === "semaine" ? 7 : 1)));
    return t.toISOString().slice(0, 10);
  }
  const months = unit === "mois" ? every : every * 12;
  const total = (m - 1) + months;
  const ny = y + Math.floor(total / 12), nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${pad(nm)}-${pad(Math.min(d, last))}`;
}

export const recurrenceLabel = (t) => (t.recur_unit ? `${t.recur_every} ${t.recur_unit}${t.recur_every > 1 && t.recur_unit !== "mois" ? "s" : ""}` : "");

// Date courte : « 25/11 » (année en cours), « 25/11/2027 » sinon ; heure « 14h » ou « 14h30 ».
export function shortDate(date, today) {
  const [y, m, d] = date.split("-");
  return `${d}/${m}` + (y === today.slice(0, 4) ? "" : `/${y}`);
}
export const shortTime = (t) => (t ? t.slice(0, 2).replace(/^0/, "") + "h" + (t.slice(3) === "00" ? "" : t.slice(3)) : "");

// Une ligne compacte par tâche : « #12 !! Appeler le plombier — retard 25/11 14h · Rendez-vous ».
export function taskLine(t, today, { defaultTypeId = null, detail = false } = {}) {
  let s = `#${t.id}${t.marker ? " " + t.marker : ""} ${t.title}`;
  if (t.due_date) {
    const when = t.due_date === today ? "aujourd'hui" : (t.due_date < today && OPEN_STATUSES.includes(t.status) ? "retard " : "") + shortDate(t.due_date, today);
    s += ` — ${when}${t.due_time ? " " + shortTime(t.due_time) : ""}`;
  }
  const extra = [];
  if (defaultTypeId != null && t.type_id !== defaultTypeId) extra.push(t.type);
  if (t.recur_unit) extra.push(`↻ ${recurrenceLabel(t)}`);
  if (t.status !== "a_faire") extra.push(t.status === "fait" && t.done_at ? `fait ${shortDate(t.done_at.slice(0, 10), today)}` : t.status);
  if (detail) {
    extra.push(t.level);
    if (t.project) extra.push(`projet: ${t.project}`);
  }
  if (extra.length) s += " · " + extra.join(" · ");
  if (detail && t.content && t.content.trim() !== t.title.trim()) {
    let c = t.content.trim().replace(/\n/g, " ");
    if (c.length > 200) c = c.slice(0, 200).trimEnd() + "…";
    s += `\n  ${c}`;
  }
  return s;
}

export const TASK_SELECT = `SELECT t.*, t.memory_id AS id, m.title, m.content, m.group_id, m.project_id, p.name AS project,
  l.name AS level, l.marker, l.position AS level_pos, l.horizon_days, ty.name AS type
  FROM tasks t JOIN memories m ON m.id = t.memory_id LEFT JOIN projects p ON p.id = m.project_id
  JOIN task_levels l ON l.id = t.level_id JOIN task_types ty ON ty.id = t.type_id`;

export async function getSetting(db, key) {
  const r = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first();
  return r ? r.value : DEFAULT_SETTINGS[key];
}

export const defaultTypeId = async (db) =>
  (await db.prepare("SELECT id FROM task_types ORDER BY is_default DESC, position, id LIMIT 1").first())?.id ?? null;

export const defaultLevelId = async (db) =>
  (await db.prepare("SELECT id FROM task_levels ORDER BY is_default DESC, position, id LIMIT 1").first())?.id ?? null;

// Cherche un type ou un niveau par nom (insensible à la casse) ; renvoie son id ou { error } avec la liste des noms.
export async function findByName(db, table, name, label) {
  const rows = (await db.prepare(`SELECT id, name FROM ${table} ORDER BY position, id`).all()).results;
  const hit = rows.find((r) => r.name.toLowerCase() === String(name).trim().toLowerCase());
  return hit ? hit.id : { error: `Erreur : ${label} inconnu(e). Valeurs : ${rows.map((r) => r.name).join(", ")}.` };
}

// Rappels du début de conversation : tâches à faire, datées, en retard, du jour ou dans l'horizon de leur niveau.
export async function reminders(db, acl, scope) {
  const today = parisNow().date;
  const rows = (await db.prepare(`${TASK_SELECT} WHERE t.status = 'a_faire' AND t.due_date IS NOT NULL
    AND t.due_date <= date(?, '+' || l.horizon_days || ' days') AND ${acl.sqlIn("m.group_id", scope)}
    ORDER BY l.position, t.due_date, COALESCE(t.due_time, '')`).bind(today).all()).results;
  if (!rows.length) return "";
  const max = Math.max(1, parseInt(await getSetting(db, "rappels_max")) || 5);
  const dt = await defaultTypeId(db);
  const lines = rows.slice(0, max).map((t) => taskLine(t, today, { defaultTypeId: dt }));
  if (rows.length > max) lines.push(`+ ${rows.length - max} autre(s) (list_tasks)`);
  return "Rappels :\n" + lines.join("\n");
}

export const touchTask = (db, id) => db.prepare("UPDATE tasks SET updated_at = ? WHERE memory_id = ?").bind(now(), id).run();

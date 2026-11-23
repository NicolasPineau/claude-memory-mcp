import { memoryTags, reindex, setTags, touchProject } from "./memories.js";
import { now } from "../util.js";

// ------------------------------------------------------------------ tâches (souvenirs avec échéance, criticité, statut)
export const TASK_STATUSES = ["a_faire", "silencieux", "fait", "annule"];
export const OPEN_STATUSES = ["a_faire", "silencieux"];
export const ALERTS = ["aucune", "notification", "alarme"];
export const RECUR_UNITS = ["jour", "semaine", "mois", "an"];
export const TZ = "Europe/Paris";

// Réglages modifiables dans /admin. `reports` : une ligne par choix « Libellé=règle » (voir parseReports).
export const DEFAULT_SETTINGS = {
  rappels_max: "5",
  alerte_matin: "08:00",
  reports: "+1 h=+1h\nCe soir 18 h=18:00\nDemain matin=+1j 08:00\n+1 semaine=+7j",
};

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
  l.name AS level, l.marker, l.position AS level_pos, l.horizon_days, l.alert, l.alert_from, l.alert_to, l.repeat_minutes, ty.name AS type, ty.sync AS type_sync
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

// ------------------------------------------------------------------ modification d'une tâche (outil MCP et page mobile)
const ECH_ERR = "AAAA-MM-JJ ou AAAA-MM-JJ HH:MM";
export { ECH_ERR };

// Valide et résout les champs d'une modification. Renvoie les colonnes à changer, ou { error }.
export async function taskFields(db, a) {
  const out = {};
  if (a.echeance != null) {
    const d = parseDue(a.echeance);
    if (d.error) return d;
    out.due_date = d.date; out.due_time = d.time;
  }
  if (a.recurrence != null) {
    const r = parseRecurrence(a.recurrence);
    if (r.error) return r;
    out.recur_every = r.every; out.recur_unit = r.unit;
  }
  if (a.criticite != null && String(a.criticite).trim()) {
    const id = await findByName(db, "task_levels", a.criticite, "criticité");
    if (id.error) return id;
    out.level_id = id;
  }
  if (a.type != null && String(a.type).trim()) {
    const id = await findByName(db, "task_types", a.type, "type");
    if (id.error) return id;
    out.type_id = id;
  }
  if (a.statut != null) {
    if (!TASK_STATUSES.includes(a.statut)) return { error: `Erreur : statut invalide (${TASK_STATUSES.join(", ")}).` };
    out.status = a.statut;
  }
  return out;
}

// Crée l'occurrence suivante d'une tâche récurrente (nouveau souvenir, mêmes projet, groupe, tags, type et niveau).
async function createNextOccurrence(db, t) {
  const due = nextDue(t.due_date, t.recur_every, t.recur_unit), ts = now();
  const m = await db.prepare("SELECT * FROM memories WHERE id = ?").bind(t.memory_id).first();
  const r = await db.prepare("INSERT INTO memories(title, content, kind, project_id, group_id, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .bind(m.title, m.content, m.kind, m.project_id, m.group_id, m.source, ts, ts).run();
  const id = r.meta.last_row_id;
  await db.prepare("INSERT INTO tasks(memory_id, type_id, level_id, status, due_date, due_time, recur_every, recur_unit, gcal_dirty, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,(SELECT sync = 'google' FROM task_types WHERE id = ?),?,?)")
    .bind(id, t.type_id, t.level_id, "a_faire", due, t.due_time, t.recur_every, t.recur_unit, t.type_id, ts, ts).run();
  await setTags(db, id, await memoryTags(db, t.memory_id));
  await reindex(db, id);
  return { id, due };
}

// Applique une modification à la tâche `t` (ligne de TASK_SELECT). `a` : champs de update_task, plus `vu` (accusé de réception)
// et `fromGoogle` (changement venu de Google Agenda : rien à renvoyer). Un changement d'échéance ou de statut réarme les alertes ;
// sur une tâche synchronisée (ou qui cesse de l'être), il est marqué à envoyer à Google. Renvoie { error } ou { next }.
export async function applyTaskUpdate(db, t, a) {
  const f = await taskFields(db, a);
  if (f.error) return f;
  const n = { ...t, ...f };
  if (n.recur_unit && !n.due_date) return { error: "Erreur : une tâche récurrente doit avoir une échéance." };
  const ts = now();
  const becomesDone = n.status === "fait" && t.status !== "fait";
  n.done_at = n.status === "fait" ? (becomesDone ? ts : t.done_at) : null;
  const rearm = n.due_date !== t.due_date || n.due_time !== t.due_time || n.status !== t.status || n.level_id !== t.level_id;
  const ack = a.vu ? 1 : rearm ? 0 : t.alert_ack;
  const changed = Object.keys(a).some((k) => !["id", "vu", "fromGoogle"].includes(k) && a[k] != null);
  const syncNew = n.type_id === t.type_id ? t.type_sync : (await db.prepare("SELECT sync FROM task_types WHERE id = ?").bind(n.type_id).first())?.sync;
  const dirty = a.fromGoogle ? 0 : changed && (t.type_sync === "google" || syncNew === "google") ? 1 : t.gcal_dirty ?? 0;
  await db.prepare("UPDATE tasks SET type_id=?, level_id=?, status=?, due_date=?, due_time=?, recur_every=?, recur_unit=?, done_at=?, alert_last=?, alert_ack=?, gcal_dirty=?, updated_at=? WHERE memory_id=?")
    .bind(n.type_id, n.level_id, n.status, n.due_date, n.due_time, n.recur_every, n.recur_unit, n.done_at, rearm ? null : t.alert_last, ack, dirty, ts, t.memory_id).run();
  const titre = a.titre != null ? String(a.titre).trim() : "";
  if (titre || a.detail != null) {
    const title = titre || t.title;
    await db.prepare("UPDATE memories SET title=?, content=?, updated_at=? WHERE id=?")
      .bind(title, a.detail != null ? (String(a.detail).trim() || title) : t.content, ts, t.memory_id).run();
    await reindex(db, t.memory_id);
  }
  await touchProject(db, t.project_id);
  return { next: becomesDone && n.recur_unit && n.due_date ? await createNextOccurrence(db, n) : null };
}

// ------------------------------------------------------------------ reports (« Repousser »)
// Règles : « +90m », « +1h » (à partir de maintenant), « 18:00 » (prochaine fois qu'il est 18 h),
// « +1j » / « +7j 08:00 » (dans N jours, à l'heure donnée, sinon à l'heure actuelle de l'échéance).
const REPORT_RE = /^(?:\+(\d+)\s*(m|min|h)|([01]?\d|2[0-3]):([0-5]\d)|\+(\d+)\s*j(?:\s+([01]?\d|2[0-3]):([0-5]\d))?)$/i;

export function parseReports(text) {
  const out = [];
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const i = line.lastIndexOf("=");
    const label = line.slice(0, i).trim(), rule = line.slice(i + 1).trim();
    if (i < 1 || !label || !REPORT_RE.test(rule)) return { error: `Report invalide : « ${line} » (format « Libellé=règle », règles : +1h, +30m, 18:00, +1j, +7j 08:00).` };
    out.push({ label, rule });
  }
  if (!out.length) return { error: "Il faut au moins un choix de report." };
  return { list: out };
}

const addDays = (date, n) => new Date(Date.parse(date + "T12:00:00Z") + n * 86400_000).toISOString().slice(0, 10);

// Nouvelle échéance { date, time } pour une règle, à partir de l'instant `at` (Date).
export function reportTarget(rule, task, at = new Date()) {
  const m = rule.match(REPORT_RE);
  if (!m) return null;
  const p = parisNow(at);
  if (m[1]) return parisNow(new Date(at.getTime() + Number(m[1]) * (m[2].toLowerCase() === "h" ? 3600_000 : 60_000)));
  if (m[3] != null) {
    const time = `${pad(+m[3])}:${m[4]}`;
    return { date: time > p.time ? p.date : addDays(p.date, 1), time };
  }
  return { date: addDays(p.date, Number(m[5])), time: m[6] != null ? `${pad(+m[6])}:${m[7]}` : task.due_time ?? null };
}

// Un souvenir de type « tache » créé autrement que par add_task (remember, update_memory, /admin) : ligne de tâche par défaut,
// sans échéance, pour qu'il soit listé et puisse recevoir échéance et criticité. Sans effet si la ligne existe.
export async function ensureTaskRow(db, memoryId) {
  const ts = now();
  await db.prepare(`INSERT OR IGNORE INTO tasks(memory_id, type_id, level_id, status, gcal_dirty, created_at, updated_at)
    SELECT m.id, ty.id, (SELECT id FROM task_levels ORDER BY is_default DESC, position, id LIMIT 1), 'a_faire', 0, ?, ?
    FROM memories m, (SELECT id FROM task_types ORDER BY is_default DESC, position, id LIMIT 1) ty WHERE m.id = ? AND m.kind = 'tache'`).bind(ts, ts, memoryId).run();
}

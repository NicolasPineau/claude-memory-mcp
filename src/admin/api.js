import { MAX_BYTES, MAX_FILE_MB, STATUTS } from "../config.js";
import { generateKey, masterKeyEnabled, sha256hex } from "../auth/keys.js";
import { ACCESS, MAX_DEPTH, effectiveRights, loadGroups } from "../db/groups.js";
import { deleteMemory, ftsQuery, moveProject, reindex, reindexProject, setTags, syncMemoryFiles, touchProject } from "../db/memories.js";
import { deleteFile, storeFile } from "../files/storage.js";
import { ALERTS, DEFAULT_SETTINGS, getSetting, parseReports } from "../db/tasks.js";
import { getSync, googleConfigured, listCalendars, setSync, syncGoogle } from "../google/calendar.js";
import { cleanName, guessMime, jsonOk, normTags, now } from "../util.js";

export const likeArg = (q) => `%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`;

export async function tagsByMemory(db, ids) {
  const map = {};
  if (!ids.length) return map;
  const rows = (await db.prepare(`SELECT mt.memory_id, t.name FROM memory_tags mt JOIN tags t ON t.id = mt.tag_id WHERE mt.memory_id IN (${ids.map(() => "?").join(",")}) ORDER BY t.name`).bind(...ids).all()).results;
  for (const r of rows) (map[r.memory_id] ||= []).push(r.name);
  return map;
}

export async function projectFrom(db, v) {
  if (v === null || v === "" || v === undefined || Number(v) === 0) return null;
  const p = await db.prepare("SELECT id, group_id FROM projects WHERE id = ?").bind(Number(v)).first();
  if (!p) throw new ApiError(404, "Projet introuvable.");
  return p;
}

export async function groupIdFrom(db, v, required = true) {
  if (v === null || v === "" || v === undefined || Number(v) === 0) {
    if (required) throw new ApiError(400, "Le groupe est obligatoire.");
    return null;
  }
  const g = await db.prepare("SELECT id FROM groups WHERE id = ?").bind(Number(v)).first();
  if (!g) throw new ApiError(404, "Groupe introuvable.");
  return g.id;
}

// Rangement d'un élément : le groupe de son projet, sinon le groupe donné (obligatoire sans projet).
async function placementFrom(db, projetId, groupId) {
  const p = await projectFrom(db, projetId);
  if (p) return { projectId: p.id, groupId: p.group_id };
  return { projectId: null, groupId: await groupIdFrom(db, groupId) };
}

// Règles d'une clé : { group_id: "rw" | "ro" | "none" }, les groupes absents héritent de leur parent.
async function rulesFrom(db, regles) {
  const out = new Map();
  for (const [gid, acc] of Object.entries(regles || {})) {
    if (!acc) continue;
    if (!ACCESS.includes(acc)) throw new ApiError(400, `Droit invalide : ${acc}.`);
    out.set(await groupIdFrom(db, gid), acc);
  }
  return out;
}

async function checkDefaultGroup(db, defaultGroupId, rules) {
  const tree = await loadGroups(db);
  if (effectiveRights(tree, rules).get(defaultGroupId) !== "rw")
    throw new ApiError(400, "Le groupe par défaut doit être en lecture-écriture pour cette clé.");
}

const ruleStmts = (db, keyId, rules) => [
  db.prepare("DELETE FROM api_key_rules WHERE key_id = ?").bind(keyId),
  ...[...rules].map(([gid, acc]) => db.prepare("INSERT INTO api_key_rules(key_id, group_id, access) VALUES (?,?,?)").bind(keyId, gid, acc)),
];

// ------------------------------------------------------------------ types de tâche et niveaux de criticité
const HHMM = /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/;
const TASK_TABLES = {
  "types-taches": { table: "task_types", fk: "type_id", label: "type" },
  niveaux: { table: "task_levels", fk: "level_id", label: "niveau" },
};

const intIn = (v, min, max, what) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new ApiError(400, `${what} : entier entre ${min} et ${max}.`);
  return n;
};

// Champs d'un type ou d'un niveau, validés ; `cur` = valeurs actuelles (modification).
function taskConfFields(res, b, cur = {}) {
  const nom = b.nom != null ? String(b.nom).trim() : cur.name;
  if (!nom) throw new ApiError(400, "Le nom est obligatoire.");
  const f = { name: nom, position: b.position != null ? intIn(b.position, 0, 999, "Ordre") : cur.position ?? 0, is_default: b.par_defaut != null ? (b.par_defaut ? 1 : 0) : cur.is_default ?? 0 };
  if (res === "types-taches") {
    f.sync = b.synchro != null ? String(b.synchro) : cur.sync ?? "";
    if (!["", "google"].includes(f.sync)) throw new ApiError(400, "Synchro invalide (aucune ou google).");
    return f;
  }
  f.marker = b.marqueur != null ? String(b.marqueur).trim().slice(0, 4) : cur.marker ?? "";
  f.horizon_days = b.horizon_jours != null ? intIn(b.horizon_jours, 0, 365, "Horizon") : cur.horizon_days ?? 0;
  f.alert = b.alerte != null ? String(b.alerte) : cur.alert ?? "aucune";
  if (!ALERTS.includes(f.alert)) throw new ApiError(400, `Alerte invalide (${ALERTS.join(", ")}).`);
  f.alert_from = b.plage_debut != null ? String(b.plage_debut) : cur.alert_from ?? "07:00";
  f.alert_to = b.plage_fin != null ? String(b.plage_fin) : cur.alert_to ?? "24:00";
  if (!HHMM.test(f.alert_from) || !HHMM.test(f.alert_to)) throw new ApiError(400, "Plage d'alerte invalide (HH:MM).");
  f.repeat_minutes = b.relance_minutes != null ? intIn(b.relance_minutes, 0, 10080, "Relance") : cur.repeat_minutes ?? 0;
  return f;
}

async function saveTaskConf(db, res, id, f) {
  const { table } = TASK_TABLES[res], ts = now(), cols = Object.keys(f);
  const stmts = f.is_default ? [db.prepare(`UPDATE ${table} SET is_default = 0`)] : [];
  try {
    if (id) stmts.push(db.prepare(`UPDATE ${table} SET ${cols.map((c) => c + " = ?").join(", ")}, updated_at = ? WHERE id = ?`).bind(...Object.values(f), ts, id));
    else stmts.push(db.prepare(`INSERT INTO ${table}(${cols.join(", ")}, created_at, updated_at) VALUES (${cols.map(() => "?").join(", ")}, ?, ?)`).bind(...Object.values(f), ts, ts));
    const r = await db.batch(stmts);
    return r[r.length - 1].meta.last_row_id;
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) throw new ApiError(409, `« ${f.name} » existe déjà.`);
    throw e;
  }
}

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function readJson(request) {
  try { return await request.json(); }
  catch { throw new ApiError(400, "JSON invalide."); }
}

// Sauvegardes présentes dans le bucket R2 lié (binding BACKUPS), les plus récentes d'abord.
export async function listBackups(env) {
  if (!env.BACKUPS) return null;
  const out = [];
  let cursor;
  do {
    const page = await env.BACKUPS.list({ prefix: "db/", cursor, limit: 1000 });
    out.push(...page.objects.map((o) => ({ nom: o.key, taille: o.size, date: o.uploaded instanceof Date ? o.uploaded.toISOString() : String(o.uploaded) })));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out.sort((a, b) => b.nom.localeCompare(a.nom));
}

export async function adminApi(request, db, path, url, env = {}, quota = null) {
  const m = request.method;
  const [res, idRaw] = path;
  const id = idRaw;

  // --- consommation et sauvegardes
  if (res === "conso" && !id && m === "GET") {
    return jsonOk({
      configure: quota?.configured ?? false,
      verifie_le: quota?.verifiedAt ? new Date(quota.verifiedAt).toISOString() : null,
      erreur: quota?.error ?? null,
      metriques: quota?.rows ?? [],
      bloque: (quota?.blocked ?? []).map((r) => r.metric),
      sauvegardes: quota?.blocked.length ? null : await listBackups(env),
    });
  }

  // --- groupes
  if (res === "groupes" && !id && m === "GET") {
    const tree = await loadGroups(db);
    const count = async (sql) => new Map((await db.prepare(sql).all()).results.map((r) => [r.group_id, r.n]));
    const np = await count("SELECT group_id, COUNT(*) n FROM projects GROUP BY group_id");
    const nm = await count("SELECT group_id, COUNT(*) n FROM memories GROUP BY group_id");
    const nf = await count("SELECT group_id, COUNT(*) n FROM files GROUP BY group_id");
    const groupes = tree.ordered().map((g) => ({ id: g.id, parent_id: g.parent_id, nom: g.name, description: g.description, chemin: g.path, niveau: g.depth,
      hauteur: tree.height(g.id), n_projets: np.get(g.id) || 0, n_souvenirs: nm.get(g.id) || 0, n_fichiers: nf.get(g.id) || 0, n_enfants: (tree.children.get(g.id) || []).length }));
    return jsonOk({ groupes, profondeur_max: MAX_DEPTH });
  }
  if (res === "groupes" && !id && m === "POST") {
    const b = await readJson(request);
    const nom = String(b.nom || "").trim();
    if (!nom || /[\/›]/.test(nom)) throw new ApiError(400, "Nom de groupe invalide (obligatoire, sans « / » ni « › »).");
    const parent = await groupIdFrom(db, b.parent_id, false);
    if (parent && (await loadGroups(db)).depth(parent) >= MAX_DEPTH) throw new ApiError(400, `Profondeur maximale : ${MAX_DEPTH} niveaux.`);
    const ts = now();
    try {
      const r = await db.prepare("INSERT INTO groups(parent_id, name, description, created_at, updated_at) VALUES (?,?,?,?,?)").bind(parent, nom, String(b.description || ""), ts, ts).run();
      return jsonOk({ ok: true, id: r.meta.last_row_id });
    } catch (e) {
      throw new ApiError(409, `Un groupe « ${nom} » existe déjà à cet endroit.`);
    }
  }
  if (res === "groupes" && id && m === "PATCH") {
    const tree = await loadGroups(db);
    const g = tree.get(id);
    if (!g) throw new ApiError(404, "Groupe introuvable.");
    const b = await readJson(request);
    const nom = b.nom != null ? String(b.nom).trim() : g.name;
    if (!nom || /[\/›]/.test(nom)) throw new ApiError(400, "Nom de groupe invalide (obligatoire, sans « / » ni « › »).");
    let parent = g.parent_id;
    if ("parent_id" in b) {
      parent = await groupIdFrom(db, b.parent_id, false);
      if (parent && tree.descendants(g.id).includes(parent)) throw new ApiError(400, "Un groupe ne peut pas être déplacé sous lui-même ou sous un de ses sous-groupes.");
      if ((parent ? tree.depth(parent) : 0) + tree.height(g.id) > MAX_DEPTH) throw new ApiError(400, `Profondeur maximale : ${MAX_DEPTH} niveaux.`);
    }
    try {
      await db.prepare("UPDATE groups SET name=?, description=?, parent_id=?, updated_at=? WHERE id=?")
        .bind(nom, b.description != null ? String(b.description) : g.description, parent, now(), g.id).run();
    } catch (e) {
      throw new ApiError(409, `Un groupe « ${nom} » existe déjà à cet endroit.`);
    }
    return jsonOk({ ok: true });
  }
  if (res === "groupes" && id && m === "DELETE") {
    const gid = Number(id);
    const u = await db.prepare("SELECT (SELECT COUNT(*) FROM groups WHERE parent_id = ?1) + (SELECT COUNT(*) FROM projects WHERE group_id = ?1) + (SELECT COUNT(*) FROM memories WHERE group_id = ?1) + (SELECT COUNT(*) FROM files WHERE group_id = ?1) AS n, (SELECT COUNT(*) FROM api_keys WHERE default_group_id = ?1 AND revoked_at IS NULL) AS k").bind(gid).first();
    if (u.n) throw new ApiError(409, "Ce groupe n'est pas vide : déplace d'abord ses sous-groupes, projets, souvenirs et fichiers.");
    if (u.k) throw new ApiError(409, "Ce groupe est le groupe par défaut d'une clé : change-le d'abord.");
    const r = await db.batch([
      db.prepare("DELETE FROM api_key_rules WHERE group_id = ?").bind(gid),
      db.prepare("DELETE FROM groups WHERE id = ?").bind(gid),
    ]);
    if (!r[1].meta.changes) throw new ApiError(404, "Groupe introuvable.");
    return jsonOk({ ok: true });
  }

  // --- clés d'accès (une par compte Claude)
  if (res === "cles" && !id && m === "GET") {
    const keys = (await db.prepare("SELECT id, name, default_group_id, show_reminders, created_at, last_used_at, revoked_at FROM api_keys ORDER BY revoked_at IS NOT NULL, created_at").all()).results;
    const rules = (await db.prepare("SELECT key_id, group_id, access FROM api_key_rules").all()).results;
    for (const k of keys) k.regles = Object.fromEntries(rules.filter((r) => r.key_id === k.id).map((r) => [r.group_id, r.access]));
    return jsonOk({ cles: keys, cle_maitresse_active: masterKeyEnabled(env) });
  }
  if (res === "cles" && !id && m === "POST") {
    const b = await readJson(request);
    const nom = String(b.nom || "").trim();
    if (!nom) throw new ApiError(400, "Le nom est obligatoire.");
    const def = await groupIdFrom(db, b.groupe_defaut_id);
    const rules = await rulesFrom(db, b.regles);
    await checkDefaultGroup(db, def, rules);
    const key = generateKey();
    const r = await db.prepare("INSERT INTO api_keys(name, key_hash, default_group_id, show_reminders, created_at) VALUES (?,?,?,?,?)").bind(nom, await sha256hex(key), def, b.rappels === false ? 0 : 1, now()).run();
    const kid = r.meta.last_row_id;
    await db.batch(ruleStmts(db, kid, rules));
    return jsonOk({ ok: true, id: kid, cle: key, url: `${url.origin}/${key}/mcp` });
  }
  if (res === "cles" && id && m === "PATCH") {
    const k = await db.prepare("SELECT * FROM api_keys WHERE id = ?").bind(Number(id)).first();
    if (!k) throw new ApiError(404, "Clé introuvable.");
    if (k.revoked_at) throw new ApiError(409, "Cette clé est révoquée.");
    const b = await readJson(request);
    const nom = b.nom != null ? String(b.nom).trim() : k.name;
    if (!nom) throw new ApiError(400, "Le nom ne peut pas être vide.");
    const def = b.groupe_defaut_id != null ? await groupIdFrom(db, b.groupe_defaut_id) : k.default_group_id;
    const rules = b.regles != null ? await rulesFrom(db, b.regles)
      : new Map((await db.prepare("SELECT group_id, access FROM api_key_rules WHERE key_id = ?").bind(k.id).all()).results.map((r) => [r.group_id, r.access]));
    await checkDefaultGroup(db, def, rules);
    const rappels = b.rappels != null ? (b.rappels ? 1 : 0) : k.show_reminders;
    await db.batch([db.prepare("UPDATE api_keys SET name = ?, default_group_id = ?, show_reminders = ? WHERE id = ?").bind(nom, def, rappels, k.id), ...ruleStmts(db, k.id, rules)]);
    return jsonOk({ ok: true });
  }
  if (res === "cles" && id && m === "DELETE") {
    const r = await db.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(now(), Number(id)).run();
    if (!r.meta.changes) throw new ApiError(404, "Clé introuvable ou déjà révoquée.");
    return jsonOk({ ok: true });
  }

  // --- tâches : types, niveaux de criticité, réglages
  if (res === "taches-config" && !id && m === "GET") {
    const count = async (fk) => new Map((await db.prepare(`SELECT ${fk} AS id, COUNT(*) n FROM tasks GROUP BY ${fk}`).all()).results.map((r) => [r.id, r.n]));
    const [nt, nl] = [await count("type_id"), await count("level_id")];
    const types = (await db.prepare("SELECT * FROM task_types ORDER BY position, id").all()).results.map((t) => ({ ...t, n_taches: nt.get(t.id) || 0 }));
    const niveaux = (await db.prepare("SELECT * FROM task_levels ORDER BY position, id").all()).results.map((l) => ({ ...l, n_taches: nl.get(l.id) || 0 }));
    const reglages = {};
    for (const k of Object.keys(DEFAULT_SETTINGS)) reglages[k] = await getSetting(db, k);
    return jsonOk({ types, niveaux, reglages, alertes: ALERTS });
  }
  if (TASK_TABLES[res] && !id && m === "POST") {
    return jsonOk({ ok: true, id: await saveTaskConf(db, res, null, taskConfFields(res, await readJson(request))) });
  }
  if (TASK_TABLES[res] && id && m === "PATCH") {
    const cur = await db.prepare(`SELECT * FROM ${TASK_TABLES[res].table} WHERE id = ?`).bind(Number(id)).first();
    if (!cur) throw new ApiError(404, "Introuvable.");
    const f = taskConfFields(res, await readJson(request), cur);
    if (cur.is_default && !f.is_default) throw new ApiError(400, "Il faut toujours un élément par défaut : coche « par défaut » sur un autre.");
    await saveTaskConf(db, res, cur.id, f);
    return jsonOk({ ok: true });
  }
  // Suppression : les tâches existantes basculent vers `?vers=<id>` (obligatoire s'il y en a, et si l'élément est celui par défaut).
  if (TASK_TABLES[res] && id && m === "DELETE") {
    const { table, fk, label } = TASK_TABLES[res];
    const cur = await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(Number(id)).first();
    if (!cur) throw new ApiError(404, "Introuvable.");
    const n = (await db.prepare(`SELECT COUNT(*) n FROM tasks WHERE ${fk} = ?`).bind(cur.id).first()).n;
    const vers = Number(url.searchParams.get("vers")) || null;
    if ((n || cur.is_default) && !vers) throw new ApiError(400, `Choisis le ${label} vers lequel basculer ${n ? `les ${n} tâche(s)` : "le réglage par défaut"}.`);
    if (vers === cur.id) throw new ApiError(400, `Le ${label} de bascule doit être différent.`);
    if (vers && !(await db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).bind(vers).first())) throw new ApiError(404, `${label} de bascule introuvable.`);
    const stmts = [];
    if (vers) stmts.push(db.prepare(`UPDATE tasks SET ${fk} = ?, updated_at = ? WHERE ${fk} = ?`).bind(vers, now(), cur.id));
    if (cur.is_default) stmts.push(db.prepare(`UPDATE ${table} SET is_default = 1 WHERE id = ?`).bind(vers));
    stmts.push(db.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(cur.id));
    await db.batch(stmts);
    return jsonOk({ ok: true, basculees: n });
  }
  if (res === "reglages" && !id && m === "PATCH") {
    const b = await readJson(request);
    const stmts = [];
    const set = (k, v) => stmts.push(db.prepare("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(k, v));
    if (b.rappels_max != null) set("rappels_max", String(intIn(b.rappels_max, 1, 50, "Rappels au démarrage")));
    if (b.alerte_matin != null) {
      if (!HHMM.test(String(b.alerte_matin)) || b.alerte_matin === "24:00") throw new ApiError(400, "Heure des alertes sans heure invalide (HH:MM).");
      set("alerte_matin", String(b.alerte_matin));
    }
    if (b.reports != null) {
      const r = parseReports(b.reports);
      if (r.error) throw new ApiError(400, r.error);
      set("reports", r.list.map((x) => `${x.label}=${x.rule}`).join("\n"));
    }
    if (stmts.length) await db.batch(stmts);
    return jsonOk({ ok: true });
  }

  // --- Google Agenda (synchro des rendez-vous)
  if (res === "google" && !id && m === "GET") {
    const g = await getSync(db);
    return jsonOk({ configure: googleConfigured(env), connecte: !!g.refresh_token, agenda_id: g.calendar_id, agenda_nom: g.calendar_name, groupe_id: g.group_id, projet_id: g.project_id,
      niveau_id: g.level_id, duree_minutes: g.duration_minutes, derniere_synchro: g.last_sync, erreur: g.last_error });
  }
  if (res === "google" && id === "agendas" && m === "GET") {
    const g = await getSync(db);
    if (!g.refresh_token) throw new ApiError(409, "Google n'est pas connecté.");
    try { return jsonOk({ agendas: await listCalendars(env, g.refresh_token) }); }
    catch (e) { throw new ApiError(502, e.message); }
  }
  if (res === "google" && !id && m === "PATCH") {
    const b = await readJson(request), g = await getSync(db), f = {};
    if ("groupe_id" in b) f.group_id = await groupIdFrom(db, b.groupe_id, false);
    if ("projet_id" in b) f.project_id = (await projectFrom(db, b.projet_id))?.id ?? null;
    if ("niveau_id" in b) {
      f.level_id = b.niveau_id ? Number(b.niveau_id) : null;
      if (f.level_id && !(await db.prepare("SELECT 1 FROM task_levels WHERE id = ?").bind(f.level_id).first())) throw new ApiError(404, "Niveau introuvable.");
    }
    if (b.duree_minutes != null) f.duration_minutes = intIn(b.duree_minutes, 5, 1440, "Durée");
    const stmts = [];
    if (b.agenda_id != null && String(b.agenda_id) !== (g.calendar_id || "")) {
      // Nouvel agenda : synchro repartie de zéro, les rendez-vous ouverts y seront recréés.
      f.calendar_id = String(b.agenda_id) || null;
      f.calendar_name = String(b.agenda_nom || "");
      f.sync_token = null;
      stmts.push(db.prepare("UPDATE tasks SET gcal_event_id = NULL, gcal_updated = NULL, gcal_dirty = CASE WHEN status IN ('a_faire', 'silencieux') AND due_date IS NOT NULL AND type_id IN (SELECT id FROM task_types WHERE sync = 'google') THEN 1 ELSE 0 END"));
      stmts.push(db.prepare("DELETE FROM gcal_trash"));
    }
    if (Object.keys(f).length) await setSync(db, f);
    if (stmts.length) await db.batch(stmts);
    return jsonOk({ ok: true });
  }
  if (res === "google" && id === "synchro" && m === "POST") {
    const r = await syncGoogle(db, env);
    if (r.error || r.skipped) throw new ApiError(r.error ? 502 : 409, r.error || `Synchro impossible : ${r.skipped}.`);
    return jsonOk({ ok: true, ...r });
  }
  if (res === "google" && !id && m === "DELETE") {
    await setSync(db, { refresh_token: null, sync_token: null, last_error: null });
    return jsonOk({ ok: true });
  }

  // --- projets
  if (res === "projets" && !id && m === "GET") {
    const rows = (await db.prepare("SELECT p.*, (SELECT COUNT(*) FROM memories WHERE project_id = p.id) AS n_souvenirs, (SELECT COUNT(*) FROM files WHERE project_id = p.id) AS n_fichiers FROM projects p ORDER BY p.status = 'archive', p.updated_at DESC").all()).results;
    const orphans = (await db.prepare("SELECT g.id AS group_id, (SELECT COUNT(*) FROM memories WHERE project_id IS NULL AND group_id = g.id) AS n_souvenirs, (SELECT COUNT(*) FROM files WHERE project_id IS NULL AND group_id = g.id) AS n_fichiers FROM groups g").all()).results
      .filter((o) => o.n_souvenirs || o.n_fichiers);
    return jsonOk({ projets: rows, sans_projet: orphans });
  }
  if (res === "projets" && !id && m === "POST") {
    const b = await readJson(request);
    const nom = String(b.nom || "").trim();
    if (!nom) throw new ApiError(400, "Le nom est obligatoire.");
    if (await db.prepare("SELECT 1 FROM projects WHERE name = ?").bind(nom).first()) throw new ApiError(409, `Un projet « ${nom} » existe déjà.`);
    const gid = await groupIdFrom(db, b.groupe_id);
    const statut = STATUTS.includes(b.statut) ? b.statut : "actif", ts = now();
    const r = await db.prepare("INSERT INTO projects(name, description, status, group_id, created_at, updated_at) VALUES (?,?,?,?,?,?)").bind(nom, String(b.description || ""), statut, gid, ts, ts).run();
    return jsonOk({ ok: true, id: r.meta.last_row_id });
  }
  if (res === "projets" && id && m === "GET") {
    const pid = Number(id);
    let projet = null;
    if (pid) {
      projet = await db.prepare("SELECT * FROM projects WHERE id = ?").bind(pid).first();
      if (!projet) throw new ApiError(404, "Projet introuvable.");
    }
    const gid = pid ? null : await groupIdFrom(db, url.searchParams.get("groupe"), false);
    const cond = pid ? "project_id = ?" : "project_id IS NULL" + (gid ? " AND group_id = ?" : "");
    const args = pid ? [pid] : gid ? [gid] : [];
    const souvenirs = (await db.prepare(`SELECT id, title, content, kind, source, group_id, project_id, created_at, updated_at FROM memories WHERE ${cond} ORDER BY updated_at DESC`).bind(...args).all()).results;
    const tags = await tagsByMemory(db, souvenirs.map((s) => s.id));
    for (const s of souvenirs) s.tags = tags[s.id] || [];
    const fichiers = (await db.prepare(`SELECT id, filename, mime, size, description, memory_id, project_id, group_id, created_at FROM files WHERE ${cond} ORDER BY created_at DESC`).bind(...args).all()).results;
    return jsonOk({ projet, groupe_id: projet ? projet.group_id : gid, souvenirs, fichiers });
  }
  if (res === "projets" && id && m === "PATCH") {
    const pid = Number(id);
    const r = await db.prepare("SELECT * FROM projects WHERE id = ?").bind(pid).first();
    if (!r) throw new ApiError(404, "Projet introuvable.");
    const b = await readJson(request);
    const nom = b.nom != null ? String(b.nom).trim() : r.name;
    if (!nom) throw new ApiError(400, "Le nom ne peut pas être vide.");
    if (nom.toLowerCase() !== r.name.toLowerCase() && await db.prepare("SELECT 1 FROM projects WHERE name = ?").bind(nom).first())
      throw new ApiError(409, `Un projet « ${nom} » existe déjà.`);
    const statut = b.statut != null ? (STATUTS.includes(b.statut) ? b.statut : null) : r.status;
    if (!statut) throw new ApiError(400, "Statut invalide.");
    const gid = b.groupe_id != null ? await groupIdFrom(db, b.groupe_id) : r.group_id;
    await db.prepare("UPDATE projects SET name=?, description=?, status=?, updated_at=? WHERE id=?")
      .bind(nom, b.description != null ? String(b.description) : r.description, statut, now(), pid).run();
    if (gid !== r.group_id) await moveProject(db, pid, gid);
    if (nom !== r.name) await reindexProject(db, pid);
    return jsonOk({ ok: true });
  }
  if (res === "projets" && id && m === "DELETE") {
    const pid = Number(id);
    const ids = (await db.prepare("SELECT id FROM memories WHERE project_id = ?").bind(pid).all()).results;
    const [, , del] = await db.batch([
      db.prepare("UPDATE memories SET project_id = NULL WHERE project_id = ?").bind(pid),
      db.prepare("UPDATE files SET project_id = NULL WHERE project_id = ?").bind(pid),
      db.prepare("DELETE FROM projects WHERE id = ?").bind(pid),
    ]);
    if (!del.meta.changes) throw new ApiError(404, "Projet introuvable.");
    for (const r of ids) await reindex(db, r.id);
    return jsonOk({ ok: true });
  }

  // --- souvenirs
  if (res === "souvenirs" && !id && m === "POST") {
    const b = await readJson(request);
    const titre = String(b.titre || "").trim(), contenu = String(b.contenu || "").trim();
    if (!titre || !contenu) throw new ApiError(400, "Titre et contenu sont obligatoires.");
    const { projectId: pid, groupId } = await placementFrom(db, b.projet_id, b.groupe_id), ts = now();
    const r = await db.prepare("INSERT INTO memories(title, content, kind, project_id, group_id, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)")
      .bind(titre, contenu, String(b.type || "note").trim() || "note", pid, groupId, "interface web", ts, ts).run();
    const mid = r.meta.last_row_id;
    await setTags(db, mid, normTags(b.tags));
    await reindex(db, mid);
    await touchProject(db, pid);
    return jsonOk({ ok: true, id: mid });
  }
  if (res === "souvenirs" && id && m === "PATCH") {
    const r = await db.prepare("SELECT * FROM memories WHERE id = ?").bind(Number(id)).first();
    if (!r) throw new ApiError(404, "Souvenir introuvable.");
    const b = await readJson(request);
    const titre = b.titre != null ? String(b.titre).trim() : r.title;
    const contenu = b.contenu != null ? String(b.contenu).trim() : r.content;
    if (!titre || !contenu) throw new ApiError(400, "Titre et contenu ne peuvent pas être vides.");
    const place = "projet_id" in b ? await placementFrom(db, b.projet_id, b.groupe_id ?? r.group_id) : { projectId: r.project_id, groupId: r.group_id };
    const pid = place.projectId;
    await db.prepare("UPDATE memories SET title=?, content=?, kind=?, project_id=?, group_id=?, updated_at=? WHERE id=?")
      .bind(titre, contenu, b.type ? String(b.type).trim() : r.kind, pid, place.groupId, now(), r.id).run();
    if (place.groupId !== r.group_id) await syncMemoryFiles(db, r.id, place.groupId);
    if (b.tags != null) await setTags(db, r.id, normTags(b.tags));
    await reindex(db, r.id);
    await touchProject(db, pid);
    return jsonOk({ ok: true });
  }
  if (res === "souvenirs" && id && m === "DELETE") {
    if (!(await deleteMemory(db, Number(id)))) throw new ApiError(404, "Souvenir introuvable.");
    return jsonOk({ ok: true });
  }

  // --- fichiers
  if (res === "fichiers" && !id && m === "GET") {
    const rows = (await db.prepare("SELECT f.id, f.filename, f.mime, f.size, f.description, f.memory_id, f.project_id, f.group_id, f.storage, f.created_at, p.name AS projet FROM files f LEFT JOIN projects p ON p.id = f.project_id ORDER BY f.size DESC").all()).results;
    return jsonOk({ fichiers: rows });
  }
  if (res === "fichiers" && id === "supprimer" && m === "POST") {
    const b = await readJson(request);
    const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(String))];
    if (!ids.length) throw new ApiError(400, "Aucun fichier sélectionné.");
    if (ids.length > 200) throw new ApiError(400, "200 fichiers au maximum par suppression.");
    let n = 0, octets = 0;
    for (const fid of ids) {
      const f = await deleteFile(db, env.FILES, fid);
      if (f) { n++; octets += f.size; }
    }
    return jsonOk({ ok: true, supprimes: n, octets });
  }
  if (res === "fichiers" && !id && m === "POST") {
    const len = parseInt(request.headers.get("Content-Length") || "0");
    if (len > MAX_BYTES * 5 + 1_000_000) throw new ApiError(413, `Envoi trop gros (max ${MAX_FILE_MB} Mo par fichier).`);
    let form;
    try { form = await request.formData(); }
    catch { throw new ApiError(400, "Formulaire invalide."); }
    const files = form.getAll("fichier").filter((f) => f && typeof f === "object" && "arrayBuffer" in f);
    if (!files.length) throw new ApiError(400, "Aucun fichier reçu.");
    for (const f of files) if (f.size > MAX_BYTES) throw new ApiError(413, `« ${f.name} » est trop gros (max ${MAX_FILE_MB} Mo).`);
    const { projectId: pid, groupId } = await placementFrom(db, form.get("projet_id"), form.get("groupe_id"));
    const description = String(form.get("description") || "").trim();
    const out = [];
    for (const f of files) {
      const name = cleanName(f.name);
      const bytes = new Uint8Array(await f.arrayBuffer());
      const mime = f.type && f.type !== "application/octet-stream" ? f.type : guessMime(name, false);
      const r = await storeFile(db, env.FILES, { name, mime, bytes, description, projectId: pid, groupId });
      out.push({ id: r.id, nom: r.name, taille: r.size });
    }
    return jsonOk({ ok: true, fichiers: out });
  }
  if (res === "fichiers" && id && m === "PATCH") {
    const f = await db.prepare("SELECT * FROM files WHERE id = ?").bind(id).first();
    if (!f) throw new ApiError(404, "Fichier introuvable.");
    const b = await readJson(request);
    const place = "projet_id" in b ? await placementFrom(db, b.projet_id, b.groupe_id ?? f.group_id) : { projectId: f.project_id, groupId: f.group_id };
    const pid = place.projectId;
    const nom = b.nom != null ? cleanName(b.nom) : f.filename;
    await db.prepare("UPDATE files SET filename=?, description=?, project_id=?, group_id=? WHERE id=?")
      .bind(nom, b.description != null ? String(b.description) : f.description, pid, place.groupId, f.id).run();
    await touchProject(db, pid);
    return jsonOk({ ok: true });
  }
  if (res === "fichiers" && id && m === "DELETE") {
    const f = await deleteFile(db, env.FILES, id);
    if (!f) throw new ApiError(404, "Fichier introuvable.");
    return jsonOk({ ok: true });
  }

  // --- tags
  if (res === "tags" && !id && m === "GET") {
    const rows = (await db.prepare("SELECT t.name, COUNT(mt.memory_id) n FROM tags t JOIN memory_tags mt ON mt.tag_id = t.id GROUP BY t.id ORDER BY n DESC, t.name").all()).results;
    return jsonOk({ tags: rows });
  }

  // --- recherche transverse
  if (res === "recherche" && !id && m === "GET") {
    const q = String(url.searchParams.get("q") || "").trim();
    const tag = normTags([url.searchParams.get("tag") || ""])[0] || null;
    if (!q && !tag) return jsonOk({ souvenirs: [], projets: [], fichiers: [] });
    const where = [], params = [];
    if (tag) {
      where.push("EXISTS (SELECT 1 FROM memory_tags mt JOIN tags tg ON tg.id = mt.tag_id WHERE mt.memory_id = m.id AND tg.name = ?)");
      params.push(tag);
    }
    let souvenirs;
    if (q) {
      const sql = "SELECT m.id, m.title, m.kind, m.updated_at, m.project_id, m.group_id, p.name AS projet, snippet(memories_fts, 1, char(1), char(2), '…', 24) AS extrait " +
        "FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid LEFT JOIN projects p ON p.id = m.project_id " +
        "WHERE memories_fts MATCH ? " + (where.length ? "AND " + where.join(" AND ") + " " : "") +
        "ORDER BY bm25(memories_fts, 5.0, 1.0, 3.0, 2.0), m.updated_at DESC LIMIT 60";
      souvenirs = (await db.prepare(sql).bind(ftsQuery(q), ...params).all()).results;
    } else {
      const sql = "SELECT m.id, m.title, m.kind, m.updated_at, m.project_id, m.group_id, p.name AS projet, substr(m.content, 1, 200) AS extrait FROM memories m LEFT JOIN projects p ON p.id = m.project_id WHERE " + where.join(" AND ") + " ORDER BY m.updated_at DESC LIMIT 60";
      souvenirs = (await db.prepare(sql).bind(...params).all()).results;
    }
    const tags = await tagsByMemory(db, souvenirs.map((s) => s.id));
    for (const s of souvenirs) s.tags = tags[s.id] || [];
    let projets = [], fichiers = [];
    if (q) {
      const l = likeArg(q);
      projets = (await db.prepare("SELECT id, name, description, status, group_id FROM projects WHERE name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT 20").bind(l, l).all()).results;
      fichiers = (await db.prepare("SELECT f.id, f.filename, f.size, f.description, f.project_id, f.group_id, p.name AS projet FROM files f LEFT JOIN projects p ON p.id = f.project_id WHERE f.filename LIKE ? ESCAPE '\\' OR f.description LIKE ? ESCAPE '\\' ORDER BY f.created_at DESC LIMIT 30").bind(l, l).all()).results;
    }
    return jsonOk({ souvenirs, projets, fichiers });
  }

  throw new ApiError(404, "Route inconnue.");
}

import { fetchUsage } from "./analytics.js";
import { METRICS, WARN_RATIO, periodKey, thresholds } from "./limits.js";

// ------------------------------------------------------------------ garde-fous de consommation
// La consommation du compte est lue dans l'API Analytics et mise en cache dans D1 (table usage_cache),
// rafraîchie au plus toutes les 5 minutes. Si l'API ne répond pas, on garde les derniers chiffres connus.
export const REFRESH_MS = 5 * 60_000;

const fmt = (n) => (Number.isInteger(n) ? n.toLocaleString("fr-FR") : n.toLocaleString("fr-FR", { maximumFractionDigits: 2 }));
const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16) + " UTC";

async function readCache(db) {
  const rows = (await db.prepare("SELECT metric, value, period, updated_at FROM usage_cache").all()).results;
  return Object.fromEntries(rows.map((r) => [r.metric, r]));
}

async function writeCache(db, entries) {
  const stmts = entries.map(([metric, value, period, ts]) =>
    db.prepare("INSERT INTO usage_cache(metric, value, period, updated_at) VALUES (?,?,?,?) ON CONFLICT(metric) DO UPDATE SET value = excluded.value, period = excluded.period, updated_at = excluded.updated_at")
      .bind(metric, value, period, ts));
  const res = await db.batch(stmts);
  return res[res.length - 1]?.meta?.size_after;
}

// Consommation courante. `fetchImpl` et `now` servent aux tests.
export async function currentUsage(db, env, { fetchImpl, now = Date.now() } = {}) {
  const cache = await readCache(db);
  const configured = Boolean(env.CF_ACCOUNT_ID && env.CF_API_TOKEN);
  const status = cache._status || null; // value = 1 si le dernier rafraîchissement a réussi
  const lastTry = status ? status.updated_at : 0;
  let error = status && !status.value ? status.period : null;

  if (now - lastTry >= REFRESH_MS) {
    // La taille de la base vient de D1 lui-même (meta.size_after) : elle est suivie même sans API Analytics.
    const date = new Date(now);
    let entries = [], ok = configured;
    if (configured) {
      try {
        const u = await fetchUsage({ accountId: env.CF_ACCOUNT_ID, token: env.CF_API_TOKEN, fetchImpl, now: date });
        entries = Object.entries(u).map(([k, v]) => [k, v, periodKey(METRICS[k].period, date), now]);
        error = null;
      } catch (e) {
        ok = false;
        error = String(e.message || e).slice(0, 300);
      }
    }
    entries.push(["_status", ok ? 1 : 0, ok ? "" : error || "", now]);
    if (ok) entries.push(["_verified", now, "", now]);
    const size = await writeCache(db, entries);
    if (size) await writeCache(db, [["d1_size_mb", size / 1e6, "", now]]);
    Object.assign(cache, await readCache(db));
  }

  // Une période écoulée (nouveau jour, nouveau mois) remet son compteur à zéro.
  const date = new Date(now), values = {};
  for (const [k, m] of Object.entries(METRICS)) {
    const c = cache[k];
    values[k] = c && (!m.period || c.period === periodKey(m.period, date)) ? Number(c.value) : 0;
  }
  return { configured, values, verifiedAt: cache._verified ? Number(cache._verified.value) : null, error };
}

// Compare la consommation aux seuils.
export function evaluate(usage, limits) {
  const rows = Object.entries(METRICS).map(([k, m]) => {
    const value = usage.values[k] || 0, limit = limits[k];
    return { metric: k, label: m.label, unit: m.unit, period: m.period, value, limit, real: m.real, ratio: limit ? value / limit : 0 };
  });
  return {
    rows,
    blocked: rows.filter((r) => r.ratio >= 1),
    warnings: rows.filter((r) => r.ratio >= WARN_RATIO && r.ratio < 1),
    configured: usage.configured,
    verifiedAt: usage.verifiedAt,
    error: usage.error,
  };
}

export async function checkQuota(db, env, opts) {
  return evaluate(await currentUsage(db, env, opts), thresholds(env));
}

const when = (r) => (r.period === "day" ? " aujourd'hui, remise à zéro à minuit UTC" : r.period === "month" ? " ce mois-ci, remise à zéro le 1er à minuit UTC" : "");
const line = (r) => `${r.label} ${fmt(r.value)}${r.unit} / ${fmt(r.limit)}${r.unit} (${Math.round(r.ratio * 100)} %)${when(r)}`;

// Lignes « ⚠️ Quota » à ajouter à chaque réponse d'outil MCP.
export function warningLines(ev) {
  const out = ev.warnings.map((r) => `⚠️ Quota : ${line(r)}.`);
  if (!ev.configured) out.push("⚠️ Quota : garde-fous inactifs, la consommation n'est pas vérifiée (CF_ACCOUNT_ID et CF_API_TOKEN à configurer).");
  else if (ev.error) out.push(`⚠️ Quota : consommation non vérifiée ${ev.verifiedAt ? "depuis " + hhmm(ev.verifiedAt) : "pour l'instant"} (${ev.error}).`);
  return out;
}

export function blockedMessage(ev) {
  return `Erreur : quota atteint, appel refusé pour préserver l'offre gratuite. ${ev.blocked.map(line).join(" ; ")}.`;
}

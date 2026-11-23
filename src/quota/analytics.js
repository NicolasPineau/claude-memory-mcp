import { R2_CLASS_B, R2_FREE } from "./limits.js";

// ------------------------------------------------------------------ consommation du compte (API GraphQL Analytics)
// Sans dépendance : utilisable par le Worker et par le script de sauvegarde (Node).
// Jeton requis : permission « Account Analytics : Read » sur le compte.
export const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";

const q = (v) => JSON.stringify(String(v));

export function usageQuery(accountId, now = new Date()) {
  const iso = now.toISOString();
  const day = iso.slice(0, 10), dayStart = `${day}T00:00:00Z`, monthStart = `${iso.slice(0, 7)}-01T00:00:00Z`;
  const storageSince = new Date(now.getTime() - 2 * 86400_000).toISOString();
  return `{
  viewer {
    accounts(filter: { accountTag: ${q(accountId)} }) {
      workers: workersInvocationsAdaptive(limit: 10000, filter: { datetime_geq: ${q(dayStart)}, datetime_leq: ${q(iso)} }) { sum { requests } }
      d1: d1AnalyticsAdaptiveGroups(limit: 10000, filter: { date_geq: ${q(day)}, date_leq: ${q(day)} }) { sum { rowsRead rowsWritten } }
      r2ops: r2OperationsAdaptiveGroups(limit: 10000, filter: { datetime_geq: ${q(monthStart)}, datetime_leq: ${q(iso)} }) { sum { requests } dimensions { actionType } }
      r2storage: r2StorageAdaptiveGroups(limit: 10000, filter: { datetime_geq: ${q(storageSince)}, datetime_leq: ${q(iso)} }, orderBy: [datetime_DESC]) { max { payloadSize metadataSize } dimensions { bucketName datetime } }
    }
  }
}`;
}

const sum = (rows, f) => (rows || []).reduce((n, r) => n + (Number(f(r)) || 0), 0);

// Transforme la réponse GraphQL en métriques (voir limits.js).
export function parseUsage(json) {
  if (json?.errors?.length) throw new Error("API Analytics : " + json.errors.map((e) => e.message).join(" ; "));
  const acc = json?.data?.viewer?.accounts?.[0];
  if (!acc) throw new Error("API Analytics : compte introuvable (identifiant ou droits du jeton).");
  let classA = 0, classB = 0;
  for (const r of acc.r2ops || []) {
    const action = r.dimensions?.actionType, n = Number(r.sum?.requests) || 0;
    if (R2_FREE.has(action)) continue;
    if (R2_CLASS_B.has(action)) classB += n;
    else classA += n;
  }
  // Stockage : la mesure la plus récente de chaque bucket, additionnée.
  const latest = new Map();
  for (const r of acc.r2storage || []) {
    const b = r.dimensions?.bucketName, t = r.dimensions?.datetime || "";
    if (!latest.has(b) || t > latest.get(b).t) latest.set(b, { t, bytes: (Number(r.max?.payloadSize) || 0) + (Number(r.max?.metadataSize) || 0) });
  }
  const r2Bytes = [...latest.values()].reduce((n, v) => n + v.bytes, 0);
  return {
    requests_day: sum(acc.workers, (r) => r.sum?.requests),
    d1_reads_day: sum(acc.d1, (r) => r.sum?.rowsRead),
    d1_writes_day: sum(acc.d1, (r) => r.sum?.rowsWritten),
    r2_class_a_month: classA,
    r2_class_b_month: classB,
    r2_storage_gb: r2Bytes / 1e9,
  };
}

export async function fetchUsage({ accountId, token, fetchImpl = fetch, now = new Date() }) {
  if (!accountId || !token) throw new Error("API Analytics non configurée (CF_ACCOUNT_ID et CF_API_TOKEN).");
  const res = await fetchImpl(GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query: usageQuery(accountId, now) }),
  });
  if (!res.ok) throw new Error(`API Analytics : HTTP ${res.status}`);
  return parseUsage(await res.json());
}

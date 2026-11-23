// ------------------------------------------------------------------ seuils de consommation
// Limites gratuites Cloudflare (vérifiées le 23/11/2026) et seuils par défaut à 50 %, pour garder de la marge
// si les offres gratuites baissent. Chaque seuil se règle par une variable d'environnement, sans redéploiement.
export const METRICS = {
  requests_day: { label: "requêtes Workers", unit: "", period: "day", env: "QUOTA_REQUESTS_DAY", def: 50_000, real: 100_000 },
  d1_reads_day: { label: "lignes D1 lues", unit: "", period: "day", env: "QUOTA_D1_READS_DAY", def: 2_500_000, real: 5_000_000 },
  d1_writes_day: { label: "lignes D1 écrites", unit: "", period: "day", env: "QUOTA_D1_WRITES_DAY", def: 50_000, real: 100_000 },
  d1_size_mb: { label: "taille de la base D1", unit: " Mo", period: null, env: "QUOTA_D1_SIZE_MB", def: 250, real: 500 },
  r2_storage_gb: { label: "stockage R2", unit: " Go", period: null, env: "QUOTA_R2_STORAGE_GB", def: 5, real: 10 },
  r2_class_a_month: { label: "opérations R2 classe A", unit: "", period: "month", env: "QUOTA_R2_CLASS_A_MONTH", def: 500_000, real: 1_000_000 },
  r2_class_b_month: { label: "opérations R2 classe B", unit: "", period: "month", env: "QUOTA_R2_CLASS_B_MONTH", def: 5_000_000, real: 10_000_000 },
};

export const WARN_RATIO = 0.8;

export function thresholds(env = {}) {
  const out = {};
  for (const [k, m] of Object.entries(METRICS)) {
    const v = Number(env[m.env]);
    out[k] = Number.isFinite(v) && v > 0 ? v : m.def;
  }
  return out;
}

// Début de la période en cours (UTC) : « 2026-11-23 » pour un jour, « 2026-11 » pour un mois.
export function periodKey(period, date = new Date()) {
  const iso = date.toISOString();
  return period === "day" ? iso.slice(0, 10) : period === "month" ? iso.slice(0, 7) : "";
}

// Opérations R2 de classe B (lectures). DeleteObject, DeleteBucket et AbortMultipartUpload sont gratuites.
// Toute autre opération, connue ou non, est comptée en classe A, la plus restrictive.
export const R2_CLASS_B = new Set(["HeadBucket", "HeadObject", "GetObject", "UsageSummary", "GetBucketEncryption", "GetBucketLocation", "GetBucketCors", "GetBucketLifecycleConfiguration"]);
export const R2_FREE = new Set(["DeleteObject", "DeleteBucket", "AbortMultipartUpload"]);

import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { parseUsage } from "../src/quota/analytics.js";
import { REFRESH_MS, currentUsage, evaluate } from "../src/quota/guard.js";
import { thresholds } from "../src/quota/limits.js";
import { MASTER, admin, call, env, rpc, schema, usage } from "./helpers.js";

const reply = (acc) => ({ data: { viewer: { accounts: [acc] } } });
const fakeFetch = (bodies) => {
  const calls = [];
  const f = async (url, init) => {
    calls.push(JSON.parse(init.body).query);
    const b = bodies.shift();
    if (b instanceof Error) throw b;
    return Response.json(b);
  };
  f.calls = calls;
  return f;
};

describe("lecture de l'API Analytics", () => {
  it("additionne requêtes, lignes D1, opérations R2 par classe et stockage R2 le plus récent", () => {
    const u = parseUsage(reply({
      workers: [{ sum: { requests: 1200 } }, { sum: { requests: 34 } }],
      d1: [{ sum: { rowsRead: 9000, rowsWritten: 300 } }],
      r2ops: [
        { sum: { requests: 10 }, dimensions: { actionType: "PutObject" } },
        { sum: { requests: 5 }, dimensions: { actionType: "ListObjects" } },
        { sum: { requests: 7 }, dimensions: { actionType: "GetObject" } },
        { sum: { requests: 3 }, dimensions: { actionType: "DeleteObject" } },
        { sum: { requests: 2 }, dimensions: { actionType: "OperationInconnue" } },
      ],
      r2storage: [
        { max: { payloadSize: 1e9, metadataSize: 0 }, dimensions: { bucketName: "a", datetime: "2026-11-23T10:00:00Z" } },
        { max: { payloadSize: 5e8, metadataSize: 0 }, dimensions: { bucketName: "a", datetime: "2026-11-22T10:00:00Z" } },
        { max: { payloadSize: 2e9, metadataSize: 1e6 }, dimensions: { bucketName: "b", datetime: "2026-11-23T09:00:00Z" } },
      ],
    }));
    expect(u).toEqual({ requests_day: 1234, d1_reads_day: 9000, d1_writes_day: 300, r2_class_a_month: 17, r2_class_b_month: 7, r2_storage_gb: 3.001 });
  });

  it("signale les erreurs de l'API", () => {
    expect(() => parseUsage({ errors: [{ message: "non autorisé" }] })).toThrow(/non autorisé/);
    expect(() => parseUsage({ data: { viewer: { accounts: [] } } })).toThrow(/compte introuvable/);
  });
});

describe("cache et périodes", () => {
  beforeEach(async () => {
    await schema();
    await env.DB.prepare("DELETE FROM usage_cache").run();
  });
  const cfg = { CF_ACCOUNT_ID: "acc", CF_API_TOKEN: "tok" };
  const t0 = Date.parse("2026-11-23T10:00:00Z");

  it("n'interroge l'API qu'une fois toutes les 5 minutes", async () => {
    const f = fakeFetch([reply({ workers: [{ sum: { requests: 40 } }], d1: [], r2ops: [], r2storage: [] }), reply({ workers: [{ sum: { requests: 90 } }], d1: [], r2ops: [], r2storage: [] })]);
    expect((await currentUsage(env.DB, cfg, { fetchImpl: f, now: t0 })).values.requests_day).toBe(40);
    expect((await currentUsage(env.DB, cfg, { fetchImpl: f, now: t0 + 60_000 })).values.requests_day).toBe(40);
    expect(f.calls.length).toBe(1);
    expect(f.calls[0]).toContain('accountTag: "acc"');
    expect((await currentUsage(env.DB, cfg, { fetchImpl: f, now: t0 + REFRESH_MS })).values.requests_day).toBe(90);
  });

  it("garde les derniers chiffres et signale l'erreur si l'API ne répond pas", async () => {
    const f = fakeFetch([reply({ workers: [], d1: [{ sum: { rowsRead: 0, rowsWritten: 45_000 } }], r2ops: [], r2storage: [] }), new Error("réseau coupé")]);
    await currentUsage(env.DB, cfg, { fetchImpl: f, now: t0 });
    const u = await currentUsage(env.DB, cfg, { fetchImpl: f, now: t0 + REFRESH_MS });
    expect(u.values.d1_writes_day).toBe(45_000);
    expect(u.error).toMatch(/réseau coupé/);
    expect(u.verifiedAt).toBe(t0);
  });

  it("remet les compteurs du jour à zéro à minuit UTC", async () => {
    const f = fakeFetch([reply({ workers: [{ sum: { requests: 49_000 } }], d1: [], r2ops: [{ sum: { requests: 3 }, dimensions: { actionType: "PutObject" } }], r2storage: [] }), new Error("panne")]);
    await currentUsage(env.DB, cfg, { fetchImpl: f, now: t0 });
    const u = await currentUsage(env.DB, cfg, { fetchImpl: f, now: Date.parse("2026-11-24T00:05:00Z") });
    expect(u.values.requests_day).toBe(0);
    expect(u.values.r2_class_a_month).toBe(3); // même mois
  });

  it("suit la taille de la base même sans API Analytics", async () => {
    const u = await currentUsage(env.DB, {}, { now: t0 });
    expect(u.configured).toBe(false);
    expect(u.values.d1_size_mb).toBeGreaterThan(0);
  });

  it("lit les seuils dans les variables d'environnement", () => {
    expect(thresholds({}).d1_writes_day).toBe(50_000);
    expect(thresholds({ QUOTA_D1_WRITES_DAY: "20000", QUOTA_R2_STORAGE_GB: "abc" })).toMatchObject({ d1_writes_day: 20_000, r2_storage_gb: 5 });
    const ev = evaluate({ configured: true, values: { d1_writes_day: 20_000 } }, thresholds({ QUOTA_D1_WRITES_DAY: "20000" }));
    expect(ev.blocked.map((r) => r.metric)).toEqual(["d1_writes_day"]);
  });
});

describe("refus et avertissements", () => {
  beforeEach(schema);

  it("ajoute la ligne ⚠️ Quota à chaque réponse entre 80 et 100 % d'un seuil", async () => {
    await usage({ d1_writes_day: 41_200 });
    for (const [name, args] of [["list_groups", {}], ["recall", { requete: "x" }], ["remember", { titre: "t", contenu: "c" }]]) {
      const out = await call(MASTER, name, args);
      expect(out).toMatch(/\n\n⚠️ Quota : lignes D1 écrites 41[\s ]200 \/ 50[\s ]000 \(82 %\) aujourd'hui, remise à zéro à minuit UTC\.$/);
    }
  });

  it("n'ajoute rien sous 80 %", async () => {
    await usage({ d1_writes_day: 10_000 });
    expect(await call(MASTER, "list_groups")).not.toContain("⚠️");
  });

  it("refuse tous les outils une fois un seuil atteint, sans toucher à la base", async () => {
    await usage({ requests_day: 50_000 });
    const before = (await env.DB.prepare("SELECT COUNT(*) n FROM memories").first()).n;
    const r = await rpc(MASTER, "tools/call", { name: "remember", arguments: { titre: "t", contenu: "c" } });
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toMatch(/^Erreur : quota atteint.*requêtes Workers 50[\s ]000 \/ 50[\s ]000 \(100 %\)/);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM memories").first()).n).toBe(before);
    expect(await call(MASTER, "recall", {})).toMatch(/quota atteint/);
    expect((await rpc(MASTER, "tools/list")).result.tools.length).toBe(15); // le connecteur reste chargeable
  });

  it("refuse les liens de téléchargement et d'envoi", async () => {
    const out = await call(MASTER, "attach_file", { nom_fichier: "a.txt", contenu_texte: "a" });
    const dl = (await call(MASTER, "read_file", { id: out.match(/id=(\w+)/)[1] })).match(/\/dl\/[\w-]+/)[0];
    const up = (await call(MASTER, "prepare_upload", { nom_fichier: "b.txt" })).match(/\/upload\/[\w-]+/)[0];
    await usage({ r2_class_a_month: 600_000 });
    expect((await SELF.fetch(`https://memory.test${dl}`)).status).toBe(429);
    expect((await SELF.fetch(`https://memory.test${up}`, { method: "PUT", body: "b" })).status).toBe(429);
  });

  it("expose la consommation à /admin", async () => {
    await usage({ d1_reads_day: 2_400_000 });
    const { checkQuota } = await import("../src/quota/guard.js");
    const url = new URL("https://memory.test/admin/api/conso");
    const { adminApi } = await import("../src/admin/api.js");
    const res = await adminApi(new Request(url), env.DB, ["conso"], url, env, await checkQuota(env.DB, env));
    const j = await res.json();
    expect(j.configure).toBe(true);
    expect(j.metriques.find((r) => r.metric === "d1_reads_day")).toMatchObject({ value: 2_400_000, limit: 2_500_000, real: 5_000_000 });
    expect(j.sauvegardes).toEqual([]); // bucket de sauvegardes local, vide
  });
});

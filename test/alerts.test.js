import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { MASTER, admin, call, env, schema } from "./helpers.js";
import { inWindow, runAlerts, signTaskLink, verifyTaskLink } from "../src/alerts/ntfy.js";
import { parseReports, reportTarget } from "../src/db/tasks.js";

beforeEach(schema);

// 23/11/2026 à 14:00 heure de Paris (UTC+1).
const AT = new Date("2026-11-23T13:00:00Z");
const later = (min) => new Date(AT.getTime() + min * 60_000);
const ENV = () => ({ ...env, NTFY_TOPIC: "topic-test", PUBLIC_URL: "https://memory.test/" });
const idOf = (out) => Number(out.match(/^ok #(\d+)/)[1]);
const task = (id) => env.DB.prepare("SELECT * FROM tasks WHERE memory_id = ?").bind(id).first();

async function run(at, ok = true) {
  const sent = [];
  const n = await runAlerts(env.DB, ENV(), { at, send: async (_, msg) => { sent.push(msg); return ok; } });
  return { n, sent };
}

describe("utilitaires", () => {
  it("plages horaires", () => {
    expect(inWindow("06:59", "07:00", "24:00")).toBe(false);
    expect(inWindow("07:00", "07:00", "24:00")).toBe(true);
    expect(inWindow("23:59", "07:00", "24:00")).toBe(true);
    expect(inWindow("03:00", "00:00", "24:00")).toBe(true);
    expect(inWindow("23:00", "22:00", "06:00")).toBe(true);
    expect(inWindow("05:00", "22:00", "06:00")).toBe(true);
    expect(inWindow("12:00", "22:00", "06:00")).toBe(false);
  });

  it("reports", () => {
    const t = { due_time: "09:30" };
    expect(reportTarget("+1h", t, AT)).toEqual({ date: "2026-11-23", time: "15:00" });
    expect(reportTarget("+30m", t, AT)).toEqual({ date: "2026-11-23", time: "14:30" });
    expect(reportTarget("18:00", t, AT)).toEqual({ date: "2026-11-23", time: "18:00" });
    expect(reportTarget("18:00", t, later(5 * 60))).toEqual({ date: "2026-11-24", time: "18:00" });
    expect(reportTarget("+1j 08:00", t, AT)).toEqual({ date: "2026-11-24", time: "08:00" });
    expect(reportTarget("+7j", t, AT)).toEqual({ date: "2026-11-30", time: "09:30" });
    expect(reportTarget("+10h", t, AT)).toEqual({ date: "2026-11-24", time: "00:00" });
    expect(parseReports("A=+1h\nB=18:00").list).toHaveLength(2);
    expect(parseReports("A=bientôt").error).toMatch(/Report invalide/);
    expect(parseReports("").error).toBeTruthy();
  });

  it("liens signés", async () => {
    const tok = await signTaskLink(env, 42, AT.getTime());
    expect(await verifyTaskLink(env, tok, AT.getTime())).toBe(42);
    expect(await verifyTaskLink(env, tok.replace(/^42/, "43"), AT.getTime())).toBeNull();
    expect(await verifyTaskLink(env, tok, AT.getTime() + 8 * 86400_000)).toBeNull();
    expect(await verifyTaskLink({ MEMORY_SECRET: "autre-secret-0123456789abc" }, tok, AT.getTime())).toBeNull();
  });
});

describe("Cron des alertes", () => {
  it("envoie les alertes dues, selon le niveau, puis relance les critiques", async () => {
    const crit = idOf(await call(MASTER, "add_task", { titre: "Gaz", detail: "Couper le gaz avant de partir", echeance: "2026-11-23 13:00", criticite: "critique" }));
    const norm = idOf(await call(MASTER, "add_task", { titre: "Pain", echeance: "2026-11-23" })); // sans heure : 08:00
    await call(MASTER, "add_task", { titre: "Plus tard", echeance: "2026-11-23 18:00" });
    await call(MASTER, "add_task", { titre: "Basse", echeance: "2026-11-20", criticite: "basse" }); // alerte « aucune »
    await call(MASTER, "add_task", { titre: "Sans date", criticite: "critique" });

    const first = await run(AT);
    expect(first.n).toBe(2);
    const [gaz, pain] = first.sent;
    expect(gaz).toMatchObject({ topic: "topic-test", title: "!! Gaz", message: "Échéance : aujourd'hui 13h\nCouper le gaz avant de partir", priority: 5, tags: ["rotating_light"] });
    expect(gaz.click).toMatch(new RegExp(`^https://memory\\.test/t/${crit}\\.\\d+\\.[\\w-]+$`));
    expect(gaz.actions.map((a) => [a.label, a.action, a.url.replace(gaz.click, "")])).toEqual([["Fait", "http", "/fait"], ["Vu", "http", "/vu"], ["Repousser…", "view", "#repousser"]]);
    expect(pain).toMatchObject({ title: "! Pain", message: "Échéance : aujourd'hui", priority: 4, tags: ["bell"] });
    expect((await task(norm)).alert_last).toBe("2026-11-23T13:00:00Z");

    expect((await run(later(15))).n).toBe(0); // relance critique : 60 min ; normale : jamais
    const again = await run(later(60));
    expect(again.sent.map((m) => m.title)).toEqual(["!! Gaz"]);
  });

  it("respecte la plage d'alerte du niveau", async () => {
    await call(MASTER, "add_task", { titre: "Critique", echeance: "2026-11-23 23:00", criticite: "critique" });
    await call(MASTER, "add_task", { titre: "Normale", echeance: "2026-11-23 23:00" });
    const night = new Date("2026-11-23T23:30:00Z"); // 00:30 à Paris : hors plage 07:00–24:00 de « normale »
    expect((await run(night)).sent.map((m) => m.title)).toEqual(["!! Critique"]);
    expect((await run(new Date("2026-11-24T06:00:00Z"))).sent.map((m) => m.title)).toEqual(["!! Critique", "! Normale"]); // 07:00 à Paris (+ relance horaire de la critique)
  });

  it("réessaie au passage suivant si ntfy échoue, et ne fait rien sans topic", async () => {
    const id = idOf(await call(MASTER, "add_task", { titre: "X", echeance: "2026-11-23 10:00" }));
    expect((await run(AT, false)).n).toBe(0);
    expect((await task(id)).alert_last).toBeNull();
    expect(await runAlerts(env.DB, { ...env, NTFY_TOPIC: "" }, { at: AT, send: async () => true })).toBe(0);
    expect((await run(AT)).n).toBe(1);
  });

  it("une tâche silencieuse ou faite n'alerte pas ; un changement d'échéance réarme", async () => {
    const a = idOf(await call(MASTER, "add_task", { titre: "A", echeance: "2026-11-23 10:00" }));
    const b = idOf(await call(MASTER, "add_task", { titre: "B", echeance: "2026-11-23 10:00" }));
    await call(MASTER, "update_task", { id: a, statut: "silencieux" });
    expect((await run(AT)).sent.map((m) => m.title)).toEqual(["! B"]);
    await call(MASTER, "update_task", { id: b, echeance: "2026-11-23 14:00" });
    expect((await run(AT)).sent.map((m) => m.title)).toEqual(["! B"]);
  });
});

describe("liens des notifications", () => {
  const link = async (id) => `https://memory.test/t/${await signTaskLink(env, id)}`;
  const post = (url, body) => SELF.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });

  it("Vu arrête les relances, Fait termine la tâche (et crée la suivante si récurrente)", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const id = idOf(await call(MASTER, "add_task", { titre: "Loyer", echeance: `${today} 00:00`, criticite: "critique", recurrence: "1 mois" }));
    let r = await post(`${await link(id)}/vu`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("Vu : plus de relance.");
    expect((await task(id)).alert_ack).toBe(1);
    expect((await runAlerts(env.DB, ENV(), { send: async () => true }))).toBe(0);

    r = await post(`${await link(id)}/fait`);
    expect(await r.text()).toMatch(/^Fait\. Prochaine le \d\d\/\d\d/);
    expect((await task(id)).status).toBe("fait");
  });

  it("Repousser décale l'échéance et réarme l'alerte ; Modifier change la tâche", async () => {
    const id = idOf(await call(MASTER, "add_task", { titre: "Pain", echeance: "2026-11-20 09:00" }));
    await env.DB.prepare("UPDATE tasks SET alert_last = '2026-11-20T08:00:00Z', alert_ack = 1 WHERE memory_id = ?").bind(id).run();
    let r = await post(`${await link(id)}/repousser`, { choix: 3 }); // +1 semaine
    expect(r.status).toBe(200);
    expect(await r.text()).toMatch(/^Repoussée au \d\d\/\d\d.* 9h\.$/);
    const t = await task(id);
    expect(t.due_date > "2026-11-20").toBe(true);
    expect([t.alert_last, t.alert_ack]).toEqual([null, 0]);

    r = await post(`${await link(id)}/modifier`, { titre: "Pain complet", detail: "Chez Paul", echeance: "2026-12-01 18:30", criticite: "critique" });
    expect(await r.text()).toBe("Enregistré.");
    expect(await call(MASTER, "list_tasks", { detail: true })).toMatch(/^#\d+ !! Pain complet — 01\/12 18h30 · critique\n  Chez Paul$/);

    expect((await post(`${await link(id)}/repousser`, { choix: 99 })).status).toBe(400);
    expect((await post(`${await link(id)}/modifier`, { echeance: "demain" })).status).toBe(400);
  });

  it("affiche la page mobile et refuse un lien faux", async () => {
    const id = idOf(await call(MASTER, "add_task", { titre: "Dentiste <3", echeance: "2026-12-01 09:00" }));
    const r = await SELF.fetch(await link(id));
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("Dentiste &lt;3");
    expect(html).toContain('id="repousser"');
    expect(html).toContain("Demain matin");
    expect((await SELF.fetch("https://memory.test/t/1.9999999999.faux")).status).toBe(404);
    expect((await post((await link(id)).replace(/\/t\/(\d+)/, "/t/$1") + "/supprimer")).status).toBe(404);
  });
});

describe("réglages", () => {
  it("valide l'heure du matin et les reports", async () => {
    expect(await admin("PATCH", "reglages", { alerte_matin: "25:00" })).toMatchObject({ status: 400 });
    expect(await admin("PATCH", "reglages", { reports: "Bof" })).toMatchObject({ status: 400 });
    expect(await admin("PATCH", "reglages", { alerte_matin: "07:30", reports: " Dans 2 h = +2h \nLundi matin=+3j 08:00" })).toMatchObject({ ok: true });
    expect((await admin("GET", "taches-config")).reglages).toEqual({ rappels_max: "5", alerte_matin: "07:30", reports: "Dans 2 h=+2h\nLundi matin=+3j 08:00" });
  });
});

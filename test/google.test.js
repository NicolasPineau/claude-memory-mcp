import { beforeEach, describe, expect, it } from "vitest";
import { MASTER, admin, call, env, group, schema } from "./helpers.js";
import { eventBody, eventDue, getSync, setSync, syncGoogle } from "../src/google/calendar.js";

beforeEach(schema);

const ENV = () => ({ ...env, GOOGLE_CLIENT_ID: "client-test", GOOGLE_CLIENT_SECRET: "secret-test" });
const idOf = (out) => Number(out.match(/^ok #(\d+)/)[1]);
const task = (id) => env.DB.prepare("SELECT * FROM tasks WHERE memory_id = ?").bind(id).first();

// Faux Google Agenda : un agenda « cal », jetons de synchro = numéro de version.
function fakeGoogle() {
  const g = { events: new Map(), seq: 0, n: 0, calls: [], tokenError: null, clock: Date.now() + 60_000 };
  const stamp = () => new Date((g.clock += 1000)).toISOString();
  const json = (status, body) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  g.edit = (id, patch) => { Object.assign(g.events.get(id), patch, { updated: stamp(), seq: ++g.seq }); };
  g.add = (ev) => { const id = `ev${++g.n}`; g.events.set(id, { id, status: "confirmed", ...ev, updated: stamp(), seq: ++g.seq }); return id; };
  g.fetch = async (url, init = {}) => {
    const u = new URL(url), method = init.method || "GET";
    g.calls.push(`${method} ${u.pathname}`);
    if (u.host === "oauth2.googleapis.com") return g.tokenError ? json(400, { error: g.tokenError }) : json(200, { access_token: "at" });
    const path = u.pathname.replace("/calendar/v3", "");
    if (path === "/users/me/calendarList") return json(200, { items: [{ id: "cal", summary: "Memory – RDV" }] });
    const m = path.match(/^\/calendars\/cal\/events(?:\/(.+))?$/);
    if (!m) return json(404, {});
    const body = init.body ? JSON.parse(init.body) : null;
    if (method === "GET") {
      const since = Number(u.searchParams.get("syncToken") || 0);
      if (since > g.seq) return json(410, {});
      const items = [...g.events.values()].filter((e) => e.seq > since).map(({ seq, ...e }) => e);
      return json(200, { items, nextSyncToken: String(g.seq) });
    }
    if (method === "POST") return json(200, (({ seq, ...e }) => e)(g.events.get(g.add(body))));
    const ev = g.events.get(decodeURIComponent(m[1]));
    if (!ev || ev.status === "cancelled") return json(404, {});
    if (method === "PATCH") { g.edit(ev.id, body); const { seq, ...e } = ev; return json(200, e); }
    if (method === "DELETE") { g.edit(ev.id, { status: "cancelled" }); return json(204); }
    return json(405, {});
  };
  return g;
}

async function connect() {
  await getSync(env.DB);
  await setSync(env.DB, { refresh_token: "rt", calendar_id: "cal", calendar_name: "Memory – RDV" });
}
const sync = (g) => syncGoogle(env.DB, ENV(), { fetchFn: g.fetch });

describe("correspondance tâche ↔ événement", () => {
  it("heure de Paris, durée, journée entière", () => {
    expect(eventBody({ memory_id: 7, title: "Dentiste", content: "Dentiste", due_date: "2026-11-25", due_time: "23:30" }, 60)).toEqual({
      summary: "Dentiste", description: "", extendedProperties: { private: { memoryId: "7" } },
      start: { dateTime: "2026-11-25T23:30:00", timeZone: "Europe/Paris" }, end: { dateTime: "2026-11-26T00:30:00", timeZone: "Europe/Paris" },
    });
    expect(eventBody({ memory_id: 7, title: "Salon", content: "Stand B", due_date: "2026-12-31", due_time: null })).toMatchObject({ description: "Stand B", start: { date: "2026-12-31" }, end: { date: "2027-01-01" } });
    expect(eventDue({ start: { dateTime: "2026-11-25T13:30:00Z" } })).toEqual({ date: "2026-11-25", time: "14:30" });
    expect(eventDue({ start: { dateTime: "2026-07-01T09:00:00+02:00" } })).toEqual({ date: "2026-07-01", time: "09:00" });
    expect(eventDue({ start: { date: "2026-11-25" } })).toEqual({ date: "2026-11-25", time: null });
  });
});

describe("synchro", () => {
  it("ne fait rien tant que Google n'est pas configuré et connecté", async () => {
    expect(await syncGoogle(env.DB, env, { fetchFn: fakeGoogle().fetch })).toEqual({ skipped: "non configuré" });
    expect(await syncGoogle(env.DB, ENV(), { fetchFn: fakeGoogle().fetch })).toEqual({ skipped: "non connecté" });
  });

  it("envoie les rendez-vous, pas les tâches ordinaires, puis les met à jour", async () => {
    await connect();
    const g = fakeGoogle();
    const rdv = idOf(await call(MASTER, "add_task", { titre: "Dentiste", echeance: "2026-11-25 14:00", type: "rendez-vous" }));
    await call(MASTER, "add_task", { titre: "Pain", echeance: "2026-11-25" });
    expect(await sync(g)).toEqual({ pulled: 0, pushed: 1 });
    const t = await task(rdv);
    expect(t.gcal_event_id).toBe("ev1");
    expect(t.gcal_dirty).toBe(0);
    expect(g.events.get("ev1")).toMatchObject({ summary: "Dentiste", start: { dateTime: "2026-11-25T14:00:00", timeZone: "Europe/Paris" }, end: { dateTime: "2026-11-25T15:00:00" } });

    expect(await sync(g)).toEqual({ pulled: 0, pushed: 0 }); // l'écho de notre envoi est ignoré

    await call(MASTER, "update_task", { id: rdv, echeance: "2026-11-26 10:00" });
    expect(await sync(g)).toEqual({ pulled: 0, pushed: 1 });
    expect(g.events.get("ev1").start.dateTime).toBe("2026-11-26T10:00:00");
    expect(g.events.size).toBe(1);
  });

  it("reçoit les modifications, suppressions et nouveaux événements de Google", async () => {
    await connect();
    const g = fakeGoogle();
    const rdv = idOf(await call(MASTER, "add_task", { titre: "Garage", echeance: "2026-11-27 09:00", type: "rendez-vous" }));
    await sync(g);
    await env.DB.prepare("UPDATE tasks SET alert_last = '2026-11-27T08:00:00Z' WHERE memory_id = ?").bind(rdv).run();

    g.edit("ev1", { summary: "Garage (vidange)", description: "Apporter le carnet", start: { dateTime: "2026-11-28T08:30:00Z" } });
    const newId = g.add({ summary: "Coiffeur", start: { date: "2026-12-02" }, end: { date: "2026-12-03" } });
    expect(await sync(g)).toEqual({ pulled: 2, pushed: 0 });
    const list = await call(MASTER, "list_tasks", { detail: true });
    expect(list).toMatch(/^#\d+ ! Garage \(vidange\) — 28\/11 9h30 · Rendez-vous · normale\n  Apporter le carnet$/m);
    expect(list).toMatch(/^#\d+ ! Coiffeur — 02\/12 · Rendez-vous · normale$/m);
    expect((await task(rdv)).alert_last).toBeNull(); // alerte réarmée
    const coif = await env.DB.prepare("SELECT m.source, m.group_id, t.gcal_event_id FROM tasks t JOIN memories m ON m.id = t.memory_id WHERE t.gcal_event_id = ?").bind(newId).first();
    expect(coif.source).toBe("Google Agenda");

    expect(await sync(g)).toEqual({ pulled: 0, pushed: 0 }); // pas de doublon

    g.edit("ev1", { status: "cancelled" });
    await sync(g);
    expect((await task(rdv)).status).toBe("annule");
  });

  it("range les RDV créés dans Google selon les réglages", async () => {
    await connect();
    const pro = await group("Pro");
    const crit = (await env.DB.prepare("SELECT id FROM task_levels WHERE name = 'critique'").first()).id;
    expect(await admin("PATCH", "google", { groupe_id: pro, niveau_id: crit, duree_minutes: 30 })).toMatchObject({ ok: true });
    const g = fakeGoogle();
    g.add({ summary: "Réunion client", start: { dateTime: "2026-12-01T09:00:00Z" } });
    await sync(g);
    expect(await call(MASTER, "list_tasks", { detail: true, groupe: "Pro" })).toMatch(/^#\d+ !! Réunion client — 01\/12 10h · Rendez-vous · critique$/);
    await call(MASTER, "add_task", { titre: "Appel", echeance: "2026-12-02 11:00", type: "rendez-vous" });
    await sync(g);
    expect(g.events.get("ev2").end.dateTime).toBe("2026-12-02T11:30:00");
  });

  it("supprime l'événement quand le RDV est annulé, change de type ou est effacé", async () => {
    await connect();
    const g = fakeGoogle();
    const a = idOf(await call(MASTER, "add_task", { titre: "A", echeance: "2026-12-01 09:00", type: "rendez-vous" }));
    const b = idOf(await call(MASTER, "add_task", { titre: "B", echeance: "2026-12-01 10:00", type: "rendez-vous" }));
    const c = idOf(await call(MASTER, "add_task", { titre: "C", echeance: "2026-12-01 11:00", type: "rendez-vous" }));
    await sync(g);
    await call(MASTER, "update_task", { id: a, statut: "annule" });
    await call(MASTER, "update_task", { id: b, type: "tâche" });
    await call(MASTER, "forget", { id: c });
    expect((await sync(g)).pushed).toBe(3);
    expect([...g.events.values()].map((e) => e.status)).toEqual(["cancelled", "cancelled", "cancelled"]);
    expect((await task(b)).gcal_event_id).toBeNull();
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM gcal_trash").first()).n).toBe(0);
  });

  it("conflit : la dernière modification gagne", async () => {
    await connect();
    const g = fakeGoogle();
    const id = idOf(await call(MASTER, "add_task", { titre: "Réunion", echeance: "2026-12-01 09:00", type: "rendez-vous" }));
    await sync(g);
    g.edit("ev1", { summary: "Réunion (Google)" });
    await call(MASTER, "update_task", { id, titre: "Réunion (local)" });
    await env.DB.prepare("UPDATE tasks SET updated_at = '2100-01-01T00:00:00Z' WHERE memory_id = ?").bind(id).run(); // local plus récent
    await sync(g);
    expect(g.events.get("ev1").summary).toBe("Réunion (local)");

    g.edit("ev1", { summary: "Réunion (Google, plus tard)" });
    await call(MASTER, "update_task", { id, titre: "Réunion (local, plus tôt)" });
    await env.DB.prepare("UPDATE tasks SET updated_at = '2000-01-01T00:00:00Z' WHERE memory_id = ?").bind(id).run(); // Google plus récent
    await sync(g);
    expect(await call(MASTER, "list_tasks")).toContain("Réunion (Google, plus tard)");
    expect(g.events.get("ev1").summary).toBe("Réunion (Google, plus tard)");
  });

  it("repart de zéro si le jeton de synchro est périmé, et signale une autorisation révoquée", async () => {
    await connect();
    const g = fakeGoogle();
    g.add({ summary: "X", start: { date: "2026-12-05" } });
    await setSync(env.DB, { sync_token: "999" });
    expect((await sync(g)).pulled).toBe(1);
    g.tokenError = "invalid_grant";
    expect((await sync(g)).error).toMatch(/reconnecte Google/);
    expect((await admin("GET", "google")).erreur).toMatch(/reconnecte Google/);
  });

  it("un changement d'agenda recrée les rendez-vous ouverts", async () => {
    await connect();
    const g = fakeGoogle();
    const id = idOf(await call(MASTER, "add_task", { titre: "RDV", echeance: "2026-12-01 09:00", type: "rendez-vous" }));
    await sync(g);
    expect(await admin("PATCH", "google", { agenda_id: "autre", agenda_nom: "Autre" })).toMatchObject({ ok: true });
    const t = await task(id);
    expect([t.gcal_event_id, t.gcal_dirty]).toEqual([null, 1]);
    expect((await getSync(env.DB)).sync_token).toBeNull();
  });
});

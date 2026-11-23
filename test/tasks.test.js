import { beforeEach, describe, expect, it } from "vitest";
import { MASTER, admin, apiKey, call, env, group, groupId, schema } from "./helpers.js";
import { ensureSchema, resetSchemaCache } from "../src/db/schema.js";
import { nextDue, parisNow, parseDue, parseRecurrence, shortDate, shortTime } from "../src/db/tasks.js";

const today = parisNow().date;
const plus = (n) => new Date(Date.parse(today + "T12:00:00Z") + n * 86400_000).toISOString().slice(0, 10);
const startup = (key = MASTER) => call(key, "list_projects", { noms_seulement: true });
const idOf = (out) => Number(out.match(/^ok #(\d+)/)[1]);

beforeEach(schema);

describe("utilitaires", () => {
  it("lit les échéances, récurrences et dates courtes", () => {
    expect(parseDue("2026-11-25")).toEqual({ date: "2026-11-25", time: null });
    expect(parseDue("2026-11-25 9:30")).toEqual({ date: "2026-11-25", time: "09:30" });
    expect(parseDue("25/11/2026 14h")).toEqual({ date: "2026-11-25", time: "14:00" });
    expect(parseDue("")).toEqual({ date: null, time: null });
    expect(parseDue("2026-02-30").error).toMatch(/inexistante/);
    expect(parseRecurrence("3 mois")).toEqual({ every: 3, unit: "mois" });
    expect(parseRecurrence("semaine")).toEqual({ every: 1, unit: "semaine" });
    expect(parseRecurrence("tous les 2 ans")).toEqual({ every: 2, unit: "an" });
    expect(parseRecurrence("bof").error).toBeTruthy();
    expect(nextDue("2026-01-31", 1, "mois")).toBe("2026-02-28");
    expect(nextDue("2026-11-05", 1, "mois")).toBe("2026-12-05");
    expect(nextDue("2026-12-30", 1, "semaine")).toBe("2027-01-06");
    expect(nextDue("2028-02-29", 1, "an")).toBe("2029-02-28");
    expect(shortDate("2026-11-25", "2026-01-01")).toBe("25/11");
    expect(shortDate("2027-01-03", "2026-12-01")).toBe("03/01/2027");
    expect(shortTime("09:00")).toBe("9h");
    expect(shortTime("14:30")).toBe("14h30");
  });
});

describe("tâches et rappels", () => {
  it("affiche au démarrage les tâches dans l'horizon de leur niveau, par criticité", async () => {
    await call(MASTER, "add_task", { titre: "Critique dans 5 j", echeance: plus(5), criticite: "critique" });
    await call(MASTER, "add_task", { titre: "Normale dans 5 j", echeance: plus(5) }); // horizon 3 j : pas encore
    await call(MASTER, "add_task", { titre: "Basse aujourd'hui", echeance: `${today} 14:00`, criticite: "basse" });
    await call(MASTER, "add_task", { titre: "Normale en retard", echeance: plus(-2) });
    await call(MASTER, "add_task", { titre: "Sans date" });
    const out = await startup();
    const rap = out.split("\nPerso")[0].split("\n");
    expect(rap[0]).toBe("Rappels :");
    expect(rap[1]).toMatch(/^#\d+ !! Critique dans 5 j — \d\d\/\d\d/);
    expect(rap[2]).toMatch(/^#\d+ ! Normale en retard — retard \d\d\/\d\d$/);
    expect(rap[3]).toMatch(/^#\d+ Basse aujourd'hui — aujourd'hui 14h$/);
    expect(out).not.toContain("Normale dans 5 j");
    expect(out).not.toContain("Sans date");
  });

  it("n'affiche pas la section Rappels quand il n'y a rien", async () => {
    await call(MASTER, "add_task", { titre: "Plus tard", echeance: plus(30) });
    expect(await startup()).not.toContain("Rappels");
  });

  it("respecte le plafond réglable", async () => {
    for (const t of ["A", "B", "C"]) await call(MASTER, "add_task", { titre: t, echeance: today });
    expect(await admin("PATCH", "reglages", { rappels_max: 1 })).toMatchObject({ ok: true });
    expect(await startup()).toMatch(/Rappels :\n#\d+ ! A — aujourd'hui\n\+ 2 autre\(s\) \(list_tasks\)/);
  });

  it("une tâche silencieuse ne remonte plus, mais reste listée", async () => {
    const id = idOf(await call(MASTER, "add_task", { titre: "Chut", echeance: today }));
    expect(await call(MASTER, "update_task", { id, statut: "silencieux" })).toBe(`ok #${id}`);
    expect(await startup()).not.toContain("Chut");
    expect(await call(MASTER, "list_tasks")).toMatch(new RegExp(`#${id} ! Chut — aujourd'hui · silencieux`));
  });

  it("cocher une tâche récurrente crée l'occurrence suivante", async () => {
    const id = idOf(await call(MASTER, "add_task", { titre: "Loyer", echeance: "2026-11-05", recurrence: "1 mois", tags: ["maison"], projet: "Maison", groupe: "Perso" }));
    const out = await call(MASTER, "update_task", { id, statut: "fait" });
    const m = out.match(/^ok #(\d+) → #(\d+) 05\/12(\/2026)?$/);
    expect(m).toBeTruthy();
    const next = Number(m[2]);
    const list = await call(MASTER, "list_tasks", { detail: true });
    expect(list).toMatch(new RegExp(`#${next} ! Loyer — .*05/12.* · ↻ 1 mois · normale · projet: Maison`));
    expect(list).not.toContain(`#${id} `);
    expect(await call(MASTER, "list_tasks", { statut: "fait" })).toMatch(new RegExp(`#${id} ! Loyer .*fait `));
    expect(await call(MASTER, "read_memory", { id: next })).toContain("Tags : maison");
  });

  it("valide les entrées et refuse une récurrence sans échéance", async () => {
    expect(await call(MASTER, "add_task", { titre: "X", recurrence: "1 mois" })).toMatch(/^Erreur : une tâche récurrente/);
    expect(await call(MASTER, "add_task", { titre: "X", criticite: "énorme" })).toMatch(/^Erreur : criticité inconnu\(e\)\. Valeurs : critique, normale, basse\./);
    const id = idOf(await call(MASTER, "add_task", { titre: "X" }));
    expect(await call(MASTER, "update_task", { id, statut: "peut-être" })).toMatch(/^Erreur : statut invalide/);
    expect(await call(MASTER, "update_task", { id: 999999, statut: "fait" })).toBe("Tâche #999999 introuvable.");
  });

  it("forget supprime aussi la tâche", async () => {
    const id = idOf(await call(MASTER, "add_task", { titre: "Éphémère", echeance: today }));
    await call(MASTER, "forget", { id });
    expect(await env.DB.prepare("SELECT 1 FROM tasks WHERE memory_id = ?").bind(id).first()).toBeNull();
  });
});

describe("droits des clés", () => {
  it("filtre par groupe et respecte la case « affiche les rappels »", async () => {
    const perso = await groupId("Perso"), pro = await group("Pro");
    await call(MASTER, "add_task", { titre: "Perso du jour", echeance: today, groupe: "Perso" });
    await call(MASTER, "add_task", { titre: "Pro du jour", echeance: today, groupe: "Pro" });
    const proKey = await apiKey("pro", pro, { [pro]: "rw" });
    const out = await startup(proKey);
    expect(out).toContain("Pro du jour");
    expect(out).not.toContain("Perso du jour");

    const silent = await apiKey("muet", perso, { [perso]: "rw" });
    await env.DB.prepare("UPDATE api_keys SET show_reminders = 0 WHERE name = 'muet'").run();
    expect(await startup(silent)).not.toContain("Rappels");
    expect(await call(silent, "list_tasks")).toContain("Perso du jour");

    const persoTask = (await call(MASTER, "list_tasks")).match(/#(\d+) ! Perso/)[1];
    expect(await call(proKey, "update_task", { id: Number(persoTask), statut: "fait" })).toBe(`Tâche #${persoTask} introuvable.`);
  });

  it("enregistre la case dans /admin", async () => {
    const perso = await groupId("Perso");
    const r = await admin("POST", "cles", { nom: "k", groupe_defaut_id: perso, regles: { [perso]: "rw" }, rappels: false });
    expect((await env.DB.prepare("SELECT show_reminders FROM api_keys WHERE id = ?").bind(r.id).first()).show_reminders).toBe(0);
    await admin("PATCH", `cles/${r.id}`, { rappels: true });
    expect((await env.DB.prepare("SELECT show_reminders FROM api_keys WHERE id = ?").bind(r.id).first()).show_reminders).toBe(1);
  });
});

describe("admin des types et niveaux", () => {
  const levelId = async (name) => (await env.DB.prepare("SELECT id FROM task_levels WHERE name = ?").bind(name).first()).id;

  it("ajoute, modifie et supprime un niveau avec bascule des tâches", async () => {
    const r = await admin("POST", "niveaux", { nom: "urgent", position: 0, marqueur: "!!!", horizon_jours: 14, alerte: "alarme", plage_debut: "00:00", plage_fin: "24:00", relance_minutes: 30 });
    expect(r.ok).toBe(true);
    expect(await admin("POST", "niveaux", { nom: "Urgent" })).toMatchObject({ status: 409 });
    expect(await admin("PATCH", `niveaux/${r.id}`, { plage_debut: "25:00" })).toMatchObject({ status: 400 });
    const id = idOf(await call(MASTER, "add_task", { titre: "Feu", echeance: plus(10), criticite: "urgent" }));
    expect(await startup()).toMatch(new RegExp(`#${id} !!! Feu`));

    expect(await admin("DELETE", `niveaux/${r.id}`)).toMatchObject({ status: 400 });
    const del = await admin("DELETE", `niveaux/${r.id}?vers=${await levelId("basse")}`);
    expect(del).toMatchObject({ ok: true, basculees: 1 });
    expect(await call(MASTER, "list_tasks", { detail: true })).toMatch(new RegExp(`#${id} Feu .* · basse`));
  });

  it("garde toujours un élément par défaut", async () => {
    const normale = await levelId("normale");
    expect(await admin("PATCH", `niveaux/${normale}`, { par_defaut: false })).toMatchObject({ status: 400 });
    expect(await admin("DELETE", `niveaux/${normale}`)).toMatchObject({ status: 400 });
    expect(await admin("DELETE", `niveaux/${normale}?vers=${await levelId("basse")}`)).toMatchObject({ ok: true });
    expect((await env.DB.prepare("SELECT name FROM task_levels WHERE is_default = 1").all()).results).toEqual([{ name: "basse" }]);
    await call(MASTER, "add_task", { titre: "Défaut", echeance: today });
    expect(await call(MASTER, "list_tasks", { detail: true })).toMatch(/Défaut .* · basse/);
  });

  it("liste la configuration", async () => {
    const j = await admin("GET", "taches-config");
    expect(j.types.map((t) => t.name)).toEqual(["Tâche", "Rendez-vous"]);
    expect(j.niveaux.map((l) => [l.name, l.horizon_days, l.alert])).toEqual([["critique", 7, "alarme"], ["normale", 3, "notification"], ["basse", 0, "aucune"]]);
    expect(j.reglages.rappels_max).toBe("5");
  });

  it("affiche le type quand ce n'est pas le type par défaut", async () => {
    await call(MASTER, "add_task", { titre: "Dentiste", echeance: `${today} 9:00`, type: "rendez-vous" });
    expect(await startup()).toMatch(/! Dentiste — aujourd'hui 9h · Rendez-vous/);
  });
});

describe("migration v5", () => {
  it("reprend les souvenirs de type « tache » sans dupliquer", async () => {
    await call(MASTER, "remember", { titre: "Ancienne tâche", contenu: "À faire", type: "tache" });
    await env.DB.prepare("DELETE FROM tasks").run();
    for (let i = 0; i < 2; i++) {
      await env.DB.prepare("DELETE FROM schema_meta").run();
      resetSchemaCache();
      await ensureSchema(env.DB);
    }
    expect(await call(MASTER, "list_tasks")).toMatch(/^#\d+ ! Ancienne tâche$/);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM task_levels").first()).n).toBe(3);
  });
});

describe("souvenirs de type « tache » hors add_task", () => {
  it("remember et /admin créent la ligne de tâche ; /admin modifie échéance et criticité", async () => {
    const out = await call(MASTER, "remember", { titre: "Via remember", contenu: "Via remember", type: "tache" });
    const id = Number(out.match(/#(\d+)/)[1]);
    expect(await call(MASTER, "list_tasks")).toMatch(new RegExp(`^#${id} ! Via remember$`, "m"));

    const perso = (await env.DB.prepare("SELECT id FROM groups WHERE name = 'Perso'").first()).id;
    const r = await admin("POST", "souvenirs", { titre: "Via admin", contenu: "x", type: "tache", groupe_id: perso, tache: { echeance: "2026-12-01 09:30", criticite: "critique", statut: "a_faire" } });
    expect(r.ok).toBe(true);
    expect(await admin("PATCH", `souvenirs/${id}`, { tache: { echeance: "2026-12-02", criticite: "basse" } })).toMatchObject({ ok: true });
    expect(await admin("PATCH", `souvenirs/${id}`, { tache: { echeance: "bientôt" } })).toMatchObject({ status: 400 });
    const list = await call(MASTER, "list_tasks", { detail: true });
    expect(list).toMatch(new RegExp(`#${r.id} !! Via admin — 01/12 9h30 · critique`));
    expect(list).toMatch(new RegExp(`#${id} Via remember — 02/12 · basse`));
    const view = await admin("GET", `projets/0?groupe=${perso}`);
    expect(view.souvenirs.find((s) => s.id === r.id).tache).toMatchObject({ statut: "a_faire", date: "2026-12-01", heure: "09:30", criticite: "critique", type: "Tâche" });
  });
});

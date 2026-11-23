import { beforeEach, describe, expect, it } from "vitest";
import { MASTER, admin, apiKey, call, env, group, groupId, rpc, schema } from "./helpers.js";

// Arbre : Perso (créé par la migration) › Scoutisme, Perso › Sensible, Pro.
// Clé perso : Perso rw, Perso › Sensible none, Pro rw. Clé pro : Pro rw. Clé lectrice : Perso ro.
let g, keys;

beforeEach(async () => {
  await schema();
  const perso = await groupId("Perso");
  g = { perso, scout: await group("Scoutisme", perso), sensible: await group("Sensible", perso), pro: await group("Pro") };
  keys = {
    perso: await apiKey("perso", g.perso, { [g.perso]: "rw", [g.sensible]: "none", [g.pro]: "rw" }),
    pro: await apiKey("pro", g.pro, { [g.pro]: "rw" }),
    lecteur: await apiKey("lecteur", g.perso, { [g.perso]: "ro" }),
  };
  // Données de référence, créées avec la clé maîtresse.
  await call(MASTER, "remember", { titre: "Réunion client", contenu: "Budget validé pour le refonte.", projet: "Client X", groupe: "Pro", tags: ["boulot"] });
  await call(MASTER, "remember", { titre: "Code coffre", contenu: "Secret de famille confidentiel.", projet: "Coffre", groupe: "Perso/Sensible", tags: ["intime"] });
  await call(MASTER, "remember", { titre: "Camp d'été", contenu: "Camp farfadets à l'étang.", projet: "Camp", groupe: "Scoutisme", tags: ["scoutisme"] });
});

const memoryId = async (title) => (await env.DB.prepare("SELECT id FROM memories WHERE title = ?").bind(title).first()).id;

describe("groupe obligatoire", () => {
  it("refuse de créer un projet sans groupe", async () => {
    expect(await call(keys.perso, "set_project", { nom: "Nouveau" })).toMatch(/^Erreur : précise le groupe/);
    expect(await call(keys.perso, "remember", { titre: "t", contenu: "c", projet: "Nouveau" })).toMatch(/^Erreur : le projet « Nouveau » n'existe pas/);
    expect(await call(keys.perso, "set_project", { nom: "Nouveau", groupe: "Perso" })).toMatch(/Projet « Nouveau » enregistré \(groupe Perso\)/);
  });

  it("range un souvenir sans projet dans le groupe par défaut de la clé", async () => {
    expect(await call(keys.pro, "remember", { titre: "Note", contenu: "Sans projet." })).toMatch(/Groupe : Pro\./);
  });

  it("indique les groupes ambigus et introuvables", async () => {
    await group("Pro", g.perso); // Perso › Pro, homonyme de Pro
    expect(await call(MASTER, "list_projects", { groupe: "Pro" })).toMatch(/plusieurs groupes s'appellent « Pro » : .*Perso › Pro/);
    expect(await call(MASTER, "list_projects", { groupe: "Perso/Pro" })).toBe("Aucun projet pour l'instant.");
    expect(await call(MASTER, "list_projects", { groupe: "Inconnu" })).toMatch(/introuvable/);
  });
});

describe("cloisonnement de la clé pro", () => {
  it("ne voit rien hors de Pro, par aucun chemin", async () => {
    const perso = await memoryId("Camp d'été");
    const fichier = await call(MASTER, "attach_file", { nom_fichier: "plan.txt", contenu_texte: "plan", projet: "Camp" });
    const fid = fichier.match(/id=(\w+)/)[1];

    expect(await call(keys.pro, "recall", { requete: "etang" })).toMatch(/^Aucun souvenir/);
    expect(await call(keys.pro, "recall", {})).not.toMatch(/Camp|coffre/i);
    expect(await call(keys.pro, "read_memory", { id: perso })).toMatch(/introuvable/);
    expect(await call(keys.pro, "project_context", { nom: "Camp" })).toMatch(/introuvable/);
    expect(await call(keys.pro, "recall", { tags: ["scoutisme"] })).toMatch(/^Aucun souvenir/);
    expect(await call(keys.pro, "list_tags")).toBe("boulot (1)");
    expect(await call(keys.pro, "read_file", { id: fid })).toMatch(/introuvable/);
    expect(await call(keys.pro, "list_files")).toBe("Aucun fichier.");
    expect(await call(keys.pro, "list_projects", { noms_seulement: true })).toBe("Pro : Client X\nTags : boulot");
    expect(await call(keys.pro, "list_groups")).toMatch(/^• Pro \[lecture-écriture \| 1 projet\(s\) \| 1 souvenir\(s\) \| par défaut\]$/);
    expect(await call(keys.pro, "update_memory", { id: perso, titre: "x" })).toMatch(/introuvable/);
    expect(await call(keys.pro, "forget", { id: perso })).toMatch(/introuvable/);
    expect(await call(keys.pro, "set_project", { nom: "Camp", groupe: "Pro" })).toMatch(/n'est pas disponible/);
  });
});

describe("héritage et exception", () => {
  it("donne accès à Perso › Scoutisme mais rien de Perso › Sensible", async () => {
    expect(await call(keys.perso, "remember", { titre: "Jeu", contenu: "Grand jeu.", projet: "Camp" })).toMatch(/Groupe : Perso › Scoutisme\./);
    expect(await call(keys.perso, "recall", { requete: "coffre" })).toMatch(/^Aucun souvenir/);
    expect(await call(keys.perso, "read_memory", { id: await memoryId("Code coffre") })).toMatch(/introuvable/);
    expect(await call(keys.perso, "list_projects", { noms_seulement: true })).not.toMatch(/Coffre|Sensible|intime/);
    expect(await call(keys.perso, "list_projects", { noms_seulement: true })).toMatch(/Perso › Scoutisme : Camp/);
    expect(await call(keys.perso, "remember", { titre: "x", contenu: "y", groupe: "Perso/Sensible" })).toMatch(/introuvable/);
  });
});

describe("lecture seule", () => {
  it("lit mais n'écrit pas", async () => {
    const id = await memoryId("Camp d'été");
    expect(await call(keys.lecteur, "read_memory", { id })).toMatch(/Groupe : Perso › Scoutisme \(lecture seule\)/);
    expect(await call(keys.lecteur, "recall", { requete: "etang" })).toMatch(/Camp d'été/);
    expect(await call(keys.lecteur, "remember", { titre: "x", contenu: "y" })).toMatch(/lecture seule/);
    expect(await call(keys.lecteur, "remember", { titre: "x", contenu: "y", projet: "Camp" })).toMatch(/lecture seule/);
    expect(await call(keys.lecteur, "update_memory", { id, titre: "x" })).toMatch(/lecture seule/);
    expect(await call(keys.lecteur, "forget", { id })).toMatch(/lecture seule/);
    expect(await call(keys.lecteur, "set_project", { nom: "Camp", statut: "termine" })).toMatch(/lecture seule/);
    expect(await call(keys.lecteur, "attach_file", { nom_fichier: "a.txt", contenu_texte: "a", projet: "Camp" })).toMatch(/lecture seule/);
  });
});

describe("déplacement d'un projet", () => {
  it("emmène ses souvenirs et ses fichiers, et sort du périmètre de la clé pro", async () => {
    const id = await memoryId("Réunion client");
    await call(MASTER, "attach_file", { nom_fichier: "devis.txt", contenu_texte: "devis", souvenir_id: id });
    expect(await call(keys.pro, "list_files")).toMatch(/devis\.txt/);
    expect(await call(keys.perso, "set_project", { nom: "Client X", groupe: "Perso" })).toMatch(/déplacé avec ses souvenirs et ses fichiers/);
    const rows = await env.DB.prepare("SELECT (SELECT group_id FROM memories WHERE id = ?) AS m, (SELECT group_id FROM files WHERE filename = 'devis.txt') AS f").bind(id).first();
    expect(rows).toEqual({ m: g.perso, f: g.perso });
    expect(await call(keys.pro, "recall", { requete: "budget" })).toMatch(/^Aucun souvenir/);
    expect(await call(keys.pro, "list_files")).toBe("Aucun fichier.");
  });

  it("exige l'écriture sur les deux groupes", async () => {
    expect(await call(keys.pro, "set_project", { nom: "Client X", groupe: "Perso" })).toMatch(/introuvable/);
    const lect = await apiKey("mixte", g.pro, { [g.pro]: "rw", [g.perso]: "ro" });
    expect(await call(lect, "set_project", { nom: "Client X", groupe: "Perso" })).toMatch(/lecture seule/);
  });
});

describe("clés", () => {
  it("refuse une clé révoquée et ne stocke que le hash", async () => {
    expect(await call(keys.pro, "list_groups")).toMatch(/Pro/);
    await env.DB.prepare("UPDATE api_keys SET revoked_at = '2026-01-01T00:00:00Z' WHERE name = 'pro'").run();
    expect((await rpc(keys.pro, "tools/list")).status).toBe(404);
    const stored = await env.DB.prepare("SELECT key_hash FROM api_keys WHERE name = 'perso'").first();
    expect(stored.key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.key_hash).not.toContain(keys.perso);
  });

  it("crée une clé dans /admin, l'affiche une fois et vérifie le groupe par défaut", async () => {
    expect((await admin("POST", "cles", { nom: "x", groupe_defaut_id: g.pro, regles: { [g.perso]: "rw" } })).erreur).toMatch(/groupe par défaut doit être en lecture-écriture/);
    const r = await admin("POST", "cles", { nom: "Claude pro 2", groupe_defaut_id: g.pro, regles: { [g.pro]: "rw" } });
    expect(r.url).toBe(`https://memory.test/${r.cle}/mcp`);
    expect(await call(r.cle, "list_projects", { noms_seulement: true })).toBe("Pro : Client X\nTags : boulot");
    const liste = await admin("GET", "cles");
    expect(JSON.stringify(liste)).not.toContain(r.cle);
    await admin("DELETE", `cles/${r.id}`);
    expect((await rpc(r.cle, "tools/list")).status).toBe(404);
  });

  it("désactive la clé maîtresse avec MASTER_KEY_ENABLED", async () => {
    const { authenticate } = await import("../src/auth/keys.js");
    expect(await authenticate(env.DB, { ...env, MASTER_KEY_ENABLED: "false" }, MASTER)).toBeNull();
    expect((await authenticate(env.DB, env, MASTER)).isMaster).toBe(true);
  });
});

describe("arbre des groupes dans /admin", () => {
  it("limite la profondeur, empêche les cycles et la suppression d'un groupe non vide", async () => {
    const lvl3 = (await admin("POST", "groupes", { nom: "Farfadets", parent_id: g.scout })).id;
    expect((await admin("POST", "groupes", { nom: "Trop", parent_id: lvl3 })).erreur).toMatch(/Profondeur maximale/);
    expect((await admin("PATCH", `groupes/${g.perso}`, { parent_id: g.scout })).erreur).toMatch(/sous lui-même/);
    expect((await admin("PATCH", `groupes/${g.perso}`, { parent_id: g.pro })).erreur).toMatch(/Profondeur maximale/); // 1 + 3 niveaux
    expect((await admin("POST", "groupes", { nom: "scoutisme", parent_id: g.perso })).erreur).toMatch(/existe déjà/);
    expect((await admin("DELETE", `groupes/${g.scout}`)).erreur).toMatch(/n'est pas vide/);
    expect((await admin("DELETE", `groupes/${g.pro}`)).erreur).toMatch(/n'est pas vide/);
    expect((await admin("DELETE", `groupes/${lvl3}`)).ok).toBe(true);
  });

  it("déplace un projet depuis /admin", async () => {
    const pid = (await env.DB.prepare("SELECT id FROM projects WHERE name = 'Camp'").first()).id;
    expect((await admin("PATCH", `projets/${pid}`, { groupe_id: g.pro })).ok).toBe(true);
    expect(await call(keys.pro, "recall", { requete: "etang" })).toMatch(/Camp d'été/);
    expect((await admin("POST", "projets", { nom: "Sans groupe" })).erreur).toMatch(/groupe est obligatoire/);
  });
});

describe("envoi par lien", () => {
  it("range le fichier dans le groupe choisi à la création du lien", async () => {
    const out = await call(keys.pro, "prepare_upload", { nom_fichier: "a.txt", projet: "Client X" });
    const path = out.match(/\/upload\/[\w-]+/)[0];
    const { SELF } = await import("cloudflare:test");
    const res = await SELF.fetch(`https://memory.test${path}`, { method: "PUT", body: "hello" });
    expect(res.status).toBe(200);
    expect(await call(keys.pro, "list_files")).toMatch(/a\.txt .* projet: Client X/);
    expect(await call(keys.perso, "list_files", { groupe: "Perso" })).toBe("Aucun fichier.");
  });
});

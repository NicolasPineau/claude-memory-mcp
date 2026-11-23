import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { schema } from "./helpers.js";

// Consommation fixée en cache : pas d'appel réel à l'API Analytics pendant les tests.
beforeAll(schema);

const SECRET = "test-secret-0123456789abcdef";
let id = 0;

async function rpc(method, params = {}) {
  const res = await SELF.fetch(`https://memory.test/${SECRET}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  return res.json();
}

async function call(name, args = {}) {
  const r = await rpc("tools/call", { name, arguments: args });
  return r.result.content[0].text;
}

describe("protocole MCP", () => {
  it("répond à initialize avec les instructions", async () => {
    const r = await rpc("initialize", { protocolVersion: "2025-06-18" });
    expect(r.result.protocolVersion).toBe("2025-06-18");
    expect(r.result.instructions).toContain("list_projects");
  });

  it("expose les 18 outils dans l'ordre", async () => {
    const r = await rpc("tools/list");
    expect(r.result.tools.map((t) => t.name)).toEqual([
      "recall", "remember", "read_memory", "update_memory", "forget",
      "list_projects", "set_project", "project_context", "list_tags", "add_task", "update_task", "list_tasks", "list_groups",
      "attach_file", "prepare_upload", "read_file", "delete_file", "list_files",
    ]);
  });

  it("refuse une mauvaise clé", async () => {
    const res = await SELF.fetch("https://memory.test/mauvaise-cle/mcp", { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
  });
});

describe("souvenirs", () => {
  it("enregistre, retrouve (sans accents) et lit un souvenir", async () => {
    expect(await call("remember", { titre: "Camp d'été", contenu: "Camp farfadets à l'étang.", projet: "Scouts", groupe: "Perso", tags: ["#Scoutisme"] }))
      .toMatch(/Souvenir #\d+ enregistré\. Projet : Scouts \(créé\)\. Groupe : Perso\. Tags : scoutisme\./);
    expect(await call("recall", { requete: "etang" })).toContain("Camp d'été");
    expect(await call("list_projects", { noms_seulement: true })).toMatch(/^Perso : Scouts\nTags : scoutisme/);
  });
});

describe("fichiers", () => {
  it("joint un fichier texte et relit son contenu", async () => {
    const out = await call("attach_file", { nom_fichier: "notes.md", contenu_texte: "# Notes\nété" });
    const fid = out.match(/id=([a-f0-9]+)/)[1];
    expect(await call("read_file", { id: fid, mode: "contenu" })).toContain("# Notes\nété");
  });
});

describe("admin", () => {
  it("reste fermé sans configuration Cloudflare Access", async () => {
    const res = await SELF.fetch("https://memory.test/admin");
    expect(res.status).toBe(503);
  });
});

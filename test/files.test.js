import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { r2Key } from "../src/files/storage.js";
import { MASTER, admin, call, env, schema } from "./helpers.js";

beforeEach(schema);

const fileId = (out) => out.match(/id=([a-f0-9]{12})/)[1];

describe("fichiers dans R2", () => {
  it("range un nouveau fichier dans R2, sans rien dans file_chunks, et le relit", async () => {
    const id = fileId(await call(MASTER, "attach_file", { nom_fichier: "note.md", contenu_texte: "# Été\nà l'étang" }));
    const row = await env.DB.prepare("SELECT storage, size FROM files WHERE id = ?").bind(id).first();
    expect(row).toEqual({ storage: "r2", size: new TextEncoder().encode("# Été\nà l'étang").length });
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM file_chunks").first()).n).toBe(0);
    expect(await (await env.FILES.get(r2Key(id))).text()).toBe("# Été\nà l'étang");
    expect(await call(MASTER, "read_file", { id, mode: "contenu" })).toMatch(/\n# Été\nà l'étang$/);
  });

  it("sert le fichier par lien de téléchargement et le supprime aussi de R2", async () => {
    const id = fileId(await call(MASTER, "attach_file", { nom_fichier: "a.bin", contenu_base64: "AAEC/w==" }));
    const dl = (await call(MASTER, "read_file", { id })).match(/\/dl\/[\w-]+/)[0];
    const res = await SELF.fetch(`https://memory.test${dl}`);
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([0, 1, 2, 255]);
    expect(await call(MASTER, "delete_file", { id })).toMatch(/supprimé/);
    expect(await env.FILES.get(r2Key(id))).toBeNull();
  });

  it("range dans R2 un fichier envoyé par lien d'envoi", async () => {
    const up = (await call(MASTER, "prepare_upload", { nom_fichier: "photo.jpg" })).match(/\/upload\/[\w-]+/)[0];
    const r = await (await SELF.fetch(`https://memory.test${up}`, { method: "PUT", body: new Uint8Array([9, 8, 7]) })).json();
    expect((await env.DB.prepare("SELECT storage FROM files WHERE id = ?").bind(r.id).first()).storage).toBe("r2");
    expect([...new Uint8Array(await (await env.FILES.get(r2Key(r.id))).arrayBuffer())]).toEqual([9, 8, 7]);
  });

  it("lit encore un ancien fichier resté dans D1", async () => {
    const g = (await env.DB.prepare("SELECT id FROM groups WHERE name = 'Perso'").first()).id;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO files(id, filename, mime, size, description, group_id, storage, created_at) VALUES ('d1d1d1d1d1d1', 'old.txt', 'text/plain', 5, '', ?, 'd1', 't')").bind(g),
      env.DB.prepare("INSERT INTO file_chunks VALUES ('d1d1d1d1d1d1', 0, 'aGVsbG8=')"),
    ]);
    expect(await call(MASTER, "read_file", { id: "d1d1d1d1d1d1", mode: "contenu" })).toMatch(/\nhello$/);
    const dl = (await call(MASTER, "read_file", { id: "d1d1d1d1d1d1" })).match(/\/dl\/[\w-]+/)[0];
    expect(await (await SELF.fetch(`https://memory.test${dl}`)).text()).toBe("hello");
  });
});

describe("ménage des fichiers dans /admin", () => {
  it("liste les fichiers du plus gros au plus petit, et en supprime plusieurs d'un coup (D1 et R2)", async () => {
    const small = fileId(await call(MASTER, "attach_file", { nom_fichier: "petit.txt", contenu_texte: "a" }));
    const big = fileId(await call(MASTER, "attach_file", { nom_fichier: "gros.txt", contenu_texte: "b".repeat(5000) }));
    const g = (await env.DB.prepare("SELECT id FROM groups WHERE name = 'Perso'").first()).id;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO files(id, filename, mime, size, description, group_id, storage, created_at) VALUES ('d1d1d1d1d1d1', 'ancien.txt', 'text/plain', 300, '', ?, 'd1', 't')").bind(g),
      env.DB.prepare("INSERT INTO file_chunks VALUES ('d1d1d1d1d1d1', 0, 'aGVsbG8=')"),
    ]);
    const list = await admin("GET", "fichiers");
    expect(list.fichiers.map((f) => f.filename)).toEqual(["gros.txt", "ancien.txt", "petit.txt"]);
    expect(list.fichiers[0]).toMatchObject({ size: 5000, storage: "r2", group_id: g });

    const r = await admin("POST", "fichiers/supprimer", { ids: [big, "d1d1d1d1d1d1", "inexistant"] });
    expect(r).toMatchObject({ ok: true, supprimes: 2, octets: 5300 });
    expect(await env.FILES.get(r2Key(big))).toBeNull();
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM file_chunks").first()).n).toBe(0);
    expect((await admin("GET", "fichiers")).fichiers.map((f) => f.id)).toEqual([small]);
    expect((await admin("POST", "fichiers/supprimer", { ids: [] })).erreur).toMatch(/Aucun fichier/);
  });
});

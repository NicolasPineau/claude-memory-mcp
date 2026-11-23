import { describe, expect, it } from "vitest";
import { planPrune } from "../scripts/lib/prune.js";

const DAY = 86400_000, now = Date.parse("2026-11-23T02:00:00Z");
const k = (...ids) => ids.map((id) => `files/${id}`);

describe("nettoyage des copies de fichiers sauvegardés", () => {
  it("note un nouvel orphelin sans l'effacer", () => {
    expect(planPrune({ keys: k("aaaaaaaaaaaa", "bbbbbbbbbbbb"), fileIds: ["aaaaaaaaaaaa"], orphans: [], now }))
      .toEqual({ toRecord: ["bbbbbbbbbbbb"], toDelete: [], toForget: [] });
  });

  it("efface un orphelin noté depuis plus de 60 jours, garde les plus récents", () => {
    const orphans = [{ id: "bbbbbbbbbbbb", since: now - 61 * DAY }, { id: "cccccccccccc", since: now - 10 * DAY }];
    expect(planPrune({ keys: k("bbbbbbbbbbbb", "cccccccccccc"), fileIds: [], orphans, now }))
      .toEqual({ toRecord: [], toDelete: ["bbbbbbbbbbbb"], toForget: ["bbbbbbbbbbbb"] });
  });

  it("respecte une autre durée de conservation", () => {
    const orphans = [{ id: "cccccccccccc", since: now - 10 * DAY }];
    expect(planPrune({ keys: k("cccccccccccc"), fileIds: [], orphans, now, keepDays: 7 }).toDelete).toEqual(["cccccccccccc"]);
  });

  it("oublie un orphelin dont le fichier est revenu ou dont la copie a disparu", () => {
    const orphans = [{ id: "aaaaaaaaaaaa", since: now - 5 * DAY }, { id: "dddddddddddd", since: now - 5 * DAY }];
    expect(planPrune({ keys: k("aaaaaaaaaaaa"), fileIds: ["aaaaaaaaaaaa"], orphans, now }))
      .toEqual({ toRecord: [], toDelete: [], toForget: ["aaaaaaaaaaaa", "dddddddddddd"] });
  });

  it("ignore les clés qui ne sont pas des copies de fichiers", () => {
    expect(planPrune({ keys: ["db/2026-11-22.sql.gz", "files/pas-un-id", "files/aaaaaaaaaaaa/x"], fileIds: [], orphans: [], now }))
      .toEqual({ toRecord: [], toDelete: [], toForget: [] });
  });
});

import { RO } from "../tool-helpers.js";

export const GROUPS_TOOLS = {
  list_groups: {
    description: "Liste les groupes visibles par ce connecteur, en arbre : chemin, droits (lecture seule ou lecture-écriture), nombre de projets et de souvenirs, groupe par défaut. Les groupes se créent dans l'interface /admin, pas ici.",
    annotations: RO,
    inputSchema: { type: "object", properties: {} },
    async run(db, a, { acl }) {
      const groups = acl.tree.ordered().filter((g) => acl.canRead(g.id));
      if (!groups.length) return "Aucun groupe accessible pour ce connecteur.";
      const count = async (table) => new Map((await db.prepare(`SELECT group_id, COUNT(*) n FROM ${table} WHERE ${acl.sqlIn("group_id")} GROUP BY group_id`).all()).results.map((r) => [r.group_id, r.n]));
      const [np, nm] = [await count("projects"), await count("memories")];
      return groups.map((g) => {
        const tags = [acl.canWrite(g.id) ? "lecture-écriture" : "lecture seule", `${np.get(g.id) || 0} projet(s)`, `${nm.get(g.id) || 0} souvenir(s)`];
        if (g.id === acl.defaultGroupId) tags.push("par défaut");
        return `${"  ".repeat(g.depth - 1)}• ${g.path} [${tags.join(" | ")}]` + (g.description ? `\n${"  ".repeat(g.depth)}${g.description}` : "");
      }).join("\n");
    },
  },
};

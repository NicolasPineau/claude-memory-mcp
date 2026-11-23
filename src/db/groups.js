import { DEFAULT_GROUP } from "./schema.js";

// ------------------------------------------------------------------ groupes (arbre) et droits
export const MAX_DEPTH = 3;
export const SEP = " › ";
export const ACCESS = ["rw", "ro", "none"];

export class GroupTree {
  constructor(rows) {
    this.list = rows;
    this.byId = new Map(rows.map((g) => [g.id, g]));
    this.children = new Map();
    for (const g of rows) {
      const k = g.parent_id ?? 0;
      if (!this.children.has(k)) this.children.set(k, []);
      this.children.get(k).push(g);
    }
  }

  get(id) {
    return this.byId.get(Number(id));
  }

  // Le groupe puis ses ancêtres, jusqu'à la racine.
  ancestors(id) {
    const out = [];
    for (let g = this.get(id); g && out.length <= MAX_DEPTH + 1; g = this.get(g.parent_id)) out.push(g);
    return out;
  }

  path(id) {
    return this.ancestors(id).reverse().map((g) => g.name).join(SEP);
  }

  depth(id) {
    return this.ancestors(id).length;
  }

  // Identifiants du groupe et de tous ses descendants.
  descendants(id) {
    const out = [];
    const walk = (gid) => {
      out.push(gid);
      for (const c of this.children.get(gid) || []) walk(c.id);
    };
    if (this.get(id)) walk(Number(id));
    return out;
  }

  // Nombre de niveaux du sous-arbre, groupe compris.
  height(id) {
    const kids = this.children.get(Number(id)) || [];
    return 1 + (kids.length ? Math.max(...kids.map((c) => this.height(c.id))) : 0);
  }

  // Parcours en profondeur, pour l'affichage.
  ordered() {
    const out = [];
    const walk = (k, depth) => {
      for (const g of this.children.get(k) || []) {
        out.push({ ...g, depth, path: this.path(g.id) });
        walk(g.id, depth + 1);
      }
    };
    walk(0, 1);
    return out;
  }
}

export async function loadGroups(db) {
  const rows = (await db.prepare("SELECT id, parent_id, name, description FROM groups ORDER BY name COLLATE NOCASE").all()).results;
  return new GroupTree(rows);
}

// Groupe racine « Perso » (créé par la migration), sinon le premier groupe racine.
export async function defaultRootGroupId(db) {
  const r = await db.prepare("SELECT id FROM groups WHERE parent_id IS NULL ORDER BY name <> ? COLLATE NOCASE, id LIMIT 1").bind(DEFAULT_GROUP).first();
  return r ? r.id : null;
}

// Droit effectif de chaque groupe : la règle la plus proche en remontant vers la racine, sinon « none ».
export function effectiveRights(tree, rules, isMaster = false) {
  const rights = new Map();
  for (const g of tree.list) {
    if (isMaster) { rights.set(g.id, "rw"); continue; }
    let r = "none";
    for (const a of tree.ancestors(g.id)) {
      if (rules.has(a.id)) { r = rules.get(a.id); break; }
    }
    rights.set(g.id, r);
  }
  return rights;
}

// Ce qu'une requête a le droit de voir et de modifier.
export class Acl {
  constructor(tree, rights, defaultGroupId) {
    this.tree = tree;
    this.rights = rights;
    this.defaultGroupId = defaultGroupId;
    this.readable = new Set([...rights].filter(([, r]) => r !== "none").map(([id]) => id));
    this.writable = new Set([...rights].filter(([, r]) => r === "rw").map(([id]) => id));
  }

  canRead(id) {
    return this.readable.has(Number(id));
  }

  canWrite(id) {
    return this.writable.has(Number(id));
  }

  // Condition SQL « col IN (...) » sur des identifiants entiers ; « 0 » (faux) si aucun.
  sqlIn(col, ids = this.readable) {
    const list = [...ids].map(Number).filter(Number.isInteger);
    return list.length ? `${col} IN (${list.join(",")})` : "0";
  }

  // Groupes lisibles du sous-arbre d'un groupe (pour les filtres).
  readableSubtree(id) {
    return new Set(this.tree.descendants(id).filter((g) => this.canRead(g)));
  }

  label(id) {
    return this.tree.path(id) + (this.canWrite(id) ? "" : " (lecture seule)");
  }

  // Trouve un groupe lisible à partir d'un chemin (« Perso/Scoutisme », « Perso › Scoutisme ») ou d'un nom seul.
  resolve(input) {
    const raw = String(input ?? "").trim();
    if (!raw) return { error: "Erreur : groupe vide." };
    const parts = raw.split(/\s*(?:\/|›)\s*/).filter(Boolean);
    const eq = (a, b) => a.localeCompare(b, "fr", { sensitivity: "accent" }) === 0;
    let found = [];
    if (parts.length > 1) {
      let level = [{ id: 0 }];
      for (const p of parts) {
        level = level.flatMap((g) => (this.tree.children.get(g.id) || []).filter((c) => eq(c.name, p)));
      }
      found = level;
    } else {
      found = this.tree.list.filter((g) => eq(g.name, parts[0]));
    }
    found = found.filter((g) => this.canRead(g.id));
    if (found.length === 1) return { group: found[0] };
    if (!found.length) return { error: `Erreur : groupe « ${raw} » introuvable. Voir list_groups.` };
    return { error: `Erreur : plusieurs groupes s'appellent « ${raw} » : ${found.map((g) => this.tree.path(g.id)).join(", ")}. Précise le chemin.` };
  }
}

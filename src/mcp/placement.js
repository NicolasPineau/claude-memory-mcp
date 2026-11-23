import { createProject, findProject } from "../db/memories.js";

// ------------------------------------------------------------------ rangement d'un élément (projet / groupe)
export const readOnlyError = (acl, gid) => `Erreur : le groupe ${acl.tree.path(gid)} est en lecture seule pour ce connecteur.`;

// Détermine où ranger un souvenir ou un fichier, en créant le projet si besoin.
// - projet existant : son groupe (`groupe`, s'il est donné, doit être le même) ;
// - projet inexistant : `groupe` obligatoire, le projet y est créé ;
// - sans projet : `groupe`, sinon le groupe par défaut de la clé.
// Renvoie { projectId, projectName, groupId, created } ou { error }.
export async function resolvePlacement(db, acl, { projet, groupe }) {
  let target = null;
  if (groupe != null && String(groupe).trim()) {
    const r = acl.resolve(groupe);
    if (r.error) return r;
    target = r.group.id;
  }
  const name = projet != null ? String(projet).trim() : "";
  if (name) {
    const p = await findProject(db, name);
    if (p) {
      if (!acl.canRead(p.group_id)) return { error: `Erreur : le nom de projet « ${name} » n'est pas disponible.` };
      if (target && target !== p.group_id)
        return { error: `Erreur : le projet « ${p.name} » est dans le groupe ${acl.tree.path(p.group_id)}, pas dans ${acl.tree.path(target)}.` };
      if (!acl.canWrite(p.group_id)) return { error: readOnlyError(acl, p.group_id) };
      return { projectId: p.id, projectName: p.name, groupId: p.group_id, created: false };
    }
    if (!target) return { error: `Erreur : le projet « ${name} » n'existe pas. Pour le créer, précise son groupe (\`groupe\`, voir list_groups).` };
    if (!acl.canWrite(target)) return { error: readOnlyError(acl, target) };
    const id = await createProject(db, name, target);
    return { projectId: id, projectName: name, groupId: target, created: true };
  }
  const gid = target ?? acl.defaultGroupId;
  if (!gid || !acl.canRead(gid)) return { error: "Erreur : ce connecteur n'a pas de groupe par défaut accessible. Précise `groupe` (voir list_groups)." };
  if (!acl.canWrite(gid)) return { error: readOnlyError(acl, gid) };
  return { projectId: null, projectName: null, groupId: gid, created: false };
}

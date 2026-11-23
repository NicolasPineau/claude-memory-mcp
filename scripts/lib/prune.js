// Nettoyage des copies de fichiers dans le bucket de sauvegarde (files/<id>).
// Une copie dont le fichier n'existe plus dans la base est notée orpheline à sa première détection,
// puis supprimée après `keepDays` jours : le temps de récupérer un fichier supprimé par erreur.
// Fonction pure, testée dans test/prune.test.js.
export const FILE_KEY = /^files\/([a-f0-9]{12})$/;

export function planPrune({ keys, fileIds, orphans, now = Date.now(), keepDays = 60 }) {
  const alive = new Set(fileIds);
  const seen = new Map(orphans.map((o) => [o.id, Number(o.since)]));
  const limit = now - keepDays * 86400_000;
  const toRecord = [], toDelete = [], toForget = [];
  const present = new Set();
  for (const key of keys) {
    const m = FILE_KEY.exec(key);
    if (!m) continue;
    const id = m[1];
    present.add(id);
    if (alive.has(id)) {
      if (seen.has(id)) toForget.push(id); // fichier restauré entre-temps : il n'est plus orphelin
    } else if (!seen.has(id)) {
      toRecord.push(id);
    } else if (seen.get(id) <= limit) {
      toDelete.push(id);
    }
  }
  // Orphelins déjà notés dont la copie a disparu : on les oublie.
  for (const id of seen.keys()) if (!present.has(id) && !toForget.includes(id)) toForget.push(id);
  return { toRecord, toDelete, toForget: [...toForget, ...toDelete] };
}

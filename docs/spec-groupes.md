# Feat 1 — Groupes, sous-groupes et clés d'accès

Statut : spec validée en interview le 23/11/2026, à implémenter. Cible : v3.0.0, avec les autres feats.

## 1. Besoin

- Séparer les projets perso des projets pro, et avoir un espace « sensible ».
- Chaque compte Claude est rattaché à un ou plusieurs groupes, avec des droits de lecture ou d'écriture, et ne voit **que** ce qui lui est accordé. Exemple : le compte perso voit tout ; le compte pro ne voit que pro.
- Un projet appartient obligatoirement à un groupe, fixé à sa création. On peut le déplacer vers un autre groupe.
- Les groupes forment un arbre : `Perso › Scoutisme › Farfadets`.

## 2. Décisions

| Sujet | Décision |
|---|---|
| Groupes | Libres, en **arbre de 3 niveaux maximum**. Aucun groupe n'a de traitement spécial dans le code. |
| Création et gestion des groupes | **`/admin` seulement** : création, renommage, déplacement dans l'arbre, suppression. Claude ne fait que les lister et y ranger des projets. |
| Rattachement | Un projet (ou un souvenir sans projet) peut être rattaché à **n'importe quel niveau** de l'arbre. |
| Appartenance | **Un seul groupe** par projet, souvenir ou fichier. Pour partager, on déplace ou on duplique. |
| Droits | Par clé et par groupe : **lecture et écriture**, **lecture seule** ou **aucun accès**. |
| Héritage | Un droit posé sur un groupe s'applique à ses sous-groupes, **sauf règle explicite** sur un sous-groupe (ex. `Perso` en lecture-écriture, `Perso › Sensible` en aucun accès). |
| Suppression d'un groupe | **Interdite tant qu'il n'est pas vide** (sous-groupes, projets, souvenirs, fichiers). |
| Chiffrement | **Pas de chiffrement applicatif.** La base reste en clair et la recherche FTS fonctionne partout. Les échanges sont déjà chiffrés (HTTPS, TLS entre le Worker et D1, D1 chiffré au repos). « Sensible » est un groupe comme un autre ; seuls ses droits le protègent. |
| Accès | Une **clé par compte Claude**, donc une URL de connecteur par compte, gérée dans `/admin`. |
| Souvenir sans projet | Il prend le groupe passé en paramètre, sinon le groupe par défaut de la clé. |
| Migration | Tous les projets, souvenirs et fichiers existants vont dans un groupe racine « Perso ». |
| `MEMORY_SECRET` | Conservé comme **clé maîtresse** pendant la transition : elle a la lecture et l'écriture sur tout l'arbre. |

### Hors périmètre

- Appartenance multiple (un élément dans plusieurs groupes).
- Chiffrement applicatif.
- Profondeur au-delà de 3 niveaux.
- Gestion des groupes et des droits par Claude via MCP.

## 3. Modèle de données

Nouvelles tables :

```sql
groups (id INTEGER PRIMARY KEY,
        parent_id INTEGER REFERENCES groups(id),               -- NULL = racine
        name TEXT NOT NULL COLLATE NOCASE,
        description TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL)
-- unicité du nom entre frères : index unique sur (COALESCE(parent_id, 0), name)

api_keys (id INTEGER PRIMARY KEY, name TEXT NOT NULL,          -- ex. « Claude perso »
          key_hash TEXT NOT NULL UNIQUE,                       -- SHA-256 hex ; la clé n'est jamais stockée
          default_group_id INTEGER NOT NULL REFERENCES groups(id),
          created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT)

api_key_rules (key_id INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
               group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
               access TEXT NOT NULL CHECK (access IN ('rw', 'ro', 'none')),
               PRIMARY KEY (key_id, group_id))

schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)        -- version du schéma pour les migrations
```

Colonnes ajoutées (`ALTER TABLE … ADD COLUMN group_id INTEGER REFERENCES groups(id)`) :

- `projects.group_id`
- `memories.group_id`, dénormalisé : égal au groupe du projet s'il y en a un, sinon au groupe choisi
- `files.group_id`, même règle

SQLite n'accepte pas `NOT NULL` sans valeur par défaut sur `ADD COLUMN`. Le caractère obligatoire est donc garanti par le code et par la migration, qui remplit toutes les lignes.

Contraintes vérifiées par le code :
- profondeur ≤ 3 ;
- pas de cycle quand on déplace un groupe dans l'arbre ;
- nom unique parmi les frères.

Le nom d'un projet reste **unique globalement**. En cas de conflit avec un projet invisible pour la clé, le message est générique (« nom indisponible ») pour ne pas révéler son existence.

## 4. Désigner un groupe

- **Chemin complet**, avec `/` ou `›` comme séparateur : `Perso/Scoutisme/Farfadets`.
- **Nom seul**, accepté s'il est unique parmi les groupes visibles par la clé. Sinon, l'erreur liste les chemins possibles.
- **Affichage** : toujours le chemin complet, `Perso › Scoutisme › Farfadets`.

## 5. Droits

### Résolution du droit effectif d'une clé sur un groupe G

1. On remonte de G vers la racine : G, puis son parent, puis son grand-parent.
2. La **première règle trouvée** s'applique (`rw`, `ro` ou `none`).
3. Si aucune règle n'est trouvée, le droit est `none`.
4. La clé maîtresse a toujours `rw`.

L'arbre étant petit (3 niveaux), le Worker charge tous les groupes et les règles de la clé une fois par requête et calcule deux ensembles : `readable` (`ro` + `rw`) et `writable` (`rw`).

### Application

| Opération | Droit requis |
|---|---|
| `recall`, `read_memory`, `list_*`, `project_context`, `read_file` | lecture sur le groupe de l'élément |
| `remember`, `attach_file`, `prepare_upload` | écriture sur le groupe cible |
| `update_memory`, `forget`, `delete_file` | écriture sur le groupe de l'élément |
| `set_project` (création, modification) | écriture sur le groupe du projet |
| Déplacer un projet | écriture sur le groupe source **et** sur le groupe cible |

- **Élément illisible** : on répond exactement comme s'il n'existait pas (« introuvable »), pour ne rien laisser fuiter.
- **Élément lisible mais pas modifiable** : on répond « lecture seule pour cette clé ».
- **Groupe par défaut** : il doit être en écriture pour la clé, ce qui est vérifié dans `/admin` à l'enregistrement.
- **Tags** : la table reste globale, mais les tags ne sont comptés et affichés que pour les souvenirs lisibles.
- **Jetons d'upload et de download** : le groupe est enregistré dans le `meta` du jeton à sa création. Le droit est vérifié à ce moment-là, puis le jeton reste valable seul, comme aujourd'hui.

## 6. Authentification

- URL inchangée : `POST /<clé>/mcp`.
- Résolution : on calcule le SHA-256 de `<clé>` et on cherche dans `api_keys` (non révoquée). Sinon on compare en temps constant avec `MEMORY_SECRET`. Sinon `404`.
- `last_used_at` est mis à jour au plus une fois par heure.
- Clé générée : 32 octets aléatoires en base64url. Elle n'est affichée **qu'une fois**, à la création dans `/admin`.

## 7. Outils MCP

### Nouveau

| Outil | Rôle |
|---|---|
| `list_groups` | Arbre des groupes lisibles par la clé : chemin, description, nb de projets et de souvenirs, droit (`lecture` ou `lecture-écriture`), groupe par défaut signalé. |

### Modifiés

| Outil | Changement |
|---|---|
| `set_project` | Paramètre `groupe`, **obligatoire à la création** (sinon erreur explicite). Sur un projet existant, un `groupe` différent **déplace** le projet, ses souvenirs et ses fichiers (ceux du projet et ceux joints à ses souvenirs). |
| `remember` | Paramètre `groupe`. Si le projet existe, le souvenir prend son groupe (erreur si `groupe` contredit). Si le projet n'existe pas, `groupe` est obligatoire et le projet est créé dedans. Sans projet : `groupe`, sinon le groupe par défaut de la clé. |
| `update_memory` | Paramètre `groupe` pour un souvenir sans projet. Passer à un autre projet aligne le groupe. Même règle de création que `remember` si le projet n'existe pas. |
| `attach_file`, `prepare_upload` | Groupe = celui du souvenir, ou celui du projet lié, sinon `groupe`, sinon le groupe par défaut. |
| `recall`, `list_projects`, `list_files` | Filtre optionnel `groupe`, qui **inclut ses sous-groupes**. Toujours limité à ce que la clé peut lire. |
| `list_projects(noms_seulement)` | Sortie groupée par chemin : `Perso : …` / `Perso › Scoutisme : …` / `Pro : …` / `Tags : …`. |
| `read_memory`, `project_context`, `read_file` | Affichent le chemin du groupe et le droit de la clé. |

Les instructions serveur (`INSTRUCTIONS`) gagnent un point : « tout projet appartient à un groupe ; à la création, choisis-le avec `list_groups` et demande à l'utilisateur s'il n'est pas évident ».

## 8. Interface `/admin`

- **Groupes** : vue en arbre. On peut créer (à la racine ou sous un groupe), renommer, modifier la description et déplacer un groupe dans l'arbre (avec contrôle de profondeur et de cycle). La suppression n'est possible que pour un groupe vide.
- **Clés** : liste (nom, règles, groupe par défaut, dernière utilisation, statut). Création avec affichage unique de la clé et de l'URL complète du connecteur, et révocation. Les règles s'éditent sur l'arbre (`rw` / `ro` / `none` / hérité), avec un aperçu du droit effectif sur chaque groupe.
- **Projets** : colonne chemin du groupe, filtre par groupe (sous-groupes inclus), déplacement vers un autre groupe.
- `/admin` reste protégé par Cloudflare Access et voit tout.

## 9. Migration (automatique, idempotente)

Au premier appel après le déploiement, si `schema_meta.version < 3` :

1. Créer les nouvelles tables et ajouter les colonnes `group_id`.
2. Créer le groupe racine « Perso » s'il n'existe pas.
3. Rattacher à « Perso » tous les projets, souvenirs et fichiers dont le `group_id` est nul.
4. Passer `schema_meta.version` à `3`.

Après le déploiement, côté utilisateur :

1. Dans `/admin`, créer l'arbre (ex. `Perso › Sensible`, `Perso › Scoutisme`, `Pro`) et y déplacer les projets.
2. Créer une clé « Claude perso » (`Perso` rw, `Pro` rw ; défaut : `Perso`) et une clé « Claude pro » (`Pro` rw ; défaut : `Pro`).
3. Remplacer l'URL du connecteur dans chaque compte Claude. **Le compte pro ne doit plus utiliser `MEMORY_SECRET`**, sinon il garde accès à tout.
4. Désactiver la clé maîtresse (voir §11).

## 10. Critères d'acceptation

- [ ] Créer un projet sans groupe renvoie une erreur qui demande le groupe.
- [ ] La clé pro ne trouve **aucun** élément hors de `Pro`, ni par `recall`, ni par id, ni par nom de projet, ni par tag, ni par fichier.
- [ ] Avec `Perso` en rw et `Perso › Sensible` en none, la clé lit et écrit dans `Perso › Scoutisme` mais ne voit rien de `Perso › Sensible`.
- [ ] Avec un groupe en `ro`, la clé lit son contenu, mais `remember`, `update_memory`, `forget` et le déplacement y sont refusés.
- [ ] Déplacer un projet déplace ses souvenirs et ses fichiers. Un projet déplacé hors du périmètre d'une clé lui devient invisible.
- [ ] Impossible de créer un 4ᵉ niveau, de créer un cycle ou de supprimer un groupe non vide.
- [ ] Une clé révoquée renvoie `404`.
- [ ] La migration sur une base v2 existante ne perd aucune donnée et rattache tout à « Perso ». Un second passage ne change rien.
- [ ] La clé n'est jamais stockée en clair et n'est affichée qu'une fois.

## 11. Point ouvert

- Clé maîtresse après la transition : on la désactive par une variable (`MASTER_KEY_ENABLED = "false"`), ou on supprime son code ?

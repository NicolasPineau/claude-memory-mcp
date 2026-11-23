# Guide pour les agents

Serveur MCP « mémoire partagée » pour Claude : Cloudflare Worker (JavaScript, modules ES, sans dépendance d'exécution) + base D1.

## Structure

| Fichier | Rôle |
|---|---|
| `src/index.js` | Point d'entrée : routage `/admin`, `/dl/<jeton>`, `/upload/<jeton>`, `/<clé>/mcp` |
| `src/config.js` | Constantes (version, tailles, durées) et `INSTRUCTIONS` envoyées à Claude |
| `src/util.js` | Utilitaires purs : dates, tags, base64, réponses JSON, comparaison à temps constant |
| `src/db/schema.js` | Schéma SQL et migrations, appliqués à la première requête (`ensureSchema`) |
| `src/db/groups.js` | Arbre des groupes, droits effectifs (héritage), `Acl` (filtres SQL, résolution d'un groupe par chemin ou nom) |
| `src/db/memories.js` | Accès aux souvenirs, projets, tags et à l'index FTS5 |
| `src/files/storage.js` | Contenu des fichiers dans R2 (`FILES`, objets `f/<id>`) ; lecture des anciens fichiers restés dans D1 (`storage = 'd1'`) ; jetons de téléchargement et d'envoi |
| `src/mcp/protocol.js` | JSON-RPC MCP (Streamable HTTP sans état) : `initialize`, `tools/list`, `tools/call` |
| `src/mcp/tool-helpers.js` | Annotations (`RO`, `WR`, `DE`) et aides pour les schémas d'entrée |
| `src/mcp/placement.js` | Où ranger un souvenir ou un fichier (projet, groupe, création de projet) selon les droits |
| `src/mcp/tools/*.js` | Outils MCP par domaine : `memories`, `projects`, `groups`, `files` ; `index.js` fixe l'ordre d'exposition |
| `src/auth/access.js` | Vérification du JWT Cloudflare Access pour `/admin` |
| `src/auth/keys.js` | Clés d'accès (hash SHA-256), clé maîtresse, construction de l'`Acl` d'une requête |
| `src/quota/limits.js` | Limites gratuites Cloudflare, seuils par défaut (50 %) et variables `QUOTA_*` |
| `src/quota/analytics.js` | Lecture de la consommation du compte (API GraphQL Analytics), sans dépendance : partagé avec le script de sauvegarde |
| `src/quota/guard.js` | Cache de la consommation (`usage_cache`), évaluation des seuils, messages de refus et lignes « ⚠️ Quota » |
| `scripts/backup.mjs` | Sauvegarde : export D1 (schéma puis données, sans la table FTS), reconstruction des index, envoi dans R2 (`db/`), copie des nouveaux fichiers (`files/`) |
| `scripts/lib/prune.js` | Nettoyage des copies de fichiers supprimés dans le bucket de sauvegarde (fonction pure, table `backup_orphans`) |
| `scripts/migrate-files-to-r2.mjs` | Migration ponctuelle du contenu des fichiers de D1 vers R2 (lancée par `.github/workflows/migrate-files.yml`) |
| `.github/workflows/backup.yml` | Lance la sauvegarde chaque dimanche à 02:00 UTC |
| `src/admin/` | `/admin` : `index.js` (routage), `api.js` (API JSON), `page.js` (interface HTML) |
| `test/` | Tests Vitest exécutés dans le runtime Workers, avec une D1 locale |

## Conventions

- Noms d'outils MCP en anglais (`snake_case`). Paramètres, descriptions, messages et interface en français.
- Pas de dépendance d'exécution : seulement les API Web et Workers.
- Toute modification de comportement s'accompagne d'un test dans `test/`.
- Ne jamais écrire de secret ni d'identifiant réel dans le code ou les tests.
- Toute requête MCP sur `projects`, `memories` ou `files` filtre par groupe (`acl.sqlIn(...)`) ; toute écriture vérifie `acl.canWrite(...)`. Un élément hors périmètre répond comme s'il n'existait pas.
- Un changement de schéma passe par `migrate()` dans `src/db/schema.js` (idempotent) et par `SCHEMA_VERSION`. Une nouvelle table à sauvegarder s'ajoute à `EXPORT_TABLES` dans `scripts/backup.mjs`.
- Toute nouvelle route qui consomme D1 ou R2 passe par `checkQuota()` et refuse l'appel quand un seuil est atteint.
- Le Worker ne fait aucun traitement lourd (10 ms de CPU par requête en gratuit) : pas de décodage ni de compression de gros volumes. Le contenu des fichiers circule en flux (`ReadableStream`) ; les traitements lourds passent par un workflow GitHub.
- Les tests fixent la consommation avec `usage()` (`test/helpers.js`) : ils ne doivent jamais appeler l'API Analytics réelle.

## Commandes

- `npm test` : lance les tests.
- `npm run dev` : lance le Worker en local.
- Déploiement : un push sur `main` déclenche Workers Builds (`wrangler deploy`).

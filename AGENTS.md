# Guide pour les agents

Serveur MCP « mémoire partagée » pour Claude : Cloudflare Worker (JavaScript, modules ES, sans dépendance d'exécution) + base D1.

## Structure

| Fichier | Rôle |
|---|---|
| `src/index.js` | Point d'entrée : routage `/admin`, `/dl/<jeton>`, `/upload/<jeton>`, `/<MEMORY_SECRET>/mcp` |
| `src/config.js` | Constantes (version, tailles, durées) et `INSTRUCTIONS` envoyées à Claude |
| `src/util.js` | Utilitaires purs : dates, tags, base64, réponses JSON, comparaison à temps constant |
| `src/db/schema.js` | Schéma SQL, créé à la première requête (`ensureSchema`) |
| `src/db/memories.js` | Accès aux souvenirs, projets, tags et à l'index FTS5 |
| `src/files/storage.js` | Fichiers découpés en morceaux, jetons de téléchargement et d'envoi |
| `src/mcp/protocol.js` | JSON-RPC MCP (Streamable HTTP sans état) : `initialize`, `tools/list`, `tools/call` |
| `src/mcp/tool-helpers.js` | Annotations (`RO`, `WR`, `DE`) et aides pour les schémas d'entrée |
| `src/mcp/tools/*.js` | Outils MCP par domaine : `memories`, `projects`, `files` ; `index.js` fixe l'ordre d'exposition |
| `src/auth/access.js` | Vérification du JWT Cloudflare Access pour `/admin` |
| `src/admin/` | `/admin` : `index.js` (routage), `api.js` (API JSON), `page.js` (interface HTML) |
| `test/` | Tests Vitest exécutés dans le runtime Workers, avec une D1 locale |

## Conventions

- Noms d'outils MCP en anglais (`snake_case`). Paramètres, descriptions, messages et interface en français.
- Pas de dépendance d'exécution : seulement les API Web et Workers.
- Toute modification de comportement s'accompagne d'un test dans `test/`.
- Ne jamais écrire de secret ni d'identifiant réel dans le code ou les tests.

## Commandes

- `npm test` : lance les tests.
- `npm run dev` : lance le Worker en local.
- Déploiement : un push sur `main` déclenche Workers Builds (`wrangler deploy`).

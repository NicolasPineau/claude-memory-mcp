# claude-memory-mcp

A personal, long-term memory for Claude, shared across all your accounts, devices and conversations.

It is an [MCP](https://modelcontextprotocol.io) server running on **Cloudflare Workers**, with its data stored in **Cloudflare D1** (SQLite). Add it as a custom connector in Claude, and every conversation can recall and save notes, projects, tags and small files — whichever Claude account you use.

Tool names are in English; tool descriptions, parameters and server instructions are in French.

## Features

- **Memories**: notes with a title, content, optional project and tags, with full-text search (FTS5, accent-insensitive).
- **Projects**: group memories by project, with a status (`actif`, `en pause`, `termine`, `archive`).
- **Groups**: every project belongs to a group, in a tree up to 3 levels deep (e.g. `Perso › Scoutisme`, `Pro`). Projects can move between groups with their memories and files.
- **Access keys**: one connector URL per Claude account, each with read-write, read-only or no access per group, inherited by sub-groups (e.g. your work account only sees `Pro`).
- **Tags**: free-form thematic tags.
- **Files**: attach files up to 20 MB, stored in a private R2 bucket (the database only keeps their metadata). Small text files can go through the tools directly; larger ones use short-lived upload links (10 min) and download links (1 h). A cleanup page in `/admin` lists them by size, with search, filters, preview and bulk delete.
- **Built-in instructions** that tell Claude how to use the memory: list project names once at the start, load a project only when relevant, save nothing mid-conversation, offer a summary at the end, and never store secrets.
- **Admin web UI** at `/admin` to browse, edit and upload, protected by Cloudflare Access.
- **Free-tier guards**: the Worker reads the account's real usage (Workers requests, D1 rows and size, R2 storage and operations) and refuses calls before reaching the free limits. Every MCP response carries a `⚠️ Quota` warning from 80 % of a threshold.
- **Weekly backups** to a private R2 bucket, through GitHub Actions.

### MCP tools

| Tool | Purpose |
|---|---|
| `recall` | Search memories (text, project, tag) |
| `remember` | Save a new memory |
| `read_memory` | Read a memory in full |
| `update_memory` | Update a memory |
| `forget` | Delete a memory |
| `list_projects` | List projects (or only project and tag names) |
| `set_project` | Create or update a project |
| `project_context` | Load a project's context |
| `list_tags` | List tags |
| `list_groups` | List the groups this connector can see, with its rights |
| `attach_file` | Attach a small text file |
| `prepare_upload` | Get a one-time upload link for a larger or binary file |
| `read_file` | Read a file or get a download link |
| `delete_file` | Delete a file |
| `list_files` | List files |

## Endpoints

| Path | Description |
|---|---|
| `POST /<key>/mcp` | MCP endpoint (stateless Streamable HTTP, JSON-RPC), with an access key or the master key |
| `/admin` | Admin UI (Cloudflare Access + JWT verification + email allow-list) |
| `PUT /upload/<token>` | One-time upload link |
| `GET /dl/<token>` | Temporary download link |

Any other path returns `404`.

## Deployment

### Requirements

- A Cloudflare account (the free plan is enough for personal use)
- Node.js and [Wrangler](https://developers.cloudflare.com/workers/wrangler/): `npm install -g wrangler`, then `wrangler login`

### 1. Create the D1 database

```sh
wrangler d1 create claude-memory
```

Copy the `database_id` it prints. You don't need to create the tables: the Worker creates them on first use.

### 2. Configure the Worker

Edit `wrangler.toml`: set the Worker `name`, and the D1 `database_name` and `database_id`.

Then set these variables in the Cloudflare dashboard (**Worker → Settings → Variables and Secrets**). Because `wrangler.toml` has `keep_vars = true`, deployments leave them untouched:

| Variable | Example |
|---|---|
| `ACCESS_TEAM_DOMAIN` | `https://<your-team>.cloudflareaccess.com` |
| `ACCESS_AUD` | the Access application's Audience (AUD) Tag |
| `ADMIN_EMAILS` | `you@example.com` (comma-separated) |

### 3. Set the connector secret

Generate a long random string (24 characters minimum) and store it as a secret:

```sh
openssl rand -hex 24 | wrangler secret put MEMORY_SECRET
```

Keep it somewhere safe: it is part of your connector URL, and anyone who has it can read and write your memory.

### 4. Deploy

Either deploy from your machine:

```sh
npm install
npm run deploy
```

Or let Cloudflare deploy on every push (recommended). In the dashboard, open the Worker, go to **Settings → Build**, connect this GitHub repository, and keep `main` as the production branch. Every push to `main` then runs `npx wrangler deploy`. You can also enable builds for other branches to get preview versions without touching production.

### 5. Protect `/admin` with Cloudflare Access

1. In the Cloudflare dashboard, open **Zero Trust → Access → Applications** and add a **Self-hosted** application.
2. Set its domain to your Worker's host, with the path `admin` (for example `claude-memory.<subdomain>.workers.dev/admin`).
3. Add a policy that allows only your email address.
4. Copy the application's **Application Audience (AUD) Tag** into `ACCESS_AUD`, and your team domain into `ACCESS_TEAM_DOMAIN`. Then deploy again.

The Worker also checks the Access JWT itself (signature, issuer, audience, expiry and email allow-list). Until `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` and `ADMIN_EMAILS` are all set, `/admin` stays closed and returns `503`.

### 6. Add the connector in Claude

In `/admin`, open **Groups** to build your tree (existing data starts in `Perso`), then **Keys** to create one key per Claude account and choose what it can see. The connector URL is shown once, when the key is created:

```
https://<your-worker>.<subdomain>.workers.dev/<key>/mcp
```

In Claude, go to **Settings → Connectors → Add custom connector** and paste it. Do this on every Claude account, each with its own key.

`MEMORY_SECRET` is the **master key**: `/<MEMORY_SECRET>/mcp` sees and edits everything. Once every account uses its own key, set the variable `MASTER_KEY_ENABLED` to `false` to turn it off.

## Security notes

- The MCP endpoint is protected by the key in its URL. Access keys are stored only as SHA-256 hashes; the master key is compared in constant time. Treat every connector URL like a password, and revoke a key in `/admin` if it leaks.
- A key never sees anything outside its groups: out-of-scope items answer exactly like missing ones.
- Upload and download links are random, single-purpose tokens that expire.
- Don't store passwords or other secrets in the memory. The built-in instructions also tell Claude not to.

## Free-tier guards

Thresholds default to **50 % of the Cloudflare free limits**, to keep a margin if those limits shrink. Each can be changed with a Worker variable, without redeploying:

| Variable | Default | Free limit |
|---|---|---|
| `QUOTA_REQUESTS_DAY` | 50,000 | 100,000 Workers requests / day |
| `QUOTA_D1_READS_DAY` | 2,500,000 | 5,000,000 D1 rows read / day |
| `QUOTA_D1_WRITES_DAY` | 50,000 | 100,000 D1 rows written / day |
| `QUOTA_D1_SIZE_MB` | 250 | 500 MB per database |
| `QUOTA_R2_STORAGE_GB` | 5 | 10 GB-month |
| `QUOTA_R2_CLASS_A_MONTH` | 500,000 | 1,000,000 / month |
| `QUOTA_R2_CLASS_B_MONTH` | 5,000,000 | 10,000,000 / month |

- Usage comes from the Cloudflare GraphQL Analytics API, for the **whole account**, cached 5 minutes. Set the variable `CF_ACCOUNT_ID` and the secret `CF_API_TOKEN` (a token with *Account Analytics: Read*) on the Worker. Without them, only the database size is tracked and every response says the guards are inactive.
- From 80 % of a threshold, every MCP response ends with a `⚠️ Quota` line, which Claude is told to relay, and `/admin` shows a banner.
- At 100 %, every MCP tool call, download and upload link is refused until the period resets (midnight UTC, or the 1st of the month for R2 operations). `/admin` stays readable but refuses writes.
- If the Analytics API is down, the last known figures are used and responses say the usage is unverified.

## Backups

Time Travel restores D1 to any minute of the last 7 days on the free plan. For longer, a GitHub Actions workflow (`.github/workflows/backup.yml`) exports the database every Sunday at 02:00 UTC, compresses it and stores it in a private R2 bucket. The data never goes through GitHub: the job log only shows sizes and file names. The backup is skipped (and the job fails) if the usage can't be checked or if it would cross an R2 threshold.

Each run stores `db/YYYY-MM-DD.sql.gz` (the whole database) and copies the attached files that are not backed up yet to `files/<id>` (once per file: files never change).

Setup, once:

1. In Cloudflare, enable R2 and create two private buckets:
   - `memoire-fichiers`, for attached files, **without** any lifecycle rule;
   - `memoire-sauvegardes`, with a lifecycle rule that deletes objects **with the prefix `db/`** after 60 days.

   Both must exist before deploying: they are bound in `wrangler.toml` (`FILES` and `BACKUPS`).
2. Create an API token with *Account Analytics: Read*, *D1: Edit* and *Workers R2 Storage: Edit*.
3. In the GitHub repository, add the secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Optional repository variables: `BACKUP_DATABASE` (default `memoire`), `BACKUP_BUCKET` (default `memoire-sauvegardes`).
4. Run the workflow once by hand (**Actions → Sauvegarde hebdomadaire → Run workflow**), first as a dry run.

### Moving files from D1 to R2 (upgrade from v2/v3)

Before v4, file contents were stored in D1 as base64 chunks. New files now go to R2, and old ones stay readable. To move the old ones, run **Actions → Migrer les fichiers vers R2** by hand: first as a dry run (the default), then for real. It checks each file's size, writes it to R2, and only then removes it from D1. It can be run again safely. The Worker can't do it itself: decoding megabytes of base64 exceeds its 10 ms CPU limit on the free plan.

GitHub disables scheduled workflows after 60 days without activity in the repository: re-enable it in the Actions tab if needed.

### Restoring

A backup is a complete SQL file, including attached files and the full-text index rebuild:

```sh
npx wrangler r2 object get memoire-sauvegardes/2026-11-29.sql.gz --file backup.sql.gz --remote
gunzip backup.sql.gz
npx wrangler d1 create memoire-restauree
npx wrangler d1 execute memoire-restauree --remote --file backup.sql
```

Then point `database_name` and `database_id` in `wrangler.toml` to the new database and deploy. Attached files are in `memoire-sauvegardes/files/<id>`: copy them back to `memoire-fichiers/f/<id>` if the files bucket was lost. For a mistake made less than 7 days ago, D1 Time Travel is simpler: `npx wrangler d1 time-travel restore memoire --timestamp=<unix time>`.

## Development

```sh
npm install
npm test        # Vitest, inside the Workers runtime, with a local D1
npm run dev     # run the Worker locally
```

The code lives in `src/`, split by concern (MCP protocol, tools per domain, storage, admin). See [AGENTS.md](AGENTS.md) for the layout and conventions.

## Credits

Written by Nicolas Pineau with Claude. Version 2.0.0.

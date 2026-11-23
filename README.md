# claude-memory-mcp

A personal, long-term memory for Claude, shared across all your accounts, devices and conversations.

It is a single-file [MCP](https://modelcontextprotocol.io) server running on **Cloudflare Workers**, with its data stored in **Cloudflare D1** (SQLite). Add it as a custom connector in Claude, and every conversation can recall and save notes, projects, tags and small files — whichever Claude account you use.

Tool names are in English; tool descriptions, parameters and server instructions are in French.

## Features

- **Memories**: notes with a title, content, optional project and tags, with full-text search (FTS5, accent-insensitive).
- **Projects**: group memories by project, with a status (`actif`, `en pause`, `termine`, `archive`).
- **Tags**: free-form thematic tags.
- **Files**: attach files up to 20 MB, stored in D1 in chunks. Small text files can go through the tools directly; larger ones use short-lived upload links (10 min) and download links (1 h).
- **Built-in instructions** that tell Claude how to use the memory: list project names once at the start, load a project only when relevant, save nothing mid-conversation, offer a summary at the end, and never store secrets.
- **Admin web UI** at `/admin` to browse, edit and upload, protected by Cloudflare Access.

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
| `attach_file` | Attach a small text file |
| `prepare_upload` | Get a one-time upload link for a larger or binary file |
| `read_file` | Read a file or get a download link |
| `delete_file` | Delete a file |
| `list_files` | List files |

## Endpoints

| Path | Description |
|---|---|
| `POST /<MEMORY_SECRET>/mcp` | MCP endpoint (stateless Streamable HTTP, JSON-RPC) |
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

Create a `wrangler.toml` next to `worker.js`:

```toml
name = "claude-memory"
main = "worker.js"
compatibility_date = "2025-11-01"

[[d1_databases]]
binding = "DB"                     # must be exactly "DB"
database_name = "claude-memory"
database_id = "<your-database-id>"

[vars]
ACCESS_TEAM_DOMAIN = "https://<your-team>.cloudflareaccess.com"
ACCESS_AUD = "<application-audience-tag>"
ADMIN_EMAILS = "you@example.com"   # comma-separated
```

### 3. Set the connector secret

Generate a long random string (24 characters minimum) and store it as a secret:

```sh
openssl rand -hex 24 | wrangler secret put MEMORY_SECRET
```

Keep it somewhere safe: it is part of your connector URL, and anyone who has it can read and write your memory.

### 4. Deploy

```sh
wrangler deploy
```

### 5. Protect `/admin` with Cloudflare Access

1. In the Cloudflare dashboard, open **Zero Trust → Access → Applications** and add a **Self-hosted** application.
2. Set its domain to your Worker's host, with the path `admin` (for example `claude-memory.<subdomain>.workers.dev/admin`).
3. Add a policy that allows only your email address.
4. Copy the application's **Application Audience (AUD) Tag** into `ACCESS_AUD`, and your team domain into `ACCESS_TEAM_DOMAIN`. Then deploy again.

The Worker also checks the Access JWT itself (signature, issuer, audience, expiry and email allow-list). Until `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` and `ADMIN_EMAILS` are all set, `/admin` stays closed and returns `503`.

### 6. Add the connector in Claude

In Claude, go to **Settings → Connectors → Add custom connector** and enter:

```
https://<your-worker>.<subdomain>.workers.dev/<MEMORY_SECRET>/mcp
```

Do the same on every Claude account that should share this memory.

## Security notes

- The MCP endpoint is protected by the secret in its URL, compared in constant time. Treat the full URL like a password.
- Upload and download links are random, single-purpose tokens that expire.
- Don't store passwords or other secrets in the memory. The built-in instructions also tell Claude not to.

## Credits

Written by Nicolas Pineau with Claude. Version 2.0.0.

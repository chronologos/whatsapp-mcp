# CLAUDE.md — WhatsApp MCP (scoped personal bot)

Project context for Claude instances working in this repo. Read this before
changing anything in `mcp/`, `webhook/`, `main.go`, or the container setup.

## What this is

A fork of `felipeadeildo/whatsapp-mcp` (Go; `whatsmeow` + `mark3labs/mcp-go`)
that exposes WhatsApp over MCP. It has been adapted for a **safe, narrowly
scoped personal/family bot**: an AI client may only read and act in an
explicitly allowlisted set of chats. The server links to a **real WhatsApp
account** via QR (linked-device), stores all data locally in SQLite, and serves
an MCP endpoint over Streamable HTTP.

Upstream assumes a trusted-localhost, full-account deployment. **This fork's
deployment decisions (made with the owner):**
- Trusted localhost environment is accepted.
- Family/allowlisted chat input is treated as trusted.
- The single hard requirement is **chat scoping** — see invariants below.

## Security invariants (do not regress these)

1. **Chat scope is the core control.** `ALLOWED_CHAT_JIDS` (comma-separated
   JIDs) restricts *every* exposure surface. When non-empty:
   - Tools `send_message`, `get_chat_messages`, `load_more_messages` reject
     out-of-scope JIDs (`mcp/handlers.go`, via `isChatAllowed` /
     `chatScopeError` in `mcp/server.go`).
   - `search_messages` filters at the SQL layer — out-of-scope rows never leave
     the DB (`storage/messages.go: SearchMessagesWithNamesFiltered`, the
     `chat_jid IN (...)` clause).
   - `list_chats` / `find_chat` results are filtered (`mcp/handlers.go`).
   - Media resource `whatsapp://media/{id}` looks up the message's chat and
     enforces scope before serving the file (`mcp/resources.go`).
   - Webhook emission drops out-of-scope events (`webhook/webhook.go:
     EmitMessageEvent`, gated by `Config.AllowedChatJIDs`).
   Empty allowlist = all chats accessible (a startup warning is logged). There
   is a storage test for the SQL filter: `storage/messages_test.go`.

2. **Scoping limits *exposure*, not *storage*.** whatsmeow still syncs and
   stores ALL chats into `data/db/messages.db`, and `data/db/whatsapp_auth.db`
   holds the full account session keys. These files are the crown jewels —
   anything that can read them owns the WhatsApp account. Never widen what's
   stored or weaken file handling without flagging it.

3. **Limits are clamped.** SQLite treats negative `LIMIT`/`OFFSET` as
   "unbounded", which would bypass scoping/paging. All tool limits go through
   `clampInt` (`mcp/handlers.go`). Keep it that way for any new tool.

4. **`send_message` is live and irreversible.** It posts to the real account
   immediately with no preview/confirmation step. Any autonomous loop built on
   top MUST add a confirmation gate or command-prefix trigger.

## Configuration (`.env`, gitignored — never commit it)

| Var | Purpose |
|-----|---------|
| `MCP_API_KEY` | Auth for the MCP + webhook HTTP endpoints. Empty → insecure default + warning. |
| `ALLOWED_CHAT_JIDS` | Comma-separated chat JIDs the bot may touch. **The scope control.** |
| `MCP_PORT` | HTTP port (default 8080). |
| `TIMEZONE`, `LOG_LEVEL` | Display tz / log verbosity. |
| `MEDIA_AUTO_DOWNLOAD_*` | Media auto-download filters. |
| `WEBHOOK_URL`, `WEBHOOK_*` | Optional outbound webhook for message events. |

Changing `ALLOWED_CHAT_JIDS` needs only `docker compose up -d` (read at
startup; no recompile). DMs end in `@s.whatsapp.net`, groups in `@g.us`.

## Running (OrbStack / Docker)

The container is hardened by default (`docker-compose.yml`): non-root user,
`read_only` rootfs + `tmpfs /tmp`, `cap_drop: ALL`, `no-new-privileges`,
`pids_limit`/`mem_limit`, port bound to `127.0.0.1` only. Only `./data` and
`/tmp` are writable.

```bash
cp .env.example .env            # set MCP_API_KEY; leave ALLOWED_CHAT_JIDS empty at first
docker compose up -d --build
docker compose logs -f          # scan the QR (also written to ./data/qr.png)
```

**First-run flow / gotchas:**
- The HTTP/MCP endpoint only starts **after** a successful QR link. Until then
  `/health` is unreachable — expected (see the QR loop in `main.go`).
- **Bootstrap ordering:** you can't discover a chat's JID while scoped
  (`list_chats` hides everything else). Run unscoped first, find the JID, then
  set `ALLOWED_CHAT_JIDS` and recreate.
- **whatsmeow version drift:** WhatsApp rejects stale clients with
  `Client outdated (405)` and pairing fails. Fix:
  `go get -u go.mau.fi/whatsmeow@latest && go mod tidy`, rebuild.
- Migrations are embedded (`//go:embed` in `storage/migrator.go`) — the runtime
  image only needs the binary.

## Acting as the MCP client (Streamable HTTP, JSON-RPC)

The endpoint is `http://localhost:<MCP_PORT>/mcp/<MCP_API_KEY>`. Responses are
plain `application/json` (not SSE) for these calls. Handshake then call:

1. `POST initialize` → capture the `Mcp-Session-Id` response header.
2. `POST notifications/initialized` (with the session id header).
3. `POST tools/call` with `{"name": "...", "arguments": {...}}`.

All subsequent requests must carry `Mcp-Session-Id` and
`Accept: application/json, text/event-stream`. Result text is at
`result.content[0].text`. (A Python helper using `urllib` works well for
multi-line message bodies — avoids shell escaping.)

## Threat model (current single-container deployment)

- **Closed by scoping:** AI reading/searching/messaging any non-allowlisted
  chat; exfiltration of other chats; sending to attacker-supplied numbers.
- **Residual, ranked:**
  1. Local session/message DBs (`data/db/*.db`) — full-account secret;
     scoping doesn't protect them. Watch backup/cloud-sync of `~/repos`,
     consider `chmod 600`.
  2. Container egress is unrestricted — a compromised dependency could exfil
     the DB. (Egress allowlist not yet implemented.)
  3. Primary-number ban risk (whatsmeow is unofficial; against WhatsApp ToS).
  4. Endpoint auth is key-in-URL with a non-constant-time compare (the webhook
     handler uses the better Bearer + `subtle.ConstantTimeCompare` path —
     `webhook/handler.go`). Low risk on localhost.
- **Key nuance:** if the agent driving this MCP server *also* has host tools
  (Bash, filesystem, other MCP servers), prompt injection from a chat can pivot
  to the host — scoping won't stop that. For an autonomous bot, give the driving
  agent ONLY this WhatsApp MCP server (and a system prompt; see README §"Running
  a Safe Family-Group Bot"). The stronger design isolates the agent from the
  data volume in a second container.

## Bot agent (`agent/`)

Optional autonomous bot: **Pi** (coding-agent harness) running **Gemini**, in a
second container, restricted to the WhatsApp MCP tools. See `agent/README.md`.
- `agent/extensions/whatsapp-mcp.ts` — Pi extension: MCP handshake →
  `tools/list` → `registerTool` per tool (proxies `tools/call`) → disables
  built-in tools via `setActiveTools` (deferred to `session_start` /
  `before_agent_start` — it cannot run during extension loading).
- `agent/bot.mjs` — webhook listener → drives a Pi RPC turn per triggering
  message (gated by `TRIGGER_PREFIX`, default `@bot`). Pi replies via the
  `send_message` tool; the supervisor never sends directly.
- **Key isolation:** the `agent` service mounts **no data volume**, so it can't
  read the session DB; its only WhatsApp capability is the scoped MCP tools.
- Config: `GEMINI_API_KEY`, `AGENT_MODEL`, `TRIGGER_PREFIX`, `WHATSAPP_MCP_URL`
  (all in `.env` / compose). The MCP server pushes events via `WEBHOOK_URL`
  pointed at `http://agent:9000/webhook`.

## Conventions

- Match surrounding Go style; lower-case comment style as in existing files.
- New tools: add scope checks + `clampInt` from day one.
- Keep secrets and personal JIDs out of committed files (they live in `.env`).
- `go build ./... && go vet ./... && go test ./...` before considering done.

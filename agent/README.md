# WhatsApp Bot Agent (Pi + Gemini)

An autonomous bot that replies in your scoped WhatsApp chats, powered by
[Pi](https://pi.dev) running Google Gemini, restricted to the WhatsApp MCP tools.

## How it works

```
 incoming msg ─► whatsapp-mcp ──webhook──► agent (bot.mjs)
                  (scoped)                    │ spawns Pi RPC turn
                                              ▼
                                   Pi (Gemini) ──registerTool──► whatsapp-mcp.ts extension
                                              │                     │ MCP tools/call
                                              └─ send_message ──────┘ ─► reply in chat
```

- **`extensions/whatsapp-mcp.ts`** — a Pi extension that does the MCP
  handshake against the WhatsApp MCP server, discovers its tools, registers
  each as a Pi tool (proxying `tools/call`), and **disables Pi's built-in
  bash/file tools** so the agent can only do scoped WhatsApp operations.
- **`bot.mjs`** — receives message events from the MCP server's webhook and,
  for messages matching the trigger prefix, drives one Pi turn over RPC. Pi
  replies by calling `send_message`; the supervisor never sends messages itself.
- **`system-prompt.md`** — the bot's persona + safety rules, framed into each turn.

## Security properties

- **No data volume.** The agent container cannot read `whatsapp_auth.db` /
  `messages.db` — its only WhatsApp capability is the scoped MCP tools over the
  network. Even a fully jailbroken agent can't touch the session secret.
- **Built-ins disabled.** Only `mcp__whatsapp` tools are active (enforced in the
  extension via `setActiveTools` on each turn).
- **Chat scope** is still enforced server-side by `ALLOWED_CHAT_JIDS` — the
  webhook only fires for, and `send_message` only accepts, allowlisted chats.
- **Trigger gate.** `TRIGGER_PREFIX` (default `@bot`) means the bot only replies
  to messages starting with it — controls cost and prevents surprise sends.
- Non-root, `cap_drop: ALL`, `no-new-privileges`, resource-limited.

## Run it

1. Get a Gemini API key: https://aistudio.google.com/apikey
2. In `.env` (repo root): set `GEMINI_API_KEY`, optionally `AGENT_MODEL`
   (default `gemini-2.0-flash`) and `TRIGGER_PREFIX` (default `@bot`).
3. `docker compose up -d` (brings up both `whatsapp-mcp` and `agent`).
4. In a scoped chat, send e.g. `@bot say hi` — the bot replies.

Logs: `docker compose logs -f agent`

### Triggering

- **Command:** any message starting with `@bot` (the prefix) gets a reply —
  works for the owner too (the bot never prefixes its own replies, so it can't
  trigger itself).
- **Persist mode:** the owner sends `@bot-persist-<duration>` (e.g.
  `@bot-persist-30m`, `@bot-persist-2h`, `@bot-persist-1h30m`). For that window
  the bot sees every new message *from others* in that chat and decides on its
  own whether to chime in — no prefix needed. `@bot-stop` ends it early.
  Capped by `PERSIST_MAX` (default 6h). **Cost note:** in persist mode every
  message from others spawns a Gemini turn (even when it stays silent).

### Memory

The bot is **stateless per message** (`pi --no-session`, fresh process each
turn) — no long-term memory. It can pull recent context on demand via the
`get_chat_messages` tool, and the persist/command prompts nudge it to do so,
but it does not remember anything across turns. Persistent memory would require
adding a store (not implemented).

## Custom models (`models.json`)

Pi ships a bundled model registry; newer models (e.g. `gemini-3.5-flash`) are
added via `agent/models.json`, baked into the image at
`~/.pi/agent/models.json`. To add another model, append an entry under
`providers.google.models` (id, name, input, contextWindow, maxTokens,
reasoning) and rebuild. Then set `AGENT_MODEL` to its id.

Note: an unknown `AGENT_MODEL` makes Pi start a turn but silently produce no
output (no error) — if the bot goes quiet, check the model id is valid/registered.

## Notes & limitations

- **Provider trust:** message text for triggered messages is sent to the Gemini
  API. Be aware of that data flow.
- **Cost:** each triggered message is one Gemini turn (often several calls).
  Gemini Flash is cheap, but keep the trigger prefix on for a chatty group.
- The MCP server uses key-in-URL auth (`/mcp/{key}`); the extension follows that.
- One turn at a time (the supervisor serializes) to keep cost/sends predictable.

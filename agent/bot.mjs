// Supervisor for the Pi-powered WhatsApp bot.
//
// Receives message events from the WhatsApp MCP server's webhook and drives a
// Pi (Gemini) turn over its RPC protocol. Pi replies by calling the WhatsApp
// `send_message` tool (via the whatsapp-mcp extension) — this supervisor only
// starts the turn, it never composes replies itself (except short control-ack
// confirmations).
//
// Triggering:
//   - Command mode: any message starting with TRIGGER_PREFIX (default "@bot")
//     triggers a reply. Works for the owner too (the bot never prefixes its own
//     replies, so it can't trigger itself).
//   - Persist mode: the owner sends "<prefix>-persist-<duration>" (e.g.
//     "@bot-persist-30m"). For that duration, the bot sees every NEW message
//     from OTHERS in that chat and decides on its own whether to chime in (no
//     prefix needed). "<prefix>-stop" ends it early.
//
// Durations: combos of s/m/h, e.g. "90s", "30m", "2h", "1h30m". Capped by
// PERSIST_MAX (default 6h).

import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PORT = Number(process.env.AGENT_PORT || 9000);
const PROVIDER = process.env.AGENT_PROVIDER || "google";
const MODEL = process.env.AGENT_MODEL || "gemini-2.0-flash";
const PREFIX = process.env.TRIGGER_PREFIX ?? "@bot";
const TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS || 120000);
const PERSIST_MAX_MS = parseDuration(process.env.PERSIST_MAX || "6h") || 6 * 3600e3;
const PERSIST_CONFIRM = (process.env.PERSIST_CONFIRM ?? "true") !== "false";

const MCP_BASE = (process.env.WHATSAPP_MCP_URL || "http://whatsapp-mcp:8080").replace(/\/$/, "");
const MCP_KEY = process.env.MCP_API_KEY || "";
const MCP_ENDPOINT = `${MCP_BASE}/mcp/${MCP_KEY}`;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RULES = readFileSync(path.join(__dirname, "system-prompt.md"), "utf8");

const PERSIST_CMD = `${PREFIX}-persist-`;
const STOP_CMD = `${PREFIX}-stop`;

// chat_jid -> epoch ms until which persist mode is active.
const persistUntil = new Map();

// Parse a duration like "90s", "30m", "2h", "1h30m" into milliseconds.
function parseDuration(s) {
  if (!s) return 0;
  let ms = 0;
  let any = false;
  for (const m of String(s).matchAll(/(\d+)\s*([smh])/gi)) {
    any = true;
    const n = Number(m[1]);
    ms += m[2].toLowerCase() === "h" ? n * 3600e3 : m[2].toLowerCase() === "m" ? n * 60e3 : n * 1e3;
  }
  return any ? ms : 0;
}

function human(ms) {
  const s = Math.round(ms / 1000);
  if (s >= 3600) return `${Math.floor(s / 3600)}h${Math.round((s % 3600) / 60) || ""}`.replace(/h$/, "h");
  if (s >= 60) return `${Math.floor(s / 60)}m`;
  return `${s}s`;
}

// --- Minimal MCP client (for short control confirmations only) ---
let mcpSession;
async function mcpCall(method, params, isNotification = false) {
  const payload = { jsonrpc: "2.0", method };
  if (!isNotification) payload.id = Math.floor(Math.random() * 1e9);
  if (params !== undefined) payload.params = params;
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  if (mcpSession) headers["Mcp-Session-Id"] = mcpSession;
  const resp = await fetch(MCP_ENDPOINT, { method: "POST", headers, body: JSON.stringify(payload) });
  const sid = resp.headers.get("mcp-session-id");
  if (sid) mcpSession = sid;
  if (isNotification) return;
  const json = JSON.parse(await resp.text());
  if (json.error) throw new Error(JSON.stringify(json.error));
  return json.result;
}
async function mcpSend(chatJid, text) {
  if (!mcpSession) {
    await mcpCall("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bot-supervisor", version: "1" } });
    await mcpCall("notifications/initialized", undefined, true);
  }
  await mcpCall("tools/call", { name: "send_message", arguments: { chat_jid: chatJid, text } });
}

// Drive one Pi RPC turn: send a prompt, wait until the agent finishes.
// Resolves with { sent, tools }: whether send_message ran, and all tools used.
function runPi(promptText) {
  return new Promise((resolve) => {
    const child = spawn("pi", ["--mode", "rpc", "--provider", PROVIDER, "--model", MODEL, "--no-session"], {
      stdio: ["pipe", "pipe", "inherit"],
      env: process.env,
    });
    let buf = "";
    let done = false;
    const tools = [];
    const finish = () => {
      if (done) return;
      done = true;
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve({ sent: tools.includes("send_message"), tools });
    };
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let evt;
        try {
          evt = JSON.parse(line);
        } catch {
          continue;
        }
        if (evt.type === "tool_execution_end" && evt.toolName) tools.push(evt.toolName);
        if (evt.type === "agent_end") finish();
      }
    });
    child.on("exit", finish);
    child.on("error", (e) => {
      console.error("[bot] pi spawn error:", e);
      finish();
    });
    child.stdin.write(JSON.stringify({ type: "prompt", message: promptText }) + "\n");
    setTimeout(finish, TIMEOUT_MS);
  });
}

// One turn at a time keeps cost predictable and avoids interleaved sends.
let busy = false;

async function handle(data) {
  const chat = data.chat_jid || "";
  const text = (data.text || "").trim();
  if (!chat || !text) return;

  // --- Owner control commands (from our own account) ---
  if (data.is_from_me && PREFIX) {
    if (text.toLowerCase().startsWith(PERSIST_CMD.toLowerCase())) {
      let ms = parseDuration(text.slice(PERSIST_CMD.length));
      if (ms <= 0) return;
      ms = Math.min(ms, PERSIST_MAX_MS);
      persistUntil.set(chat, Date.now() + ms);
      console.error(`[bot] persist ON for ${chat} (${human(ms)})`);
      if (PERSIST_CONFIRM) await mcpSend(chat, `🤖 listening for ${human(ms)} — say ${STOP_CMD} to end`).catch((e) => console.error("[bot] confirm failed:", e.message));
      return;
    }
    if (text.toLowerCase() === STOP_CMD.toLowerCase()) {
      persistUntil.delete(chat);
      console.error(`[bot] persist OFF for ${chat}`);
      if (PERSIST_CONFIRM) await mcpSend(chat, "🤖 off").catch(() => {});
      return;
    }
  }

  const hasPrefix = !!PREFIX && text.startsWith(PREFIX);
  const persistActive = (persistUntil.get(chat) || 0) > Date.now();

  // Decide trigger + mode.
  let mode;
  if (hasPrefix) mode = "command"; // explicit, anyone (incl owner)
  else if (persistActive && !data.is_from_me) mode = "persist"; // others only, no prefix
  else return; // not triggered

  // Loop-safety: never act on our own non-prefixed messages.
  if (data.is_from_me && mode !== "command") return;

  const userText = (hasPrefix ? text.slice(PREFIX.length) : text).trim();
  if (!userText) return;

  if (busy) {
    console.error("[bot] busy; dropping message");
    return;
  }
  busy = true;
  try {
    const from = data.sender_push_name || data.sender_contact_name || data.sender_jid || "someone";
    const guidance =
      mode === "persist"
        ? "You are in PASSIVE mode (no one addressed you directly). Only reply if you genuinely have something useful or fun to add; otherwise do nothing and do NOT call send_message. For context you may call get_chat_messages on this chat_jid first."
        : "If a reply is warranted, send it to chat_jid above with the send_message tool. You may call get_chat_messages first for context.";
    const framed =
      `${RULES}\n\n` +
      `--- INCOMING WHATSAPP MESSAGE ---\n` +
      `chat_jid: ${chat}\n` +
      `chat_name: ${data.chat_name || ""}\n` +
      `from: ${from}\n` +
      `text: ${userText}\n` +
      `--- END ---\n\n` +
      guidance;
    console.error(`[bot] handling (${mode}) in ${chat} from ${data.sender_jid}`);
    const { sent, tools } = await runPi(framed);
    console.error(
      `[bot] turn done (${mode}) in ${chat}: ${sent ? "replied" : "stayed silent"}` +
        (tools.length ? ` [tools: ${tools.join(", ")}]` : " [no tools]")
    );
  } finally {
    busy = false;
  }
}

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || !req.url.startsWith("/webhook")) {
    res.writeHead(404);
    return res.end();
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.writeHead(200);
    res.end("ok"); // ack immediately
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      return;
    }
    handle(payload?.data || {}).catch((e) => console.error("[bot] handle error:", e));
  });
});

server.listen(PORT, () =>
  console.error(`[bot] listening on :${PORT} model=${PROVIDER}/${MODEL} prefix='${PREFIX}' persist<=${human(PERSIST_MAX_MS)}`)
);

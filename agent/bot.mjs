// Supervisor for the Pi-powered WhatsApp bot.
//
// Receives message events from the WhatsApp MCP server's webhook, and for
// messages that match the trigger prefix, drives a Pi (Gemini) turn over its
// RPC protocol. Pi replies by calling the WhatsApp `send_message` tool (via the
// whatsapp-mcp extension) — this supervisor only starts the turn, it never
// sends messages itself.
//
// The trigger prefix is a cost + safety gate: the bot only responds to messages
// that start with it (default "@bot"). Set TRIGGER_PREFIX="" to respond to all
// messages (not recommended).

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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RULES = readFileSync(path.join(__dirname, "system-prompt.md"), "utf8");

// Drive one Pi RPC turn: send a prompt, wait until the agent finishes.
function runPi(promptText) {
  return new Promise((resolve) => {
    const child = spawn("pi", ["--mode", "rpc", "--provider", PROVIDER, "--model", MODEL, "--no-session"], {
      stdio: ["pipe", "pipe", "inherit"],
      env: process.env,
    });

    let buf = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve();
    };

    child.stdout.on("data", (d) => {
      buf += d.toString();
      let idx;
      // Pi RPC is line-delimited JSON; split on \n only.
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

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || !req.url.startsWith("/webhook")) {
    res.writeHead(404);
    return res.end();
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    res.writeHead(200);
    res.end("ok"); // ack the webhook immediately

    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      return;
    }
    const data = payload?.data || {};
    if (data.is_from_me) return; // never react to our own messages
    const text = (data.text || "").trim();
    if (PREFIX && !text.startsWith(PREFIX)) return; // gate
    const userText = (PREFIX ? text.slice(PREFIX.length) : text).trim();
    if (!userText) return;

    if (busy) {
      console.error("[bot] busy; dropping message");
      return;
    }
    busy = true;
    try {
      const from = data.sender_push_name || data.sender_contact_name || data.sender_jid || "someone";
      const framed =
        `${RULES}\n\n` +
        `--- INCOMING WHATSAPP MESSAGE ---\n` +
        `chat_jid: ${data.chat_jid}\n` +
        `chat_name: ${data.chat_name || ""}\n` +
        `from: ${from}\n` +
        `text: ${userText}\n` +
        `--- END ---\n\n` +
        `If a reply is warranted, send it to chat_jid above with the send_message tool.`;
      console.error(`[bot] handling message in ${data.chat_jid} from ${data.sender_jid}`);
      await runPi(framed);
    } finally {
      busy = false;
    }
  });
});

server.listen(PORT, () => console.error(`[bot] listening on :${PORT} model=${PROVIDER}/${MODEL} prefix='${PREFIX}'`));

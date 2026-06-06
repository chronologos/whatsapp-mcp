// Pi extension: MCP client for the WhatsApp MCP server.
//
// On startup it performs the MCP Streamable-HTTP handshake against the
// WhatsApp MCP server, discovers its tools, and registers each as a Pi tool
// that proxies to `tools/call`. It then restricts the agent to ONLY these
// tools (built-in bash/file/etc. are disabled) so a prompt-injected model can
// do nothing but scoped WhatsApp operations.
//
// Config (env):
//   WHATSAPP_MCP_URL  base URL of the MCP server (default http://whatsapp-mcp:8080)
//   MCP_API_KEY       API key (placed in the /mcp/{key} path, as the server expects)

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BASE = (process.env.WHATSAPP_MCP_URL || "http://whatsapp-mcp:8080").replace(/\/$/, "");
const KEY = process.env.MCP_API_KEY || "";
const ENDPOINT = `${BASE}/mcp/${KEY}`;

let sessionId: string | undefined;

// Single JSON-RPC round-trip against the MCP endpoint. Captures/sends the
// Mcp-Session-Id header. Handles both application/json and SSE responses.
async function mcpCall(method: string, params?: unknown, isNotification = false): Promise<any> {
  const payload: any = { jsonrpc: "2.0", method };
  if (!isNotification) payload.id = Math.floor(Math.random() * 1e9);
  if (params !== undefined) payload.params = params;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  const resp = await fetch(ENDPOINT, { method: "POST", headers, body: JSON.stringify(payload) });
  const sid = resp.headers.get("mcp-session-id");
  if (sid) sessionId = sid;

  if (isNotification) return undefined;

  const text = await resp.text();
  if (!resp.ok) throw new Error(`MCP ${method} HTTP ${resp.status}: ${text.slice(0, 200)}`);

  const json = parseMcpBody(text);
  if (json.error) throw new Error(`MCP ${method} error: ${JSON.stringify(json.error)}`);
  return json.result;
}

// The server may answer with plain JSON or an SSE stream (data: {...}).
function parseMcpBody(text: string): any {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  let result: any = null;
  for (const line of trimmed.split(/\n/)) {
    const m = line.match(/^data:\s?(.*)$/);
    if (m) {
      try {
        result = JSON.parse(m[1]);
      } catch {
        /* ignore non-JSON data lines */
      }
    }
  }
  if (result == null) throw new Error(`Unparseable MCP response: ${text.slice(0, 200)}`);
  return result;
}

// Gemini's function-calling is strict about JSON Schema; strip keywords it
// rejects so MCP tool schemas register cleanly.
function sanitizeSchema(schema: any): any {
  if (schema == null || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);
  const drop = new Set(["$schema", "$id", "$ref", "additionalProperties", "definitions", "examples", "default"]);
  const out: any = {};
  for (const [k, v] of Object.entries(schema)) {
    if (drop.has(k)) continue;
    if (k === "format" && typeof v === "string" && !["enum", "date-time"].includes(v)) continue;
    out[k] = sanitizeSchema(v);
  }
  return out;
}

export default async function (pi: ExtensionAPI) {
  if (!KEY) throw new Error("MCP_API_KEY env var is required for the WhatsApp MCP extension");

  // MCP handshake.
  await mcpCall("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "pi-whatsapp-ext", version: "1.0" },
  });
  await mcpCall("notifications/initialized", undefined, true);

  // Discover and register tools.
  const listed = await mcpCall("tools/list");
  const tools = (listed?.tools ?? []) as Array<{ name: string; description?: string; inputSchema?: any }>;

  const registered: string[] = [];
  for (const tool of tools) {
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description || tool.name,
      parameters: sanitizeSchema(tool.inputSchema ?? { type: "object", properties: {} }) as any,
      async execute(_toolCallId, params) {
        const result = await mcpCall("tools/call", { name: tool.name, arguments: params ?? {} });
        const parts = (result?.content ?? []) as Array<any>;
        const out = parts.filter((p) => p?.type === "text").map((p) => p.text).join("\n") || JSON.stringify(result);
        if (result?.isError) throw new Error(out); // surface tool errors to the model
        return { content: [{ type: "text", text: out }], details: { mcp_result: result } };
      },
    });
    registered.push(tool.name);
  }

  // SAFETY: restrict the agent to ONLY the WhatsApp MCP tools (no bash/file).
  // setActiveTools cannot run during extension loading, so defer it to the
  // lifecycle hooks — both fire before the model can invoke any tool, and we
  // re-assert each turn in case anything tries to re-enable built-ins.
  const lockTools = () => {
    try {
      pi.setActiveTools(registered);
    } catch (e) {
      console.error("[whatsapp-mcp] setActiveTools failed:", e);
    }
  };
  pi.on("session_start", async () => lockTools());
  pi.on("before_agent_start", async () => lockTools());

  console.error(`[whatsapp-mcp] registered ${registered.length} tools; built-ins disabled: ${registered.join(", ")}`);
}

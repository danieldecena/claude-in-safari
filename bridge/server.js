// MCP stdio server that relays tool calls to the Safari extension over a localhost
// WebSocket. stdout belongs to MCP, so every log line goes to stderr.
//   node server.js          MCP mode (what Claude Code launches)
//   node server.js --spike  no MCP; pings the extension every 30s to test worker survival
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { WebSocketServer } from "ws";
import * as z from "zod/v4";

const PORT = 18765;
const TIMEOUT_MS = 15000;

const log = (...a) => console.error(new Date().toISOString(), ...a);

let ext = null;
let nextId = 1;
const pending = new Map();

// A web page can also dial ws://127.0.0.1; only the extension's origin is accepted.
const wss = new WebSocketServer({
  host: "127.0.0.1",
  port: PORT,
  verifyClient: ({ origin }) => {
    const ok = origin?.startsWith("safari-web-extension://");
    if (!ok) log("rejected origin", origin);
    return ok;
  },
});

wss.on("connection", (sock, req) => {
  log("extension connected", req.headers.origin);
  ext?.close();
  ext = sock;
  sock.on("message", (data) => {
    const msg = JSON.parse(data);
    if (msg.type === "hello") return log("hello, worker startedAt", new Date(msg.startedAt).toISOString());
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result);
  });
  sock.on("close", () => {
    log("extension disconnected");
    if (ext === sock) ext = null;
  });
});

function call(method, params = {}) {
  if (!ext) return Promise.reject(new Error("Safari extension not connected. Is Safari open with Claude in Safari enabled?"));
  const id = nextId++;
  ext.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => pending.delete(id) && reject(new Error(`${method} timed out`)), TIMEOUT_MS);
  });
}

if (process.argv.includes("--spike")) {
  log(`spike: listening on 127.0.0.1:${PORT}`);
  setInterval(async () => {
    const t = Date.now();
    try {
      const r = await call("ping");
      log(`ping ok rtt=${Date.now() - t}ms worker uptime=${Math.round(r.uptimeMs / 1000)}s`);
    } catch (e) {
      log("ping FAILED:", e.message);
    }
  }, 30000);
} else {
  const server = new McpServer({ name: "claude-in-safari", version: "0.1.0" });
  server.registerTool(
    "ping",
    { description: "Check that the Safari extension is connected.", inputSchema: z.object({}) },
    async () => ({ content: [{ type: "text", text: JSON.stringify(await call("ping")) }] }),
  );
  await server.connect(new StdioServerTransport());
}

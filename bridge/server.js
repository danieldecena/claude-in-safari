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

// One socket per extension context: every browser and every Safari profile loads its own
// copy, each with a distinct safari-web-extension:// origin. A new connection from a known
// origin replaces the old one; other origins are left alone.
const socks = new Map();
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
  const origin = req.headers.origin;
  log("extension connected", origin);
  socks.get(origin)?.close();
  socks.set(origin, sock);
  ext = sock;
  sock.on("message", (data) => {
    const msg = JSON.parse(data);
    if (msg.type === "hello") return log("hello", origin, "startedAt", new Date(msg.startedAt).toISOString(), msg.ua);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result);
  });
  sock.on("close", () => {
    log("extension disconnected", origin);
    if (socks.get(origin) === sock) socks.delete(origin);
    if (ext === sock) ext = [...socks.values()].at(-1) ?? null;
  });
});

function call(method, params = {}, target = ext) {
  if (!target) return Promise.reject(new Error("Safari extension not connected. Is Safari open with Claude in Safari enabled?"));
  const id = nextId++;
  target.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => pending.delete(id) && reject(new Error(`${method} timed out`)), TIMEOUT_MS);
  });
}

if (process.argv.includes("--spike")) {
  log(`spike: listening on 127.0.0.1:${PORT}`);
  setInterval(() => {
    if (!socks.size) log("ping FAILED: no extension connected");
    for (const [origin, sock] of socks) {
      const t = Date.now();
      call("ping", {}, sock).then(
        (r) => log(`ping ok ${origin.slice(-8)} rtt=${Date.now() - t}ms worker uptime=${Math.round(r.uptimeMs / 1000)}s`),
        (e) => log(`ping FAILED ${origin.slice(-8)}:`, e.message),
      );
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

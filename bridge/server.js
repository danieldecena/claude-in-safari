// MCP stdio server that relays tool calls to the Safari extension over a localhost
// WebSocket. stdout belongs to MCP, so every log line goes to stderr.
//   node server.js          MCP mode (what Claude Code launches)
//   node server.js --spike  no MCP; pings the extension every 30s to test worker survival
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { WebSocketServer } from "ws";
import * as z from "zod/v4";
import { readFileSync } from "node:fs";

const PORT = 18765;
const TIMEOUT_MS = 15000;

const log = (...a) => console.error(new Date().toISOString(), ...a);
const bootedAt = Date.now();

// Shared secret read from the extension source, the single place it is defined; the
// extension sends it back as ?token= when dialing (see CIS_TOKEN in background.js).
const TOKEN = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8")
  .match(/^const CIS_TOKEN = "(\w+)"/m)?.[1];
if (!TOKEN) throw new Error("CIS_TOKEN not found in extension/background.js");

// One socket per extension context: every browser and every Safari profile loads its own
// copy, each with a distinct safari-web-extension:// origin. A new connection from a known
// origin replaces the old one; other origins are left alone.
const socks = new Map();
let ext = null;
let nextId = 1;
const pending = new Map();

// A web page or another extension can also dial ws://127.0.0.1; require the extension
// origin scheme plus the shared token, since any Safari extension gets that scheme.
const wss = new WebSocketServer({
  host: "127.0.0.1",
  port: PORT,
  verifyClient: ({ origin, req }) => {
    const ok = origin?.startsWith("safari-web-extension://")
      && new URL(req.url, "ws://127.0.0.1").searchParams.get("token") === TOKEN;
    if (!ok) log("rejected connection from origin", origin);
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
    if (msg.type === "hello") {
      sock.ua = msg.ua;
      return log("hello", origin, "startedAt", new Date(msg.startedAt).toISOString(), msg.ua);
    }
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
  // Every browser and profile loads its own extension context, and a context only sees its
  // own profile's windows. Contexts with no tabs (STP 27.0 exposes none) are left out.
  const settled = async () => {
    // A fresh bridge has no sockets until the extensions redial (backoff cap 5s), and an
    // empty or short list must not read as "no tabs open". Wait for the first socket, then
    // until the bridge is older than the redial cap so every context has had time to join.
    for (let i = 0; i < 100 && !socks.size; i++) await new Promise((r) => setTimeout(r, 100));
    if (!socks.size) throw new Error("no Safari extension connected. Is Safari open with Claude in Safari enabled?");
    const wait = 6000 - (Date.now() - bootedAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  };
  const contexts = async () => {
    await settled();
    const all = await Promise.all([...socks].map(async ([origin, sock]) => ({
      context: origin.slice(-8),
      browser: sock.ua?.match(/Version\/[\d.]+/)?.[0],
      sock,
      tabs: await call("tabs_context", {}, sock).catch(() => []),
    })));
    return all.filter((c) => c.tabs.length);
  };
  const text = (v) => ({ content: [{ type: "text", text: JSON.stringify(v, null, 1) }] });
  server.registerTool(
    "tabs_context",
    { description: "List open Safari tabs, grouped by extension context (one per Safari profile).", inputSchema: z.object({}) },
    async () => text((await contexts()).map(({ sock, ...c }) => c)),
  );
  server.registerTool(
    "navigate",
    {
      description: "Open a URL in a new background tab, or load it into an existing tab when tabId is given.",
      inputSchema: z.object({
        url: z.string().describe("http:// or https:// URL"),
        tabId: z.number().optional().describe("Existing tab to navigate; omit to open a new background tab"),
        context: z.string().optional().describe("Context from tabs_context; needed only for a new tab when several profiles are open"),
      }),
    },
    async ({ url, tabId, context }) => {
      const cs = await contexts();
      const c = tabId != null ? cs.find((c) => c.tabs.some((t) => t.tabId === tabId))
        : context ? cs.find((c) => c.context === context)
        : cs.length === 1 ? cs[0] : null;
      if (!c) throw new Error(tabId != null ? `no context owns tab ${tabId}` : `pass context, one of: ${cs.map((c) => `${c.context} (${c.browser})`).join(", ") || "(none connected)"}`);
      return text({ context: c.context, ...(await call("navigate", { url, tabId }, c.sock)) });
    },
  );
  const onTab = async (method, params) => {
    const c = (await contexts()).find((c) => c.tabs.some((t) => t.tabId === params.tabId));
    if (!c) throw new Error(`no context owns tab ${params.tabId}; call tabs_context`);
    return call(method, params, c.sock);
  };
  const tabId = z.number().describe("Tab id from tabs_context");
  server.registerTool(
    "get_page_text",
    { description: "Text content of a tab (article or main element if present, else body).", inputSchema: z.object({ tabId }) },
    async (p) => text(await onTab("get_page_text", p)),
  );
  server.registerTool(
    "read_page",
    {
      description: "Accessibility-style tree of a tab with ref_N ids for elements.",
      inputSchema: z.object({ tabId, filter: z.enum(["all", "interactive"]).optional().describe("interactive limits to links, buttons and fields") }),
    },
    async (p) => ({ content: [{ type: "text", text: await onTab("read_page", p) }] }),
  );
  server.registerTool(
    "find",
    { description: "Find visible elements in a tab whose role, name or href contains the query; returns up to 20 with refs.", inputSchema: z.object({ tabId, query: z.string() }) },
    async (p) => ({ content: [{ type: "text", text: (await onTab("find", p)).join("\n") || "no matches" }] }),
  );
  server.registerTool(
    "screenshot",
    { description: "Screenshot the visible area of a tab as PNG (briefly activates the tab if it is in the background).", inputSchema: z.object({ tabId }) },
    async (p) => {
      const { dataUrl } = await onTab("screenshot", p);
      const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (!m) throw new Error(`unexpected screenshot format: ${dataUrl.slice(0, 40)}`);
      return { content: [{ type: "image", mimeType: m[1], data: m[2] }] };
    },
  );
  server.registerTool(
    "computer",
    {
      description: "Interact with a tab: click an element, type into a field, press a key, or scroll. Element refs come from read_page or find.",
      inputSchema: z.object({
        tabId,
        action: z.enum(["click", "type", "key", "scroll", "set"]),
        ref: z.string().optional().describe("ref_N target; required for click and type, optional for key and scroll"),
        text: z.string().optional().describe("type: text to put in the field (replaces its value)"),
        value: z.union([z.string(), z.boolean()]).optional().describe("set: option value or text for a select, true/false for a checkbox or radio, text for other fields"),
        key: z.string().optional().describe("key: key name like Enter, Escape, Tab, ArrowDown, or a single character"),
        direction: z.enum(["up", "down", "left", "right"]).optional().describe("scroll: direction; omit it but pass ref to scroll that element into view"),
        amount: z.number().optional().describe("scroll: distance in px, default 80% of the viewport"),
      }),
    },
    async (p) => text(await onTab("computer", p)),
  );
  server.registerTool(
    "javascript",
    {
      description: "Run JavaScript in a tab and return the last expression's value. Executes in the content-script world: full DOM access, but not the page's own JS variables; synchronous code only.",
      inputSchema: z.object({ tabId, code: z.string().describe("JavaScript source; the value of the last expression is returned") }),
    },
    async (p) => text(await onTab("javascript", p)),
  );
  server.registerTool(
    "read_console",
    {
      description: "Console output and page errors captured in a tab since load (up to 500 entries). Pages with a strict CSP only capture errors, not console.* calls.",
      inputSchema: z.object({ tabId, clear: z.boolean().optional().describe("Empty the buffer after reading") }),
    },
    async (p) => ({ content: [{ type: "text", text: (await onTab("read_console", p)).join("\n") || "console buffer empty" }] }),
  );
  server.registerTool(
    "read_network",
    {
      description: "Resources a tab loaded (scripts, images, fetch/XHR) as initiator, status, duration, size and url. Timing entries only: no request method, headers or bodies, and the status is '?' where Safari does not report it. Buffer is roughly the last 250 entries.",
      inputSchema: z.object({ tabId, clear: z.boolean().optional().describe("Empty the buffer after reading") }),
    },
    async (p) => ({ content: [{ type: "text", text: (await onTab("read_network", p)).join("\n") || "no resources recorded" }] }),
  );
  server.registerTool(
    "tab",
    {
      description: "Close, reload, or move back/forward in a tab's history.",
      inputSchema: z.object({ tabId, action: z.enum(["close", "reload", "back", "forward"]) }),
    },
    async (p) => text(await onTab("tab", p)),
  );
  server.registerTool(
    "ping",
    { description: "Check that the Safari extension is connected.", inputSchema: z.object({}) },
    async () => {
      await settled();
      const rows = await Promise.all([...socks].map(async ([origin, sock]) => ({
        context: origin.slice(-8),
        browser: sock.ua?.match(/Version\/[\d.]+/)?.[0],
        ...(await call("ping", {}, sock).catch((e) => ({ error: e.message }))),
      })));
      return text(rows);
    },
  );
  await server.connect(new StdioServerTransport());
}

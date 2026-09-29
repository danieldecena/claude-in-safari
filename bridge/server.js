// MCP stdio server that relays tool calls to the Safari extension over a localhost
// WebSocket. stdout belongs to MCP, so every log line goes to stderr.
//   node server.js          MCP mode (what Claude Code launches)
//   node server.js --spike  no MCP; pings the extension every 30s to test worker survival
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { WebSocket, WebSocketServer } from "ws";
import * as z from "zod/v4";
import { readFileSync } from "node:fs";

const PORT = Number(process.env.CIS_PORT ?? 18765);
const BIND_RETRY_MS = Number(process.env.CIS_BIND_RETRY_MS ?? 3000);
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

// Other Claude sessions' bridges that joined this one as relays (see joinHub).
const relays = new Set();

// A web page or another extension can also dial ws://127.0.0.1; require the extension
// origin scheme plus the shared token, since any Safari extension gets that scheme.
// Relays dial /relay with the token and no Origin header: browsers always send Origin on a
// WebSocket, so a page cannot pass as a relay even if it learned the path.
// A second Claude session starts a second bridge on the same port. Without an error handler the
// EADDRINUSE error is unhandled and kills the process, so the MCP server never comes up.
// Instead the second bridge joins the holder as a relay, so every session reaches Safari at once.
let listenError = null;
function bind() {
  const wss = new WebSocketServer({
    host: "127.0.0.1",
    port: PORT,
    verifyClient: ({ origin, req }) => {
      const u = new URL(req.url, "ws://127.0.0.1");
      const ok = u.searchParams.get("token") === TOKEN
        && (u.pathname === "/relay" ? !origin : origin?.startsWith("safari-web-extension://"));
      if (!ok) log("rejected connection from origin", origin, u.pathname);
      return ok;
    },
  });
  wss.on("listening", () => {
    if (listenError) log(`bound port ${PORT} after retrying`);
    listenError = null;
  });
  wss.on("error", (e) => {
    const inUse = e.code === "EADDRINUSE";
    listenError = inUse ? null : `bridge socket error: ${e.message}`;
    if (listenError) log(listenError);
    if (inUse) {
      wss.close();
      joinHub();
    }
  });
  wss.on("connection", (sock, req) => (req.url.startsWith("/relay") ? onRelay(sock) : onConnection(sock, req)));
}

// Relay side: forward this session's calls to the bridge holding the port. Each extension
// context the hub reports becomes a stand-in socket in `socks`, so the tools run unchanged.
// When the hub goes away, rebind: one relay wins the port and the rest join it.
function joinHub() {
  const hub = new WebSocket(`ws://127.0.0.1:${PORT}/relay?token=${TOKEN}`);
  let joined = false;
  hub.on("open", () => {
    joined = true;
    log(`port ${PORT} is held by another session's bridge; relaying through it`);
  });
  hub.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return log("dropped malformed message from hub"); }
    if (msg.type !== "contexts") return settle(msg);
    socks.clear();
    for (const c of msg.contexts) {
      socks.set(c.origin, {
        ua: c.ua,
        OPEN: WebSocket.OPEN,
        get readyState() { return hub.readyState; },
        send: (d) => hub.send(JSON.stringify({ ...JSON.parse(d), origin: c.origin })),
      });
    }
    ext = [...socks.values()].at(-1) ?? null;
  });
  hub.on("error", (e) => {
    if (joined) return log("hub socket error:", e.message);
    listenError = `port ${PORT} is in use by something that refused to relay (${e.message}); an older bridge or another app. Retrying every ${BIND_RETRY_MS / 1000}s`;
    log(listenError);
  });
  hub.on("close", () => {
    for (const [id, p] of pending) {
      pending.delete(id);
      clearTimeout(p.timer);
      p.reject(new Error("the bridge this session relays through exited mid-call; retry"));
    }
    socks.clear();
    ext = null;
    if (joined) log("hub went away; rebinding");
    // Jitter so relays freed by the same exit do not all hit the port in the same tick.
    setTimeout(bind, joined ? 100 + Math.random() * 400 : BIND_RETRY_MS);
  });
}

// Hub side: run a relay's call against the named extension context and send the answer back.
const contextsMsg = () => JSON.stringify({ type: "contexts", contexts: [...socks].map(([origin, s]) => ({ origin, ua: s.ua })) });
const broadcastContexts = () => { for (const r of relays) r.send(contextsMsg()); };
function onRelay(sock) {
  log("relay joined");
  relays.add(sock);
  sock.send(contextsMsg());
  sock.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return log("dropped malformed message from relay"); }
    call(msg.method, msg.params, socks.get(msg.origin) ?? null).then(
      (result) => sock.send(JSON.stringify({ id: msg.id, result })),
      (e) => sock.send(JSON.stringify({ id: msg.id, error: e.message })),
    );
  });
  sock.on("close", () => { relays.delete(sock); log("relay left"); });
}

function settle(msg) {
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  clearTimeout(p.timer);
  msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result);
}

function onConnection(sock, req) {
  const origin = req.headers.origin;
  log("extension connected", origin);
  socks.get(origin)?.close();
  socks.set(origin, sock);
  ext = sock;
  sock.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return log("dropped malformed message from", origin); }
    if (msg.type === "hello") {
      sock.ua = msg.ua;
      broadcastContexts();
      return log("hello", origin, "startedAt", new Date(msg.startedAt).toISOString(), msg.ua);
    }
    settle(msg);
  });
  sock.on("close", () => {
    log("extension disconnected", origin);
    for (const [id, p] of pending) {
      if (p.sock !== sock) continue;
      pending.delete(id);
      clearTimeout(p.timer);
      p.reject(new Error("Safari extension disconnected mid-call (Safari quit, or the extension reloaded)"));
    }
    if (socks.get(origin) === sock) socks.delete(origin);
    if (ext === sock) ext = [...socks.values()].at(-1) ?? null;
    broadcastContexts();
  });
  broadcastContexts();
}

bind();

function call(method, params = {}, target = ext) {
  if (!target) return Promise.reject(new Error(listenError ?? "Safari extension not connected. Is Safari open with Claude in Safari enabled?"));
  if (target.readyState !== target.OPEN) return Promise.reject(new Error("Safari extension socket is closing; retry"));
  const id = nextId++;
  target.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => pending.delete(id) && reject(new Error(`${method} timed out`)), TIMEOUT_MS);
    pending.set(id, { resolve, reject, sock: target, timer });
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
    if (!socks.size) throw new Error(listenError ?? "no Safari extension connected. Is Safari open with Claude in Safari enabled?");
    const wait = 6000 - (Date.now() - bootedAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  };
  const contexts = async (keepEmpty = false) => {
    await settled();
    const all = await Promise.all([...socks].map(async ([origin, sock]) => ({
      context: origin.slice(-8),
      browser: sock.ua?.match(/Version\/[\d.]+/)?.[0],
      sock,
      ...(await call("tabs_context", {}, sock).then((tabs) => ({ tabs }), (e) => ({ tabs: [], error: e.message }))),
    })));
    return keepEmpty ? all : all.filter((c) => c.tabs.length);
  };
  const text = (v) => ({ content: [{ type: "text", text: JSON.stringify(v, null, 1) }] });
  server.registerTool(
    "tabs_context",
    { description: "List open Safari tabs, grouped by extension context (one per Safari profile). A context with no tabs is listed with an empty tabs array; one that failed to answer carries an error.", inputSchema: z.object({}) },
    async () => text((await contexts(true)).map(({ sock, ...c }) => c)),
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
  const tabId = z.number().int().describe("Tab id from tabs_context");
  server.registerTool(
    "get_page_text",
    { description: "Text content of a tab (article or main element if present, else body), plus a frames list with the text of any iframes.", inputSchema: z.object({ tabId }) },
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
    { description: "Find visible elements in a tab (and its iframes) whose role, name or href contains the query; returns up to 20 with refs. Iframe hits carry f<frameId>: refs that computer accepts.", inputSchema: z.object({ tabId, query: z.string() }) },
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
        ref: z.string().optional().describe("ref_N target (or f<frameId>:ref_N for an iframe element); required for click and type, optional for key and scroll"),
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
      inputSchema: z.object({ tabId, code: z.string().describe("JavaScript source; the value of the last expression is returned"), frameId: z.number().int().optional().describe("run in this iframe: the N from a [frame fN] header of read_page, e.g. 236223201282 (Safari frame ids are large; pass them whole); default is the top frame") }),
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

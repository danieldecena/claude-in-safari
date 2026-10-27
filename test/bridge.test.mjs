// Protocol tests for bridge/server.js against a fake extension: no Safari needed.
//   cd bridge && node --test ../test/
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { WebSocket } from "../bridge/node_modules/ws/wrapper.mjs";
import { TOKEN } from "../bridge/token.js";

const ORIGIN = "safari-web-extension://00000000-test";
let nextPort = 19000 + (process.pid % 500) * 2;

// A test that throws before its b.stop() would leave the bridge child alive and node --test
// hanging; kill every bridge this file spawned once all tests are done.
const children = new Set();
after(() => { for (const p of children) p.kill(); });

function startBridge(port, env = {}) {
  const p = spawn("node", ["server.js"], { cwd: new URL("../bridge/", import.meta.url), env: { ...process.env, CIS_PORT: String(port), ...env }, stdio: ["pipe", "pipe", "pipe"] });
  children.add(p);
  let buf = "", n = 0, err = "";
  const waiters = new Map();
  p.stderr.on("data", (d) => (err += d));
  p.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiters.get(m.id)?.(m); }
  });
  const rpc = (method, params) => new Promise((res) => { const id = ++n; waiters.set(id, res); p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  const ready = rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } })
    .then(() => p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"));
  const call = async (name, args = {}) => {
    const r = await rpc("tools/call", { name, arguments: args });
    return { error: r.error ?? r.result?.isError, text: r.result?.content?.[0]?.text ?? JSON.stringify(r.error) };
  };
  return { p, ready, call, stderr: () => err, stop: () => p.kill() };
}

const dial = (port, { token = TOKEN, origin = ORIGIN, path = "/" } = {}) => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}?token=${token}`, origin ? { origin } : {});
  ws.on("open", () => resolve(ws));
  ws.on("unexpected-response", (_, res) => resolve(res.statusCode));
  ws.on("error", () => {});
});

const tabsReply = (ws) => ws.on("message", (d) => {
  const m = JSON.parse(d);
  if (m.method === "tabs_context") ws.send(JSON.stringify({ id: m.id, result: [{ tabId: 7, windowId: 1, url: "https://x.test/", title: "x", active: true }] }));
});

test("socket auth: wrong token and web origin are refused, right token is accepted", { timeout: 30000 }, async () => {
  const port = nextPort++, b = startBridge(port);
  await b.ready; await new Promise((r) => setTimeout(r, 500));
  assert.equal(await dial(port, { token: "wrong" }), 401);
  assert.equal(await dial(port, { origin: "https://evil.test" }), 401);
  assert.equal(await dial(port, { path: "/relay", origin: "https://evil.test" }), 401, "a page must not pass as a relay");
  assert.equal(await dial(port, { path: "/relay", origin: null, token: "wrong" }), 401);
  const ok = await dial(port);
  assert.equal(typeof ok, "object", "right token + extension origin must connect");
  const relay = await dial(port, { path: "/relay", origin: null });
  assert.equal(typeof relay, "object", "right token + no origin on /relay must connect");
  ok.close(); relay.close(); b.stop();
});

test("known-good: tabs_context reaches the fake extension and returns its tabs", { timeout: 30000 }, async () => {
  const port = nextPort++, b = startBridge(port);
  await b.ready; await new Promise((r) => setTimeout(r, 500));
  const ws = await dial(port); tabsReply(ws);
  const r = await b.call("tabs_context");
  assert.ok(!r.error, r.text);
  assert.match(r.text, /"tabId": 7/);
  ws.close(); b.stop();
});

test("a malformed message from the extension does not kill the bridge", { timeout: 30000 }, async () => {
  const port = nextPort++, b = startBridge(port);
  await b.ready; await new Promise((r) => setTimeout(r, 500));
  const ws = await dial(port); tabsReply(ws);
  ws.send("{not json");
  const r = await b.call("tabs_context");
  assert.ok(!r.error, r.text);
  assert.equal(b.p.exitCode, null);
  ws.close(); b.stop();
});

test("a disconnect mid-call rejects promptly instead of waiting out the 15s timeout", { timeout: 30000 }, async () => {
  const port = nextPort++, b = startBridge(port);
  await b.ready; await new Promise((r) => setTimeout(r, 500));
  const ws = await dial(port); tabsReply(ws);
  await b.call("tabs_context"); // past the settle window, tab 7 known
  ws.removeAllListeners("message");
  ws.on("message", () => ws.close()); // die on the next call
  const t = Date.now();
  const r = await b.call("get_page_text", { tabId: 7 });
  assert.ok(r.error, "must fail");
  assert.match(r.text, /disconnected|no context owns/);
  assert.ok(Date.now() - t < 8000, `took ${Date.now() - t}ms`);
  b.stop();
});

test("a second session relays through the first, and both reach the extension", { timeout: 30000 }, async () => {
  const port = nextPort++, first = startBridge(port);
  await first.ready; await new Promise((r) => setTimeout(r, 500));
  const second = startBridge(port);
  await second.ready; await new Promise((r) => setTimeout(r, 500));
  assert.match(second.stderr(), /relaying through it/, "precondition: second must have joined as a relay");
  const ws = await dial(port); tabsReply(ws);
  const [a, b] = await Promise.all([first.call("tabs_context"), second.call("tabs_context")]);
  assert.ok(!a.error, a.text);
  assert.ok(!b.error, b.text);
  assert.match(b.text, /"tabId": 7/);
  ws.close(); first.stop(); second.stop();
});

test("a relay takes over the port once the hub exits", { timeout: 30000 }, async () => {
  const port = nextPort++, first = startBridge(port);
  await first.ready; await new Promise((r) => setTimeout(r, 500));
  const second = startBridge(port);
  await second.ready; await new Promise((r) => setTimeout(r, 500));
  assert.match(second.stderr(), /relaying through it/, "precondition: second must be a relay first");
  first.stop();
  await new Promise((r) => setTimeout(r, 1500));
  const ws = await dial(port); tabsReply(ws);
  assert.equal(typeof ws, "object", "second bridge must now own the port");
  const r = await second.call("tabs_context");
  assert.ok(!r.error, r.text);
  ws.close(); second.stop();
});

test("a port held by something that is not a bridge is reported, and the MCP server still answers", { timeout: 30000 }, async () => {
  const port = nextPort++;
  const squatter = createServer((_, res) => res.writeHead(404).end()).listen(port, "127.0.0.1");
  await new Promise((r) => squatter.on("listening", r));
  const b = startBridge(port);
  await b.ready; await new Promise((r) => setTimeout(r, 500));
  assert.equal(b.p.exitCode, null, "bridge must stay up");
  const r = await b.call("ping");
  assert.ok(r.error);
  assert.match(r.text, /in use by something that refused to relay/);
  b.stop(); squatter.close();
});

// Fake extension for batch: tab 7 exists; computer clicks succeed; javascript "boom" fails;
// every method name received is recorded in order.
const scripted = (ws, seen) => ws.on("message", (d) => {
  const m = JSON.parse(d);
  if (!m.method) return; // status broadcasts are not calls
  seen.push(m.method === "computer" ? `computer:${m.params.ref}` : m.method);
  if (m.method === "tabs_context") return ws.send(JSON.stringify({ id: m.id, result: [{ tabId: 7, windowId: 1, url: "https://x.test/", title: "x", active: true }] }));
  if (m.method === "computer") return ws.send(JSON.stringify({ id: m.id, result: { clicked: m.params.ref } }));
  if (m.method === "javascript" && m.params.code === "boom") return ws.send(JSON.stringify({ id: m.id, error: "boom" }));
  if (m.method === "javascript") return ws.send(JSON.stringify({ id: m.id, result: { result: 1 } }));
});

test("batch runs steps in order and stops at the first failure", { timeout: 30000 }, async () => {
  const port = nextPort++, b = startBridge(port);
  await b.ready; await new Promise((r) => setTimeout(r, 500));
  const ws = await dial(port), seen = []; scripted(ws, seen);
  const r = await b.call("batch", { tabId: 7, steps: [
    { tool: "computer", args: { action: "click", ref: "ref_1" } },
    { tool: "javascript", args: { code: "boom" } },
    { tool: "computer", args: { action: "click", ref: "ref_2" } },
  ] });
  assert.ok(!r.error, r.text);
  assert.match(r.text, /^1\. computer: /m);
  assert.match(r.text, /^2\. javascript failed: boom$/m);
  assert.match(r.text, /stopped at step 2 of 3/);
  assert.doesNotMatch(r.text, /^3\./m);
  assert.deepEqual(seen.filter((s) => s !== "tabs_context"), ["computer:ref_1", "javascript"]);
  assert.equal(seen.filter((s) => s === "tabs_context").length, 1, "a batch looks the tab's context up once, not once per step");
  ws.close(); b.stop();
});

test("the extension gets a status message on connect and when a relay joins or leaves", { timeout: 30000 }, async () => {
  const port = nextPort++, first = startBridge(port);
  await first.ready; await new Promise((r) => setTimeout(r, 500));
  const ws = await dial(port), statuses = [];
  ws.on("message", (d) => { const m = JSON.parse(d); if (m.type === "status") statuses.push(m); });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(statuses.length, 1, "one status on connect");
  assert.equal(statuses[0].sessions, 1);
  assert.equal(typeof statuses[0].bootedAt, "number");
  const second = startBridge(port);
  await second.ready; await new Promise((r) => setTimeout(r, 500));
  assert.match(second.stderr(), /relaying through it/, "precondition: second must be a relay");
  assert.equal(statuses.at(-1).sessions, 2, "relay join raises the session count");
  second.stop(); await new Promise((r) => setTimeout(r, 500));
  assert.equal(statuses.at(-1).sessions, 1, "relay leave lowers it again");
  ws.close(); first.stop();
});

test("batch reports a schema failure on one line and treats a non-numeric wait as 0", { timeout: 30000 }, async () => {
  const port = nextPort++, b = startBridge(port);
  await b.ready; await new Promise((r) => setTimeout(r, 500));
  const ws = await dial(port), seen = []; scripted(ws, seen);
  const r = await b.call("batch", { tabId: 7, stopOnError: false, steps: [
    { tool: "wait", args: { ms: "soon" } },
    { tool: "computer", args: { action: "poke", ref: "ref_1" } },
  ] });
  assert.match(r.text, /^1\. wait 0ms$/m);
  assert.match(r.text, /^2\. computer failed: [^\n]*action[^\n]*$/m, "schema errors must stay on one line");
  ws.close(); b.stop();
});

test("batch with stopOnError false runs every step", { timeout: 30000 }, async () => {
  const port = nextPort++, b = startBridge(port);
  await b.ready; await new Promise((r) => setTimeout(r, 500));
  const ws = await dial(port), seen = []; scripted(ws, seen);
  const r = await b.call("batch", { tabId: 7, stopOnError: false, steps: [
    { tool: "javascript", args: { code: "boom" } },
    { tool: "computer", args: { action: "click", ref: "ref_2" } },
  ] });
  assert.match(r.text, /^1\. javascript failed: boom$/m);
  assert.match(r.text, /^2\. computer: /m);
  ws.close(); b.stop();
});

test("batch caps wait at 5000ms and refuses screenshot", { timeout: 30000 }, async () => {
  const port = nextPort++, b = startBridge(port);
  await b.ready; await new Promise((r) => setTimeout(r, 500));
  const ws = await dial(port), seen = []; scripted(ws, seen);
  const t = Date.now();
  const w = await b.call("batch", { tabId: 7, steps: [{ tool: "wait", args: { ms: 99999 } }] });
  assert.match(w.text, /^1\. wait 5000ms$/m);
  assert.ok(Date.now() - t < 9000, `took ${Date.now() - t}ms`);
  const s = await b.call("batch", { tabId: 7, steps: [{ tool: "screenshot" }] });
  assert.ok(s.error, "screenshot must be rejected by the schema");
  ws.close(); b.stop();
});

// Polls instead of sleeping a fixed time, so a loaded machine slows the test without failing it.
const until = async (fn, ms = 10000) => {
  for (const end = Date.now() + ms; !fn(); ) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
};

// ws answers pings on its own; autoPong: false lets a test decide when the peer goes silent.
// Each context needs its own origin: a second connection from the same one replaces the first.
const quietDial = (port, origin = ORIGIN) => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${TOKEN}`, { origin, autoPong: false });
  ws.on("open", () => resolve(ws));
});

test("heartbeat: a peer that keeps answering pings stays; one that goes silent is dropped", { timeout: 30000 }, async () => {
  const port = nextPort++, b = startBridge(port, { CIS_HEARTBEAT_MS: "200" });
  await b.ready; await new Promise((r) => setTimeout(r, 500));

  const good = await quietDial(port);
  let goodClosed = false, goodPings = 0;
  good.on("ping", () => { goodPings++; good.pong(); });
  good.on("close", () => (goodClosed = true));

  const bad = await quietDial(port, "safari-web-extension://00000000-bad");
  let badClosed = false, answered = false;
  bad.on("ping", () => { if (!answered) { answered = true; bad.pong(); } });
  bad.on("close", () => (badClosed = true));

  assert.ok(await until(() => badClosed), "a peer that answered once and then went silent must be dropped");
  assert.ok(await until(() => goodPings >= 8), `known-good peer was pinged ${goodPings} times`);
  assert.equal(goodClosed, false, "a peer that answers every ping must stay connected");
  assert.match(b.stderr(), /dropping socket/);
  good.close(); b.stop();
});

test("heartbeat: a peer that never answers is left connected, with one warning", { timeout: 30000 }, async () => {
  const port = nextPort++, b = startBridge(port, { CIS_HEARTBEAT_MS: "200" });
  await b.ready; await new Promise((r) => setTimeout(r, 500));
  const mute = await quietDial(port);
  let closed = false, pings = 0;
  mute.on("close", () => (closed = true));
  mute.on("ping", () => pings++);
  assert.ok(await until(() => pings >= 8), `the heartbeat must actually have pinged it (${pings})`);
  assert.equal(closed, false, "no pong ever seen means pings are unsupported, not that the peer is dead");
  assert.equal(b.stderr().match(/has not answered 5 pings/g)?.length, 1, "the fallback must be visible, once");
  mute.close(); b.stop();
});

test("heartbeat: a relay drops a frozen hub, keeps retrying, and rejoins when it thaws", { timeout: 30000 }, async () => {
  const env = { CIS_HEARTBEAT_MS: "200", CIS_BIND_RETRY_MS: "300" };
  const port = nextPort++, hub = startBridge(port, env);
  await hub.ready; await new Promise((r) => setTimeout(r, 500));
  const relay = startBridge(port, env);
  await relay.ready;
  assert.ok(await until(() => /relaying through it/.test(relay.stderr())), "precondition: second must have joined as a relay");
  assert.doesNotMatch(relay.stderr(), /dropping socket/, "a healthy hub must not be dropped");
  hub.p.kill("SIGSTOP"); // socket stays open, nothing answers: a half-open hub
  assert.ok(await until(() => /dropping socket/.test(relay.stderr())), "frozen hub must be dropped");
  assert.ok(await until(() => /refused to relay/.test(relay.stderr())), "the redial against a frozen hub must time out and retry, not hang");
  hub.p.kill("SIGCONT");
  assert.ok(await until(() => relay.stderr().match(/relaying through it/g)?.length >= 2), "relay must rejoin once the hub answers again");
  hub.stop(); relay.stop();
});

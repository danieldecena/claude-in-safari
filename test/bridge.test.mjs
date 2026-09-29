// Protocol tests for bridge/server.js against a fake extension: no Safari needed.
//   cd bridge && node --test ../test/
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { WebSocket } from "../bridge/node_modules/ws/wrapper.mjs";

const TOKEN = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8").match(/^const CIS_TOKEN = "(\w+)"/m)[1];
const ORIGIN = "safari-web-extension://00000000-test";
let nextPort = 19000 + (process.pid % 500) * 2;

function startBridge(port, env = {}) {
  const p = spawn("node", ["server.js"], { cwd: new URL("../bridge/", import.meta.url), env: { ...process.env, CIS_PORT: String(port), ...env }, stdio: ["pipe", "pipe", "pipe"] });
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

const dial = (port, { token = TOKEN, origin = ORIGIN } = {}) => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`, { origin });
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
  const ok = await dial(port);
  assert.equal(typeof ok, "object", "right token + extension origin must connect");
  ok.close(); b.stop();
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

test("a busy port is reported, and the MCP server still answers", { timeout: 30000 }, async () => {
  const port = nextPort++, first = startBridge(port);
  await first.ready; await new Promise((r) => setTimeout(r, 500));
  const second = startBridge(port);
  await second.ready;
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(second.p.exitCode, null, "second bridge must stay up");
  const r = await second.call("ping");
  assert.ok(r.error);
  assert.match(r.text, /in use/);
  first.stop(); second.stop();
});

test("a bridge stuck on a busy port takes over once the holder exits", { timeout: 30000 }, async () => {
  const port = nextPort++, first = startBridge(port);
  await first.ready; await new Promise((r) => setTimeout(r, 500));
  const second = startBridge(port, { CIS_BIND_RETRY_MS: "300" });
  await second.ready; await new Promise((r) => setTimeout(r, 500));
  assert.match((await second.call("ping")).text, /in use/, "precondition: second must be blocked first");
  first.stop();
  await new Promise((r) => setTimeout(r, 1500));
  const ws = await dial(port); tabsReply(ws);
  assert.equal(typeof ws, "object", "second bridge must now own the port");
  const r = await second.call("tabs_context");
  assert.ok(!r.error, r.text);
  ws.close(); second.stop();
});

// Times extension page tools on live pages. Joins the bridge that a running Claude session
// holds (as a relay), so Safari with Claude in Safari must be connected.
//   cd bridge && node bench.js https://example.com https://www.linkedin.com/jobs/view/<id>/
//   BENCH_UA=Version/27.0 picks Safari Technology Preview; BENCH_SETTLE_MS=7000 lets ad frames load.
import { WebSocket } from "ws";
import { readFileSync } from "node:fs";

const PORT = Number(process.env.CIS_PORT ?? 18765);
const TOKEN = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8").match(/^const CIS_TOKEN = "(\w+)"/m)[1];
const urls = process.argv.slice(2);
if (!urls.length) { console.error("usage: node bench.js <url>..."); process.exit(2); }

const hub = new WebSocket(`ws://127.0.0.1:${PORT}/relay?token=${TOKEN}`);
const pending = new Map();
let nextId = 1, contexts = [];
const joined = new Promise((resolve, reject) => {
  hub.on("error", reject);
  hub.on("message", (d) => {
    const m = JSON.parse(d);
    if (m.type === "contexts") { contexts = m.contexts; if (contexts.length) resolve(); return; }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
  });
});
const call = (origin, method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  hub.send(JSON.stringify({ id, method, params, origin }));
  // A relay call has no timeout of its own; without this a lost reply hangs the bench.
  setTimeout(() => { if (pending.delete(id)) reject(new Error("no reply in 25s")); }, 25000);
});
const time = async (probe, fn) => {
  const t = Date.now();
  try {
    const r = await fn();
    return { probe, ms: Date.now() - t, status: "ok", bytes: JSON.stringify(r ?? null).length };
  } catch (e) {
    return { probe, ms: Date.now() - t, status: `ERR ${String(e.message).slice(0, 60)}`, bytes: 0 };
  }
};

await Promise.race([joined, new Promise((_, rej) => setTimeout(() => rej(new Error("no extension context reached the hub in 10s")), 10000))]);
// STP contexts can report zero tabs; bench the first context that sees any.
// BENCH_UA narrows the pick to a browser (matched against the context's user agent or origin).
let origin;
for (const c of contexts) {
  if (process.env.BENCH_UA && !`${c.ua} ${c.origin}`.includes(process.env.BENCH_UA)) continue;
  const tabs = await call(c.origin, "tabs_context", {}).catch(() => []);
  if (tabs.length) { origin = c.origin; break; }
}
if (!origin) throw new Error("no connected context reports any tabs");

const rows = [];
for (const url of urls) {
  const { tabId } = await call(origin, "navigate", { url });
  // navigate returns at load "complete", before an SPA has rendered or its ad frames exist.
  // BENCH_SETTLE_MS waits for that, so the probes time the page a person would see.
  await new Promise((r) => setTimeout(r, Number(process.env.BENCH_SETTLE_MS ?? 0)));
  const host = new URL(url).hostname;
  for (const [probe, method, params] of [
    ["javascript sync", "javascript", { tabId, code: "document.title" }],
    ["find", "find", { tabId, query: "apply" }],
    ["read_page interactive", "read_page", { tabId, filter: "interactive" }],
    ["get_page_text", "get_page_text", { tabId }],
    ["javascript async", "javascript", { tabId, code: "await new Promise((r) => setTimeout(r, 300)); return 42" }],
  ]) rows.push({ host, ...(await time(probe, () => call(origin, method, params))) });
  await call(origin, "tab", { tabId, action: "close" }).catch(() => {});
}
console.table(rows);
hub.close();

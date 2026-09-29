# Safari Speed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop claude-in-safari's page tools timing out on LinkedIn/Workday and cut a Workday page fill from ~25 calls to 1-2.

**Architecture:** Measure first with a bench script that joins the running bridge as a relay. Then fix the extension (parallel subframes, cheaper visibility, shadow DOM, time budget), add async `javascript` (content script stores the promise, background polls), and add a bridge-side `batch` tool that runs existing tool handlers in sequence. Finally, write Safari recipes for the apply skills.

**Tech Stack:** Node 20+ ESM (`bridge/`, pnpm, `ws`, `@modelcontextprotocol/server`, `zod/v4`), Safari Web Extension MV2 (`extension/`), `node --test`.

**Spec:** `docs/superpowers/specs/2026-09-29-safari-speed-design.md`

## Global Constraints

- pnpm, not npm, in `bridge/`.
- Manifest stays MV2. Do not "modernize" it.
- stdout belongs to MCP in `bridge/server.js`: log only through `log` (stderr).
- No top-level bindings in `content.js`; everything inside the `window.__cis` version guard. When handlers change, bump `CIS_VERSION` AND the literal in the guard line (`< 8` -> `< 9`).
- `CIS_TOKEN` line in `extension/background.js` must keep the exact format `const CIS_TOKEN = "<hex>";`.
- After touching `extension/`: rebuild and reinstall the app (commands in Task 2 Step 4), then Daniel toggles the extension off/on in Safari > Settings > Extensions (human step).
- After touching `bridge/server.js`: the running Claude session's bridge only picks it up after `/mcp` reconnect or a session restart (human step).
- Page-tool time budget 8000 ms; async javascript budget 12000 ms (below the bridge's 15000 ms call timeout); batch max 30 steps; `wait` max 5000 ms.
- A fix whose before/after bench timing does not improve is reverted, not kept (spec, Testing).

---

## File Structure

- Create `bridge/bench.js`: times extension methods on live pages by joining the running bridge as a relay. One responsibility: measurement.
- Modify `extension/background.js`: `inPage` gains a `retryMs` option; `withFrames` and `find` visit subframes in parallel with a skip list; `javascript` polls pending async results.
- Modify `extension/content.js`: walker visibility, shadow roots, time budget; async `javascript` + `poll`.
- Modify `bridge/server.js`: tool registry + `batch` tool.
- Modify `test/bridge.test.mjs`: batch tests.
- Create `docs/skill-recipes.md`: Safari tool map and recipes.
- Create `docs/skill-uploads/{apply-next-job,linkedin-job-list,workday-apply-handoff}/SKILL.md`: upload copies with a Safari section.
- Modify `STATUS.md`, `README.md`: numbers and the new tools.

---

### Task 1: Bench script and baseline numbers

**Files:**
- Create: `bridge/bench.js`
- Modify: `STATUS.md` (decision log)

**Interfaces:**
- Consumes: relay protocol from `feat/bridge-relay-hub` (`ws://127.0.0.1:18765/relay?token=<CIS_TOKEN>`, no Origin; hub sends `{type:"contexts", contexts:[{origin, ua}]}`, accepts `{id, method, params, origin}`, replies `{id, result}` or `{id, error}`).
- Produces: `node bench.js <url>...` printing one row per (url, probe): `probe`, `ms`, `status`, `bytes`. Later tasks re-run it.

- [ ] **Step 1: Write the bench script**

```js
// Times extension page tools on live pages. Joins the bridge that a running Claude session
// holds (as a relay), so Safari with Claude in Safari must be connected.
//   cd bridge && node bench.js https://example.com https://www.linkedin.com/jobs/view/<id>/
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
let origin;
for (const c of contexts) {
  const tabs = await call(c.origin, "tabs_context", {}).catch(() => []);
  if (tabs.length) { origin = c.origin; break; }
}
if (!origin) throw new Error("no connected context reports any tabs");

const rows = [];
for (const url of urls) {
  const { tabId } = await call(origin, "navigate", { url });
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
```

- [ ] **Step 2: Prove the bench detects both a fast and a slow page**

Precondition: a Claude session with claude-in-safari running and Safari connected (`ping` in that session returns `pong: true`), and that session's bridge started AFTER `feat/bridge-relay-hub` was checked out (an older bridge answers `/relay` with 401 and the bench fails with "Unexpected server response: 401"). Check: `lsof -nP -iTCP:18765 -sTCP:LISTEN` then `ps -o lstart= -p <pid>` is later than commit `8e7b00d`'s time; otherwise `/mcp` reconnect claude-in-safari first.

Run: `cd bridge && node bench.js https://example.com https://www.linkedin.com/jobs/view/4454341334/ "https://wd1.myworkdaysite.com/en-US/recruiting/snapchat/snap/job/New-York-New-York/Senior-Sales-Operations-Associate---Revenue-Tooling_R0046585-1"`

Expected: example.com rows all `ok` and under ~1500 ms (the known-good control). LinkedIn `find`/`read_page`/`get_page_text` either `ERR ... timed out` at ~15000 ms or several seconds. `javascript async` fails on all hosts today (a SyntaxError, since `await` is not allowed at top level). If example.com is also slow, stop: the bench or the connection is broken, not the page tools.

- [ ] **Step 3: Record the baseline**

Append to `STATUS.md` under `## Decision log` / `### 2026-09-29`:

```markdown
- Finding: bench baseline before speed fixes (bridge/bench.js): <paste console.table rows for the 3 hosts>.
```

- [ ] **Step 4: Commit**

```bash
git add bridge/bench.js STATUS.md
git commit -m "Add a bench that times page tools on live Safari pages" -m "Joins the running bridge as a relay so it measures the extension without a second MCP client. Records the baseline the speed fixes are judged against." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- bridge/bench.js STATUS.md
```

---

### Task 2: Parallel subframes with a skip list

**Files:**
- Modify: `extension/background.js` (`inPage` ~line 44, `withFrames` ~line 78, `find` case ~line 149)

**Interfaces:**
- Produces: `inPage(tabId, method, params, frameId, { retryMs = 5000 } = {})`: same return as today; `retryMs: 0` means one attempt.

- [ ] **Step 1: Give `inPage` a retry budget and at least one attempt**

Replace the body of `inPage` with:

```js
async function inPage(tabId, method, params, frameId, { retryMs = 5000 } = {}) {
  const code = `window.__cis.run(${JSON.stringify(method)}, ${JSON.stringify(params)})`;
  const deadline = Date.now() + retryMs;
  let last = "no result";
  for (;;) {
    try {
      const at = frameId ? { frameId } : {};
      await chrome.tabs.executeScript(tabId, { file: "content.js", ...at });
      const [r] = await chrome.tabs.executeScript(tabId, { code, ...at });
      if (r?.error) throw Object.assign(new Error(r.error), { fromPage: true });
      if (r) return r.result;
      last = "no result";
    } catch (e) {
      if (e.fromPage) throw e;
      last = String(e?.message ?? e);
    }
    if (Date.now() + 250 >= deadline) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`tab ${tabId} did not accept the script (still loading or not scriptable): ${last}`);
}
```

- [ ] **Step 2: Visit subframes in parallel, once each, skipping ad/tracker frames**

Add above `withFrames`:

```js
// Ad and tracker frames never hold anything the tools need, and each one that refuses the
// script used to cost a full retry budget.
const SKIP_FRAME = /doubleclick\.net|googlesyndication\.com|googletagmanager\.com|recaptcha\/api2\/(anchor|bframe)/;
const subframes = async (tabId) => (await allFrames(tabId)).filter((f) => f.frameId !== 0 && !SKIP_FRAME.test(f.url ?? ""));
```

Replace the loop in `withFrames`:

```js
async function withFrames(tabId, method, params, top) {
  const subs = (await Promise.all((await subframes(tabId)).map(async (f) => {
    try {
      let r = await inPage(tabId, method, params, f.frameId, { retryMs: 0 });
      if (method === "read_page") r = r.replace(/\[(ref_\d+)\]/g, `[f${f.frameId}:$1]`);
      return { frameId: f.frameId, url: f.url, r };
    } catch {
      return null;
    }
  }))).filter(Boolean);
```

(keep the rest of `withFrames` unchanged). Replace the `find` case:

```js
    case "find": {
      const top = await inPage(params.tabId, "find", params);
      const per = await Promise.all((await subframes(params.tabId)).map((f) =>
        inPage(params.tabId, "find", params, f.frameId, { retryMs: 0 })
          .then((r) => r.map((l) => l.replace(/\[(ref_\d+)\]/, `[f${f.frameId}:$1]`)), () => [])));
      return [...top, ...per.flat()].slice(0, 20);
    }
```

- [ ] **Step 3: Rebuild, reinstall, reload**

```bash
cd ~/developer/claude-in-safari
xcodebuild -project "Claude in Safari/Claude in Safari.xcodeproj" -scheme "Claude in Safari" -configuration Debug -derivedDataPath DerivedData build | tail -3
rm -rf "$HOME/Applications/Claude in Safari.app"
ditto "DerivedData/Build/Products/Debug/Claude in Safari.app" "$HOME/Applications/Claude in Safari.app"
```

Expected: `** BUILD SUCCEEDED **`. Then Daniel toggles Claude in Safari off and on in Safari > Settings > Extensions (human step), and `ping` in the Claude session shows a fresh `startedAt`.

- [ ] **Step 4: Bench and compare**

Run the Task 1 Step 2 command. Expected: example.com unchanged; LinkedIn `find`/`read_page`/`get_page_text` no longer at the 15000 ms timeout. If LinkedIn does not move, revert this task's diff (`git checkout -- extension/background.js`) and record that in STATUS.md instead.

- [ ] **Step 5: Run the bridge tests (no regressions)**

Run: `cd bridge && pnpm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add extension/background.js STATUS.md
git commit -m "Visit subframes in parallel and skip ad frames" -m "Each subframe that refused the script cost up to 5s of retries, one after another. Now subframes get one attempt, in parallel, and ad/tracker frames are skipped. Bench: <before -> after ms for LinkedIn read_page>." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- extension/background.js STATUS.md
```

(Append the bench numbers to STATUS.md before committing, same format as Task 1 Step 3.)

---

### Task 3: Walker: shadow DOM, cheaper visibility, time budget

**Files:**
- Modify: `extension/content.js` (guard line 8-9, `visible` ~77, `readPage` ~100, `find` ~114)

**Interfaces:**
- Produces: `read_page` and `find` see elements inside open shadow roots; output may end with `(partial: time budget hit)`.

- [ ] **Step 1: Bump the version**

Line 8: `if ((window.__cis?.version ?? 0) < 9) {`  Line 9: `const CIS_VERSION = 9;`

- [ ] **Step 2: Cheaper visibility**

Replace `visible`:

```js
  // checkVisibility answers from the engine's own state; the fallback forces layout and style.
  const visible = (el) => {
    if (el.checkVisibility) return el.checkVisibility({ visibilityProperty: true });
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none";
  };
```

- [ ] **Step 3: Shadow roots and a time budget in `readPage` and `find`**

Add after `visible`:

```js
  const BUDGET_MS = 8000;
  // Open shadow roots render as part of the page (LinkedIn's Easy Apply modal lives in one).
  const kids = (el) => (el.shadowRoot ? [...el.shadowRoot.children, ...el.children] : el.children);
```

Replace `readPage`:

```js
  const readPage = ({ filter = "all", maxChars = 50000 } = {}) => {
    const lines = [];
    const deadline = Date.now() + BUDGET_MS;
    let partial = false;
    const walk = (el, depth) => {
      if (partial || !(el instanceof Element) || !visible(el)) return;
      if (Date.now() > deadline) { partial = true; return; }
      const role = roleOf(el);
      const keep = role && (filter !== "interactive" || INTERACTIVE.has(role));
      if (keep) lines.push(`${"  ".repeat(depth)}${describe(el, role)}`);
      for (const c of kids(el)) walk(c, keep ? depth + 1 : depth);
    };
    walk(document.body, 0);
    if (partial) lines.push("(partial: time budget hit)");
    const out = lines.join("\n");
    return out.length > maxChars ? `${out.slice(0, maxChars)}\n[truncated at ${maxChars} chars]` : out;
  };
```

Replace `find`:

```js
  const find = ({ query }) => {
    const q = query.toLowerCase();
    const hits = [];
    const deadline = Date.now() + BUDGET_MS;
    const walk = (el) => {
      if (hits.length >= 20 || !(el instanceof Element)) return;
      if (Date.now() > deadline) { if (hits.at(-1) !== "(partial: time budget hit)") hits.push("(partial: time budget hit)"); return; }
      const role = roleOf(el);
      if (role && visible(el)) {
        const hay = `${role} ${nameOf(el)} ${el.getAttribute("href") ?? ""}`.toLowerCase();
        if (hay.includes(q)) hits.push(describe(el, role));
      }
      for (const c of kids(el)) walk(c);
    };
    walk(document.body);
    return hits;
  };
```

Note: `find` now walks from `document.body` instead of `querySelectorAll("*")`, so it can enter shadow roots; it still visits every element (an invisible parent does not hide a `position: fixed` child from `find`, matching today's behavior).

- [ ] **Step 4: Rebuild, reinstall, reload**

Same commands and human step as Task 2 Step 3.

- [ ] **Step 5: Bench and check shadow DOM**

Run the Task 1 Step 2 command. Expected: LinkedIn `read_page interactive` under 3000 ms, example.com unchanged.
Shadow check (from a Claude session): open `https://www.linkedin.com/jobs/view/<an Easy Apply job id>/`, click Easy Apply, take a `screenshot` (activates the tab), then `find` query `Next` or `Review`. Expected: a `button "Next"`/`"Review"` hit from inside the modal (before this task it returned nothing). Close the modal without submitting.
If timings do not move, revert the `visible` change only and re-bench; keep shadow roots and the budget (they are correctness, not speed).

- [ ] **Step 6: Commit**

```bash
git add extension/content.js STATUS.md
git commit -m "Walk open shadow roots and cap page reads at 8s" -m "LinkedIn renders Easy Apply in a shadow root, which find and read_page never entered. Visibility now uses checkVisibility where Safari has it, and a slow page returns partial results instead of hitting the bridge timeout. Bench: <numbers>." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- extension/content.js STATUS.md
```

---

### Task 4: Async `javascript`

**Files:**
- Modify: `extension/content.js` (`javascript` ~205, `window.__cis` ~271)
- Modify: `extension/background.js` (`javascript` case ~171; add `pollJs`)

**Interfaces:**
- Consumes: `CIS_VERSION` 9 from Task 3 (bump to 10 here; guard literal `< 10`).
- Produces: content `javascript` returns `{ result }` (sync, unchanged) or `{ __cis_pending: <int> }`; `window.__cis.poll(id)` returns `{ pending: true } | { result } | { error }`. The tool's final value is `{ result }` either way.

- [ ] **Step 1: Bump the version to 10** (guard literal and const).

- [ ] **Step 2: Content side**

Replace the `javascript` handler:

```js
  // Async code (anything using await) runs as an async function: its `return` is the result.
  // The reply channel to background does not deliver, so a pending promise is parked here and
  // background polls window.__cis.poll(id).
  const parked = new Map();
  let nextParked = 1;
  const settle = (result) => {
    try {
      JSON.stringify(result);
      return { result: result === undefined ? "undefined" : result };
    } catch {
      return { result: String(result) };
    }
  };
  // The content-script world has its own console, which the page-world hook never sees;
  // wrap it for the duration of the eval so the code's own logs reach read_console.
  const javascript = ({ code }) => {
    const orig = {};
    for (const level of LEVELS) {
      orig[level] = console[level];
      console[level] = (...args) => { push(level, args.map(fmt).join(" ")); return orig[level].apply(console, args); };
    }
    try {
      let result;
      try {
        result = (0, eval)(code);
      } catch (e) {
        if (!(e instanceof SyntaxError && /\bawait\b/.test(code))) throw e;
        result = (0, eval)(`(async () => {\n${code}\n})()`);
      }
      if (typeof result?.then !== "function") return settle(result);
      const id = nextParked++;
      parked.set(id, { done: false });
      result.then(
        (v) => parked.set(id, { done: true, out: settle(v) }),
        (e) => parked.set(id, { done: true, error: String(e?.message ?? e) }),
      );
      return { __cis_pending: id };
    } finally {
      Object.assign(console, orig);
    }
  };
```

Add `poll` to the `window.__cis` object (next to `run`):

```js
    poll: (id) => {
      const p = parked.get(id);
      if (!p) return { error: `javascript call ${id} is gone (the page navigated or reloaded)` };
      if (!p.done) return { pending: true };
      parked.delete(id);
      return p.error ? { error: p.error } : { result: p.out };
    },
```

- [ ] **Step 3: Background side**

Add above `handle`:

```js
// Polls an async javascript call parked by content.js; 12s stays under the bridge's 15s timeout.
async function pollJs(tabId, id, frameId) {
  const at = frameId ? { frameId } : {};
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    const [r] = await chrome.tabs.executeScript(tabId, { code: `window.__cis.poll(${id})`, ...at });
    if (r?.error) throw new Error(r.error);
    if (r && !r.pending) return r.result;
  }
  throw new Error("javascript: async code still running after 12s");
}
```

Replace the `javascript` case:

```js
    case "javascript": {
      if (params.frameId) await requireFrame(params.tabId, params.frameId, "javascript", "re-run read_page");
      const r = await inPage(params.tabId, method, params, params.frameId);
      return r?.__cis_pending ? pollJs(params.tabId, r.__cis_pending, params.frameId) : r;
    }
```

- [ ] **Step 4: Update the tool description** in `bridge/server.js` (`javascript` tool):

```js
    { description: "Run JavaScript in a tab. Sync code returns its last expression. Code that uses await runs as an async function: use `return` for the result (12s limit). Content-script world: full DOM access, not the page's own JS variables.", ... }
```

(keep the existing `inputSchema` object unchanged.)

- [ ] **Step 5: Rebuild, reinstall, reload** (Task 2 Step 3), and `/mcp` reconnect for the description.

- [ ] **Step 6: Bench**

Run the Task 1 Step 2 command. Expected: `javascript async` rows `ok` at ~300-500 ms on all three hosts, `bytes` showing `{"result":42}`; `javascript sync` unchanged.
Known-bad check from a Claude session: `javascript` with `await new Promise(() => {}); return 1` returns `javascript: async code still running after 12s` at ~12 s (not a bridge timeout at 15 s).

- [ ] **Step 7: Commit**

```bash
git add extension/content.js extension/background.js bridge/server.js STATUS.md
git commit -m "Let javascript await: park the promise in the page, poll from background" -m "Click-then-read flows cost two calls each because javascript could not wait. Code using await now runs as an async function; the page's reply channel does not deliver, so background polls a parked result every 100ms for up to 12s." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- extension/content.js extension/background.js bridge/server.js STATUS.md
```

---

### Task 5: `batch` tool

**Files:**
- Modify: `bridge/server.js` (tool registration block)
- Test: `test/bridge.test.mjs`

**Interfaces:**
- Produces: MCP tool `batch({ tabId: int, steps: [{ tool, args? }] (1-30), stopOnError?: boolean = true })`, `tool` in `computer | javascript | find | get_page_text | read_page | navigate | tab | wait`. Returns one text block: lines `N. <tool>: <text>`, `N. wait <ms>ms`, `N. <tool> failed: <message>`, and `stopped at step N of M` on an early stop.

- [ ] **Step 1: Write the failing tests** (append to `test/bridge.test.mjs`)

```js
// Fake extension for batch: tab 7 exists; computer clicks succeed; javascript "boom" fails;
// every method name received is recorded in order.
const scripted = (ws, seen) => ws.on("message", (d) => {
  const m = JSON.parse(d);
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
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd bridge && pnpm test`
Expected: the 3 new tests FAIL (unknown tool `batch`); the existing 7 pass.

- [ ] **Step 3: Implement**

In `bridge/server.js`, inside the `else` block right after `const server = new McpServer(...)`, add:

```js
  // Batchable tools are registered through `tool` so batch can call their handlers directly,
  // with the same schema parsing (and defaults) as a direct call.
  const handlers = {};
  const tool = (name, def, fn) => {
    handlers[name] = (args) => fn(def.inputSchema.parse(args));
    server.registerTool(name, def, fn);
  };
```

Change `server.registerTool(` to `tool(` for: `navigate`, `get_page_text`, `read_page`, `find`, `computer`, `javascript`, `tab`. Leave `tabs_context`, `screenshot`, `read_console`, `read_network`, `ping` on `server.registerTool`.

After the `ping` registration, add:

```js
  const BATCHABLE = ["computer", "javascript", "find", "get_page_text", "read_page", "navigate", "tab"];
  server.registerTool(
    "batch",
    {
      description: "Run up to 30 tool steps on one tab in order, in one call. Each step is {tool, args}; tabId is inherited. tool: computer, javascript, find, get_page_text, read_page, navigate, tab, or wait ({ms}, max 5000). Stops at the first failing step unless stopOnError is false. Screenshots are not allowed in a batch.",
      inputSchema: z.object({
        tabId,
        steps: z.array(z.object({ tool: z.enum([...BATCHABLE, "wait"]), args: z.record(z.string(), z.any()).optional() })).min(1).max(30),
        stopOnError: z.boolean().optional(),
      }),
    },
    async ({ tabId, steps, stopOnError = true }) => {
      const out = [];
      for (const [i, s] of steps.entries()) {
        const n = i + 1;
        try {
          if (s.tool === "wait") {
            const ms = Math.min(Math.max(Number(s.args?.ms ?? 0), 0), 5000);
            await new Promise((r) => setTimeout(r, ms));
            out.push(`${n}. wait ${ms}ms`);
            continue;
          }
          const r = await handlers[s.tool]({ ...s.args, tabId: s.args?.tabId ?? tabId });
          out.push(`${n}. ${s.tool}: ${r.content.map((c) => c.text ?? `[${c.type}]`).join("\n")}`);
        } catch (e) {
          out.push(`${n}. ${s.tool} failed: ${e.message}`);
          if (stopOnError) {
            out.push(`stopped at step ${n} of ${steps.length}`);
            break;
          }
        }
      }
      return text_(out.join("\n"));
    },
  );
```

and define next to `text` (which JSON-encodes): `const text_ = (s) => ({ content: [{ type: "text", text: s }] });`

Note `computer` returns `text(await onTab(...))`, so its step text is JSON; that is fine and matches the test's `1. computer: ` prefix.

- [ ] **Step 4: Run the tests**

Run: `cd bridge && pnpm test`
Expected: 10 pass, 0 fail.

- [ ] **Step 5: Live check** (after `/mcp` reconnect)

From a Claude session on any form page: one `batch` with `find` + `computer type` + `computer key Tab` + `javascript` readback returns 4 numbered lines. A `batch` whose second step uses a bad ref returns `2. computer failed: ref_… not found…` and `stopped at step 2 of N`.

- [ ] **Step 6: Commit**

```bash
git add bridge/server.js test/bridge.test.mjs
git commit -m "Add a batch tool that runs tool steps on one tab in one call" -m "A Workday page took ~25 calls: click, key, Enter per dropdown plus readbacks. batch runs existing handlers in order with the same schema parsing, stops at the first failure by default, and caps wait at 5s." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- bridge/server.js test/bridge.test.mjs
```

---

### Task 6: Recipes and skill upload files

**Files:**
- Create: `docs/skill-recipes.md`
- Create: `docs/skill-uploads/apply-next-job/SKILL.md`, `docs/skill-uploads/linkedin-job-list/SKILL.md`, `docs/skill-uploads/workday-apply-handoff/SKILL.md`
- Modify: `README.md` (tool list), `STATUS.md`

**Interfaces:**
- Consumes: `batch` (Task 5), async `javascript` (Task 4), shadow-root `find` (Task 3).

- [ ] **Step 1: Write `docs/skill-recipes.md`**

```markdown
# Safari recipes for the job-apply skills

Used when Daniel picks Safari (claude-in-safari) instead of the in-app browser.

## Tool map

| In-app browser | claude-in-safari |
|---|---|
| tabs_context / tabs_create + navigate / preview_start | tabs_context / navigate (no tabId = new background tab) |
| get_page_text, read_page, find | same names |
| computer left_click / type / key | computer action click / type / key (by ref) |
| form_input | computer action set |
| javascript_tool | javascript (await allowed; use `return`) |
| browser_batch | batch |
| tabs_close | tab action close |
| file upload | not available: Daniel attaches the resume |

## Rules

- Take one `screenshot` before reading a modal in a background tab: it activates the tab so the modal renders.
- LinkedIn's Easy Apply modal is in a shadow root: `find`/`read_page` see it (v9+); `document.querySelector` from `javascript` does not, so walk `el.shadowRoot` there.
- Close the job's tab once submission is verified.

## Workday page in one call

Application Questions with Yes/No dropdowns: `find` "Select One" once to get refs, then one `batch`:
click ref, key Y (or N), key Enter, for each dropdown, then a `javascript` readback
`[...document.querySelectorAll('main button[aria-haspopup=listbox]')].map(b=>b.innerText)`.
Save and Continue: `batch` [computer click <save ref>, wait 5000, javascript step readback
`document.querySelector('main').innerText.match(/current step \d of \d/i)?.[0]`].

## LinkedIn AI search: 3 pages and job ids in one call

The cards carry no ids; clicking a card sets `currentJobId` in the URL. One `javascript`:
for each target card, click it, `await` 800 ms, read `location.href.match(/currentJobId=(\d+)/)[1]`,
and `return` the list. Page buttons: click "2"/"3", `await` 3500 ms, read the cards.
```

- [ ] **Step 2: Create the upload copies**

```bash
S=~/.claude/skills/synced/9f9a33c3-d18c-4a92-bcdd-5e0f26ae4877_1414539c-b9fd-4ff2-a01a-025193bd3342
for n in apply-next-job linkedin-job-list workday-apply-handoff; do
  mkdir -p docs/skill-uploads/$n && cp "$S/$n/SKILL.md" docs/skill-uploads/$n/SKILL.md
done
```

Append this section to the end of each of the three copies:

```markdown

## Safari (claude-in-safari)

When Daniel asks for Safari, use the `mcp__claude-in-safari__*` tools. Tool map and recipes:
`~/developer/claude-in-safari/docs/skill-recipes.md`. In short: `batch` for a whole form page
(one call, stops at the first failed step), `javascript` with `await` for click-then-read
loops (use `return`), one `screenshot` before reading a modal in a background tab, no file
upload (Daniel attaches the resume), and close the job tab once submission is verified.
```

- [ ] **Step 3: README and STATUS**

In `README.md`, add `batch` to the tool list with the one-line description from Task 5, and note that `javascript` accepts `await`. In `STATUS.md` `## Confirmed working`, add one line with the final bench numbers from Tasks 2-4 and the Workday call count from a live fill (Step 4).

- [ ] **Step 4: Live acceptance**

On a real Workday Application Questions page (or the next Workday job in the queue), fill the page using the recipe. Expected: 1-2 calls for the dropdowns + readback (spec success criterion). Record the count in STATUS.md.

- [ ] **Step 5: Commit**

```bash
git add docs/skill-recipes.md docs/skill-uploads README.md STATUS.md
git commit -m "Add Safari recipes and skill upload copies for the apply skills" -m "The apply skills are synced from claude.ai, so the Safari section ships as upload-ready SKILL.md copies plus a recipe doc in this repo." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- docs/skill-recipes.md docs/skill-uploads README.md STATUS.md
```

Then tell Daniel: upload the three `docs/skill-uploads/*/SKILL.md` files to claude.ai (Settings > Capabilities > Skills), replacing the current versions.

# Safari speed: no timeouts, fewer calls

Date: 2026-09-29 · Branch: `feat/safari-speed` (stacked on `feat/bridge-relay-hub`)

## Problem

Driving job applications through claude-in-safari on 2026-09-29 was slow in two ways:

1. **Timeouts.** `find`, `read_page` and `get_page_text` hit the 45 s MCP timeout on a
   LinkedIn job page. `javascript` on the same page answered at once, so the page itself was
   reachable.
2. **Call count.** Resolving 12 LinkedIn job ids took ~24 calls (click, then read, because
   `javascript` cannot await). The Snap Workday fill took ~60 calls (one per keystroke-level
   action, 8 dropdowns x click/key/Enter plus readbacks).

Also observed: `find`/`read_page` never saw LinkedIn's Easy Apply modal (it renders inside a
shadow root), and a background tab did not render the modal until a screenshot activated it.

## Success criteria

- `find` and `read_page` on a LinkedIn job page and a Workday application page return in
  under 3 s, measured live.
- A Workday "Application Questions" page (8 Yes/No dropdowns + readback) fills in 1-2 calls.
- LinkedIn search paging + card reading for 3 pages runs in 1 `javascript` call.
- Existing bridge tests stay green; each new behavior has a failing-first test.

## Causes (from code reading, to confirm by timing before fixing)

- `withFrames` (`extension/background.js`) visits subframes serially, and `inPage` retries
  each one for up to 5 s. LinkedIn carries several ad/tracking iframes that refuse scripts.
- `readPage`'s walker (`extension/content.js`) calls `getBoundingClientRect` +
  `getComputedStyle` on every element, forcing layout across a very large DOM.
- The walker follows `el.children` only, so open shadow roots are skipped.
- `javascript` evaluates synchronously; a returned Promise is not awaited.

## Design

### A. Speed fixes (extension)

- **Frames in parallel.** `withFrames` runs subframes with `Promise.all`. Only the top frame
  keeps the 5 s "still loading" retry; a subframe gets one attempt. Frames whose URL is
  `about:blank` with no content or matches a small ad/tracker host list
  (`doubleclick.net`, `googlesyndication`, `recaptcha` anchors) are skipped.
- **Cheaper visibility.** Prune a subtree when its root has no layout box
  (`el.checkVisibility?.()` where available, else `offsetParent === null` for non-fixed
  elements); call `getComputedStyle` only for elements about to be emitted.
- **Shadow DOM.** The walker and `find` descend into `el.shadowRoot` when it is open. Refs are
  per-element and already survive this.
- **Time budget.** Page tools stop walking after 8 s and append
  `(partial: time budget hit)`. The bridge's 15 s call timeout stays as the backstop.

### B. Async `javascript`

- The page-to-background reply channel does not deliver (`content.js:3`), so async results are
  polled: `run("javascript")` wraps the code in `(async () => { ... })()`, stores the settled
  value or error under a call id in `window.__cis`, and returns `{pending: id}`. Background
  polls `window.__cis.poll(id)` every 100 ms until settled or 12 s pass.
- Synchronous snippets keep working: a non-Promise last expression returns immediately, as
  today. Bump `CIS_VERSION` and the guard literal.

### C. `batch` tool (bridge only)

- `batch({tabId, steps: [{tool, args}], stopOnError = true})`: up to 30 steps, run in order
  through the existing tool handlers in `bridge/server.js`. Each step inherits `tabId` unless
  it sets its own. Result: a numbered list of each step's text (images from `screenshot` are
  not allowed in a batch).
- Allowed tools: `computer`, `javascript`, `find`, `get_page_text`, `read_page`, `navigate`,
  `tab`, plus a batch-only `wait` step (`{ms}`, max 5000).
- On the first error with `stopOnError`, return the results so far plus
  `step N (<tool>) failed: <message>`.

### D. Skill recipes

- `docs/skill-recipes.md` in this repo: the in-app browser to Safari tool map, and recipes
  (Workday page = one `batch`; LinkedIn AI-search paging and job-id capture = one async
  `javascript`; close the job tab after a confirmed submit).
- Updated `SKILL.md` files for `apply-next-job`, `linkedin-job-list` and
  `workday-apply-handoff`, written to `docs/skill-uploads/` for Daniel to upload to
  claude.ai. The synced copies under `~/.claude/skills/synced/` are not edited (the account
  sync owns them).

## Testing

- Bridge tests (fake extension, `test/bridge.test.mjs`): batch runs in order; batch stops at
  the first failing step and reports its index; batch rejects `screenshot`; `wait` caps at
  5000 ms.
- Extension logic has no unit harness today. Time the causes on real pages before and after
  (LinkedIn job page, Workday application page) with `ping`-style timing from a Claude
  session; record the numbers in STATUS.md. A fix whose before/after timing does not move is
  reverted, not kept.

## Out of scope

- A `fill_form` macro (label to value map): batch covers it.
- File upload from Safari (resume attach stays Daniel's).
- Background-tab rendering: `screenshot` already activates the tab; recipes say to take one
  before reading a modal.

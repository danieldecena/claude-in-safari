---
name: verify
description: How to verify claude-in-safari changes at runtime: drive bridge/server.js over MCP stdio against live Safari, ship extension changes with the notarized build, and what cannot be captured.
---

# Verifying claude-in-safari at runtime

## Bridge and tool changes (MCP surface)

Another Claude session usually holds port 18765. A second `node bridge/server.js` joins it as a
relay, so you can drive the real MCP surface without touching that session:

```js
// spawn("node", ["server.js"], { cwd: "<repo>/bridge" }), then JSON-RPC over stdin/stdout:
// initialize -> notifications/initialized -> wait ~6.5s (settle window) -> tools/list, tools/call
```

`test/bridge.test.mjs` has the exact `startBridge`/`rpc` helpers to copy. Safari needs at least
one open window or `navigate` fails ("no connected context reports any tabs"). Use example.com
as the control page; its only link is "Learn more" (ref_1 from `read_page interactive`).

Quick timing across page tools: `cd bridge && BENCH_SETTLE_MS=1000 node bench.js https://example.com`
(it also joins as a relay; `javascript async` is the await probe).

## Extension changes

content.js / background.js only run after a ship: `zsh scripts/build-notarized.sh`, then
`rm -rf "$HOME/Applications/Claude in Safari.app"` and `ditto` the printed APP there. Stable
Safari picked up a reinstalled build without a restart on 2026-10-13; STP needs quit + reopen.
Confirm with `javascript` code `window.__cis.version` (must equal `CIS_VERSION` in content.js).

## What cannot be captured

Daniel's Safari window lives on the Sidecar display (window bounds start around x=3364), so
`screencapture -R`/`-l` return "could not create image from rect". `swift` scripts also fail
here (module cache is not writable). For toolbar icon or popup checks, ask Daniel for a
screenshot; the `screenshot` tool only captures page content, never the toolbar.

## Gotchas seen

- An async `javascript` that triggers a full navigation loses its parked promise and fails with
  "javascript call N is gone"; that is expected. Use `batch` [computer click, wait, javascript].
- `javascript` with `return` but no `await` is a SyntaxError by design ("Return statements are
  only valid inside functions").

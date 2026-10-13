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
Confirm with `javascript` code `window.__cis.version` (must equal `CIS_VERSION` in content.js),
and `ping` for a fresh `uptimeMs` (a background.js change needs a new context, not just a new file).

**After every install, re-register the appex** or STP will relaunch with no extension context
at all (the build re-registers the DerivedData copy and displaces the installed one):

```sh
pluginkit -a "$HOME/Applications/Claude in Safari.app/Contents/PlugIns/Claude in Safari Extension.appex"
open "$HOME/Applications/Claude in Safari.app"
# verify: pluginkit -mAvvv -p com.apple.Safari.web-extension | grep -A1 claude-in-safari.Extension | grep Path
```

Symptom when this is wrong: the relay lists only `Version/27.2` and every STP call answers
"no context matching".

## What cannot be captured

Daniel's Safari window lives on the Sidecar display (window bounds start around x=3364), so
`screencapture -R`/`-l` return "could not create image from rect". `swift` scripts also fail
here (module cache is not writable). For toolbar icon or popup checks, ask Daniel for a
screenshot; the `screenshot` tool only captures page content, never the toolbar.

## Reproducing a restored-but-unloaded tab

The bug class behind "tab did not accept the script": a tab Safari restored and never showed
has no main frame. To build one in STP: open the page, add a second tab and make *it* the
front tab, quit STP, reopen it, then History > "Reopen All Windows from Last Session"
(AppleScript: click that menu item via System Events). `debug_tab` on the background tab shows
`frames: ERR ... Main frame not found` and `exec: [null]` while `tabs.get` looks normal.
Note the Safari 27.2 menu item is often disabled; STP's works.

## Gotchas seen

- An async `javascript` that triggers a full navigation loses its parked promise and fails with
  "javascript call N is gone"; that is expected. Use `batch` [computer click, wait, javascript].
- `javascript` with `return` but no `await` is a SyntaxError by design ("Return statements are
  only valid inside functions").

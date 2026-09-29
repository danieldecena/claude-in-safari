# Reliability and capabilities pass

Status: implemented and verified 2026-09-29. Touches `extension/content.js`,
`extension/background.js`, `bridge/server.js`, `README.md`.

## Goal

Remove the flaky spots seen in the 2026-09-29 end-to-end test, and close four capability gaps
against Claude in Chrome. Everything is additive: each capability is a handler in
`content.js` (or a `background.js` case), a case in the `background.js` switch, and a tool
registration in `server.js`. No new transport, no module split.

## 1. Reliability

**Page tools right after `navigate`.** Calling `get_page_text`, `read_page`, `javascript` and
`find` immediately after `navigate` returned `no result from tab 450`; the same calls after a
4s wait worked. Cause unconfirmed (believed: `executeScript` returns nothing for a tab that is
still loading). `inPage` retries the injection every 250ms for up to 5s while the result is
empty. On timeout the error says the page did not accept the script (permission or still
loading), not just `no result`.

**First-call wait.** The bridge waits for the first socket, then a fixed 2s. The extension
redial backoff cap is 5s, so a slow context can be missing from the first `tabs_context`.
Replace with: hold until the bridge process is 6s old (5s cap plus 1s margin). The no-socket
error path is unchanged (wait up to 10s, then `no Safari extension connected`). Calls after
the bridge is 6s old never wait.

**`navigate` waits for the load.** Found in testing: the retry alone let a page tool
called right after `navigate` read the previous document. `navigate` now resolves on
`tabs.onUpdated` status `complete` (10s cap).

Unchanged: the `window.__cis` version guard.

## 2. Console fix

`javascript` runs `eval` in the content-script world, whose `console.*` nothing hooks, so a
marker logged by `javascript` never reaches `read_console`. During the `eval`, wrap that
world's `console.log/info/warn/error/debug` to push into `window.__cis_logs`, then restore
them in a `finally`. No CSP dependency. Works because `javascript` is synchronous.
Bump `CIS_VERSION`.

Done when: `javascript` running `console.log("cis-marker")` is followed by `read_console`
returning `cis-marker` (the slice 6 done-when as originally written).

## 3. Tab control

New tool `tab`: `{ tabId, action: "close" | "back" | "forward" | "reload" }`.
`close` uses `chrome.tabs.remove`, `reload` uses `chrome.tabs.reload`. `back` and `forward` run `history.back()` / `history.forward()` through `inPage` (the
`chrome.tabs.goBack` route was not tried). Returns `{ tabId, action }`.
The bridge routes it through `onTab`, so `close` on an unknown tab errors
`no context owns tab N`.

## 4. Form input

`computer` gains `action: "set"` with `ref` and `value` (string or boolean):
`<select>` matches an option by value, then by visible text; checkbox and radio take a
boolean; anything else falls through to the existing `type` logic. Fires `input` and `change`.
An unmatched option errors listing the available options. No new tool schema.

## 5. Network capture

New tool `read_network`: `{ tabId, clear? }`, backed by
`performance.getEntriesByType("resource")` in the content-script world, so strict CSP cannot
block it (the console hook can be). Returns url, initiator type, duration and transfer size,
plus response status if `responseStatus` exists in Safari (unverified: check before
documenting it). No method, headers or bodies: Safari has no debugger API. `clear` calls
`performance.clearResourceTimings()`. Limitation stated in the tool description and README.

## Cost

Tools go from 10 to 12 (`tab`, `read_network`); each adds schema tokens to every session.

## Verification

Each item gets a failing case before the change, a passing case after, and a known-good
control. Driver: `/tmp/cis-mcp.mjs`.

| Item | Before | After | Control |
|------|--------|-------|---------|
| Reliability 1 | `navigate` then `get_page_text` at once fails | same calls succeed | already-loaded tab returns first try; `favorites://` tab still errors clearly |
| Reliability 2 | fresh bridge, first `tabs_context` | lists all 4 contexts | second call returns with no wait |
| Console | `javascript` marker absent from `read_console` | marker present | a page-world `console.log` still appears |
| Tab | n/a | `close` removes a test tab from `tabs_context`; back returns to the prior URL | `close` on a bogus id errors |
| set | n/a | select, checkbox and text field on a local test page change and fire events | unmatched option errors with the list |
| Network | n/a | example.com load lists its own URL | `clear` empties the buffer |

`background.js` changes need the app rebuilt (`/tmp/cis-rebuild.sh`) and the extension
reloaded in Safari and STP; Safari-side reload is manual.

## Out of scope

Trusted input (no `debugger` in Safari), file upload, window resize, GIF recording, request
headers and bodies.

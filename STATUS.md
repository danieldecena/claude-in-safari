# Status

## Confirmed working
- Bridge: stdio MCP + WebSocket on 127.0.0.1:18765; a bridge blocked on a busy port retries and takes over when the holder exits.
- read_page / find / computer / javascript reach iframes; bare iframes get a `[frame fN]` header; stale frameIds fail fast.
- read_page shows `autocomplete` / `passwordrules`; password values show length only.
- Private remote: github.com/danieldecena/claude-in-safari.

## Known broken
- A Safari-restored iCloud Mail tab refuses scripts ("Could not execute script in tab"), even after a reload; a Mail tab opened via `navigate` works, as do restored LinkedIn tabs. Cause unknown.

## Next Up
- Nothing queued; see TASKS.md.

## Decision log
### 2026-09-29
- Decided: keep this project rather than switch to Safari 27's `safaridriver --mcp`. It runs an isolated automation session: `list_tabs` saw none of the user's tabs, iCloud Mail loaded signed out, and `evaluate_javascript` with `frameId` failed on a plain `<iframe src="inner.html">` ("Could not determine iframe src URL"). It is fine for clean-room testing; it cannot act in the logged-in browser.
- Decided: the Safari "autofill" doc is form-markup guidance, not an API. Implemented as read-only field hints in read_page; no filling of saved AutoFill data.
- Decided: the content.js guard literal must be bumped with `CIS_VERSION` (it was stuck at `< 6`, so updates never replaced handlers in open pages).
- Decided: repo is private because `CIS_TOKEN` is committed in `extension/background.js`.
- Finding: a Safari toggle does not always restart every extension context; context `bb428ddd` (started 14:19) survived three toggles running old background.js. Quit and reopen STP to clear.
- Finding: STP's 0-tabs and Safari's missing context were one cause: pluginkit had the extension registered from `DerivedData/`, not `~/Applications`. `pluginkit -a` on the installed `.appex` plus opening the app fixed STP at once; Safari then needed the extension re-ticked in Settings > Extensions.
- Finding: the iCloud Mail failure is per-tab, not per-site: icloud.com, apple.com and a fresh Mail tab all accept scripts; only the tab Safari restored refuses, and a reload does not clear it.

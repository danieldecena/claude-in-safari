# Status

## Confirmed working
- Bridge: stdio MCP + WebSocket on 127.0.0.1:18765; a bridge blocked on a busy port retries and takes over when the holder exits.
- read_page / find / computer / javascript reach iframes; bare iframes get a `[frame fN]` header; stale frameIds fail fast.
- read_page shows `autocomplete` / `passwordrules`; password values show length only.
- Private remote: github.com/danieldecena/claude-in-safari.

## Known broken
- iCloud Mail tab refuses scripts ("Could not execute script in tab"); likely per-site permission, uninvestigated.
- STP (Version/27.0): extension contexts connect but `tabs.query` returns 0 tabs, despite a LinkedIn tab open, website access Allow, and an STP restart. Safari 27.2 is unaffected.

## Next Up
- Nothing queued; see TASKS.md.

## Decision log
### 2026-09-29
- Decided: keep this project rather than switch to Safari 27's `safaridriver --mcp`. It runs an isolated automation session: `list_tabs` saw none of the user's tabs, iCloud Mail loaded signed out, and `evaluate_javascript` with `frameId` failed on a plain `<iframe src="inner.html">` ("Could not determine iframe src URL"). It is fine for clean-room testing; it cannot act in the logged-in browser.
- Decided: the Safari "autofill" doc is form-markup guidance, not an API. Implemented as read-only field hints in read_page; no filling of saved AutoFill data.
- Decided: the content.js guard literal must be bumped with `CIS_VERSION` (it was stuck at `< 6`, so updates never replaced handlers in open pages).
- Decided: repo is private because `CIS_TOKEN` is committed in `extension/background.js`.
- Finding: a Safari toggle does not always restart every extension context; context `bb428ddd` (started 14:19) survived three toggles running old background.js. Quit and reopen STP to clear.
- Finding: after reinstall, STP contexts see 0 tabs through grant, restart, and "Other Websites: Allow"; each STP launch also opens two contexts. Live checks verified on Safari 27.2 only.

# Status

## Confirmed working
- Bridge: stdio MCP + WebSocket on 127.0.0.1:18765. A second session's bridge joins the holder as a relay (`/relay`, token, no Origin) and both reach Safari; a relay rebinds when the holder exits. Verified by bridge tests only, not yet with two live sessions.
- read_page / find / computer / javascript reach iframes; bare iframes get a `[frame fN]` header; stale frameIds fail fast.
- read_page shows `autocomplete` / `passwordrules`; password values show length only.
- Private remote: github.com/danieldecena/claude-in-safari.
- Installed app is Developer ID signed and notarized (spctl: "Notarized Developer ID"); extension loads in Safari 27.2 and STP, and survives a Safari restart with "Allow unsigned extensions" off.
- Toolbar popup shows "Connected to bridge" and Reconnect reconnects (user-observed; Safari on Sidecar cannot be screen-captured).

## Known broken
- iCloud Mail tab refuses scripts ("Could not execute script in tab"); likely per-site permission, uninvestigated.
- STP (Version/27.0): extension contexts connect but `tabs.query` returns 0 tabs, despite a LinkedIn tab open, website access Allow, and an STP restart. Safari 27.2 is unaffected. After the notarized reinstall, STP context `d5624250` listed its Start Page tab; recheck with a real site before closing.

## Next Up
- Live check of the relay hub: two Claude sessions, `ping` + `tabs_context` from each, then quit the first and confirm the second still works. Needs the new bridge in both sessions (restart them).

## Decision log
### 2026-09-29
- Decided: second sessions share the bridge as relays instead of retrying the bind. The old retry left a new session with no Safari until the holder exited, and taking over the port meant killing another session's bridge. The relay path needs the token and no Origin header, so a web page can't use it. An older holder rejects relays, and the new bridge falls back to retrying.
- Decided: keep this project rather than switch to Safari 27's `safaridriver --mcp`. It runs an isolated automation session: `list_tabs` saw none of the user's tabs, iCloud Mail loaded signed out, and `evaluate_javascript` with `frameId` failed on a plain `<iframe src="inner.html">` ("Could not determine iframe src URL"). It is fine for clean-room testing; it cannot act in the logged-in browser.
- Decided: the Safari "autofill" doc is form-markup guidance, not an API. Implemented as read-only field hints in read_page; no filling of saved AutoFill data.
- Decided: the content.js guard literal must be bumped with `CIS_VERSION` (it was stuck at `< 6`, so updates never replaced handlers in open pages).
- Decided: repo is private because `CIS_TOKEN` is committed in `extension/background.js`.
- Finding: a Safari toggle does not always restart every extension context; context `bb428ddd` (started 14:19) survived three toggles running old background.js. Quit and reopen STP to clear.
- Finding: after reinstall, STP contexts see 0 tabs through grant, restart, and "Other Websites: Allow"; each STP launch also opens two contexts. Live checks verified on Safari 27.2 only.
- Decided: notarize via xcodebuild Release with Developer ID flags, then re-sign appex then app with their own entitlements minus `get-task-allow` (Apple rejects it). Do not use `CODE_SIGN_INJECT_BASE_ENTITLEMENTS=NO`: the sandbox comes from the `ENABLE_APP_SANDBOX` build setting, so it vanishes too, notarization still passes, and pluginkit silently never registers the extension. Credentials: keychain profile `notary`.

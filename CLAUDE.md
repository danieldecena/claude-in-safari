# Claude in Safari — working notes

Read README.md first for what this is and how the pieces connect.

## Rules that will bite you

- **pnpm, not npm** (bridge/). No Docker/colima. No paid services.
- **The manifest stays MV2.** MV3 service workers never load in Safari/STP and MV3
  event pages die after ~30s (slice 1 findings in
  `~/developer/_project-knowledge/plans/claude-in-safari.md`). Don't "modernize" it.
- **stdout belongs to MCP.** In `bridge/server.js`, every log line goes to stderr
  (use the `log` helper). One stray `console.log` corrupts the stdio transport.
- **No top-level bindings in `content.js`.** `tabs.executeScript` re-runs the file in
  the same isolated world; a top-level `const` throws a redeclaration SyntaxError on
  the second run. Everything lives inside the `window.__cis` version guard — bump
  `CIS_VERSION` when handlers change so already-open pages replace theirs.
- **`CIS_TOKEN` is defined once**, in `extension/background.js`; the bridge regex-parses
  it from that file at startup (`^const CIS_TOKEN = "(\w+)"`). Renaming or reformatting
  that line breaks the bridge's startup.
- **After touching `extension/`**, rebuild the app and reload the extension in Safari
  — the running extension is a copy inside the built `.appex`, not the source files.

## Build / run

```sh
xcodebuild -project "Claude in Safari/Claude in Safari.xcodeproj" \
  -scheme "Claude in Safari" -configuration Debug \
  -derivedDataPath DerivedData build
rm -rf "$HOME/Applications/Claude in Safari.app"   # ditto merges into an existing bundle, breaking the signature
ditto "DerivedData/Build/Products/Debug/Claude in Safari.app" \
  "$HOME/Applications/Claude in Safari.app"
cd bridge && pnpm spike   # connectivity check, no MCP
```

Signing: Apple Development cert (free personal team); ad-hoc signing does not work.

## Testing changes end to end

Register the bridge locally (`claude mcp add claude-in-safari -- node "$PWD/bridge/server.js"`)
and drive it from a fresh Claude Code session. `ping` proves the socket;
`tabs_context` proves a live extension context; `read_page` on example.com proves
content-script injection.

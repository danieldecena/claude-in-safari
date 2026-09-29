## Tasks
- [x] Act inside iframes: computer, find, javascript
- [x] Slice 1: extension stays reachable in background
- [x] Slice 2: tabs_context and navigate from Claude Code
- [x] Slice 3: get_page_text, read_page, find
- [x] Slice 4: computer click, type, key, scroll
- [x] Slice 5: screenshot a tab
- [x] Slice 6: javascript_tool and console capture
- [x] Slice 7: token, docs, Browser Lanes entry
- [x] Reliability pass and console fix
- [x] tab, read_network and computer set tools
- [x] Claude icon for the extension and app

<!-- resume-footer -->
---
Plan approved 2026-09-29 06:31.

Sessions start in "plan" (permissions.defaultMode in
~/.claude/settings.json). Bypass is reachable in the Shift+Tab cycle only
when launched via `cb` (--allow-dangerously-skip-permissions); `yolo`
(--dangerously-skip-permissions) starts in bypass outright.

Only if Claude Code actually closed:

    claude --resume 4930778c-85d1-4722-8e7c-037d8872415d

(`-c` resumes the most recent session; bare `--resume` opens a searchable picker.)
<!-- /resume-footer -->

## Tasks
- [ ] Safari speed T1: bench page tools, record baseline
- [ ] Safari speed T2: parallel subframes + ad-frame skip
- [ ] Safari speed T3: shadow DOM, checkVisibility, 8s budget
- [ ] Safari speed T4: async javascript (parked promise + poll)
- [x] Safari speed T5: batch tool in the bridge -- b240952
- [ ] Safari speed T6: recipes + skill upload copies

## Completed
- [x] Act inside iframes: computer, find, javascript
- [x] Fail fast on unknown javascript frameId — bff9b2c
- [x] Mask password field values in read_page and find
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
Plan approved 2026-09-29 12:17.

Sessions start in "plan" (permissions.defaultMode in
~/.claude/settings.json). Bypass is reachable in the Shift+Tab cycle only
when launched via `cb` (--allow-dangerously-skip-permissions); `yolo`
(--dangerously-skip-permissions) starts in bypass outright.

Only if Claude Code actually closed:

    claude --resume de6f14e0-3947-4c06-9f8b-254079c16e12

(`-c` resumes the most recent session; bare `--resume` opens a searchable picker.)
<!-- /resume-footer -->

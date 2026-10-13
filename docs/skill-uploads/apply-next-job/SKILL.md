---
name: "apply-next-job"
description: "Work Daniel's job-apply queue in chat with one plan box per job: queue posted links, screen and fill the next job, submit when he picks it or hand off, verify, log, sync Career Hub. Use for /apply-next-job, 'apply to next job', 'work the queue', 'submit for me', 'submit the next N'. Trigger even when run from the Claude Code terminal instead of the desktop app, or when he only asks whether a staged application went through."
---

# Apply Next Job (interactive)

Work in ~/developer/"job search" (quote the space). Use .venv/bin/python3, never bare python3. Start every shell command with `cd ~/developer/"job search" && unset JOB_SCOUT_DATA;`. Do not read STATUS*.md files and do not explore the repo.

This file is the core and the single owner of the rules below; a reference file never overrides it. References live in `docs/operations/apply-skill/` in that repo. Read one only when its row applies, before acting on that case:

| When | Read |
|---|---|
| Running in the Claude desktop app (`start_process`, `Claude_Browser__*` exist) | `desktop-app.md` |
| CLI run goes off the scripted path: window placement, resume file-sheet fallback, Safari bridge dropped, tool call shapes | `cli-safari.md` |
| Sign-in or create-account page, iCIMS, Workday | `accounts.md`, plus the `workday-apply-handoff` and `creating-a-profile` skills |
| Greenhouse form | `ats-greenhouse.md` |
| Rippling form | `ats-rippling.md` |
| LinkedIn Easy Apply | `ats-linkedin-easy-apply.md` |
| Ashby, Lever, Gem, Comeet, JobAdder, short links, embedded forms, custom portals, aggregators | `ats-other.md` |
| A form with questions beyond contact and resume; free-text answers; the claim bank | `fill-rules.md` |
| He posted links, a focus request, a stuck queue head, the skip command | `queue-and-screen.md` |
| Errors after submit, a Submitted / Check errors answer, verifying from Mail | `submit-verify.md` |
| Logging or the Career Hub sync fails or needs detail | `log-sync.md` |
| Demographic (EEO) answers | `private-eeo-notes.md` (local only) and `Resume/profile.json` `eeo` |

`incidents.md` is the dated history behind these rules. Do not read it during a run. If the synced copy of this file is ever replaced by an older version, restore it from `docs/operations/apply-skill/SKILL.core.md`.

## Hard rules
- **Submit authority.** LinkedIn Easy Apply: once the Review page reads back every answer correctly, click "Submit application" yourself. Any other ATS: click Submit only when he said so for that job, by picking `Fill + submit` on its plan box or typing "submit for me". "Submit the next N" covers exactly N jobs, one at a time. A pick never carries to another job. Guard every submit click on the readback.
- **His alone.** Never sign, tick a terms or consent box, or accept terms. Consents, attestations, e-signatures, pronouns, relocation and in-office commitments, and experience claims come only from a plan-box preview he saw and picked a fill option on. "Fill all" does not change this. Never read, type or paste a password, never fill a sign-in or signup form, and CAPTCHAs are his.
- Never overwrite a field value you did not set. Re-read the form and tell him.
- **Read it back.** Never report a field filled, a resume attached or a job submitted without reading the value, the file size, the confirmation line. A script's exit code alone is not the readback.
- **A confirmation is a line you can quote.** `scripts/apply_confirm.py "<url needle>"` reads the tab and never closes it; exit 0 prints `CONFIRMED | <url> | <the line it matched>`. Read that line: if it does not confirm this application, it is not a confirmation. Any other exit (`ERRORS`, `TAB_GONE`, `STILL_FORM`, `UNSURE`) is not one either.
- **Log only on a positive observation:** that `CONFIRMED` line, confirmation text you read in the tab, or a same-day receipt from `scripts/apply_mail_check.py`. His saying "submitted" is a reason to look, not an observation. Nothing observed: the job stays staged, and you say so.
- **Never claim what the record does not support.** Look the answer up in `Resume/profile.json` first (`skills.years_by_tool`, `standard_answers`). `[record gap]` marks a claim the record is silent on or that exceeds it, never one you did not look up. An under-claim is as wrong as an over-claim.
- Never edit assets/my_profile.json or anything under JobData/ (the exports `apply_log.sh` writes are the only exception). Never write SQL by hand (read-only scripts/jsql is the only exception). Never use pick.py. Never disclose salary history.

## Where things run
- **Browser.** CLI: regular Safari through `mcp__claude-in-safari__*`, one fresh minimized window per job. Desktop app: the in-app browser pane. Safari Technology Preview or Chrome only when he asks by name.
- **Resume.** CLI: you attach it with `~/bin/attach-resume-bg.sh` and check `size` equals `want`. Desktop app: the pane cannot upload, so attaching is the first item of his handoff.
- **LinkedIn "Follow <company>" box.** Leave it as LinkedIn set it and say which way it was.
- **Values** (phone, LinkedIn URL, salary figure, employer, tool years) come from `Resume/profile.json`, never from memory of an earlier form.

## Questions
- EVERY question goes through AskUserQuestion, never plain text and never a tool call written as text. Max 4 options, recommended first with "(Recommended)". One-line question; detail goes in the card or the `preview`.
- **One plan box per job.** A card (SendUserMessage in the desktop app, plain reply text in the CLI), then ONE single-select box. Question line: `<Company> · <short title>: <N> answers ready, <M> yours`. Options: `Fill + submit (Recommended)`, `Fill, I'll submit` (not offered for Easy Apply), `Skip`, plus `Stop` in a batch. The `preview` lists every field and its value, one per line, grouped Contact / Authorization / Claims / Consents / Essays / EEO, each demographic question marked required or optional. Mark `[yours]` plus a reason on a human-tier line, `[saved]` on one from the claim bank, `[record gap]` per the hard rule. Essays show the full draft. His pick of a fill option is his answer to every `[yours]` line shown. He edits by typing in Other: apply it and show the same box once more.
- **Timing.** Greenhouse: ask straight after `screen_posting.py`, before filling. Every other ATS: open the form, read it, fill contact and other record-backed fields, then ask.
- **A second box is allowed only** for a human-tier question that appears after filling (a field revealed by an earlier answer, a required question the first read could not see). One question, never a repeat of the first box.
- **No box at all:** a posting that is closed, Canada-only, or whose pay top is under the floor is skipped with one line in the next card. No "was it submitted?" box when the page confirms. No "next job?" box inside a counted batch.
- Never send the same list twice (card, box, handoff). A handoff is only what is left for him: the fields he must touch with exact option text, and one line of red flags.
- Don't ask what you can look up (the tab's URL, whether a field is empty, whether a row is `applied`). Check, then say what you found.
- He typed instead of picking: a value, an instruction or the question text itself means do that (draft the essay, apply the value), then show the same box again. An ambiguous word ("ok", "fix", "answer") or a non-answer (a pasted URL) while a job is staged: check every staged form yourself, fix what is safe, report in two lines, and re-ask once with clear options. A dismissed box, or "[No preference]" to a submitted question, means Not yet: leave it staged and move on.
- "Remember these answers": save them through the claim bank (`fill-rules.md`); if his final on-screen choice differs from what you filled, the on-screen choice wins.
- A tool he names that is not in the session: ToolSearch once, say so in one line if absent, and carry on.

## Screening targets
- **Pay:** $100K base floor, target $140K (desired-salary answers: `Resume/profile.json` `compensation`). A top under the floor is a skip; a range straddling it is a note. Hourly converts at x2080. With regional tiers, use the US tier. "Not on LinkedIn" is not "not listed": check the company posting or the form first.
- **Location:** LA metro in any mode. SF Bay Area and Seattle metro hybrid or remote only. Anywhere else fully remote only. A Bay Area or Seattle city with no remote/hybrid wording counts as onsite. "United States" usually means remote: say "looks remote". He is not authorized outside the US: Canada-only is a skip, any other non-US role a flag.
- **Years:** he has 7 (4 in marketing automation). Flag entry level, director+, asks above 7, required people-management years, and years in a named niche.
- **Tool fit:** flag a hard requirement for a tool not in `years_by_tool`, and any required certification.
- **Freshness:** flag postings over a week old and contract/temp roles.
- A flag other than the three no-box skips makes `Skip` the recommended option with the top reason in its description. His fill pick still wins; do not argue twice.

## Card
```
**<Company>**
<Title> · <Easy Apply | external apply | Workday>

- ✓/✗ Posted <age>
- ✓/✗ Location: <place, onsite/hybrid/remote>
- ✓/✗ Pay: <range, or "not listed">
- ✓/✗ Years: asks <N>, you have 7
- ✓/✗ Fit: <one short clause>
```
The card carries screening facts only; the plan box carries the answers.

## The run
Steps are named, and reference files use these names.
1. **Preflight.** ArtifactData `list` collections `jobs` and `answers` of Career Hub (https://claude.ai/artifact/1Kzkp5sBqBv4Fb1bKNDQWw) with `out_dir=<scratchpad>/page`, then `scripts/apply_preflight.sh <scratchpad>/page`. It applies his page inputs, lists forms staged in an earlier chat with their DB status, and prints the next job (`null` = queue empty). `ACKS` printed: one ArtifactData `batch` of `update`s, one per `acks.json` entry, using its `collection`, `doc_id` and `{synced_at}`. A staged form still open: ask about it first (Submitted / Check errors / Not yet / Passed). A row already `applied`: tick its TASKS.md line, no box. Links he posted are queued first (`queue-and-screen.md`).
2. **Screen.** `.venv/bin/python3 scripts/screen_posting.py "<url>" --answers <scratchpad>/answers.json`: card facts, FLAG lines, the ATS, the form URL and (Greenhouse) every question with options, plus `HUMAN` lines for the box and `REVIEW` lines for you to decide. `closed: YES` means skip. A value printed `unknown` is unknown, not absent.
3. **Card and plan box** (Questions above).
4. **Fill.** `~/bin/safari-bg-window.sh "<form url>"` opens a new minimized window for this job only; never reuse a window or `navigate` an old tab. Greenhouse: `scripts/gh_fill.py` per `ats-greenhouse.md`. Any other ATS: its reference file. Attach the resume after filling, or first where the form parses it (`ats-rippling.md`).
5. **Read back.** Every required field is verified or listed as his.
6. **Present and submit.** `scripts/safari_present.sh "<url needle>"` un-minimizes onto the right third of the main display; a tab count above 1 means his own tabs share the window. `Fill + submit`: one last readback, click Submit, then `.venv/bin/python3 scripts/apply_confirm.py "<url needle>" --wait 20 --form-seen`. `Fill, I'll submit`: start the same command with `--wait 1800` and `run_in_background`, hand off his fields, and ask one box (Submitted / Check errors / Not yet / Passed) only if it has not reported. A field only he can set (a captcha, a typeahead that will not select) stops that job: leave it staged with the watch running, say so, continue the batch.
7. **Verify, log, sync, close.** With a positive observation (Hard rules): `scripts/apply_log.sh "<linkedin url>" "<notes quoting the confirmation line or the receipt subject>"` must print `applied: <url>`, `COUNTS submitted N queued M` and a db row reading `applied`. ArtifactData `list` collection `snapshot` with an `out_dir`; the new submitted count must be >= the current one (if it shrank, stop and report). One ArtifactData `batch`: set `snapshot/latest` from `JobData/exports/submitted-snapshot.json` and `snapshot/queue` from `JobData/exports/queue-snapshot.json`, each with `if_version`. Then `scripts/apply_confirm.py --close "<url needle>"`.
8. **Next.** One status line (job, result, counts). Inside "submit the next N", go straight on. Otherwise one box: Next job / Stop here. When the queue head is a job still staged, take the next with `scripts/apply_next.py --skip <staged> -n 3`.

## When a step fails
- `apply_preflight.sh` prints `[x]` or `ERROR`: report the line and stop. A `DRIFT` line means this file was replaced: run the `cp` it prints and tell him. `scripts/apply_skill_doctor.sh` lists every dependency.
- `screen_posting.py` exits 1: read the posting in the browser and say the script failed; never screen from memory. `ats: unknown`: read the Apply link in the browser (`ats-other.md`).
- `gh_fill.py` exit 4: a field was `kept` because it held a value you did not set; leave it and name it in the handoff. Exit 2: read each `error` field, fix the JSON, rerun (safe). Exit 3: tab gone, wrong needle, or `MULTITAB` (`ats-greenhouse.md`).
- `attach-resume-bg.sh` prints a `size` different from `want`, or `NOTAB`: not attached. Use the file-sheet fallback in `cli-safari.md` or hand it to him.
- `apply_confirm.py` exit 2: form errors (`submit-verify.md`). 3: tab missing or several match. 4: still the form. 5: a bare "Thank you" on a page whose form this run never saw; read the page yourself. For 3, 4 and 5 try `scripts/apply_mail_check.py "<Company>" --wait 5` before saying it is unconfirmed.
- `apply_log.sh` prints `ERROR`: nothing after that point ran; report it and do not sync. ArtifactData `version_mismatch`: list again, redo the count check, retry once.
- A tool this file names is missing: say so in one line and use the mapped tool from `cli-safari.md` or `desktop-app.md`; never skip the readback.

## Safari (claude-in-safari)

When Daniel asks for Safari, use the `mcp__claude-in-safari__*` tools. Tool map and recipes:
`~/Developer/safari/claude-in-safari/docs/skill-recipes.md`. In short: `batch` for a whole form page
(one call, stops at the first failed step), `javascript` with `await` for click-then-read
loops (use `return`), one `screenshot` before reading a modal in a background tab, no file
upload (Daniel attaches the resume), and close the job tab once submission is verified.

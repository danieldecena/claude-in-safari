---
name: "linkedin-job-list"
description: "List every job on pages 1-3 of a LinkedIn job search or recommendations link for Daniel, deduped, grouped by role type and sorted by location then pay, with a one-line blurb under each role. Use for 'list all jobs on this page', 'what's on pages 1-3', 'clean up/regroup/resort this list', 'get the ATS link for job N', or before an apply sweep."
---

# LinkedIn Job List

Turn a LinkedIn jobs link into a clean, grouped list Daniel can scan in one pass. This skill only reads LinkedIn: it never clicks Apply, Save or Easy Apply *button submissions* — but see "Resolving an ATS link" below for the one safe exception (reading, not submitting, the Apply button's destination). To actually apply, hand off to `apply-next-job` (queue the picks) or `linkedin-apply-sweep`.

Daniel often keeps working while you're mid-extraction — a tangential question, an unrelated ask, a formatting tweak, or a correction ("filter should be past week", "there's a classic and an AI search"). Answer or apply those inline without losing your place in the scrape; don't make him repeat the original request.

## 0. The list comes from his link, exactly

- Scrape the page he gave you as he sees it. **Never substitute your own keyword searches** and present the result as his list. He needs to know every queued job came from his link (2026-09-28).
- If the link is too broad to be useful (no keywords, e.g. "past week + experience level" = 900K results), say so in one line and ask with AskUserQuestion: scrape it as-is / add his preference keywords / he'll paste a new link. Don't decide for him.
- Default time filter is **past week** (`f_TPR=r604800`) unless his link sets another one.
- No link given ("run it on the built-in browser")? Ask with AskUserQuestion which page: his preferences feed (recommended), the last link, or LinkedIn's top picks.

## 1. Open the page (built-in browser)

- Use the built-in browser (`Claude_Browser__*`) by default. It's signed in to LinkedIn and keeps working while the pane is hidden. Use Claude in Chrome only if Daniel asks for it: a background Chrome tab stops rendering LinkedIn's cards and throttles timers, so scrapes there time out.
- Load the tools in one ToolSearch call on the `mcp__remote-devices__Claude_Browser__` prefix (or `mcp__Claude_Browser__` in the desktop app).
- Work in your own tab (`preview_start` with the URL), never in one of his. Close it (`tabs_close`) when done.
- Widen the viewport with `resize_window` 1440x900 for the search page, and reset with `preset: "desktop"` as soon as you finish reading.
- Name the surface in one line above the list (header text + result count).
- **Claude Code CLI (no built-in browser):** fall back to Claude in Safari (`mcp__claude-in-safari__*`: navigate, javascript, tab), not Chrome. `navigate` without a `tabId` opens his link in a new background tab; close it with `tab` action `close` when the three pages are read. There is no `resize_window`, and the AI-search read does not need one.

### Two search surfaces

- **Classic search** `/jobs/search/?keywords=...&geoId=...&f_TPR=r604800` — real filters (`f_TPR` date, `f_WT=2` remote, `f_E` experience, `f_AL=true` Easy Apply). One `geoId` per URL: California `102095887`, United States `103644278`. Keywords take boolean OR with quoted phrases.
- **AI search** `/jobs/search-results/?keywords=<natural language>&geoId=<comma list>` — this is where his **preferences feed** opens (the "Show all" under "Jobs based on your preferences" on linkedin.com/jobs/). It has no filter pills: put the filter in the query, e.g. append ", posted in the past week" to the keywords. The page confirms it understood ("past week in …").
- The old `origin=PREFERENCES_LANDING` classic URL now errors ("problem loading your filters") and falls back to generic top picks. Don't use it.
- **Preferences feed = both, merged** (Daniel's pick, 2026-09-28): the AI search with his saved query + past week, plus the classic equivalent: his preference titles as a quoted OR list, past week, run once for California and once for United States + `f_WT=2`. Get his saved query and geos by reading the preferences "Show all" link on linkedin.com/jobs/ (keywords + geoId params only).

## 2. Read pages 1–3

Never use page-wide scans (`querySelectorAll('*')` with getComputedStyle, or scrolling "the element with the most Promoted"). On LinkedIn they freeze the renderer and time out at 45 s.

**Classic search:** every card is an `li[data-occludable-job-id]`. The id attribute is always present, but card text only renders for cards that have been on screen, and a hidden pane renders only the first ~7. So collect ids, not text. One `javascript_tool` call can do all three pages:

```js
const ids=async()=>{await new Promise(r=>setTimeout(r,3000)); return [...document.querySelectorAll('li[data-occludable-job-id]')].map(l=>l.getAttribute('data-occludable-job-id'));};
const out={hdr:document.querySelector('.jobs-search-results-list__subtitle')?.innerText, p1:(await ids()).join(',')};
for(const N of [2,3]){const b=[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='Page '+N); if(!b) break; b.click(); out['p'+N]=(await ids()).join(',');} out
```

Then fill in each id's details with `.venv/bin/python3 scripts/linkedin_guest_fetch.py <ids>` (run in `~/developer/"job search"`; ids as arguments or one per line on stdin). It reads the public guest endpoint `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/<id>`, which works no matter what the pane shows, and prints one JSON line per id: title, company, location, posted, pay (with /hr), closed. It uses 2 workers and backs off on 429; an id that never answers prints `error` and is unknown, never "no pay listed". Verified 2026-10-05: 110 ids, no failures. Search the output for `"error"` before trusting a count.

- **Rate limit from the Mac (2026-10-02):** a 16-worker pool run from his own shell got HTTP 429 on 43 of 75 ids, and a 429 body has no `topcard__title`, so an unchecked parse reads it as a job with no title, no pay and not closed. That is why the script uses 2 workers (backoff 1.5 s plus 4 s per attempt) and reports failures as `error`. Do not hand-roll a pool again.
- **Fetch only what the AI search did not show (2026-10-05):** the AI cards already carry location with work type, pay and age, so run the script only on classic ids that are not in the AI list (110 of 185 that day). The guest location has no (Remote)/(Hybrid) parenthetical, so a classic-only Bay Area or Southern California role is tagged "(work type unlisted)", not dropped and not assumed remote.

**AI search:** cards have no job ids or links in the DOM. Each card has a `Dismiss <title> job` button; walk up from it to the card and read its text, then click the "2" and "3" page buttons:

```js
const read=()=>[...document.querySelectorAll('button')].filter(b=>/^Dismiss .* job$/.test(b.getAttribute('aria-label')||b.innerText.trim())).map(b=>{let c=b; for(let i=0;i<6;i++){c=c.parentElement; if(/Posted|ago|benefit|\$/.test(c.innerText) && c.innerText.length>60) break;} return c.innerText.replace(/\n+/g,' | ').replace(/\|[^|]*(alumni|alum|connection)[^|]*/g,'').slice(0,200);});
const out={p1:read()}; for(const N of ['2','3']){const b=[...document.querySelectorAll('button')].find(b=>b.innerText.trim()===N); if(!b) break; b.click(); await new Promise(r=>setTimeout(r,3500)); out['p'+N]=read();} out
```

AI-only jobs go in the list without a link, tagged (AI). Resolve a link only when he picks that number.

- **Job ids from AI-search cards (CLI/Safari, 2026-10-01):** the card has no link, but a wrapper has `componentkey="job-card-component-ref-<jobId>"`. Walk up from each `Dismiss <title> job` button until a parent's `componentkey` starts with `job-card-component-ref-` and take the id. That gives all 25 ids on a page in one synchronous `javascript` call, with no clicking and no per-pick probe. Then the posting is `https://www.linkedin.com/jobs/view/<id>`. `javascript` in the Safari bridge is synchronous only (no `await`), so do not use the click-and-sleep page loop there; read one page per call.
- **Timing in the Safari bridge (2026-10-05):** the first read after a page click came back empty (0 cards) once, and classic pages need about 4 s. Put `sleep 4` in a Bash call between the click and the read, and treat an empty read as "not rendered yet", never as "no results". Classic page buttons are found by `aria-label` "Page N"; AI page buttons by `innerText` "N".
- **Pages 2 and 3 in the Safari bridge (verified 2026-10-02, 75 cards):** click the page button in one `javascript` call (`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='2').click()`), then read the cards in the next call. The tool round trip is the wait, so no sleep is needed. Compare the first id against the previous page's first id before trusting the read: an unchanged id means the page had not swapped yet, so read again. Return `id :: card text` per card in the same call so work type and Easy Apply come with the id.
- In card text the title can appear twice (once with "(Verified job)"). Then company, location with work type, optional pay, and tags (Viewed, Easy Apply, Posted …).
- Read the work-type parenthetical: "Austin, TX (Remote)" is remote. The guest endpoint's location has no parenthetical, so take work type from the card text when you have it.
- **Past week on the AI search (2026-10-06):** a link with `f_TPR=r604800` still opens the AI surface, which has no date filter. Append ", posted in the past week" to its `keywords` instead (the page confirms it). Pages 1 to 3 then read 75 cards with ids; page 2 and 3 clicks needed `sleep 4` before the read.

## 3. Clean the data

- **Dedupe** across pages and across surfaces. Same company + title in several cities → one line listing the cities. Mark "(both searches)" when the classic and AI searches both found it. Flag agency listings (Jobgether, RevOps Report, TalentHop, Aquent, 24 Seven, Ladders, staffing firms).
- **Normalize.** "Sr." for Senior. Pay as $115K–$135K; hourly as $/hr; keep non-USD pay in its own currency. Work type lowercase: remote, hybrid, on-site.
- **Leave out, with a count** (state what was left out in the header line):
  - off-target roles: product/brand/content/social/paid-media/affiliate marketing, sales, engineering, non-marketing;
  - director+ and associate/coordinator/analyst/intern levels;
  - pay ceilings under $100K (hourly x2080; Daniel lowered the floor from $130K on 2026-10-01);
  - locations outside his rules: on-site/hybrid anywhere except the LA metro (not Orange County), SF Bay Area, NYC or Vancouver BC; Bay Area on-site-only roles.
  This list is deliberately wider than the apply skill's screening targets (NYC, Vancouver and Seattle on-site stay listed, and "old" here means 3 months, not a week): the list shows him the market, and the apply skill's card and plan box are where a job is skipped.
- **Flag, don't drop:** postings older than 3 months (old), non-USD pay, contract/hourly, and anything already in his pipeline. Check with `scripts/jsql "SELECT regexp_replace(url,'.*/view/(\d+).*','\1'), status FROM jobs WHERE url LIKE '%/jobs/view/%' AND status NOT IN ('scouted')"` and tag (applied), (queued) or (in pipeline).
- **One-line blurb** (under ~12 words) under each role: what the role does and who the company is.

## 4. Group, then sort

Group by role type, in this order:

1. **Marketing Ops & MarTech**: marketing ops, marketing systems and automation, MarTech, campaign ops, ABM ops.
2. **RevOps & GTM Ops**: revenue ops, GTM systems, sales ops.
3. **Lifecycle, CRM & Retention**: lifecycle, CRM, email/SMS, retention, engagement. This includes "Growth Marketing Manager, Lifecycle".
4. **Growth & other**: general growth and anything that fits none of the above.

Seattle on-site and hybrid roles stay in the list under the Seattle subhead (Daniel, 2026-10-02); the leave-out rule for other cities does not apply to them. A "Canada (Remote)" card is Canada-only: merge it into its United States twin as (also Canada), or leave it out when there is no twin.

Within each group, sort by location: remote → LA / SoCal → Seattle → Bay Area → elsewhere. Inside each location, sort by pay, highest first, with no listed pay last.

**Bay Area** means SF, San Mateo, Santa Clara, Sunnyvale, Fremont, Palo Alto, Mountain View, Menlo Park, Oakland and San Jose.

If he asks for a different grouping, regroup the same data without re-reading LinkedIn: by location, by pay band (≥$150K, $120–150K, <$120K, not listed), or Easy Apply first.

## 5. Output format

Keep it clean and scannable, and keep the markup light. No tables and no code blocks.

```
## Marketing Ops & MarTech

### Remote
1. **InStride Health** — Sr. Manager, Marketing Operations · $134K–$149K
   Runs marketing ops at a pediatric anxiety-care company.
2. **Teamworks** — Sr. Marketing Operations Manager · $125K–$150K (both searches)
   Marketing ops at a sports-team operations software company.
```

- Company bold, em dash, title. Then only what adds information: location (when the subheading doesn't say it), pay, and tags in plain parentheses: (Easy Apply), (old), (applied), (agency listing), (AI), (both searches), (also <city>).
- `##` group headers, `###` location subheads.
- Number continuously across groups so he can say "queue 3, 7, 12."
- In chat, show the top picks (about 10–12 strongest fits with pay listed) rather than all of them, and send the full list as the saved file.
- Finish with one line of counts: total unique jobs read, how many listed, remote, with pay, Easy Apply, and how many were left out (2026-10-05: 185 read, 76 listed, 33 remote, 30 with pay, 4 Easy Apply). Tag a job Daniel's own apply run skipped as "(skipped: <reason>)" instead of dropping it, so a re-scrape does not re-offer it unexplained.
- A search surface that returns hundreds of results is normal for the classic quoted-title search (687 to 921 results, 3 pages read = 75): say "top 75 of N" in the header line so he knows the list is a window, not the whole search.
- Then one AskUserQuestion box for the next step: queue his picks (he types numbers via Other) / queue the top picks / regroup / stop. Queued picks go through "Queue his links" in `docs/operations/apply-skill/queue-and-screen.md` with reason "Daniel picked from <file name>".
- **"Queue all" (Daniel, 2026-10-02: "queue all, I'll decide if skipped on the /apply skill"):** send every listed role that is not applied, queued or in the pipeline through the same queueing step, without pins (pinning all of them would bury the jobs he queued earlier). The ingest script's own gate then screens some out and prints only counts (`screened out: location=6 pay<100K=4 duplicate=5`). Compare the `queued` count before and after against the number sent; a gap means screened jobs. For each one, call `utils.location_gate.allowed`, `utils.pay_floor.passes` and look up the company + title pair in `jobs` to learn which gate fired. Re-send with `--no-gate` the ones that were screened on location (work type unlisted, or Seattle) or as a duplicate of a `scouted` row. The pay gate uses his $100K floor (`utils/pay_floor.py`, lowered from $130K on 2026-10-02), so a pay-screened job really is under the floor: leave it out and say so. Never re-send a duplicate whose twin is `applied`, `rejected` or `needs_manual`: that is a repost of a job he already handled. Then write the queue snapshot and sync Career Hub `snapshot/queue` (`docs/operations/apply-skill/log-sync.md`), and read the doc back to confirm the item count.
  - **Worked example (2026-10-06):** 22 sent, queued 64 -> 82 (+18). Signet (location gate: "Remote," in the title, Irving TX) and Eightfold (twin only `scouted`) went back with `--no-gate` (84). Homebase and Jobgether were left out: each twin was `applied`. Find the screened ids by listing the sent ids' statuses in one `scripts/jsql` query and diffing against the sent list. Do not parse the `jsql` output by splitting on whitespace: a split-based lookup printed "NONE" for rows that were queued.
- **"Sort the queue by posted in the past week" (Daniel, 2026-10-06):** the queue has no posted-date column and orders pins first, oldest pin first. (1) `scripts/linkedin_guest_fetch.py` over every queued id (82 ids, 40 s, 0 errors) gives `posted`. (2) Past week = "N hours ago" or "N days ago" and not closed; "1 week ago" is outside it. (3) Rebuild the pin list with `utils.page_inputs.set_pinned`: unpin then re-pin the fresh jobs freshest first, then unpin and re-pin the old pins so they follow. Just adding pins does not work: the 51 earlier pins stay ahead and the old job stays on top. (4) Check `db.get_queued_jobs()[:N]` are all fresh, write the queue snapshot and sync `snapshot/queue`.

## Resolving an ATS link for a job

Default to resolving only the numbers he names. For a job with an id, open `https://www.linkedin.com/jobs/view/<id>/` in the built-in browser and run the Apply-link reader from `docs/operations/apply-skill/ats-other.md` ("Find the real form"). It reads the Apply button's destination and returns origin + path (the LinkedIn URL itself for a button with no link, such as Easy Apply) or `none` when the page has no Apply button; nothing is clicked, no tab opens, nothing is submitted. Pay and the closed flag come from `scripts/linkedin_guest_fetch.py`. Batch up to 6 jobs per browser_batch (navigate + probe each). Return only origin + pathname; raw query strings get blocked in tool output. A generic careers page (company.com/careers, /apply) isn't a form link; say so.

For an AI-only job with no id, click its card in the AI search results, read `currentJobId` from the tab URL, then probe that id.

## Save it

Write the list, with LinkedIn job URLs when you have them, to `~/developer/job search/JobData/linkedin-lists/<YYYY-MM-DD>-<short-name>.md` (write it in the session outputs folder, then device_commit_files to that path; in the Claude Code CLI write straight to that path, which git ignores, so there is nothing to commit). If he asks for it "in session" or as a download, deliver it as a file instead. Tell him the file name either way. Later runs and `apply-next-job` reuse the saved file without re-scraping.

## Safari (claude-in-safari)

When Daniel asks for Safari, use the `mcp__claude-in-safari__*` tools. Tool map and recipes:
`~/Developer/safari/claude-in-safari/docs/skill-recipes.md`. In short: `batch` for a whole form page
(one call, stops at the first failed step), `javascript` with `await` for click-then-read
loops (use `return`), one `screenshot` before reading a modal in a background tab, no file
upload (Daniel attaches the resume), and close the job tab once submission is verified.

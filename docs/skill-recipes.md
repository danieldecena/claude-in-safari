# Safari recipes for the job-apply skills

Used when Daniel picks Safari (claude-in-safari) instead of the in-app browser.

## Tool map

| In-app browser | claude-in-safari |
|---|---|
| tabs_context / tabs_create + navigate / preview_start | tabs_context / navigate (no tabId = new background tab) |
| get_page_text, read_page, find | same names |
| computer left_click / type / key | computer action click / type / key (by ref) |
| form_input | computer action set |
| javascript_tool | javascript (await allowed; use `return`) |
| browser_batch | batch |
| tabs_close | tab action close |
| file upload | not available: Daniel attaches the resume |

## Rules

- Take one `screenshot` before reading a modal in a background tab: it activates the tab so the modal renders.
- LinkedIn's Easy Apply modal is in a shadow root: `find`/`read_page` see it (content.js v9+); `document.querySelector` from `javascript` does not, so walk `el.shadowRoot` there.
- `javascript` code that uses `await` runs as an async function with a 12 s limit; the result is what you `return`. Sync code still returns its last expression.
- `batch` runs up to 30 steps on one tab and stops at the first failed step (pass `stopOnError: false` to keep going). `wait` steps cap at 5000 ms. No `screenshot` inside a batch.
- Close the job's tab once submission is verified.

## Workday page in one call

Application Questions with Yes/No dropdowns: `find` "Select One" once to get refs, then one `batch`:
click ref, key Y (or N), key Enter, for each dropdown, then a `javascript` readback
`[...document.querySelectorAll('main button[aria-haspopup=listbox]')].map(b=>b.innerText)`.

Save and Continue: `batch` [computer click <save ref>, wait 5000, javascript step readback
`document.querySelector('main').innerText.match(/current step \d of \d/i)?.[0]`].

## LinkedIn AI search: 3 pages and job ids in one call

The cards carry no ids; clicking a card sets `currentJobId` in the URL. One `javascript`:
for each target card, click it, `await` 800 ms, read `location.href.match(/currentJobId=(\d+)/)[1]`,
and `return` the list. Page buttons: click "2"/"3", `await` 3500 ms, read the cards.

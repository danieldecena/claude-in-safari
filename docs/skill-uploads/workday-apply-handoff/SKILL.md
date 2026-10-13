---
name: "workday-apply-handoff"
description: "Handle a Workday-hosted job application (*.myworkdayjobs.com) inside the apply-next-job flow: hand off account creation/login to Daniel, then fill the rest from his profile and stop before submit."
---

# Workday Apply Handoff

Workday postings (`*.myworkdayjobs.com`) always need an account. Creating that account (email and password alike) and signing in are Daniel's to do by hand. Claude never types into an account-creation or sign-in form, whether the value comes from chat, profile.json, an env variable, a password CLI (ipass, apw, `security`) or anywhere else, in any browser, and no skill changes that. Running this skill again does not get past that step; say so plainly if Daniel expects it to. Everything else, including the resume upload where the browser allows it, Claude does.

Called from `apply-next-job` step 4 whenever the real form URL is on a Workday domain. Don't run `run.py --url` or `fill_frontmost.py` on Workday; they don't stop at the login wall.

## 1. Screen first
Workday postings go through the normal screening hook (apply-next-job step 2, job-search.md 4.1) before anything opens. Don't open a job that would get skipped anyway.

## 2. Open it in the in-app browser
Daniel's rule (2026-09-29, job-search.md 4.4): all browser work, Workday included, runs in the in-app built-in browser (`Claude_Browser__*`). Use Claude in Chrome only when Daniel asks for it for that application (for example, he wants his Chrome password manager for the sign-in). Once an application is started in one browser, finish it there.

The fill/skip box during screening already covers whether to open it. Then:
- Open the apply URL with preview_start (or reuse the tab); the `/apply` path usually lands on `.../apply/autofillWithResume`.
- Cookie banner: Decline.
- If a "Start Your Application" page shows, click **Autofill with Resume**. It lands on **Create Account** (or Sign In if he has an account with this employer). Stop. Don't type in any field there and don't click Create Account or Sign In.

## 3. Account hook, then hand off the account step only
Before the handoff, invoke the `creating-a-profile` skill (Daniel, 2026-09-29: whenever an account has to be created, hook /creating-a-profile). Use it to check the profile's `accounts.workday.<company_key>` record, run the usernames-only account check (`make ipass-check URL=<url> COMPANY="<co>"`, job-search.md 4.6), and decide whether the handoff says "Sign in as <username>" or "Create an account". If the check returns `unauthed` (ipass can't authorize on this macOS), say so and give both paths.

Then one short nested checklist:
- Create the account or sign in · 1 min
  Each employer's Workday is a separate account.
  - Email: danieldecena@icloud.com
  - Password: click the field and take the password manager's suggested strong password.
  - Consent checkbox under the form: his call.
  - Click the verification email if one arrives.
- Say go.
Name the tab, then one AskUserQuestion box (Signed in, go / Not yet / Skip). Wait for his reply once; don't poll. If he pastes a password, asks Claude to type one, or suggests a tool to fetch one, decline in one line and repeat that it's his step.

After he is through, record the account (`scripts/ipass_accounts.py "<url>" --company "<co>" --record`) and remind him he can save that employer's password with `make workday-pw COMPANY="<employer>"`.

## 4. Verify before touching anything
When he says go, screenshot the tab. Progress dots appear on Create Account too, so they prove nothing. He's through when his email shows top right and the page is Autofill with Resume or later.
- Still on Create Account: he probably did it in another tab. Re-navigate this tab to the same `.../apply/autofillWithResume` URL; the new session carries over. If it's still Create Account, ask where he did it with one AskUserQuestion box.

## 5. Attach the resume
- **In-app browser (default):** it can't upload files. Name the field (the resume drop zone / "Select files") and Daniel attaches `Resume/Daniel_Decena_Resume.pdf` himself in the pane; wait for his go, then confirm "Successfully Uploaded!" and Continue.
- **Claude in Chrome (only if he chose Chrome for this application):** `device_stage_files` on `/Users/home/developer/job search/Resume/Daniel_Decena_Resume.pdf`, `find` the file input, then `mcp__claude-in-chrome__file_upload` with the staged path (`/mnt/user-data/uploads/job search/Resume/Daniel_Decena_Resume.pdf`). Confirm "Successfully Uploaded!", then Continue.

## 6. Fill from the profile
Fill from `Resume/profile.json` + job-search.md sections 5–8 with the confidence ladder (see `creating-a-profile`). Any field the profile doesn't cover goes to `Resume/answers_unmatched.json` and is named in the handoff.

Workday mechanics (learned on Visa):
- **Save and Continue** takes 5–8 seconds. Wait and re-read the "current step N of 7" line before assuming it failed.
- **Select One dropdowns:** mouse clicks on options land on the wrong item. Click the button, type the option text, press Return, then verify every answer with JS: `[...document.querySelectorAll('main button[aria-haspopup=listbox]')].map(b=>b.innerText)`.
- **Search prompts** (How Did You Hear, School, Field of Study, Skills): click, type, Return, then read the listbox and confirm the chip.
- **Dates** are spinbuttons: click Month, type MM; click Year, type YYYY.
- **Textareas:** click, cmd+a, type.

The resume parser is unreliable. Check and fix every field it touched:
- Names: it put "Angeles" (from Los Angeles) in Last Name and the last name in Middle Name. Set First Daniel, Last Decena, Middle blank.
- Work history: it merged and dropped jobs. Rebuild all five from job-search.md section 8, with the resume bullets as Role Description:
  - Ad Ops Specialist · DoorDash (contract via Sage Group) · Los Angeles, CA · 08/2025–05/2026
  - Growth Marketing Specialist · Field Nation · Seattle, WA · 12/2023–07/2024
  - Marketing Automation Specialist · PitchBook Data · Seattle, WA · 08/2021–08/2023
  - Marketing Specialist · Grange Insurance · Seattle, WA · 12/2019–01/2021
  - Product Marketing Associate · Leafly · Seattle, WA · 08/2019–11/2019
- Education: University of Washington; Degree "Bachelor's or Equivalent First-Degree"; 2014–2019. Workday lists often lack plain "Communications": leave the closest match and flag it in the handoff rather than guessing.
- Skills: remove any suggested skill not on his record (Visa's parser added Sage Accounting Software, Database Administration, Microsoft Windows).
- Address, phone, How Did You Hear (LinkedIn), "worked here before" (No): profile.json.

Application questions: identity verification Yes, eligible to work Yes, sponsorship No, base salary 140000, military spouse No, National Guard/Reserves No. SMS consent and AI-review opt-in/out use his saved choices (SMS Opt-Out, AI matching Opt-In); list them in the handoff.

Employer address, supervisor name, "may we contact": human tier, leave blank and list them.

## 7. Stop at Voluntary Disclosures
Stop when the form reaches the Voluntary Disclosures / Self Identify steps (EEO questions, a privacy acknowledgment, the disability form and e-signature). All of that is his. Hand off with a nested checklist: those steps, any flagged fields (e.g. Field of Study), and "Review, then submit". Name the tab, and mention the draft is saved on Workday: he can also finish in any browser from `<tenant>.myworkdayjobs.com/en-US/<Tenant>/userHome` → Continue Application. Then a Submitted / Check errors / Not yet / Passed box. Never click Submit, accept terms or e-sign.

## 8. Log it
On Submitted, run apply-next-job step 6 (`record_applied.py`, `render_submitted.py`) and step 7 (sync Career Hub), same as any other posting.

## Safari (claude-in-safari)

When Daniel asks for Safari, use the `mcp__claude-in-safari__*` tools. Tool map and recipes:
`~/Developer/safari/claude-in-safari/docs/skill-recipes.md`. In short: `batch` for a whole form page
(one call, stops at the first failed step), `javascript` with `await` for click-then-read
loops (use `return`), one `screenshot` before reading a modal in a background tab, no file
upload (Daniel attaches the resume), and close the job tab once submission is verified.

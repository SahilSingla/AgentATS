# Healthy18 ATS — Setup Guide

Two ways to install. Path A is for anyone comfortable copy-pasting text. Path B is the zero-effort route once a template is published.

---

## Path A — Install from this repository (~10 minutes, no coding)

### 1. Create the Apps Script project

1. Sign in to the Google account that should *own* the ATS (all data will live in this account).
2. Go to **[script.google.com](https://script.google.com)** and click **New project**.
3. Name it (top-left) — e.g. `Healthy18 ATS`.

### 2. Paste the files

For each file below: in the editor's left sidebar click **+** next to *Files*, pick the right type, name it **exactly** as shown, then paste the full contents from this repo and save (Ctrl/Cmd-S).

| File in this repo | Type to create | Name it |
|---|---|---|
| `Code.gs` | Script | `Code` |
| `AiGateway.gs` | Script | `AiGateway` |
| `TalentRubric.gs` | Script | `TalentRubric` |
| `Index.html` | HTML | `Index` |
| `Apply.html` | HTML | `Apply` |
| `Source.html` | HTML | `Source` |
| `Agency.html` | HTML | `Agency` |
| `SelfSchedule.html` | HTML | `SelfSchedule` |

(`Code.gs` already exists in a new project — just replace its contents. `CvForwarder.gs` is **not** pasted here; it goes into a *separate* project later — see below.)

### 3. Add your Gemini API key

1. Get a free key at **[aistudio.google.com](https://aistudio.google.com)** → *Get API key*.
2. In Apps Script: **⚙ Project Settings → Script Properties → Add script property**:
   - Property: `GEMINI_KEY`
   - Value: *(paste your key)*

Keys live only in Script Properties. Never paste a key into a code file.

Gemini-only setup remains the default. For optional Claude support, ordered model fallback, and per-task routing, add `ANTHROPIC_API_KEY` and `AI_CONFIG` as described in [AI_GATEWAY.md](AI_GATEWAY.md). Existing installations must also add the new `AiGateway.gs` file before deploying updated code.

### 4. Run `firstRun()` — the self-provisioning step

1. Back in the **Editor**, in the function dropdown (toolbar), choose **`firstRun`**.
2. Click **Run**. Google will ask you to authorize — review and allow (it needs Sheets, Drive, Gmail, Calendar for its features; the code is all in front of you).
3. When it finishes, open **Executions** (left sidebar) or the log: it prints the URL of your brand-new tracker spreadsheet.

What `firstRun()` did for you — no manual IDs anywhere:
- Created a spreadsheet **"Healthy18 ATS Tracker"** and a Drive folder **"Healthy18 ATS CVs"** in your account.
- Stored their ids in Script Properties (`SHEET_ID`, `FOLDER_ID`) — the app reads them from there forever after.
- Built every tab (Tracker, Requisitions, Users, headers, candidate IDs).
- Added **you** as the Admin user with a personal access token.

It's safe to run again — it never overwrites an existing install. **Run it before deploying.**

### 5. Deploy the web app

1. **Deploy → New deployment → ⚙ Select type → Web app.**
2. *Execute as:* **Me**. *Who has access:* **Anyone**. (Required so your public careers page works. Your data stays protected — every internal action is checked server-side against the Users tab and per-person tokens.)
3. Click **Deploy** and copy the web app URL (ends in `/exec`).

Open the URL — that's your ATS. In the app, use the **Team** section to add colleagues; each gets a personal link (`...?u=THEIRTOKEN`). Share those links privately, like passwords.

### 6. Enable the public careers page

It's already live: your web app URL + **`?page=apply`**

`https://script.google.com/macros/s/…/exec?page=apply`

Put that link on your website, LinkedIn, or job posts. Applications (with CV upload) land directly in your pipeline, get parsed and scored automatically. Intake is rate-capped (200/day) and CVs are limited to 5 MB.

### 7. Enable CV-by-email (optional — `CvForwarder.gs`)

If you have a `careers@yourcompany.com` (or any) mailbox that receives CVs:

1. In the **main** Healthy18 ATS project, add a Script Property `WEBHOOK_SECRET` with a long random value (20+ characters — mash the keyboard).
2. Sign in **as the careers@ account**, go to script.google.com → **New project**, and paste all of `CvForwarder.gs`.
3. At the top of that file, fill in the two clearly marked values:
   - `APP_EXEC_URL` → your web app URL from step 5 (the one ending in `/exec`).
   - `INGEST_SECRET` → the same value you put in `WEBHOOK_SECRET`.
4. Run `setup` once and authorize. Done — every emailed CV is now parsed into the ATS within 5 minutes, with automatic retries and a daily alert email if anything ever backs up.

### 8. Optional extras

- **Interview feedback form**: run `createFeedbackForm` once from the editor.
- **Notifications**: in-app **🏢 Company** settings — add an alerts email and/or a Google Chat webhook URL.
- **Analytics dashboard**: in **📈 Analytics**, click *Build / refresh dashboard data*, then connect Looker Studio to the generated tab.
- **Interview feedback SLA reminders**: in the Apps Script editor, **Triggers → Add Trigger** → function `checkInterviewSla` → Time-driven → Hour timer → every hour. Reminds the interviewer(s) after 24h of no feedback, escalates to the alerts email above after 48h (each interview at most once).
- **Recurring sourcing-sheet sync**: link a consulting firm's sourcing sheet to a req from **Sourcing channels → Recurring sync** (after mapping columns for a one-time import), then in the Apps Script editor, **Triggers → Add Trigger** → function `syncSourceSheets` → Time-driven → Hour timer (or Day timer) → your interval. Pulls new candidates from every active link on that schedule and tags them the same way as an agency-portal submission (`Agency: <firm name>`); the firm can see their submissions' current stage on their own Sourcing Channels link (Agency.html → My submissions). One firm's broken sheet never blocks the others.
- **Require Google sign-in for everyone (single deployment)**: an alternative to step 5's default (*Execute as:* Me, *Who has access:* Anyone — fully anonymous, no login for anyone). Redeploy with *Execute as:* **User accessing the web app** and *Who has access:* **Anyone** (not restricted to a domain). Apps Script then forces every visitor — internal team, candidates, consulting-firm contacts — to sign in with *some* Google account before anything loads; there's no way to make only some pages skip that wall on one deployment, since Google enforces it before `doGet()` ever runs. In exchange, one URL serves everyone and there's no `PUBLIC_APP_URL` property or second deployment to keep in sync: `doGet()` itself checks the signed-in user against the Users sheet and only serves the internal app/sourcing tool to someone with an active role there — anyone else (any other Google account) only ever reaches `apply`/`agency`/`selfschedule`. Worth confirming once live: a non-`@healthy18.com` Google account signing in should get treated as a Guest (no role), never as an internal teammate — test by opening the URL signed in as a personal Gmail account. The real tradeoff is UX, not security: candidates and consulting-firm contacts must have and use a Google account to apply or submit a candidate at all, where the default anonymous setup has none of that friction.

---

## Path B — "Make a copy" template (easiest, for non-technical users)

The friendliest distribution is a **template spreadsheet with the script attached**: the user opens a link, clicks **File → Make a copy**, and gets the whole system in their own account — no pasting at all. Then they only do steps 3–5 above (add `GEMINI_KEY`, run `firstRun`, deploy).

**For maintainers — how to publish one:**
1. Do a fresh Path A install in a clean Google account, but as a *container-bound* script: create a blank Sheet → **Extensions → Apps Script** → paste the files there.
2. Make sure Script Properties are **empty** (properties don't copy anyway — which is exactly why no secrets can leak through a template).
3. Set the Sheet's sharing to *Anyone with the link — Viewer* and publish the copy link:
   `https://docs.google.com/spreadsheets/d/TEMPLATE_ID/copy`
4. Every "Make a copy" gives the user their own private copy of both the Sheet and the code.

### 9. Automate deploys with GitHub Actions (optional, for teams tracking this repo in git)

By default, shipping a code change means pasting it into the Apps Script editor and clicking **Deploy → Manage deployments → New version** (see Troubleshooting below). If you keep this repo in GitHub, `.github/workflows/deploy.yml` can do that push for you on every merge to `main`.

1. Install clasp once, locally: `npm install -g @google/clasp`.
2. `clasp login` (opens a Google sign-in for the account that owns the Apps Script project). This creates `~/.clasprc.json`.
3. In your GitHub repo, add these under **Settings → Secrets and variables → Actions**:
   - `CLASPRC_JSON` — the full contents of `~/.clasprc.json` from step 2.
   - `CLASP_SCRIPT_ID` — from script.google.com: **Project Settings → IDs → Script ID**.
   - `CLASP_DEPLOYMENT_ID` *(optional)* — from **Deploy → Manage deployments**, if you also want the live `/exec` URL to update automatically. Without this secret, the workflow only pushes source; you still click **New version** once to ship it, same as today.
4. Push to `main` — the workflow pushes `Code.gs`, `AiGateway.gs`, `TalentRubric.gs`, `CvForwarder.gs`, the `.html` files, and `appsscript.json` straight into the Apps Script project.

Never commit `.clasprc.json` or `.clasp.json` — both are already covered by `.gitignore`/`.claspignore`, and the values above belong only in GitHub Secrets.

---

## Troubleshooting

- **"AI request failed (authentication)"** — check the key for the selected provider in Script Properties. For configuration, model availability, or attempt-budget errors, see [AI_GATEWAY.md](AI_GATEWAY.md).
- **App loads but says you need a personal access link** — open it through your `?u=` link (see Team section), or as the account owner just sign in with the owning Google account.
- **Careers page won't upload a CV** — files must be PDF/DOC/DOCX under 5 MB.
- **CV forwarder does nothing** — run its `setup` again; it refuses to run until both config values are truly filled in (that's deliberate, so CVs are never silently dropped).
- **Changed the code after deploying?** — Deploy → Manage deployments → ✏ Edit → *New version* → Deploy. The URL stays the same.

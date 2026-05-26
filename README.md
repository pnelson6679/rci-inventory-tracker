# RCI Inventory Tracker

Mobile-friendly web app for construction crews to log and track vehicle and heavy-machinery
service history. Built on **Google Apps Script** (web app) + **BigQuery** (data) +
**Google Drive** (photos) + **GitHub** (source).

See [`fleet-service-tracker-spec.md`](../fleet-service-tracker-spec.md) in the parent folder
for the full product spec.

---

## Project layout

```
rci-inventory-tracker/
├── .github/workflows/deploy.yml   # CI/CD (wire up after first manual push)
├── src/
│   ├── appsscript.json            # Apps Script manifest (scopes, web-app access)
│   ├── backend/
│   │   ├── Code.gs                # doGet router + email allowlist + endpoints
│   │   ├── BigQuery.gs            # data-access layer (stubs for JS Engineer)
│   │   ├── Drive.gs               # photo upload to Drive
│   │   └── Utils.gs               # CONFIG (edit me!) + helpers
│   └── frontend/
│       ├── Index.html             # app shell (HtmlService template)
│       ├── styles.html            # CSS
│       └── scripts.html           # client JS (google.script.run wiring)
├── schema/
│   ├── vehicles.json              # BigQuery table schemas
│   ├── service_records.json
│   └── service_schedules.json
├── .claspignore
├── .gitignore
└── README.md
```

> **clasp note:** `rootDir` is `./src`, so files push to Apps Script with a folder
> prefix — e.g. `backend/Code`, `frontend/Index`. That's why `doGet` calls
> `createTemplateFromFile('frontend/Index')` and the template uses
> `include('frontend/styles')`. Keep that prefix if you add files.

---

## Before you start — fill in CONFIG

Open `src/backend/Utils.gs` and set:

- `GCP_PROJECT_ID` — your Google Cloud project ID
- `BQ_DATASET` — already set to `rci_inventory_tracker_db`
- `DRIVE_ROOT_FOLDER_ID` — the Drive folder that will hold per-vehicle photo sub-folders
- `ALLOWLIST` — every crew email allowed to open the app

---

## Step-by-step: get it connected and live

Throughout, substitute your own values for `<gcp-project-id>` and `<github-user>`.

### 1. Install the CLI tools (one time)

```bash
# Node.js 18+ required first: https://nodejs.org

# GitHub CLI
brew install gh            # macOS;  Windows: winget install GitHub.cli
gh auth login

# clasp (Apps Script CLI)
npm install -g @google/clasp

# Google Cloud SDK (provides gcloud + bq): https://cloud.google.com/sdk/docs/install
gcloud init
```

### 2. Create the GitHub repo

```bash
cd "rci-inventory-tracker"
git init
git add .
git commit -m "chore: initial project scaffold"
gh repo create pnelson6679/rci-inventory-tracker --private --source=. --push
```

No `gh`? Create the repo in the web UI, then:
`git remote add origin https://github.com/pnelson6679/rci-inventory-tracker.git && git push -u origin main`

### 3. Set up BigQuery

Enable the API once: https://console.cloud.google.com/apis/library/bigquery.googleapis.com

```bash
# Create the dataset
bq --project_id=rci-inventory mk --dataset \
  --description "RCI Inventory Tracker dataset" \
  <gcp-project-id>:rci_inventory_tracker_db

# Create the three tables from the schema files
bq mk --table rci-inventory:rci_inventory_tracker_db.vehicles          schema/vehicles.json
bq mk --table rci-inventory:rci_inventory_tracker_db.service_records   schema/service_records.json
bq mk --table rci-inventory:rci_inventory_tracker_db.service_schedules schema/service_schedules.json

# Verify
bq ls rci-inventory:rci_inventory_tracker_db
```

### 4. Create the Drive photo folder

In Google Drive, create a folder (e.g. "RCI Vehicle Photos"), open it, and copy the ID from
the URL (`drive.google.com/drive/folders/THIS_PART`). Paste it into `CONFIG.DRIVE_ROOT_FOLDER_ID`.

### 5. Create the Apps Script project with clasp

```bash
clasp login                       # opens an OAuth browser flow

# From the repo root. rootDir must be ./src so the manifest + both folders push.
clasp create --title "RCI Inventory Tracker" --type webapp --rootDir ./src
```

`clasp create` writes `.clasp.json` (git-ignored — it holds the script ID). Then push:

```bash
clasp push
clasp open                        # opens the project in the Apps Script editor
```

You should see `backend/Code`, `backend/BigQuery`, `frontend/Index`, etc. in the editor.

### 6. Link the GCP project & enable BigQuery in Apps Script

1. In the Apps Script editor: **Project Settings (gear) → Google Cloud Platform (GCP) Project
   → Change project** and enter your `<gcp-project-id>` project number. (Required for BigQuery.)
2. The BigQuery advanced service is already declared in `appsscript.json`, so no manual toggle
   is needed — but confirm it shows under **Services** in the editor.

### 7. Deploy the web app

```bash
clasp deploy --description "v1 initial deploy"
```

Or in the editor: **Deploy → New deployment → Web app**, with:
- **Execute as:** *User deploying* (so only you need BigQuery/Drive access — see access note below)
- **Who has access:** *Anyone* (the app runs its own Google sign-in; see "Access model" below)

Copy the web-app URL and open it. Accounts on the `ALLOWLIST` can sign in and use the app;
everyone else is blocked at sign-in.

> **Before the app will let anyone in, you must complete the one-time sign-in setup**
> (next-but-one section). Until then, even you will be stopped at the sign-in screen.

### 8. (Optional) Turn on CI deploys

`.github/workflows/deploy.yml` pushes on merge to `main`. To enable it, add two GitHub secrets:
- `CLASP_CREDENTIALS` — contents of your local `~/.clasprc.json` after `clasp login`
- `CLASP_SCRIPT_ID` — the `scriptId` from `.clasp.json`

---

## Access model (Google sign-in + email allowlist)

The crew is on personal Gmail, not a Workspace domain. That rules out the old trick of
reading `Session.getActiveUser().getEmail()` — under *Execute as: me* Google returns an
**empty** email for any visitor who isn't the owner, so a `doGet`-level check would deny
everyone. Instead the app runs its own lightweight **"Sign in with Google"** flow:

1. The app is deployed **Execute as: me**, so photo uploads land in *your* Drive and only
   *you* need BigQuery/Drive access. End users never authorize those scopes.
2. On first visit the browser shows a **Sign in with Google** button. It sends the visitor
   through Google OAuth requesting only the non-sensitive `openid email` scopes.
3. The server (`Auth.gs`) verifies the returned email, checks it against `CONFIG.ALLOWLIST`,
   and — if allowed — issues a short-lived **HMAC-signed session token**. The browser stores
   it in `localStorage` and replays it on every `google.script.run` call.
4. **Every server endpoint calls `requireAuth_(token)`** before doing any work, re-checking
   the allowlist each time. So even a logged-in stranger who pokes at the endpoints directly
   is rejected, and removing someone from the allowlist locks them out immediately.

Add or remove crew members by editing `CONFIG.ALLOWLIST` in `Utils.gs` and running
`./release.sh` (or `clasp push` + redeploy). **No GCP console change is needed to add a person.**

### One-time sign-in setup

Because the data project (`rci-inventory`) requests the restricted Drive scope, its OAuth
consent screen has to stay in **Testing** (publishing it would force Google verification —
which we're avoiding). A consent screen in Testing only lets *test users* authorize it, which
is exactly the cap we're trying to escape. The fix is to put the **sign-in** OAuth client in
its **own, separate GCP project** whose consent screen uses only the non-sensitive `email`
scope — that one can be published to production with **no verification and no user cap**.

1. **Create a second GCP project** (e.g. "RCI Sign-In") at
   <https://console.cloud.google.com/projectcreate>. (You can technically reuse `rci-inventory`
   instead, but then every crew member must be added as a *test user* — the very thing we're
   avoiding. A separate project skips that.)
2. In that project: **APIs & Services → OAuth consent screen** → User type **External** →
   fill in app name + your email. On the Scopes step, add **only**
   `.../auth/userinfo.email` (and `openid`) — do **not** add any sensitive/restricted scopes.
   Then **Publish app → Production**. Because the only scope is non-sensitive, Google does
   **not** require verification and there is **no 100-user cap**.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID** → type
   **Web application**. Under **Authorized redirect URIs** add your exact web-app `/exec` URL:
   `https://script.google.com/macros/s/AKfycbwH1YMlQn3kZ8ws7XFMshpx8M4G9__aliEi4MOO22Uwoll1JZeELVkhurNBn2vOmW2q/exec`
   Copy the **Client ID** and **Client secret**.
4. In the **Apps Script editor** (this project): **Project Settings (gear) → Script Properties**
   → add two properties:
   - `OAUTH_CLIENT_ID` = the client ID from step 3
   - `OAUTH_CLIENT_SECRET` = the client secret from step 3
5. Still in the editor, open `backend/Auth.gs`, pick **`generateSessionSecret`** from the
   function dropdown, and click **Run** once. That writes a random `SESSION_SECRET` to Script
   Properties. (Re-running it later just logs everyone out — harmless.)
6. Make sure your web-app URL is registered in step 3 **exactly** (Google requires an exact
   match, including the trailing `/exec`). If you ever create a brand-new deployment with a
   different URL, add that URL to the client's redirect URIs too.

That's it — keep `rci-inventory` in **Testing** with just yourself; end users only ever touch
the separate sign-in project, which is production and uncapped.

> **Why a session token instead of re-checking on each page load?** Apps Script web apps are
> stateless and can't set cookies, so the signed token (kept in `localStorage`) is what lets a
> crew member stay signed in across refreshes. Tokens expire after 12 hours (`SESSION_TTL_SECONDS`
> in `Auth.gs`); after that they sign in again — one click, no re-consent.

---

## Verification checklist

- [ ] `git status` is clean and the repo is visible at `github.com/<github-user>/rci-inventory-tracker`
- [ ] `bq ls <gcp-project-id>:rci_inventory_tracker_db` lists all three tables
- [ ] `clasp push` succeeds and files appear in the Apps Script editor
- [ ] GCP project is linked in Apps Script Project Settings
- [ ] Web-app URL loads for an allowlisted account; denied for a non-listed one
- [ ] `CONFIG` in `Utils.gs` has real values (not the `YOUR_...` placeholders)

---

## Known gotchas for the dev team

- **clasp only syncs `.gs` and `.html`** under `rootDir`. JSON/schema/CI files stay in git only.
- **OAuth scopes** (BigQuery, Drive, external requests, email) are declared in `appsscript.json`.
  Adding a feature that needs a new scope requires re-authorizing the app.
- **Apps Script execution limit** is ~6 minutes per call. The spec already recommends a
  computed view / scheduled job for fleet-wide status rather than recomputing on every load.
- **BigQuery streaming inserts** (`Tabledata.insertAll`) have a short buffer delay before rows
  are queryable — fine for this app, but don't expect read-after-write to be instant.

## Hand-off

Infrastructure is ready. Next:
- **JS Engineer** — implement the `BQ_*` and business-logic stubs in `BigQuery.gs`.
- **HTML Expert** — build the five views in `frontend/` against the `window.RCI.*` client API.

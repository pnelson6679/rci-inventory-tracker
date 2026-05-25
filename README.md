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
- **Who has access:** *Anyone with a Google account*

Copy the web-app URL and open it. Accounts on the `ALLOWLIST` get the app; everyone else
gets an "Access denied" page.

### 8. (Optional) Turn on CI deploys

`.github/workflows/deploy.yml` pushes on merge to `main`. To enable it, add two GitHub secrets:
- `CLASP_CREDENTIALS` — contents of your local `~/.clasprc.json` after `clasp login`
- `CLASP_SCRIPT_ID` — the `scriptId` from `.clasp.json`

---

## Access model (email whitelist)

Apps Script web apps can't natively restrict to an arbitrary email list, so access is
enforced in two layers:

1. **Deployment** set to *Anyone with a Google account* forces sign-in, which gives us the
   visitor's email.
2. **`doGet` checks that email** against `CONFIG.ALLOWLIST` and shows an "Access denied"
   page to anyone not listed.

Add or remove crew members by editing `CONFIG.ALLOWLIST` in `Utils.gs` and running `clasp push`.

> **Gotcha:** `Session.getActiveUser().getEmail()` reliably returns the visitor's email when
> everyone is on the same Google Workspace domain. For mixed consumer Gmail accounts it can
> come back empty under *Execute as: User deploying*. If your crew uses personal Gmail, switch
> the deployment to **Execute as: User accessing** — but then each user also needs BigQuery
> read/write access on the GCP project (or front the data layer with a service account).
> Decide this with the team before launch.

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

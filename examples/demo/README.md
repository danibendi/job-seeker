# Fictional screenshot dataset

`scripts/demo-data.mjs` loads a coherent public-demo workspace for **Alex Morgan**, a fictional design programme leader. Every person, organisation, job, and event is invented. Every external URL uses the reserved `.example` domain.

The seeder is deliberately difficult to run by accident. Start with a fresh clone and a newly created, explicitly disposable PostgreSQL database. Never point this process at a database that has held a real candidate's data.

```bash
git clone https://github.com/danibendi/job-seeker.git
cd job-seeker
npm ci
cp .env.example .env.local
chmod 600 .env.local
```

Edit `.env.local` and set `DATABASE_URL`. For Neon, also set the direct, non-pooler URL as `DATABASE_URL_UNPOOLED`. Keep both values in the protected file rather than putting a credentialed URL in shell history. Create the login configuration and run every migration:

```bash
read -rsp "Job Seeker demo login password: " JOB_SEEKER_LOGIN_PASSWORD
echo
export JOB_SEEKER_LOGIN_PASSWORD
npm run setup
unset JOB_SEEKER_LOGIN_PASSWORD
```

`npm run setup` writes the password hash and a random session secret to `.env.local`; remember the password you chose for browser login. Seed the still-empty database by loading that file through Node:

```bash
export JOB_SEEKER_DEMO_SEED=I_UNDERSTAND_THIS_REQUIRES_AN_EMPTY_DISPOSABLE_DATABASE
export JOB_SEEKER_DISPOSABLE_DATABASE=true
export JOB_SEEKER_DEMO_ANCHOR=2026-09-18T09:00:00.000Z
node --env-file=.env.local scripts/demo-data.mjs
unset JOB_SEEKER_DEMO_SEED JOB_SEEKER_DISPOSABLE_DATABASE JOB_SEEKER_DEMO_ANCHOR
```

Verify and start the local app:

```bash
npm run verify:setup
npm run dev
```

Open <http://localhost:3000>, sign in with the password chosen during setup, and use the stable routes below. Use an anchor near the screenshot date so the two pending interviews appear as upcoming. The exact UTC ISO value makes the fixture reproducible. If it is omitted, the canonical fixture anchor shown above is used.

The script checks the full migrated table set, takes a transaction-scoped advisory lock, and refuses a database containing business data. The only tolerated pre-existing rows are the neutral `owner` workspace and neutral `owner` execution-settings row installed by migrations. All inserts run in one transaction. Database URLs and database error details are never printed.

The seed covers:

- one completed fictional workspace with search preferences, weekly targets, all notifications off, a disabled search schedule, and unassigned worker executors;
- ten fictional companies and roles across sourced, to apply, applied, screening, interviewing, offer, rejected, and irrelevant stages;
- complete fit assessments, factors, company dossiers, status history, feedback, a rejection learning record, and CV tailoring decisions;
- two CV variants and a small generated fictional PDF source document;
- two upcoming interviews with fictional interviewers, questions, checklists, and prep briefs;
- answered, open, and failed requests plus succeeded, waiting, cancelled, and historical search tasks, all explicitly marked synthetic;
- completed/skipped synthetic run history, a timeline, digest, strategy, agencies, outreach, watchlist sources, and events.

The seed does not create queued or running tasks, worker credentials, schedule occurrences, LinkedIn ingestion records, pending outbox events, or enabled notifications. It never starts a worker, model, browser, schedule, or external request.

Stable tour routes returned by the script include:

| Capability | Route |
| --- | --- |
| Dashboard | `/` |
| Pipeline | `/pipeline` |
| Rich assessment | `/jobs/00000003-0000-4000-8000-000000000001` |
| Interview preparation | `/interviews/00000007-0000-4000-8000-000000000001` |
| CV variant and document | `/cv?variant=design-program-leadership` |
| Proposed CV tailoring | `/cv?tailoring=00000006-0000-4000-8000-000000000001` |
| Task history | `/activity?tab=tasks` |
| Requests | `/activity?tab=requests` |
| Insights | `/insights` |
| Agencies | `/agencies` |
| Watchlist | `/watchlist` |
| Disabled schedule/executors | `/settings?tab=schedule` |

The tables that must be empty are the workspace business tables: companies/jobs and their workflow children, CVs/documents, interviews, directories, strategy/events/targets, requests/rejections, automation and activity history, settings/preferences, outbox and LinkedIn ingestion/search state, and agent tasks. Migration metadata and login-attempt audit rows are outside the business-data check.

## Capture the product tour

The screenshots in [the product tour](../../docs/product-tour.md) were captured from the real app using this fixture, a production Next.js server, and Chromium. The capture script signs in, visits the screens, expands selected saved answers, and checks for page errors, HTTP failures, and horizontal overflow. It never saves login cookies or calls an agent.

With the demo app running, install the optional browser tooling outside the app's dependencies:

```bash
TOUR_TOOLS="$(mktemp -d)"
npm install --prefix "$TOUR_TOOLS" --no-save --package-lock=false playwright@1.63.0
"$TOUR_TOOLS/node_modules/.bin/playwright" install chromium
export JOB_SEEKER_PLAYWRIGHT_MODULE="$TOUR_TOOLS/node_modules/playwright/index.mjs"
read -rsp "Job Seeker demo login password: " JOB_SEEKER_LOGIN_PASSWORD
echo
export JOB_SEEKER_LOGIN_PASSWORD
JOB_SEEKER_DEMO_CAPTURE=true node scripts/capture-tour.mjs
unset JOB_SEEKER_LOGIN_PASSWORD JOB_SEEKER_PLAYWRIGHT_MODULE
```

Use `JOB_SEEKER_DEMO_URL` if the app is not at `http://localhost:3000`, `JOB_SEEKER_TOUR_OUTPUT` to save elsewhere, or `JOB_SEEKER_CHROME_PATH` to use an existing Chromium/Chrome executable. Use a current fixture anchor so both interviews are still upcoming. The script deliberately requires the fictional candidate and pending CV proposal; it is not a generic way to publish a real workspace.

After trying the demo, stop its local server and delete only the disposable database or Neon branch you created for it. Remove the temporary browser-tool directory when it is no longer needed. Keep screenshots only after checking that they contain fictional data.

# Job Seeker

Job Seeker is a self-hosted workspace for one person's job search. It keeps jobs, CV variants, applications, interviews, notes, and search preferences in one place. Agent automation is optional: the app works as a manual tracker with only Node.js and PostgreSQL.

Each deployment owns one workspace and one candidate profile. Run separate deployments for separate people so their data, credentials, schedules, and browser accounts never mix.

## What is included

- A responsive Next.js application for the job pipeline, CVs, interviews, strategy, agencies, and activity.
- PostgreSQL schema and repeatable Drizzle migrations.
- Guided onboarding with no person-specific profile or active search defaults.
- An optional owner MCP endpoint for interactive assistants.
- An optional Python worker with direct API, Codex, and Hermes adapters.
- Separate credentials for the owner MCP client, workers, scheduler, and LinkedIn collector.
- Sanitized setup verification that reports `passed`, `failed`, `disabled`, or `not tested` for every check.

Public web search is currently exploratory. It does not prove complete coverage of the job market or even of a configured collection of employer sites. LinkedIn automation requires the account owner's own login and a separately configured browser provider. See [current capabilities and limitations](docs/project-status.md) before enabling automation.

## Quick start

You need Node.js 22–24, npm, and PostgreSQL. The database can be local, hosted, or Neon.

```sh
git clone https://github.com/danibendi/job-seeker.git
cd job-seeker
npm ci
cp .env.example .env.local
chmod 600 .env.local
```

Add `DATABASE_URL` to `.env.local`. For Neon, use a pooled URL for `DATABASE_URL` and a direct URL for `DATABASE_URL_UNPOOLED`. Then set the login password for this shell without putting it in a command argument:

```sh
read -rsp "Job Seeker login password: " JOB_SEEKER_LOGIN_PASSWORD
echo
export JOB_SEEKER_LOGIN_PASSWORD
npm run setup
unset JOB_SEEKER_LOGIN_PASSWORD
npm run dev
```

Open <http://localhost:3000>, sign in, and finish onboarding. The setup command generates a session secret in the git-ignored, mode-`0600` environment file and applies every migration. It preserves existing values when run again.

Verify the database and configuration at any time:

```sh
npm run verify:setup
```

To test a running deployment too:

```sh
npm run verify:setup -- --url https://jobs.example.com
```

The report never includes passwords, tokens, connection strings, candidate identifiers, or workspace names.

## Installation choices

- [Ordinary Node.js and PostgreSQL](docs/installation.md) is the provider-independent path.
- [Vercel and Neon](docs/deployment-vercel-neon.md) is a convenience deployment.
- [Agent integrations](docs/agent-integrations.md) covers MCP and background workers.
- [Operations](docs/operations.md) covers schedules, upgrades, backup, and recovery.
- [Migration](docs/migration.md) explains safe upgrades from earlier Job Seeker releases.
- [Security](docs/security.md) documents credential boundaries and deployment checks.

## Where to start in the code

| You want to… | Start here |
| --- | --- |
| Install the app | [Installation](docs/installation.md), then [`.env.example`](.env.example) |
| Connect an assistant or worker | [Agent integrations](docs/agent-integrations.md), then [adapter configuration](docs/agents.md) |
| Work on the interface | [`src/app`](src/app) and [`src/components`](src/components) |
| Understand database and task behavior | [`src/db`](src/db), [`src/lib`](src/lib), and [worker protocol](docs/worker-protocol.md) |
| Adapt Hermes for your installation | [`ops/hermes`](ops/hermes) and [`scripts/compass_worker`](scripts/compass_worker) |
| Check what has actually been tested | [Release verification](docs/verification-results.md) |

For a coding agent, read [AGENTS.md](AGENTS.md) first, follow the installation guide, then read the protocol before changing automation. The examples contain fictional profiles; enter your own information through onboarding, settings, and CVs.

A [GitHub Actions workflow example and activation instructions](docs/ci.md) are included.

Contributor conventions are in [AGENTS.md](AGENTS.md). The project is available under the [MIT License](LICENSE).

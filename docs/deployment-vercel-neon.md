# Deploy with Vercel and Neon

Vercel and Neon are optional conveniences. Job Seeker uses standard Next.js and PostgreSQL interfaces, so this recipe does not change the application contract.

## 1. Create the database

Create a Neon project and database in a region close to the Vercel function region you plan to use. Neon exposes two useful connection strings:

- A pooled URL, whose host contains `-pooler`, for application traffic.
- A direct URL for migrations, dumps, and administrative work.

Neon recommends the direct connection for ORM migrations and a pooled connection for bursty serverless application traffic. See Neon's [connection pooling guide](https://neon.com/docs/connect/connection-pooling).

Create an isolated Neon branch before rehearsing an upgrade or migration. Do not test a migration against the only copy of production data.

## 2. Create the Vercel project

Import the repository into Vercel or run `vercel` from the repository root. Confirm that the project Framework Preset is **Next.js** and Root Directory is the repository root (`./`). A project created separately with the CLI or API can lack that framework setting; select it explicitly before deployment. Select a supported Node.js version from this project's `engines` range and choose a function region near the database.

Set these production environment variables:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Neon pooled connection string used by the running app |
| `DATABASE_URL_UNPOOLED` | Neon direct connection string used by migrations |
| `AUTH_PASSWORD_HASH` | bcrypt hash produced by `npm run setup` |
| `SESSION_SECRET` | random value of at least 32 characters |
| `OWNER_MCP_TOKEN` | optional owner-assistant bearer token |

Keep worker, scheduler, and collector variables absent until those components are intentionally installed. In Vercel, mark production secrets as sensitive. The official CLI supports `vercel env add NAME production --sensitive`; it can read values from standard input or a protected file. Vercel applies environment changes only to new deployments, so redeploy after changing one. See [Vercel environment variables](https://vercel.com/docs/environment-variables) and the [CLI reference](https://vercel.com/docs/cli/env).

Do not attach the production database to arbitrary preview deployments. Give a preview its own Neon branch and preview-scoped credentials if it needs database access.

## 3. Apply migrations

Run migrations from a trusted workstation or CI job that has `DATABASE_URL_UNPOOLED`:

```sh
npm ci
npm run db:migrate
```

The command prefers `DATABASE_URL_UNPOOLED` and falls back to `DATABASE_URL` for ordinary PostgreSQL. It does not seed a person.

## 4. Deploy and verify

Deploy, finish onboarding in the production browser, then run:

```sh
JOB_SEEKER_APP_URL=https://jobs.example.com npm run verify:setup -- --env-file /protected/path/production.env
```

If Vercel Deployment Protection is enabled, configure access for your test client and agent before interpreting its response as an app response. The app still requires its own login and role-specific bearer credentials.

Confirm that `/api/health` reports an available database, login works, the workspace opens on desktop and phone, and Vercel runtime logs contain no database or migration failures. If owner MCP is enabled, verification also checks that an invalid bearer is rejected and an authenticated initialization is accepted.

This repository does not provision or mutate Vercel or Neon automatically. Account creation, billing, regions, domains, branch retention, backups, and production promotion remain operator decisions.

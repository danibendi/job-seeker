# Deploy with Vercel and Neon

Vercel and Neon are optional conveniences. Job Seeker uses standard Next.js and PostgreSQL interfaces, so this recipe does not change the application contract.

For the complete app-and-agent setup, use the [Neon + Vercel + Hermes reference stack](reference-stack.md), which includes generated configuration, deployment and cleanup helpers, and a runnable queue clock.

## Scope and release policy

This public repository supplies software and a reference deployment; it does not
define a shared production app, account, domain, database or operator identity.
The checked-in GitHub workflow runs validation on pushes and pull requests; it
does not deploy Vercel, run production migrations or activate workers. A source
release and an operator's production rollout are separate outcomes.

“Ship it” invokes `babysit-pr` for review, validation and merge. A production rollout
is included only when the request or existing operator policy identifies and
authorizes that installation. Do not treat publishing this project as authority
to release every installation. For an in-scope installation, inspect its actual
Git integration: an operator may have configured automatic production deployment
from `main`, including documentation changes. Complete prerequisites before that
merge; do not start a duplicate manual deployment. Honor any narrower scope or
environment approval already configured.

Keep an operator-private release record containing production URL, account/project
IDs, production branch, trigger, environment approvals, secret sources/names,
application and worker revisions, database/branch identity, backup reference and
last good deployment. Never add real values, personal identifiers or private
hosts to this repository. The placeholders in these instructions are synthetic.

## Regular updates

The numbered sections below cover initial provisioning. For an existing
installation, do not recreate the project, rerun onboarding, seed data or rotate
credentials just to update the app.

1. Fetch the release branch and inspect intervening commits for changes to design,
   behavior, schema, authentication and worker protocol. Incorporate compatible
   changes and tell the operator when they significantly affect the proposed work.
   Pin the reviewed release to a full Git SHA; rerun affected checks and reviews
   after updating the base. A conflict-free merge is not semantic review.
2. From a clean checkout of that SHA, run `npm ci`, `npm run verify`, the relevant
   Python tests, `npm run privacy:scan`, `npm run licenses:generate` and
   `npm run build`. The notice generation must leave the reviewed notice file
   unchanged. Follow the contributor privacy instructions, including an
   operator-protected deny-terms file when extracting from a private deployment.
   Do database-backed checks on an isolated branch/database with synthetic data.
3. Back up PostgreSQL and verify restoration before schema/data changes. Rehearse
   all pending migrations against a production clone; inspect applied identifiers
   and check rerun behavior. Use the exact release source and direct connection
   supplied in the trusted process environment:

   ```sh
   npm run db:migrate
   ```

   The command prefers `DATABASE_URL_UNPOOLED`; use the pooled connection only for
   the app. Do not seed an existing workspace. Review compatibility with both
   current and proposed app/worker versions. Complete backward-compatible
   migrations before the app release; an incompatible migration needs a specific
   write-pause and recovery plan before any automatic trigger.
4. For the generated reference stack, set its protected configuration's
   `sourceRevision` to the pinned SHA and `sourceRoot` to that clean checkout,
   rerender into a new protected output directory, and retain the matching
   `vercel-project.json` ownership record as described in
   [the reference stack](reference-stack.md#2-configure-and-render-the-stack).
   Its renderer defaults to a write-free configuration dry-run:

   ```sh
   python3 examples/reference-stack/render.py --config /protected/job-seeker/stack.json
   python3 examples/reference-stack/render.py --config /protected/job-seeker/stack.json \
     --write --output /protected/job-seeker/generated-new-release
   ```

   Write mode refuses an existing output directory. For an update, copy the
   existing protected `vercel-project.json` ownership record for this exact
   account/project into the new directory with mode 0600; never reuse a record
   from another installation. Check the generated files before executing them:

   ```sh
   install -m 600 /protected/job-seeker/previous-release/vercel-project.json \
     /protected/job-seeker/generated-new-release/vercel-project.json
   python3 examples/reference-stack/render.py \
     --check-generated /protected/job-seeker/generated-new-release
   ```

   Substitute the actual retained ownership-record path. Supply `VERCEL_TOKEN`
   through the operator's secret manager, then run this release's helper once:

   ```sh
   /protected/job-seeker/generated-new-release/deploy-vercel.sh
   ```

   This helper performs a production deployment, checks account/project ownership,
   refuses a mismatched revision or dirty deployment inputs, uploads an allowlist,
   and verifies the configured origin and source revision. Its output directory
   here is an example; use the one just generated for this release. It is not a
   no-op preview or an inspection command. For installations using Git integration
   or another release system, follow that established trigger instead of running
   this helper as a second release.
5. Record the deployment ID, immutable URL and source revision. Wait for the
   selected deployment to become Ready, for example
   `vercel inspect <deployment-url> --wait` in the verified operator account.
   Confirm the production alias selects it. Verify `/api/health` reports an
   available database and `sourceRevision` equal to the pinned SHA when
   `JOB_SEEKER_SOURCE_REVISION` is configured. For Git deployments also verify the
   provider's Git commit metadata. A Ready build or a health response with no
   source proof does not establish which revision serves production.
6. Run the setup verifier against the actual app using the operator's protected
   environment file:

   ```sh
   npm run verify:setup -- --env-file /protected/path/production.env --url https://jobs.example.com
   ```

   Complete actual browser login and the changed journeys on desktop and phone.
   Use existing approved accounts and reversible data; do not reseed production
   or run the destructive protocol harness there. Inspect deployment/runtime logs
   for auth, database and protocol failures. Record which optional checks ran and
   which were intentionally disabled or not tested.
7. If a worker or scheduler is affected, deploy its artifact and configuration
   from the same reviewed compatible revision using the installation's supervisor
   procedure and [reference stack](reference-stack.md). A local `--check` is not a
   completed task. Verify the separately authorized saved-result flow before
   enabling schedules. Preserve leases, checkpoints, worker authority and paused
   automation; app deployment alone does not authorize activation or model calls.

Serialize releases for each installation. If the branch or production alias moves
while releasing, inspect the added commits and final serving revision before
acting. Never promote an old artifact over a newer release. Following a timeout,
inspect the existing deployment and alias before retrying. Release records should
state the actual live revision, verification times and any remaining observation
gap; do not claim an unestablished background watch.

## Failed rollout and recovery

Inspect the deployment state and production alias first: a failed build may leave
the prior app healthy. Cancel a bad pending rollout through the operator's Vercel
deployment controls after checking it has not been superseded by a legitimate
newer release. Preserve the source revision, current schema state and logs.

For an unhealthy released app, use a recorded prior Ready production deployment
only after checking compatibility with the current database and worker protocol.
Check the account's plan and target eligibility first. [Vercel Hobby](https://vercel.com/docs/instant-rollback)
permits Instant Rollback only to the immediately previous production deployment. If a compatible
build is older, use a reviewed forward fix or escalate recovery rather than substitute a stale
promotion. In the verified operator account, for an eligible target the command is:

```sh
vercel rollback <previous-production-deployment-url>
```

Application rollback does not reverse migrations, credentials, worker installs or
external actions. Do not restore an old database over new user data as routine
code recovery. Prefer a reviewed roll-forward correction when old code cannot
read the current schema. A destructive restore needs the operator's explicit
decision, preserved current data, a tested restore and reconciliation of pending
work. Pause affected scheduling before incompatible recovery; use the
[operations](operations.md) and
[reference-stack recovery](reference-stack.md#cleanup-and-rollback) procedures
for the installed components.

Vercel rollback disables automatic production-domain assignment. Once a reviewed forward-fix
production build is Ready and verified, use `vercel promote <reviewed-production-deployment-url>`,
confirm the alias/revision, and verify automatic assignment is restored before normal Git releases.
Select a compatible production build, never a preview or stale release. Verify
revision/alias, database, browser, MCP and affected task flow after recovery, then
resume only the schedules previously authorized. Reconcile the branch with a
reviewed revert/fix. Report whether the previous app stayed healthy, recovery
succeeded, or service remains impaired; escalate missing source proof, schema
incompatibility, human-only consent or failed recovery to the operator.

## Initial installation

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

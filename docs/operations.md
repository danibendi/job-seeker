# Operations

## Backups and upgrades

Back up PostgreSQL before an upgrade and verify that the backup can be restored. Use a direct database connection for `pg_dump`, `pg_restore`, and migrations. On Neon, rehearse the release on a branch cloned from production. On ordinary PostgreSQL, restore a recent dump into a separate database.

Upgrade with:

```sh
git pull --ff-only
npm ci
npm run db:migrate
npm run build
npm run verify:setup
```

Stop writes or put the old app into maintenance during a migration that changes live data. Keep the prior application version and backup until login, onboarding state, counts, notes, task history, and representative job records pass verification.

## Health and diagnostics

`GET /api/health` checks the database and exposes only operational status. `npm run verify:setup` adds local runtime, secret-presence, migration, workspace, and optional integration checks. Its output is sanitized, but a saved report can still reveal versions and a deployment hostname; store it with normal operational logs rather than publishing it.

`passed` means that exact check ran successfully. `disabled` means the optional capability is intentionally absent. `not tested` means required runtime context, such as a deployed URL, was not supplied. A worker's `--check` validates local configuration only; it does not prove that a task was claimed or completed.

The repository also contains a destructive protocol conformance harness for a newly migrated, empty, disposable database. It refuses non-loopback application URLs and refuses to run unless `JOB_SEEKER_DISPOSABLE_DATABASE=true`. Supply `DATABASE_URL`, `JOB_SEEKER_TEST_URL`, `JOB_SEEKER_TEST_OWNER_TOKEN`, `JOB_SEEKER_TEST_WORKER_TOKEN`, `JOB_SEEKER_TEST_WORKER_ID`, and optionally `JOB_SEEKER_TEST_EXECUTOR`, then run `npm run verify:protocol`. The app and database must point to the same disposable installation. The harness creates and changes synthetic jobs, requests, and tasks; never aim it at a real workspace.

This harness exercises owner MCP initialization, discovery and an allowed write; credential separation; concurrent claim ownership; lease expiry and recovery; replaced-token rejection; progress, completion and idempotency; cancellation, retry and waiting-for-user behavior. It does not call a model provider, browser provider, Codex, or Hermes.

## Worker and scheduler

Task storage and scheduling are separate. A worker claims queued work. A scheduler tick may enqueue due work. Connecting an MCP assistant does not drain the queue.

Run a long-lived worker under a process supervisor, or invoke one bounded poll frequently:

```sh
job-seeker-worker --once
```

Run the scheduler with its own credential:

```sh
job-seeker-worker --schedule-tick
```

Example systemd units are under `examples/systemd/`. They assume an unprivileged `job-seeker` operating-system user, an installation in `/opt/job-seeker`, and protected environment files in `/etc/job-seeker`. Review paths and hardening for your host before installing them.

## Credential rotation

Owner, worker, scheduler, and collector credentials have different authority. Rotate one role at a time and do not reuse values between roles. Where a server setting accepts a short overlap list, add the new value, update the client, confirm health, then remove the old value. Never copy the owner token into a worker or scheduler environment.

Task-attempt credentials are short-lived capabilities issued after a durable claim. They must not be stored as static deployment secrets. A replaced or expired attempt must not be able to write results.

## Recovery

If a worker stops, inspect the visible task state before restarting it. The queue lease and checkpoint determine whether work resumes, retries, or remains waiting for user action. Do not manually mark work complete based only on an adapter log. Verify the saved result in the application.

Automation begins disabled on fresh installations. Enable one capability at a time and complete a real question or evaluation flow before enabling a schedule. Public search should remain labeled exploratory until a bounded connector has measurable source coverage.

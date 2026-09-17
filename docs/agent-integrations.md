# Agent integrations

Job Seeker separates interactive owner access from queued background execution. Both are optional.

## Owner MCP

The owner MCP endpoint is `/api/mcp`. Enable it by setting `OWNER_MCP_TOKEN` to a random value with at least 32 characters. `HERMES_API_TOKEN` is accepted only as a migration alias for earlier installations.

You can generate the owner token without displaying it:

```sh
npm run setup -- --with-owner-mcp --skip-migrate
```

Configure any compatible MCP client with the HTTPS endpoint and an `Authorization: Bearer …` header. Treat this token as owner authority: it can read and change job-search data. Use a protected environment variable or secret file supported by the client.

MCP access is interactive. It does not install a worker, run queued questions, or create a schedule. Verify the endpoint boundary with `npm run verify:setup -- --url https://jobs.example.com`.

## Background worker

The portable worker requires Python 3.11 or newer. Install it using the worker package instructions in [docs/agents.md](agents.md), then configure:

| Variable | Purpose |
| --- | --- |
| `JOB_SEEKER_APP_URL` | Preferred application base URL; `COMPASS_APP_URL` is the compatibility name |
| `COMPASS_WORKER_TOKEN` or `_FILE` | Credential for one registered worker |
| `COMPASS_WORKER_EXECUTOR` | `api`, `codex`, or `hermes` |

The app-side `COMPASS_WORKERS_JSON` is a JSON array of registrations with distinct IDs, executors, and tokens. Start with [the registration example](../examples/workers.json), replace `REPLACE_ME` with a newly generated secret of at least 32 characters, and store the resulting JSON as the app’s `COMPASS_WORKERS_JSON`. Give that same worker-specific secret to its worker process through `COMPASS_WORKER_TOKEN_FILE`. The example placeholder is intentionally too short to authenticate. Keep the completed registration in a protected environment file. Do not put JSON containing real tokens in documentation, tickets, shell arguments, or source control.

Validate local configuration without contacting the app:

```sh
job-seeker-worker --check
```

Claim at most one task:

```sh
job-seeker-worker --once
```

`--check` does not prove the registered token, network path, claim handoff, model response, or saved result. Complete a real question and inspect the saved answer before advertising an adapter as ready.

## Direct model API adapter

The `api` executor uses an OpenAI-compatible model API and does not require Codex or Hermes. It needs `COMPASS_API_BASE_URL`, `COMPASS_API_KEY` or `COMPASS_API_KEY_FILE`, and `COMPASS_API_MODEL`. Optional task-kind and reasoning settings are documented in [docs/agents.md](agents.md).

The API adapter can handle questions and evaluations. Public web discovery depends on the selected provider exposing a compatible web-search capability. Results from that mode are exploratory and cannot establish source completeness.

## Codex and Hermes adapters

The Codex adapter runs the operator's own Codex CLI installation. The Hermes adapter runs the operator's own Hermes runtime and profile. Neither runtime ships credentials with this repository. Provider, model, profile, workspace, and browser settings belong to the deployment.

These adapters must obey the same durable claim and attempt-token boundary as the direct API adapter. A constructor or configuration check does not establish feature parity. Test question, cancellation, retry, and any source-specific flow that you enable.

## Scheduler and browser collection

The scheduler uses `COMPASS_SCHEDULER_TOKEN`, never a worker or owner token. `job-seeker-worker --schedule-tick` performs one bounded tick.

LinkedIn collection is a separate optional capability. It needs `LINKEDIN_COLLECTOR_TOKEN`, a supported browser-session provider, and the account owner's own authenticated session. Configure and verify account identity before collecting. Login-required, partial, blocked, and budget-exhausted states must remain visible; do not turn those states into silent success.

# Agent and worker adapters

Job Seeker stores tasks, claims, leases, policy, evidence, and results. An executor supplies judgment or source access after a worker has durably claimed a task. Executors do not create their own queue and do not need Hermes Kanban semantics.

## Install the optional worker

From the repository root, create an isolated Python environment and install the package:

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install .
job-seeker-worker --help
```

For the Hermes readiness checker, use `python -m pip install '.[hermes]'`. Contributors can instead install an editable copy with `python -m pip install -e '.[test]'`.

To produce an immutable deployment artifact:

```sh
python -m pip install build 'setuptools>=77' wheel
SOURCE_DATE_EPOCH=1704067200 python -m build --wheel --no-isolation
sha256sum dist/job_seeker_worker-0.1.0-py3-none-any.whl
```

Record the digest and install that wheel on the worker host with `python -m pip install dist/job_seeker_worker-0.1.0-py3-none-any.whl`. The wheel includes the Codex prompt/schema and the optional Node CDP connector. It also installs `job-seeker-hermes-launch`, an executable entry point used when package installers do not preserve the source launcher's executable bit. [The package manifest](../ops/worker-package.manifest.json) records the release contract.

## Supported adapters

| Executor | Task kinds | External runtime | Current limitations |
| --- | --- | --- | --- |
| `api` | `question`, `linkedin_evaluate`; optional `search` | OpenAI-compatible `/chat/completions` HTTP API | Public search requires the provider's `web_search_options` extension. It is exploratory and does not establish source-registry completeness. It does not support LinkedIn collection. |
| `codex` | `question`, `search`, `linkedin_evaluate` according to the worker registration | Codex CLI | Browser work requires a separately configured browser MCP URL and explicit tool allowlist. Validation of the local CLI is not proof that a provider task completed. |
| `hermes` | `question`, `search`, `linkedin_evaluate` according to the worker registration | Hermes native Kanban CLI | Requires an operator-owned profile, reserved board, absent staging profile, and disabled gateway dispatch. The example is not a live deployment recipe for every Hermes version. |

The app worker registration fixes the executor identity. Each worker requests only the task kinds it can execute; task kinds are a client capability filter, not a separate server-side permission boundary. For `api`, `COMPASS_API_TASK_KINDS` is also sent with claims so unsupported kinds are never requested. Configure API search tasks with `sources: ["public"]`; the API adapter refuses mixed public/LinkedIn tasks.

## Direct API executor

Required environment:

```dotenv
JOB_SEEKER_APP_URL=https://jobs.example.net
COMPASS_WORKER_TOKEN_FILE=/run/secrets/job-seeker-worker
COMPASS_WORKER_EXECUTOR=api
COMPASS_API_BASE_URL=https://api.example.net/v1
COMPASS_API_KEY_FILE=/run/secrets/model-api-key
COMPASS_API_MODEL=provider-model-id
COMPASS_API_TASK_KINDS=question,linkedin_evaluate
```

Optional settings are `COMPASS_API_REASONING_EFFORT`, `COMPASS_API_TIMEOUT_SECONDS`, and `COMPASS_API_STRUCTURED_OUTPUT=json_schema|json_object`. Set both `COMPASS_API_WEB_SEARCH=true` and add `search` to `COMPASS_API_TASK_KINDS` only when the selected endpoint implements the OpenAI `web_search_options` extension. A compatible JSON endpoint without that extension supports questions and evaluation, but not discovery.

The direct evaluator imports only the shared evaluation contract and validators. It does not import Hermes, read a Hermes credential store, or impersonate a Hermes executor. Model, reasoning, endpoint, and API credential are deployment settings; candidate preferences cannot select them.

## Codex executor

Set `COMPASS_CODEX_BIN`, `COMPASS_WORKSPACE`, and optionally `COMPASS_CODEX_MODEL`. The installed wheel includes the fixed prompt and output schema. A browser MCP requires `COMPASS_CODEX_BROWSER_MCP_URL`, an optional token or token file, and `COMPASS_CODEX_BROWSER_MCP_ENABLED_TOOLS`. The child receives the current task capability and explicitly configured browser capability. It does not receive the reusable worker or scheduler credential.

The fixed Codex response schema is compatible with strict Structured Outputs: every object rejects extra properties and requires every declared property. Free-form `details` and `checkpoint` values cross the Codex boundary as JSON-encoded strings, then the trusted adapter parses and validates them back into an object and an object-or-null before calling the app. Artifact entries always carry all four wire fields; null optional fields are removed during that conversion. This encoding is private to the Codex adapter and does not change worker protocol v1.

## Hermes executor

Start from [the neutral profile example](../ops/hermes/profile.example.yaml) and the [setup notes](../ops/hermes/README.md). Configure the board, tenant, profile, runtime path, executable, model, provider, and reasoning effort for the operator's own installation. `compass-worker-staging` is deliberately absent. The adapter creates blocked cards under that nonexistent assignee and publishes the app execution reference before a model-dispatched card is assigned and unblocked. Compact evaluations stay staged and are executed by trusted adapter code.

Compact evaluation has no built-in model settings. Supply its model, provider, and reasoning effort as one complete `COMPASS_HERMES_EVALUATION_*` triple, or deliberately reuse a complete explicit general `COMPASS_HERMES_MODEL`/`PROVIDER`/`REASONING` triple. Without either triple, the worker excludes `linkedin_evaluate` from its Hermes claim kinds and reports that capability as disabled; question and search tasks remain available through the configured runtime profile. `COMPASS_HERMES_TASK_KINDS` can narrow the advertised claim filter further.

The offline subscribed-model benchmark also has no model grid. Every model run requires one or more explicit `--variant MODEL:EFFORT` arguments. `--validate-only` remains available without a variant and makes no model call.

Run the readiness check before enabling a worker:

```bash
python ops/hermes/check-readiness.py \
  --profiles-dir /path/to/hermes/profiles \
  --profile compass-worker \
  --staging-profile compass-worker-staging \
  --root-config /path/to/hermes/config.yaml
```

This check validates files and the staging/gateway invariants. It does not call Hermes, inspect a private runtime, or prove provider execution.

## Browser connector

LinkedIn collection is optional. Set `COMPASS_LINKEDIN_EXPECTED_NAME` to the account identity that must be uniquely visible. Choose either a loopback CDP endpoint through `COMPASS_LINKEDIN_CDP_URL`, or Browser Use with `BROWSER_USE_API_KEY` and `COMPASS_LINKEDIN_PROFILE_ID`. Cloud API URL, profile name, profile user ID, proxy country, Node executable, and media blocking are configurable. The default cloud connection uses no proxy (`COMPASS_LINKEDIN_PROXY_COUNTRY=direct`).

No cookie import/export or access-control bypass is implemented. Login-required and identity-mismatch states become explicit human handoffs.

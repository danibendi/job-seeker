# Worker protocol v1

This document defines the stable HTTP boundary between one Job Seeker deployment and its workers. JSON field names at the boundary use camel case inside task payloads, including `candidateId`. Internal Python code may use snake case.

## Credentials and authority

Four credential roles remain separate:

| Credential | Accepted at | Authority |
| --- | --- | --- |
| Worker credential | `/api/worker/tasks/claim` | Claim work registered for one executor and its requested compatible kinds. It is reusable and never enters model context. |
| Attempt capability (`claim_token`) | One task's renew/progress/fail/complete routes and `/api/worker/mcp` | Operate only the current task, attempt, worker, and unexpired lease. Replaced or expired tokens cannot write. |
| Scheduler credential | `/api/worker/schedule/tick` | Evaluate the configured schedule and enqueue due work. It cannot claim or execute tasks. |
| Owner MCP credential | `/api/mcp` | Interactive owner operations. New installations use `OWNER_MCP_TOKEN`; `HERMES_API_TOKEN` is a migration alias. It is never a worker, scheduler, or attempt token. |

Use `Authorization: Bearer <token>`. Tokens may be supplied to the portable worker directly or through a protected `*_FILE`. Redirects are refused so credentials are not replayed to another URL. Non-loopback application URLs require HTTPS.

## Claim

`POST /api/worker/tasks/claim`

```json
{"kinds":["question","linkedin_evaluate"]}
```

`kinds` is optional. When present it must be a nonempty subset of `search`, `question`, and `linkedin_evaluate`. The app also filters by the executor bound to the worker credential.

Idle response:

```json
{"task":null}
```

Claim response:

```json
{
  "task": {
    "id": "opaque-task-id",
    "kind": "question",
    "executor": "api",
    "attemptCount": 1,
    "payload": {"candidateId":"candidate-01"},
    "checkpoint": {}
  },
  "claim_token": "opaque-attempt-capability",
  "lease_expires_at": "2030-01-01T12:00:00.000Z",
  "heartbeat_interval_seconds": 30
}
```

The app atomically changes one eligible queued task to running before returning the capability. An executor must not start an external runtime before this durable claim. A Hermes card is optional bookkeeping created after claim; it is not the app task or the ownership boundary.

## Lease renewal and cancellation

`POST /api/worker/tasks/{task_id}/renew`

```json
{"claim_token":"opaque-attempt-capability"}
```

Success currently returns `{"lease_expires_at":"..."}`. Cancellation or replacement makes the claim invalid and renewal is rejected; additive future responses may also return a cancelled status or `cancel_requested: true`, which requires execution to stop. The worker enforces the last confirmed deadline with a monotonic clock and a five-second safety margin; a response arriving after that deadline cannot revive authority. HTTP 401, 403, 404, 409, 410, and 422 permanently cancel the local attempt. Transient renewal errors may be retried only while the last confirmed lease remains valid.

Adapters poll `control.cancelled`, terminate owned child processes, and attest cleanup through trusted adapter code. Model text cannot attest cleanup. If cleanup is unconfirmed, the worker exits nonzero and does not submit a terminal write. LinkedIn cloud sessions and Hermes native children have provider-specific positive cleanup checks.

## Progress

`POST /api/worker/tasks/{task_id}/progress`

```json
{
  "claim_token":"opaque-attempt-capability",
  "checkpoint":{"cursor":"opaque-source-cursor"},
  "external_ref":"optional-runtime-reference",
  "message":"Bounded status text"
}
```

All fields except `claim_token` are optional. Checkpoints must be JSON objects and should contain only resumable state, measured usage, and opaque identifiers. They must not contain credentials, cookies, authorization headers, or private paths. Progress writes are fenced by task, attempt, worker, lease, and token.

## Completion

`POST /api/worker/tasks/{task_id}/complete`

```json
{
  "claim_token":"opaque-attempt-capability",
  "result":{"summary":"Completed the bounded task."}
}
```

Completion is idempotent only for the same task attempt, worker, token, and byte-equivalent logical result hash. A replay with different data is rejected. The worker validates JSON finiteness, a 200 kB request-body limit, and a 100,000 UTF-16-unit summary limit before sending. A `linkedin_evaluate` task can complete only after the linked snapshot has a fresh terminal evaluation persisted through task MCP.

The Codex CLI adapter's strict model-output schema is an internal transport. Its free-form `details` and `checkpoint` fields are JSON-encoded strings so every schema object can have closed, fully required properties. Trusted adapter code decodes and validates those strings before constructing the object-valued progress, completion, or failure body defined here. The encoded strings never cross the app protocol boundary.

## Failure and waiting for a person

`POST /api/worker/tasks/{task_id}/fail`

```json
{
  "claim_token":"opaque-attempt-capability",
  "error":"Bounded safe error",
  "retryable":true,
  "waiting_for_user":false,
  "checkpoint":{}
}
```

The default policy allows three total attempts. Retryable ordinary failure and expired-lease recovery requeue immediately until the cap. `waiting_for_user: true` does not retry automatically. A human Retry action grants a new three-attempt budget. Terminal calls are not automatically replayed after an ambiguous network failure; the worker first reads durable state or leaves the attempt for lease recovery.

LinkedIn browser recovery has separate bounds: 60 and 300 second no-progress delays, at most three consecutive no-progress failures, and at most 20 sessions in one task failure-recovery history. Continuation children retain spend and progress checks. The current protocol does not claim a single count bound across every successful continuation child.

## Task MCP

`GET|POST /api/worker/mcp` accepts only the current attempt capability. Every tool call includes `task_id` and `attempt`. The server rechecks running status, worker, attempt, token, and lease. Core tools are:

- `get_task_context` and `get_task_context_section` for versioned policy, request, CV, evidence, and checkpoint context;
- `verify_public_source` then `save_job` for a direct public employer/ATS vacancy;
- LinkedIn lookup, ingest, scan-page, detail, and stop receipts for the deterministic connector;
- `complete_linkedin_evaluation` for one policy-fenced stored snapshot decision.

Large contexts return a section manifest. A client must fetch every applicable JSON chunk with the same `context_version`; a version conflict requires reloading from the start.

The backend checks live policy hash, source permission, minimum score, company/work-mode rules, current public-source receipts, and fuller LinkedIn source facts. Some semantic public gates still rely on the model's evidence attestation. A schema-valid response is not proof of correct eligibility.

## Compatibility

Protocol version 1 permits additive response fields. Workers ignore unknown task fields, reject unknown task kinds they did not advertise, and fail closed on missing identity, capability, lease, or required context. New required request fields, changed meanings, or removed fields require a new protocol version. Health and verification output should record the app protocol version and installed worker package version.

Public web model search is currently exploratory. It has no completeness denominator and does not advance a configured-source watermark. Source-registry enumeration, durable per-source cursors, overlap windows, and incremental completeness remain future work; no adapter may report them as implemented.

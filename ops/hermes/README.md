# Optional Hermes adapter

These files are neutral examples for an operator-owned Hermes installation. They do not target a private host, credential manager, browser account, profile tree, or release. Reconcile the fragment with the schema and effective defaults of the exact Hermes version you operate.

The adapter reserves one board, tenant, and real profile configured through `COMPASS_HERMES_BOARD`, `COMPASS_HERMES_TENANT`, and `COMPASS_HERMES_PROFILE`. It also derives `<profile>-staging`. That staging profile must not exist. Cards are initially blocked under staging until the app has durably accepted the native execution reference. Only then may a model-dispatched card be assigned to the real profile and unblocked. Compact evaluations stay staged while trusted adapter code performs the tool-free model call and persistence.

Keep `kanban.dispatch_in_gateway: false`. The adapter alone performs a dry-run selection and a one-shot real dispatch after a durable app claim. The guarded launcher binds `COMPASS_TASK_TOKEN` to the selected native card, board, profile, task ID, attempt, run ID, claim lock, and confirmed local lease deadline before it execs Hermes. Never place `COMPASS_TASK_TOKEN` or the reusable worker token in a profile, card, root secret map, dotenv file, or model prompt.

Configure your own values:

```dotenv
COMPASS_WORKER_EXECUTOR=hermes
COMPASS_HERMES_BIN=/absolute/path/to/hermes
COMPASS_HERMES_RUNTIME_ROOT=/absolute/path/to/reviewed/hermes/source
COMPASS_HERMES_BOARD=job-seeker
COMPASS_HERMES_TENANT=job-seeker
COMPASS_HERMES_PROFILE=compass-worker
COMPASS_HERMES_MODEL=your-model-id
COMPASS_HERMES_PROVIDER=your-provider-id
COMPASS_HERMES_REASONING=your-supported-reasoning-effort
COMPASS_HERMES_EVALUATION_MODEL=your-evaluation-model-id
COMPASS_HERMES_EVALUATION_PROVIDER=your-provider-id
COMPASS_HERMES_EVALUATION_REASONING=your-supported-reasoning-effort
COMPASS_HERMES_TASK_KINDS=question,search,linkedin_evaluate
```

Compact evaluation never selects a built-in provider, model, or reasoning effort. Set all three `COMPASS_HERMES_EVALUATION_*` values together. If none are set, the adapter reuses the general Hermes override only when `COMPASS_HERMES_MODEL`, `COMPASS_HERMES_PROVIDER`, and `COMPASS_HERMES_REASONING` are all explicit. Otherwise compact evaluation is disabled, removed from the claim-kind filter, and reported as disabled by `job-seeker-worker --check --json`; ordinary question and search cards can still use the runtime profile. A partial evaluation triple is a configuration error.

Merge `profile.example.yaml` into the real profile and `root-config.example.yaml` into root configuration through the operator's reviewed configuration workflow. Confirm the effective profile denies shell, files, memory, delegation, messaging, browser control, and unrelated MCP servers. Refresh any release-specific plugin or tool inventories from the actual runtime rather than copying another deployment's inventory.

Install the Hermes checker dependency with `python -m pip install 'job-seeker-worker[hermes]'` (or install `PyYAML>=6,<7` when running from a source checkout). Run `check-readiness.py` before the worker starts. It safely parses the root YAML, rejects duplicate keys, and requires the root `kanban.dispatch_in_gateway` value to be the literal boolean `false`. Then run `job-seeker-worker --check`. The first check proves only file-level staging and gateway invariants; the second proves only local adapter configuration. Neither proves a real question, discovery, evidence verification, evaluation, cancellation, or retry flow. Test those against a non-production app task before advertising the integration.

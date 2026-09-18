# Contributor instructions

Job Seeker is a one-person-per-deployment application. Keep identity, location, language, provider choices, schedules, and search policy in workspace data or deployment configuration. Do not add a real person's profile, CV, job history, account identifier, host, secret reference, or browser session to source control.

Start with the [product tour](docs/product-tour.md) to understand the screens, [installation](docs/installation.md) for the minimal app, and the [reference stack](docs/reference-stack.md) for the complete Neon/Vercel/Hermes wiring. The [fictional demo](examples/demo/README.md) is the reproducible source of the tour's screenshots; seed it only into an explicitly disposable empty database.

Use Node.js 22–24 and Python 3.11 or newer. Install JavaScript dependencies with `npm ci`. Keep Vitest at no more than two workers; `vitest.config.ts` owns that limit. Run targeted tests while developing, then `npm run verify` and the relevant Python tests. Browser-facing changes need an end-to-end browser check.

Fresh databases must migrate to the neutral `owner` workspace with onboarding incomplete, all schedules disabled, no sources selected, and no executor assigned. Migrations must be repeatable and preserve existing records. Do not run personal seed scripts. Synthetic examples must be obviously fictional and opt-in.

Use `scripts/lib/env-file.mjs` for protected env files. Next.js expands dollar-prefixed substrings, so bcrypt hashes and other values containing `$` must be serialized with `quoteEnvValue`; a normal JSON-quoted value is unsafe. Test generated authentication values through `@next/env`, not only through the local parser.

Keep the app usable without an agent, Hermes, Codex, Browser Use, Docker, Neon, Vercel, or a secret manager. Environment variables and protected files are the baseline credential mechanism. Maintain separate authority for owner MCP, workers, scheduler, task attempts, and collectors.

Do not claim complete source coverage from general web search. Describe it as exploratory unless a connector durably enumerates a bounded source, records progress and failures, and verifies the observed ID set. An adapter's configuration check proves only that local configuration is valid.

Never print or commit secret values. Setup and diagnostic output may include versions, timestamps, enabled/disabled states, HTTP status, and counts. It must omit connection strings, hashes, tokens, candidate IDs, profile names, and private URLs.

Run `npm run privacy:scan` and regenerate `THIRD_PARTY_NOTICES.json` with `npm run licenses:generate` before a release. Publishers should also pass a protected `--deny-terms-file` containing private names, usernames, hosts, tenant IDs, and paths from the source deployment. The scanner allows those extra terms only in the exact compatibility SQL migrations; do not expand that exception to application code, generated snapshots, tests, or examples.

Before changing worker behavior, read `docs/worker-protocol.md`. Before changing integration guidance, read `docs/agents.md`. Keep compatibility aliases documented until a migration removes them deliberately.

# Release verification

These checks were performed on 17 September 2026. This is evidence for the named flows, not a claim that every optional provider or automation path has been exercised.

## Tested environment

- Application: Job Seeker 0.1.0, protocol v1, Next.js 15.5.22, Node.js 24.19.0.
- Database: PostgreSQL 18 on a disposable Neon branch. Empty databases and a private reference-data clone were tested separately.
- Worker: Python 3.11 package installation and test suite; Codex CLI 0.153.4 with gpt-5.6-sol for the actual queued-question test.
- Browser: headless Google Chrome through Playwright, 1440 × 1000 desktop and 390 × 844 phone viewports.

## Completed checks

| Check | Evidence |
| --- | --- |
| Clean JavaScript installation | `npm ci`, installed dependency resolution, and production build passed. |
| Setup script | Protected environment generation, repeat execution, migrations, and generated bcrypt authentication through Next.js environment loading passed. |
| Fresh database | All migrations through 0017 applied. Onboarding started empty and automation disabled. |
| Existing-data upgrade | All 34 pre-existing tables retained their row counts and normalized content hashes. Normalization covered only the intended identity/column/actor compatibility changes. A later post-browser comparison differed only in the expected login-attempt audit table. Private rows and deployment identifiers are excluded from this repository. |
| Vercel/Neon | Temporary Next.js deployment on Node.js 22 in `fra1`: health 200 with connected database, login API 200 with session cookie, MCP initialization and 48-tool discovery 200, invalid bearer 401. Explicitly selecting the Next.js framework was necessary for a CLI-created project. The project was deleted and absence verified. |
| Manual app | Login, persisted onboarding, manual job creation, factual CV creation, job detail, and saved requests passed in a real browser. |
| Phone layout | Home, pipeline, CV, activity, and settings rendered without page errors or horizontal page overflow. |
| Migrated app | Pipeline, CVs, task activity, and settings rendered from the upgraded reference database without browser errors. |
| Existing credential configuration | With a synthetic seed and private namespace configuration, the new derivation reproduced the reference deployment’s worker/scheduler values exactly. Shared Python/TypeScript vectors also cover public defaults and custom namespaces. No live agent credentials were used. |
| HTTP/database protocol | All 30 checks passed: authenticated owner MCP discovery/write, invalid bearer rejection, role separation, concurrent ownership, progress, expired lease recovery, replaced-token rejection, completion replay/conflict, cancellation, explicit retry, and waiting-for-user. |
| Installation isolation | Two separately configured synthetic candidates had distinct IDs, time zones, roles, and task contexts. The second database had no jobs/CVs from the first. Owner and worker credentials were rejected across instances in both directions; 14 isolation and six UI checks passed. |
| Actual Codex question | A browser-submitted question was stored, claimed by the portable worker, answered by a real model call, and saved to its request. The final answer was opened in the browser. This test exposed and repaired the CLI's strict JSON-schema requirement. |
| Automated regression checks | 126 TypeScript tests and 167 Python tests passed. Production build and type checking passed; lint had no errors and three existing warnings in browser fixture/helper code. |
| Python distribution | A clean Python 3.11 environment installed the worker wheel and exercised its command entry points and bundled resources. |
| Export privacy | Publisher-specific forbidden terms and credential patterns were scanned; compatibility literals are limited to the upgrade migration. Dependency license metadata was generated for 666 JavaScript package versions and the optional Python dependency. |

## GitHub CI

The initial release was validated locally. The [CI workflow](../.github/workflows/ci.yml) is now enabled for pushes and pull requests; see [CI details](ci.md) and the [Actions runs](https://github.com/danibendi/job-seeker/actions/workflows/ci.yml) for hosted results.

## Product-tour verification, 18 September 2026

The [fictional demo seeder](../scripts/demo-data.mjs) ran against a newly migrated empty database on an isolated Neon branch. It inserted ten jobs and companies, two CV variants, two pending interviews, one pending tailoring, and synthetic requests and activity. Read-only checks confirmed no active schedules, assigned executors, queued/running tasks, enabled notifications, pending outbox events, or schedule occurrences. Repeating the seed correctly refused the nonempty database.

The production Next.js app rendered all 17 [tour views](product-tour.md) at 1440 × 1100 desktop and 390 × 844 phone sizes. The [capture script](../scripts/capture-tour.mjs) found no browser errors, HTTP failures, or horizontal page overflow. Visual review caught blank agency status badges caused by importing shared labels from a client component; moving those labels into a shared module fixed them, and the final browser pass explicitly checked all three displayed statuses.

After capturing the images, real browser actions saved an interview-preparation edit, a CV tailoring decision, and a role note. Each persisted after reload. The fictional CV's stored PDF also downloaded successfully. These were manual app checks: no model, agent worker, or live Hermes configuration was used.

The final app build, type checking, all 126 TypeScript and 167 Python tests, and the publisher privacy scan passed. The screenshot data is invented and contains only reserved example domains. The temporary app process and gallery database branch were removed after verification; existing production resources were preserved. Reference-setup validation is recorded in the [reference guide](reference-stack.md).

## Boundaries of the evidence

The cloud browser reached the login page, but its post-login automation stopped on a test-selector error; cloud runtime-error logs were not checked. Full authenticated browser flows passed on the local production server. The cloud snapshot preceded the final health metadata/privacy correction and optional derived-credential configuration; final local build, health and credential checks cover those changes.

The ordinary app ran as a production Node.js process against standard PostgreSQL connections. An independently administered PostgreSQL server, a persistent systemd installation, and a separate self-hosted HTTPS reverse proxy were not tested. The Docker and systemd examples are examples, not verified installations.

The direct API adapter has integration tests against a local HTTP fixture; no paid external API-provider flow was run. Hermes adapter lifecycle and readiness were tested without creating a live profile, card, schedule, or configuration. A complete live Hermes deployment is not claimed. LinkedIn account login, cloud browser provisioning, real collection, and recovery were not exercised for this public release.

Public search remains exploratory. Configured-source enumeration, complete or incremental coverage, and general evaluation accuracy are not claimed. The question test does not establish search, evaluation, or provider parity.

All temporary Vercel projects and the disposable Neon branch/databases were deleted, and their absence was verified. Existing production resources and live agent configuration were not changed.

See [capability status](project-status.md), [operations](operations.md), and [the worker protocol](worker-protocol.md) for the reproducible checks and remaining limits.

# Capability status

This file distinguishes shipped code from end-to-end evidence. See [initial release verification](verification-results.md) for the exact tested environment and flows.

`npm run verify:protocol` reproduces the local HTTP/database task-protocol checks on an empty disposable database. Its exact safety contract is documented in [operations](operations.md). Provider and browser claims still require separate evidence.

| Area | Current public status | Evidence required before a stronger claim |
| --- | --- | --- |
| Manual app | Fresh migration, onboarding, login, manual jobs/CVs, desktop and phone flows verified | Broader interview, strategy, and document-upload browser coverage |
| Ordinary Node/PostgreSQL | Production Node server and PostgreSQL connection verified | Independently administered PostgreSQL, self-hosted HTTPS and supervised restart |
| Vercel/Neon | Disposable Next.js deployment, Neon connection, health, login API and MCP verified | Complete hosted browser flow and runtime-error log review |
| Owner MCP | Real initialize/discovery, read/write and bearer rejection verified | Each operator’s own MCP client connection |
| Queued worker | Packaged API/Codex/Hermes adapters; actual Codex question and shared HTTP lifecycle verified | Live API and Hermes flows; search/evaluation and runtime cancellation for each provider |
| Public web discovery | Exploratory only | A bounded connector registry with durable page/ID coverage, pause/resume, failure visibility, and reference-set equality |
| LinkedIn/browser collection | Optional provider-specific integration | Own-account identity check, login recovery, bounded resume, list/detail evidence and new/changed-only evaluation |
| Multi-user hosting | Not supported | Out of scope; deploy one isolated instance per person |

The repository includes unit and integration tests for important contracts. Those tests do not prove a provider account, live browser, external model, deployed queue, or complete source scan. Release notes should name the exact recipe, versions, and flows tested, and should use `not tested` for anything that was not exercised.

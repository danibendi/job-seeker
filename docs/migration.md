# Migration and upgrade safety

The migrations in `drizzle/` support both empty databases and databases created by earlier application versions. They normalize the singleton workspace to `owner`, retain historical task and activity data, and create onboarding state without inventing a new person.

## Rehearse first

1. Stop or isolate background workers so they cannot write during the rehearsal.
2. Create a database clone: restore a dump into a separate PostgreSQL database, or create a Neon branch from production.
3. Point a protected temporary environment file at the clone.
4. Run `npm ci`, `npm run db:migrate`, and `npm run verify:setup` against the clone.
5. Start the application against the clone and inspect login, workspace identity, notes, task history, representative jobs, CV variants, interviews, and search settings.
6. Compare table counts and any installation-specific invariants to the source. Record counts, not record contents, in review evidence.

This process never requires changing the live database. A successful migration command alone is insufficient evidence: the application flows and retained records must also be checked.

For a read-only count and digest inventory before and after migration:

```sh
npm run db:inventory -- --env-file /protected/source.env --output /protected/before.json
npm run db:inventory -- --env-file /protected/clone.env --output /protected/after.json
npm run db:inventory -- --compare /protected/before.json /protected/after.json --allow-differences
```

Inventory mode runs only `SELECT` statements. It records table names, row counts, and SHA-256 digests of canonical row JSON; it never writes row values or a connection string to the report. A migration that renames columns or normalizes values will legitimately change some digests, so review every changed table against the migration's intended transformation. Use application-specific invariants in addition to this generic comparison.

## Cut over

Back up production, pause writers, apply the same migrations through a direct connection, deploy the matching application version, and run verification. Keep the previous version and recoverable backup until browser checks pass. If the check fails, preserve the failed clone or logs for diagnosis and restore according to your database provider's documented procedure.

## Credential rename

New deployments use `OWNER_MCP_TOKEN`. `HERMES_API_TOKEN` remains a temporary compatibility alias for owner MCP access. It must not be confused with worker, scheduler, collector, or task-attempt credentials. Migrate clients one at a time, verify access with the new name, then remove the alias.

The internal `COMPASS_*` environment names are retained for worker protocol compatibility. They do not identify a person or require a product called Compass.

## Derived-credential deployments

Prefer independent random worker and scheduler credentials for new installations. If an older installation derives those credentials from its owner key, you can retain that deployment's exact HMAC namespace values through `COMPASS_DERIVED_WORKER_DOMAIN` and `COMPASS_DERIVED_SCHEDULER_DOMAIN` on the app and derivation helper. Enable the app's existing `COMPASS_HERMES_DERIVED_WORKER_ENABLED=true` switch only for that explicit compatibility path.

Copy namespace values from the old installation's configuration or code into private deployment configuration; never assume that a renamed product uses the same derivation. Worker and scheduler domains must be nonempty and distinct. If no overrides are supplied, the public defaults are `job-seeker:v1:worker:hermes` and `job-seeker:v1:scheduler`. The shared Python/TypeScript test vectors verify both the neutral defaults and a configured custom namespace. This compatibility path does not create or update a Hermes profile.

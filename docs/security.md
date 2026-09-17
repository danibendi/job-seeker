# Security model

Job Seeker contains personal employment data. An operator is responsible for access control, database protection, HTTPS, backups, provider accounts, and compliance that applies to their deployment.

## Baseline

- Keep `.env.local` and other secret files outside source control with owner-only permissions.
- Use HTTPS for every non-loopback app, MCP, and worker connection.
- Put self-hosted `next start` behind a maintained reverse proxy.
- Use a unique login password and separate random tokens for every authority role.
- Give the database role only the access this database needs.
- Keep production data out of previews, examples, tests, bug reports, and public verification artifacts.
- Back up before migrations and test restoration.

Variables prefixed `NEXT_PUBLIC_` are included in browser code by Next.js. Never give that prefix to a password, database URL, model key, or bearer token.

## Authority boundaries

| Credential | Authority |
| --- | --- |
| `AUTH_PASSWORD_HASH` and `SESSION_SECRET` | Browser login and signed session cookies |
| `OWNER_MCP_TOKEN` | Broad interactive owner reads and writes |
| Worker token in `COMPASS_WORKERS_JSON` | Claim work for one registered executor |
| `COMPASS_SCHEDULER_TOKEN` | Trigger scheduler ticks |
| Task-attempt token | Write only for one current durable claim |
| `LINKEDIN_COLLECTOR_TOKEN` | Submit collector evidence through its endpoint |

Do not collapse these into one deployment token. A worker should receive only its own registration token before claim; the app issues the narrower attempt credential after durable ownership is established.

## Reports and logs

`npm run verify:setup` intentionally reports configuration presence rather than values. Application and worker errors should identify the failed stage without printing request authorization, model keys, database queries containing private data, or connection strings. Review process-manager, reverse-proxy, database, Vercel, and model-provider retention policies before sending real candidate data through them.

## Responsible disclosure

Do not open a public issue containing candidate data, credentials, private deployment URLs, or browser-session evidence. Reproduce with the fictional examples where possible and rotate any credential that was exposed.

Before publishing a release, create a protected text file with one private name, username, host, tenant ID, account ID, or path fragment per line. Then run:

```sh
npm run privacy:scan -- --deny-terms-file /protected/private-terms.txt
```

You can also supply a comma-separated `JOB_SEEKER_PRIVATE_TERMS` environment variable. The scan prints only paths and rule names. Extra publisher terms are allowed only in the exact compatibility SQL migrations, where legacy identifiers are needed to upgrade existing data. Inspect the exact staged tree and the complete history that will become public as well. The automated scan catches common secret files, provider tokens, credentialed PostgreSQL URLs, private tailnet references, and publisher-supplied terms. It supplements human review; it cannot prove that arbitrary prose or low-entropy credentials are safe.

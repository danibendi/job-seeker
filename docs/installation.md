# Install with Node.js and PostgreSQL

This is the baseline installation. Docker, Vercel, Neon, Hermes, Codex, and 1Password are not required.

## Requirements

- Node.js 22, 23, or 24 and npm
- PostgreSQL 15 or newer
- HTTPS and a reverse proxy for an internet-facing deployment
- Python 3.11 or newer only if you install the optional worker

Create an empty PostgreSQL database and a role that owns it. Job Seeker needs normal schema migration and application read/write privileges. Keep the database connection string out of shell history and source control.

## Install

```sh
git clone https://github.com/danibendi/job-seeker.git
cd job-seeker
npm ci
cp .env.example .env.local
chmod 600 .env.local
```

Edit `.env.local` and set `DATABASE_URL`. On ordinary PostgreSQL, `DATABASE_URL_UNPOOLED` may be omitted or set to the same URL. On a provider with a transaction pooler, keep the pooled URL in `DATABASE_URL` and put the direct URL in `DATABASE_URL_UNPOOLED`.

Create the login password hash and random session secret, then migrate:

```sh
read -rsp "Job Seeker login password: " JOB_SEEKER_LOGIN_PASSWORD
echo
export JOB_SEEKER_LOGIN_PASSWORD
npm run setup
unset JOB_SEEKER_LOGIN_PASSWORD
```

`npm run setup` is safe to repeat. It keeps existing generated secrets, replaces the password hash only when a new password is supplied, and applies only unapplied migrations. It never inserts a candidate profile. A new database contains one neutral owner workspace with onboarding incomplete and automation disabled.

To apply later migrations without changing the login configuration, run `npm run db:migrate`. Pass `-- --env-file /protected/path/app.env` when the database variables are stored outside `.env.local`.

For a non-interactive installer, put the password in a mode-`0600` temporary file and use `npm run setup -- --password-file /protected/path/password`. Remove that file after setup. Never pass the password as a command-line argument.

## Run

For local development:

```sh
npm run dev
```

For production:

```sh
npm run build
npm run start
```

By default, the server listens on port 3000. Put a production process supervisor and an HTTPS reverse proxy in front of it. The [Next.js self-hosting guide](https://nextjs.org/docs/app/guides/self-hosting) recommends a reverse proxy rather than exposing `next start` directly.

Open `/login`, sign in, and complete `/onboarding`. Candidate identity, display labels, locale, time zone, goals, and preferences belong to this deployment's workspace. Repeat the entire install with a separate database and secrets for another person.

## Verify

```sh
npm run verify:setup -- --url https://jobs.example.com
```

The command exits nonzero when a required check fails. Optional components report `disabled`; checks that need a running URL report `not tested` when no URL is supplied. Add `--json` for machine-readable output. Redirect that output only to a protected location because even sanitized host and version metadata may be private.

## Optional local PostgreSQL with Docker

Docker is only a convenience for development. If it is installed, copy `examples/postgres.compose.yml`, set a strong password in a protected environment file, and start the database with your Compose implementation. The application itself still runs through npm. This recipe is supplied as an example and is not part of the required installation path.

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
env -i PATH="$PATH" HOME="$HOME" bash -c '
  set -eu
  read -rsp "Job Seeker login password: " JOB_SEEKER_LOGIN_PASSWORD
  echo
  export JOB_SEEKER_LOGIN_PASSWORD
  exec npm run setup -- --env-file .env.local
'
```

`npm run setup` is safe to repeat. It keeps existing generated secrets, replaces the password hash only when a new password is supplied, and applies only unapplied migrations. It never inserts a candidate profile. A new database contains one neutral owner workspace with onboarding incomplete and automation disabled.

To apply later migrations without changing the login configuration, run
`env -i PATH="$PATH" HOME="$HOME" npm run db:migrate -- --env-file .env.local`.
Replace `.env.local` with the protected configuration's explicit path when stored elsewhere;
use that same file for setup, migration and verification. The isolated environment prevents
another installation's exported database URL from overriding the selected file.

For a non-interactive installer, put the password in a mode-`0600` temporary file and use
`env -i PATH="$PATH" HOME="$HOME" npm run setup -- --env-file .env.local --password-file /protected/path/password`.
Remove that file after setup. Never pass the password as a command-line argument.

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
env -i PATH="$PATH" HOME="$HOME" \
  npm run verify:setup -- --env-file .env.local --url https://jobs.example.com
```

Use the same installation’s protected file that was configured above; replace `.env.local`
with its explicit path if stored elsewhere. Clearing inherited variables prevents another
installation’s database or credentials from overriding it. The command exits nonzero when a required check fails. Optional components report `disabled`; checks that need a running URL report `not tested` when no URL is supplied. Add `--json` for machine-readable output. Redirect that output only to a protected location because even sanitized host and version metadata may be private.

## Optional local PostgreSQL with Docker

Docker is only a convenience for development. If it is installed, copy `examples/postgres.compose.yml`, set a strong password in a protected environment file, and start the database with your Compose implementation. The application itself still runs through npm. This recipe is supplied as an example and is not part of the required installation path.

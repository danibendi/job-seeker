#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT=@@PROJECT_NAME@@
SOURCE_ROOT=@@SOURCE_ROOT@@
ACCOUNT_ID=@@ACCOUNT_ID@@
SCOPE=@@SCOPE@@
APP_URL=@@APP_URL@@
SOURCE_REVISION=@@SOURCE_REVISION@@
FUNCTION_REGION=@@FUNCTION_REGION@@
STATE_FILE="$SCRIPT_DIR/vercel-project.json"

if [ -z "${VERCEL_TOKEN:-}" ]; then
  echo "VERCEL_TOKEN must be supplied through the caller's secret manager" >&2
  exit 2
fi

ACTUAL_REVISION=$(git -C "$SOURCE_ROOT" rev-parse HEAD)
if [ "$ACTUAL_REVISION" != "$SOURCE_REVISION" ]; then
  echo "sourceRoot HEAD does not match sourceRevision" >&2
  exit 2
fi
if [ -n "$(git -C "$SOURCE_ROOT" status --porcelain --untracked-files=all -- package.json package-lock.json next.config.ts next-env.d.ts tsconfig.json postcss.config.mjs eslint.config.mjs drizzle.config.ts src public drizzle)" ]; then
  echo "deployment allowlist contains tracked or untracked changes" >&2
  exit 2
fi

set -a
# shellcheck disable=SC1091
. "$SCRIPT_DIR/app.env"
set +a

PROJECT="$PROJECT" ACCOUNT_ID="$ACCOUNT_ID" STATE_FILE="$STATE_FILE" FUNCTION_REGION="$FUNCTION_REGION" node <<'NODE'
import { constants, lstatSync, readFileSync, writeFileSync } from "node:fs";
const { PROJECT: project, ACCOUNT_ID: accountId, STATE_FILE: stateFile, FUNCTION_REGION: functionRegion } = process.env;
const headers = {
  authorization: `Bearer ${process.env.VERCEL_TOKEN}`,
  "content-type": "application/json",
};
const query = `?teamId=${encodeURIComponent(accountId)}`;
let prior = null;
try {
  const info = lstatSync(stateFile);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error("unsafe Vercel state file");
  prior = JSON.parse(readFileSync(stateFile, "utf8"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
let response = await fetch(`https://api.vercel.com/v9/projects/${encodeURIComponent(project)}${query}`, { headers });
let body;
if (response.status === 404) {
  if (prior) throw new Error("recorded Vercel project is missing; inspect before recreating");
  response = await fetch(`https://api.vercel.com/v11/projects${query}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: project, framework: "nextjs" }),
  });
  if (!response.ok) throw new Error(`Vercel project creation failed: ${response.status}`);
  body = await response.json();
  if (body.name !== project || body.accountId !== accountId || !body.id) {
    throw new Error("Vercel created a project outside the expected account");
  }
  writeFileSync(stateFile, JSON.stringify({ id: body.id, name: body.name, accountId }) + "\n", {
    encoding: "utf8", mode: 0o600, flag: constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
  });
} else {
  if (!response.ok) throw new Error(`Vercel project lookup failed: ${response.status}`);
  body = await response.json();
  if (!prior || prior.id !== body.id || prior.name !== project || prior.accountId !== accountId || body.accountId !== accountId) {
    throw new Error("existing Vercel project has no matching local ownership record");
  }
}
response = await fetch(`https://api.vercel.com/v9/projects/${encodeURIComponent(body.id)}${query}`, {
  method: "PATCH",
  headers,
  body: JSON.stringify({
    framework: "nextjs",
    nodeVersion: "22.x",
    serverlessFunctionRegion: functionRegion,
  }),
});
if (!response.ok) throw new Error(`Vercel project configuration failed: ${response.status}`);
body = await response.json();
if (body.accountId !== accountId || body.framework !== "nextjs" || body.nodeVersion !== "22.x" || body.serverlessFunctionRegion !== functionRegion) {
  throw new Error("Vercel did not retain account, framework, Node version, and function region");
}
NODE

for name in DATABASE_URL DATABASE_URL_UNPOOLED AUTH_PASSWORD_HASH SESSION_SECRET OWNER_MCP_TOKEN COMPASS_WORKERS_JSON COMPASS_SCHEDULER_TOKEN JOB_SEEKER_SOURCE_REVISION; do
  printenv "$name" | vercel env add "$name" production --project "$PROJECT" --scope "$SCOPE" --sensitive --force --yes >/dev/null
done

STAGE=$(mktemp -d "${TMPDIR:-/tmp}/job-seeker-vercel.XXXXXX")
chmod 700 "$STAGE"
trap 'rm -rf "$STAGE"' EXIT HUP INT TERM
for entry in package.json package-lock.json next.config.ts next-env.d.ts tsconfig.json postcss.config.mjs eslint.config.mjs drizzle.config.ts src public drizzle; do
  if [ ! -e "$SOURCE_ROOT/$entry" ]; then
    echo "required deployment input is missing: $entry" >&2
    exit 2
  fi
  if find "$SOURCE_ROOT/$entry" -type l -print -quit | grep -q .; then
    echo "deployment input contains a symbolic link: $entry" >&2
    exit 2
  fi
  cp -R "$SOURCE_ROOT/$entry" "$STAGE/$entry"
done

vercel deploy "$STAGE" --prod --project "$PROJECT" --scope "$SCOPE" --regions "$FUNCTION_REGION" --yes

APP_URL="$APP_URL" SOURCE_REVISION="$SOURCE_REVISION" node <<'NODE'
const endpoint = new URL("/api/health", process.env.APP_URL);
const response = await fetch(endpoint, { redirect: "manual", signal: AbortSignal.timeout(15000) });
const body = await response.json().catch(() => ({}));
if (!response.ok || body.ok !== true || body.database !== "connected" || body.version !== "0.1.0" || body.protocolVersion !== 1 || body.sourceRevision !== process.env.SOURCE_REVISION) {
  throw new Error(`deployed health verification failed: ${response.status}`);
}
console.log(JSON.stringify({ status: "deployed_health_passed", sourceRevision: body.sourceRevision }));
NODE

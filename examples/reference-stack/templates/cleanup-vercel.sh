#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT=@@PROJECT_NAME@@
ACCOUNT_ID=@@ACCOUNT_ID@@
STATE_FILE="$SCRIPT_DIR/vercel-project.json"

if [ -z "${VERCEL_TOKEN:-}" ]; then
  echo "VERCEL_TOKEN must be supplied through the caller's secret manager" >&2
  exit 2
fi

PROJECT="$PROJECT" ACCOUNT_ID="$ACCOUNT_ID" STATE_FILE="$STATE_FILE" node <<'NODE'
import { lstatSync, readFileSync, unlinkSync } from "node:fs";
const { PROJECT: project, ACCOUNT_ID: accountId, STATE_FILE: stateFile } = process.env;
const info = lstatSync(stateFile);
if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error("unsafe Vercel state file");
const owned = JSON.parse(readFileSync(stateFile, "utf8"));
if (!owned.id || owned.name !== project || owned.accountId !== accountId) {
  throw new Error("Vercel ownership record does not match this stack");
}
const headers = { authorization: `Bearer ${process.env.VERCEL_TOKEN}` };
const query = `?teamId=${encodeURIComponent(accountId)}`;
let response = await fetch(`https://api.vercel.com/v9/projects/${encodeURIComponent(owned.id)}${query}`, { headers });
if (!response.ok) throw new Error(`Vercel project pre-delete lookup failed: ${response.status}`);
const current = await response.json();
if (current.id !== owned.id || current.name !== project || current.accountId !== accountId) {
  throw new Error("Vercel project no longer matches the ownership record");
}
response = await fetch(`https://api.vercel.com/v9/projects/${encodeURIComponent(owned.id)}${query}`, {
  method: "DELETE", headers,
});
if (!response.ok) throw new Error(`Vercel project deletion failed: ${response.status}`);
response = await fetch(`https://api.vercel.com/v9/projects/${encodeURIComponent(owned.id)}${query}`, { headers });
if (response.status !== 404) throw new Error(`Vercel project absence check failed: ${response.status}`);
unlinkSync(stateFile);
console.log(JSON.stringify({ status: "deleted_and_absent", project }));
NODE

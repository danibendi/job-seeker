#!/usr/bin/env node

import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { parseEnvFile } from "./lib/env-file.mjs";

const VALID_STATUSES = new Set(["passed", "failed", "disabled", "not tested"]);

function parseArgs(argv) {
  const result = { envFile: ".env.local", url: "", json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--env-file") result.envFile = argv[++index] ?? "";
    else if (value === "--url") result.url = argv[++index] ?? "";
    else if (value === "--json") result.json = true;
    else if (value === "--help" || value === "-h") result.help = true;
    else throw new Error(`Unknown option: ${value}`);
  }
  return result;
}

function usage() {
  console.log(`Usage: npm run verify:setup -- [--env-file PATH] [--url URL] [--json]

Produces a sanitized installation report. Checks use only the statuses passed,
failed, disabled, and not tested. No credentials or connection strings are shown.`);
}

function check(id, status, detail) {
  if (!VALID_STATUSES.has(status)) throw new Error(`Invalid check status: ${status}`);
  return { id, status, detail };
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
}

async function readConfiguration(file) {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return { values: {}, check: check("environment_file", "failed", "Path is not a regular, non-symbolic file") };
    const mode = stat.mode & 0o777;
    return {
      values: parseEnvFile(await readFile(file, "utf8")),
      check: mode & 0o077
        ? check("environment_file", "failed", "File permissions allow group or other access")
        : check("environment_file", "passed", "Protected file is present"),
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { values: {}, check: check("environment_file", "failed", "File is missing") };
    return { values: {}, check: check("environment_file", "failed", "File could not be inspected") };
  }
}

function verifyWorkerRegistry(value) {
  if (!value) return check("worker_automation", "disabled", "No worker registry is configured");
  try {
    const workers = JSON.parse(value);
    const valid = Array.isArray(workers) && workers.length > 0 && workers.every((worker) =>
      worker && typeof worker.id === "string" && worker.id.length > 0
      && ["api", "codex", "hermes"].includes(worker.executor)
      && typeof worker.token === "string" && worker.token.length >= 32);
    return valid
      ? check("worker_automation", "passed", `${workers.length} worker registration(s) are structurally valid`)
      : check("worker_automation", "failed", "Worker registry has an invalid structure");
  } catch {
    return check("worker_automation", "failed", "Worker registry is not valid JSON");
  }
}

async function verifyDatabase(env) {
  if (!env.DATABASE_URL) return [check("database_configuration", "failed", "DATABASE_URL is missing")];
  const checks = [check("database_configuration", "passed", "DATABASE_URL is present")];
  let sql;
  try {
    const { default: postgres } = await import("postgres");
    sql = postgres(env.DATABASE_URL_UNPOOLED || env.DATABASE_URL, { max: 1, prepare: false, connect_timeout: 8, idle_timeout: 2 });
    const [objects] = await sql`
      select
        to_regclass('drizzle.__drizzle_migrations') is not null as migrations,
        to_regclass('public.workspaces') is not null as workspaces
    `;
    checks.push(check("database_connection", "passed", "PostgreSQL accepted a query"));
    if (objects?.migrations && objects?.workspaces) {
      const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
      const expected = Array.isArray(journal.entries) ? journal.entries.length : 0;
      const [migrationState] = await sql`select count(*)::int as applied from drizzle.__drizzle_migrations`;
      checks.push(Number(migrationState?.applied) === expected
        ? check("database_migrations", "passed", `${expected} migration(s) are applied`)
        : check("database_migrations", "failed", `Expected ${expected} applied migration(s); found ${Number(migrationState?.applied ?? 0)}`));
    } else {
      checks.push(check("database_migrations", "failed", "Expected migrated tables are missing"));
    }
    if (objects?.workspaces) {
      const [workspace] = await sql`select onboarding_completed_at is not null as configured from workspaces where id = 'owner' limit 1`;
      checks.push(workspace
        ? check("workspace", "passed", workspace.configured ? "Owner workspace exists and onboarding is complete" : "Owner workspace exists; onboarding is pending")
        : check("workspace", "failed", "Owner workspace is missing"));
    }
  } catch {
    checks.push(check("database_connection", "failed", "PostgreSQL connection or verification query failed"));
    checks.push(check("database_migrations", "not tested", "Database connection did not pass"));
  } finally {
    if (sql) await sql.end({ timeout: 2 }).catch(() => {});
  }
  return checks;
}

async function fetchWithTimeout(url, init = {}) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(10_000), redirect: "manual" });
}

async function verifyApplication(baseUrl, ownerToken) {
  if (!baseUrl) return [check("application_health", "not tested", "Set JOB_SEEKER_APP_URL or pass --url to test a running app")];
  const parsed = safeUrl(baseUrl);
  if (!parsed) return [check("application_health", "failed", "Application URL is invalid")];
  const checks = [];
  try {
    const response = await fetchWithTimeout(new URL("/api/health", parsed));
    const body = await response.json().catch(() => ({}));
    checks.push(response.ok && body.ok === true && body.database === "connected"
      ? check("application_health", "passed", "Health endpoint reports an available database")
      : check("application_health", "failed", `Health endpoint returned HTTP ${response.status}`));
  } catch {
    checks.push(check("application_health", "failed", "Health endpoint could not be reached"));
  }

  if (!ownerToken) {
    checks.push(check("owner_mcp_runtime", "disabled", "Owner MCP token is not configured"));
    return checks;
  }
  const endpoint = new URL("/api/mcp", parsed);
  const request = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "job-seeker-verify", version: "0.1.0" } },
  };
  const headers = { accept: "application/json, text/event-stream", "content-type": "application/json" };
  try {
    const denied = await fetchWithTimeout(endpoint, { method: "POST", headers: { ...headers, authorization: "Bearer invalid-verification-token" }, body: JSON.stringify(request) });
    const accepted = await fetchWithTimeout(endpoint, { method: "POST", headers: { ...headers, authorization: `Bearer ${ownerToken}` }, body: JSON.stringify(request) });
    checks.push(denied.status === 401 && accepted.ok
      ? check("owner_mcp_runtime", "passed", "Invalid bearer was rejected and initialization was accepted")
      : check("owner_mcp_runtime", "failed", "MCP authorization or initialization did not behave as expected"));
  } catch {
    checks.push(check("owner_mcp_runtime", "failed", "MCP endpoint could not be verified"));
  }
  return checks;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return usage();
  const config = await readConfiguration(path.resolve(options.envFile));
  const env = { ...config.values, ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)) };
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const environmentFileCheck = config.check.status === "failed"
    && Object.keys(config.values).length === 0
    && Boolean(process.env.DATABASE_URL && process.env.SESSION_SECRET && process.env.AUTH_PASSWORD_HASH)
    ? check("environment_file", "not tested", "Configuration is supplied through the process environment")
    : config.check;
  const checks = [
    environmentFileCheck,
    nodeMajor >= 22 && nodeMajor < 25
      ? check("node_runtime", "passed", `Node ${process.versions.node}`)
      : check("node_runtime", "failed", `Node ${process.versions.node}; supported majors are 22 through 24`),
    env.SESSION_SECRET?.length >= 32
      ? check("session_secret", "passed", "Session secret is present and long enough")
      : check("session_secret", "failed", "SESSION_SECRET must contain at least 32 characters"),
    /^\$2[aby]\$\d{2}\$/.test(env.AUTH_PASSWORD_HASH ?? "")
      ? check("login_password", "passed", "A bcrypt password hash is configured")
      : check("login_password", "failed", "AUTH_PASSWORD_HASH is missing or malformed"),
    env.OWNER_MCP_TOKEN || env.HERMES_API_TOKEN
      ? check("owner_mcp_configuration", "passed", "A bearer token is configured")
      : check("owner_mcp_configuration", "disabled", "Owner MCP is not configured"),
    verifyWorkerRegistry(env.COMPASS_WORKERS_JSON),
    env.COMPASS_SCHEDULER_TOKEN
      ? check("scheduler", env.COMPASS_SCHEDULER_TOKEN.length >= 32 ? "passed" : "failed", env.COMPASS_SCHEDULER_TOKEN.length >= 32 ? "Scheduler credential is configured" : "Scheduler credential is too short")
      : check("scheduler", "disabled", "No scheduler credential is configured"),
    env.LINKEDIN_COLLECTOR_TOKEN
      ? check("linkedin_collector", env.LINKEDIN_COLLECTOR_TOKEN.length >= 32 ? "passed" : "failed", env.LINKEDIN_COLLECTOR_TOKEN.length >= 32 ? "Collector credential is configured" : "Collector credential is too short")
      : check("linkedin_collector", "disabled", "LinkedIn collection is not configured"),
  ];
  checks.push(...await verifyDatabase(env));
  const appUrl = options.url || env.JOB_SEEKER_APP_URL || env.COMPASS_APP_URL || "";
  checks.push(...await verifyApplication(appUrl, env.OWNER_MCP_TOKEN || env.HERMES_API_TOKEN));

  const report = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    product: "Job Seeker",
    checks,
    summary: Object.fromEntries([...VALID_STATUSES].map((status) => [status, checks.filter((item) => item.status === status).length])),
  };
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`Job Seeker setup verification (${report.generated_at})`);
    for (const item of checks) console.log(`${item.status.padEnd(10)} ${item.id}: ${item.detail}`);
    console.log(`Summary: ${Object.entries(report.summary).map(([status, count]) => `${status}=${count}`).join(", ")}`);
  }
  if (checks.some((item) => item.status === "failed")) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`Verification failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});

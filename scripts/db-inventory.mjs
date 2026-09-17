#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmod, lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";
import { parseEnvFile } from "./lib/env-file.mjs";

function parseArgs(argv) {
  const options = { envFile: ".env.local", output: "", compare: [], allowDifferences: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--env-file") options.envFile = argv[++index] ?? "";
    else if (value === "--output") options.output = argv[++index] ?? "";
    else if (value === "--compare") options.compare = [argv[++index] ?? "", argv[++index] ?? ""];
    else if (value === "--allow-differences") options.allowDifferences = true;
    else if (value === "--help" || value === "-h") options.help = true;
    else throw new Error(`Unknown option: ${value}`);
  }
  return options;
}

function usage() {
  console.log(`Usage:
  npm run db:inventory -- [--env-file PATH] [--output PATH]
  npm run db:inventory -- --compare BEFORE.json AFTER.json [--allow-differences]

Inventory mode reads every public table without modifying it and records only
row counts plus SHA-256 digests of canonical PostgreSQL JSON. Compare mode never
connects to a database. Reports contain no row values or connection strings.`);
}

async function loadEnv(file) {
  try {
    return parseEnvFile(await readFile(path.resolve(file), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

function identifier(...parts) {
  return parts.map((part) => `"${String(part).replaceAll('"', '""')}"`).join(".");
}

async function inventory(options) {
  const fileValues = await loadEnv(options.envFile);
  const url = process.env.DATABASE_URL_UNPOOLED || fileValues.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || fileValues.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL or DATABASE_URL_UNPOOLED is required");
  const sql = postgres(url, { max: 1, prepare: false, connect_timeout: 10, idle_timeout: 2 });
  try {
    const tableRows = await sql`
      select table_schema, table_name
      from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
      order by table_name
    `;
    const tables = [];
    for (const table of tableRows) {
      const rows = await sql.unsafe(`select to_jsonb(t)::text as row_json from ${identifier(table.table_schema, table.table_name)} t order by to_jsonb(t)::text`);
      const digest = createHash("sha256");
      for (const row of rows) digest.update(row.row_json).update("\n");
      tables.push({ table: table.table_name, rows: rows.length, sha256: digest.digest("hex") });
    }
    return {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      database: "redacted",
      scope: "public base tables",
      tables,
      totals: { tables: tables.length, rows: tables.reduce((total, table) => total + table.rows, 0) },
    };
  } finally {
    await sql.end({ timeout: 2 }).catch(() => {});
  }
}

async function writeProtected(file, value) {
  const target = path.resolve(file);
  try {
    const stat = await lstat(target);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Output path must be a regular, non-symbolic file");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(target, 0o600);
  console.log(`Sanitized inventory written: ${target}`);
}

async function compare(options) {
  if (options.compare.some((value) => !value)) throw new Error("--compare requires two report paths");
  const [before, after] = await Promise.all(options.compare.map(async (file) => JSON.parse(await readFile(path.resolve(file), "utf8"))));
  const left = new Map(before.tables.map((table) => [table.table, table]));
  const right = new Map(after.tables.map((table) => [table.table, table]));
  const names = [...new Set([...left.keys(), ...right.keys()])].sort();
  const tables = names.map((name) => {
    const oldTable = left.get(name);
    const newTable = right.get(name);
    const status = !oldTable ? "added" : !newTable ? "removed" : oldTable.rows === newTable.rows && oldTable.sha256 === newTable.sha256 ? "unchanged" : "changed";
    return {
      table: name,
      status,
      before_rows: oldTable?.rows ?? null,
      after_rows: newTable?.rows ?? null,
      before_sha256: oldTable?.sha256 ?? null,
      after_sha256: newTable?.sha256 ?? null,
    };
  });
  const result = {
    schema_version: 1,
    compared_at: new Date().toISOString(),
    tables,
    summary: Object.fromEntries(["unchanged", "changed", "added", "removed"].map((status) => [status, tables.filter((table) => table.status === status).length])),
  };
  console.log(JSON.stringify(result, null, 2));
  if (!options.allowDifferences && tables.some((table) => table.status !== "unchanged")) process.exitCode = 1;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return usage();
  if (options.compare.length) return compare(options);
  const report = await inventory(options);
  if (options.output) await writeProtected(options.output, report);
  else console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(`Inventory failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});

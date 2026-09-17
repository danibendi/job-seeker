#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseEnvFile } from "./lib/env-file.mjs";

function optionsFor(argv) {
  const options = { envFile: ".env.local" };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--env-file") options.envFile = argv[++index] ?? "";
    else if (value === "--help" || value === "-h") options.help = true;
    else throw new Error(`Unknown option: ${value}`);
  }
  if (!options.envFile) throw new Error("--env-file requires a path");
  return options;
}

async function fileEnvironment(file) {
  try { return parseEnvFile(await readFile(path.resolve(file), "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

async function main() {
  const options = optionsFor(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: npm run db:migrate -- [--env-file PATH]");
    return;
  }
  const fromFile = await fileEnvironment(options.envFile);
  const environment = { ...fromFile, ...process.env };
  if (!environment.DATABASE_URL_UNPOOLED && !environment.DATABASE_URL) {
    throw new Error("DATABASE_URL or DATABASE_URL_UNPOOLED is required");
  }
  const cli = path.resolve("node_modules/drizzle-kit/bin.cjs");
  const result = spawnSync(process.execPath, [cli, "migrate"], { cwd: process.cwd(), env: environment, stdio: "inherit" });
  if (result.error || result.status !== 0) throw new Error("Drizzle migration failed");
}

main().catch((error) => {
  console.error(`Migration failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});

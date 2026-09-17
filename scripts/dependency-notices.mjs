#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function packageName(lockPath, metadata) {
  if (metadata.name) return metadata.name;
  const marker = "node_modules/";
  const remainder = lockPath.slice(lockPath.lastIndexOf(marker) + marker.length);
  const parts = remainder.split("/");
  return parts[0]?.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
}

async function main() {
  const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
  const packages = new Map();
  const missing = [];
  for (const [lockPath, metadata] of Object.entries(lock.packages ?? {})) {
    if (!lockPath || !metadata.version) continue;
    const name = packageName(lockPath, metadata);
    const license = typeof metadata.license === "string" ? metadata.license : metadata.license?.type;
    if (!license) missing.push(`${name}@${metadata.version}`);
    const key = `${name}@${metadata.version}`;
    packages.set(key, { name, version: metadata.version, license: license ?? "UNKNOWN" });
  }
  const manifest = {
    schema_version: 1,
    generated_from: "package-lock.json",
    javascript: [...packages.values()].sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version)),
    python: {
      runtime: "Python standard library only",
      hermes_and_test_extras: [{ name: "PyYAML", license: "MIT", source: "https://github.com/yaml/pyyaml" }],
    },
    external_optional_runtimes: [
      "Codex CLI, installed and licensed separately by the operator",
      "Hermes, installed and licensed separately by the operator",
      "Browser and model API providers, selected and contracted separately by the operator"
    ],
  };
  await writeFile("THIRD_PARTY_NOTICES.json", `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${path.resolve("THIRD_PARTY_NOTICES.json")} (${manifest.javascript.length} JavaScript package versions).`);
  if (missing.length) {
    console.error(`License metadata is missing for ${missing.length} package version(s): ${missing.join(", ")}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`Could not generate dependency notices: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});

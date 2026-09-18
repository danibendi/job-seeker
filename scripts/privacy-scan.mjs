#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const ignoredDirectories = new Set([".git", ".next", "node_modules", "coverage", "__pycache__", ".venv", "venv", "build", "dist"]);
const binaryExtensions = new Set([".ico", ".jpg", ".jpeg", ".png", ".webp", ".gif", ".pdf", ".woff", ".woff2"]);
const legacyCompatibilitySql = [
  /^drizzle\/0013_/,
];
const secretReferenceGuardPaths = new Set([
  "scripts/compass_worker/__main__.py",
  "scripts/compass_worker/api.py",
  "scripts/compass_worker/browser.py",
  "scripts/compass_worker/credentials.py",
  "src/lib/derived-worker-auth.ts",
]);

const contentRules = [
  { id: "private_key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { id: "secret_reference", pattern: /\bop:\/\// },
  { id: "provider_token", pattern: /\b(?:ghp_|github_pat_|glpat-|sk-proj-|xox[baprs]-)[A-Za-z0-9_-]{12,}/ },
  { id: "credentialed_postgres_url", pattern: /postgres(?:ql)?:\/\/(?!placeholder:placeholder@)[^\s:/]+:[^\s@/]+@/i },
  { id: "private_tailnet", pattern: /\b(?:tailscale|[A-Za-z0-9-]+\.ts\.net)\b/i },
];

const forbiddenFileRules = [
  { id: "environment_file", pattern: /(^|\/)\.env(?:\..+)?$/, allow: /\.example$/ },
  { id: "secret_key_file", pattern: /\.(?:pem|key|p12|pfx)$/i },
  { id: "secret_manager_file", pattern: /(?:^|\/).+\.op$/i },
];

async function filesUnder(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    // In a Git worktree this is a pointer file, not a directory. Neither form
    // belongs to the publishable source tree.
    if (entry.name === ".git") continue;
    if (entry.isDirectory() && (ignoredDirectories.has(entry.name) || entry.name.endsWith(".egg-info"))) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(absolute, relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

function ruleAllowed(file, rule) {
  if (file === "scripts/privacy-scan.mjs") return true;
  if (rule.id === "secret_reference" && secretReferenceGuardPaths.has(file)) return true;
  return rule.id === "private_term" && legacyCompatibilitySql.some((pattern) => pattern.test(file));
}

function withoutSafeLocalUrls(content) {
  return content.replace(/postgres(?:ql)?:\/\/(?:placeholder:placeholder|test:test)@(?:127\.0\.0\.1|localhost)(?=[:/\s"'])/gi, "");
}

async function privateTerms(argv) {
  const terms = (process.env.JOB_SEEKER_PRIVATE_TERMS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--deny-terms-file") {
      const file = argv[++index];
      if (!file) throw new Error("--deny-terms-file requires a path");
      const lines = (await readFile(path.resolve(file), "utf8")).split(/\r?\n/).map((value) => value.trim()).filter((value) => value && !value.startsWith("#"));
      terms.push(...lines);
    } else if (argv[index] === "--help" || argv[index] === "-h") {
      console.log("Usage: npm run privacy:scan -- [--deny-terms-file /protected/path] [--help]");
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${argv[index]}`);
    }
  }
  return [...new Set(terms)];
}

async function main() {
  const denyTerms = await privateTerms(process.argv.slice(2));
  const rules = [
    ...contentRules,
    ...denyTerms.map((term) => ({ id: "private_term", pattern: new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") })),
  ];
  const files = (await filesUnder(root)).sort();
  const findings = [];
  for (const file of files) {
    for (const rule of forbiddenFileRules) {
      if (rule.pattern.test(file) && !rule.allow?.test(file)) findings.push({ file, rule: rule.id });
    }
    if (binaryExtensions.has(path.extname(file).toLowerCase())) continue;
    let content;
    try { content = await readFile(path.join(root, file), "utf8"); }
    catch { continue; }
    for (const rule of rules) {
      const inspected = rule.id === "credentialed_postgres_url" ? withoutSafeLocalUrls(content) : content;
      if (!ruleAllowed(file, rule) && rule.pattern.test(inspected)) findings.push({ file, rule: rule.id });
    }
  }

  if (findings.length) {
    console.error("Privacy scan failed:");
    for (const finding of findings) console.error(`- ${finding.file}: ${finding.rule}`);
    console.error("The scan reports locations and rule names only; inspect values locally and never paste secrets into an issue.");
    process.exitCode = 1;
    return;
  }
  console.log(`Privacy scan passed (${files.length} files, ${denyTerms.length} publisher term(s); values were not printed).`);
}

main().catch(() => {
  console.error("Privacy scan failed before completion.");
  process.exitCode = 1;
});

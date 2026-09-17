/** Parse the simple KEY=VALUE subset used by Job Seeker's protected env files. */
export function parseEnvFile(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2];
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\([\\"$nrt])/g, (_match, escaped) => {
        if (escaped === "n") return "\n";
        if (escaped === "r") return "\r";
        if (escaped === "t") return "\t";
        return escaped;
      });
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\\\$/g, "$");
    }
    values[match[1]] = value;
  }
  return values;
}

/**
 * Serialize one value for Next.js' dotenv + dotenv-expand loader.
 * Dollar signs must be escaped or bcrypt hashes are treated as substitutions.
 */
export function quoteEnvValue(value) {
  return `"${String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("$", "\\$")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t")}"`;
}

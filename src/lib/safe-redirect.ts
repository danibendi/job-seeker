export function safeInternalPath(value: string | null | undefined, fallback = "/") {
  if (!value || !value.startsWith("/")) return fallback;
  try {
    let decoded = value;
    for (let pass = 0; pass < 2; pass += 1) decoded = decodeURIComponent(decoded);
    const hasControl = [...decoded].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
    if (decoded.startsWith("//") || decoded.includes("\\") || hasControl) return fallback;
    const parsed = new URL(value, "https://compass.invalid");
    if (parsed.origin !== "https://compass.invalid") return fallback;
    return parsed.pathname + parsed.search + parsed.hash;
  } catch {
    return fallback;
  }
}

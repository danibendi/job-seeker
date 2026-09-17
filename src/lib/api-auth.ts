import "server-only";
import { timingSafeEqual } from "node:crypto";

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) {
    timingSafeEqual(a, Buffer.alloc(a.length));
    return false;
  }
  return timingSafeEqual(a, b);
}

function bearerMatches(header: string | null, configuredValue: string | undefined) {
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = header.slice(7).trim();
  const configured = (configuredValue ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
  let matched = false;
  for (const token of configured) matched = safeEqual(supplied, token) || matched;
  return configured.length > 0 && matched;
}

export function bearerIsValid(header: string | null) {
  return bearerMatches(header, process.env.OWNER_MCP_TOKEN)
    || bearerMatches(header, process.env.HERMES_API_TOKEN);
}

export function collectorBearerIsValid(header: string | null) {
  return bearerMatches(header, process.env.LINKEDIN_COLLECTOR_TOKEN);
}

export function unauthorized() {
  return Response.json({ error: "Unauthorized" }, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
}

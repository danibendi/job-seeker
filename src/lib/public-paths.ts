const PUBLIC_PATHS = ["/login", "/api/auth/", "/api/mcp", "/api/bridge/", "/api/linkedin/", "/api/worker/", "/api/health", "/manifest.webmanifest", "/icon.svg", "/icons/", "/sw.js"];

export function isPublicPath(pathname: string) {
  return PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(path));
}

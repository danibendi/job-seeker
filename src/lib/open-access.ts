// Explicit local-development switch. Production builds never bypass authentication,
// including on ordinary self-hosted machines where VERCEL_ENV is unset.
export function isOpenAccess() {
  return process.env.NODE_ENV === "development" && process.env.COMPASS_OPEN_ACCESS === "1";
}

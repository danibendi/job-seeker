export const WORKSPACE_ID = "owner" as const;

export const DEFAULT_WORKSPACE = {
  id: WORKSPACE_ID,
  candidateId: "workspace-owner",
  displayName: "Job Seeker",
  ownerName: "",
  assistantLabel: "Assistant",
  locale: "en",
  timeZone: "UTC",
  onboardingCompletedAt: null,
} as const;

const CANDIDATE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,118}[a-z0-9])?$/;
const LOCALE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

function text(value: unknown, maxLength: number) {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, maxLength);
}

export function normalizeWorkspaceInput(input: Record<string, unknown>) {
  const candidateId = text(input.candidateId, 120).toLowerCase();
  const displayName = text(input.displayName, 160);
  const ownerName = text(input.ownerName, 160);
  const assistantLabel = text(input.assistantLabel, 160);
  const locale = text(input.locale, 35);
  const timeZone = text(input.timeZone, 80);

  if (!CANDIDATE_ID.test(candidateId)) throw new Error("Candidate ID may contain lowercase letters, numbers, dots, hyphens, and underscores");
  if (!displayName) throw new Error("Workspace name is required");
  if (!ownerName) throw new Error("Your name is required");
  if (!assistantLabel) throw new Error("Assistant label is required");
  if (!LOCALE.test(locale)) throw new Error("Locale must be a language tag such as en or en-GB");
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format();
  } catch {
    throw new Error("Choose a valid IANA time zone");
  }
  return { candidateId, displayName, ownerName, assistantLabel, locale, timeZone };
}

export const WORK_MODES = [
  { id: "onsite", label: "On-site" },
  { id: "hybrid", label: "Hybrid" },
] as const;

export const SCHEDULE_FREQUENCIES = [
  { id: "weekdays", label: "Every weekday" },
  { id: "daily", label: "Every day" },
  { id: "weekly", label: "Once a week" },
  { id: "custom", label: "Chosen days" },
] as const;

export const WEEKDAYS = [
  { id: "mon", label: "Mon" },
  { id: "tue", label: "Tue" },
  { id: "wed", label: "Wed" },
  { id: "thu", label: "Thu" },
  { id: "fri", label: "Fri" },
  { id: "sat", label: "Sat" },
  { id: "sun", label: "Sun" },
] as const;

export type Weekday = (typeof WEEKDAYS)[number]["id"];
export type ScheduleFrequency = (typeof SCHEDULE_FREQUENCIES)[number]["id"];

export type OfficeLocation = { city: string; country: string; radiusKm: number };
export type RemoteSearchLocation = { city: string; country: string };
/** searchLocations is optional only for stored JSON written before this field existed. */
export type RemoteSettings = { enabled: boolean; countries: string[]; includeWorldwide: boolean; includeUnspecified: boolean; searchLocations?: RemoteSearchLocation[] };
export type NormalizedRemoteSettings = Omit<RemoteSettings, "searchLocations"> & { searchLocations: RemoteSearchLocation[] };
export type SearchSchedule = { enabled: boolean; frequency: ScheduleFrequency; time: string; days: Weekday[]; maxJobs: number };

export type SearchSettingsValues = {
  minimumFitScore: number;
  followUpDays: number;
  targetRoles: string[];
  languages: string[];
  excludedCompanies: string[];
  excludedKeywords: string[];
  locations: OfficeLocation[];
  workModes: string[];
  remote: RemoteSettings;
  schedule: SearchSchedule;
  tailorCvSuggestions: boolean;
  notesMd: string | null;
};

export type EffectiveSearchPolicy = {
  schema: "compass.effective-search-policy";
  schemaVersion: 1;
  minimumFitScore: number;
  roles: { targets: string[] };
  languages: { accepted: string[] };
  office: { workModes: string[]; locations: Array<{ city: string; countryCode: string; radiusKm: number }> };
  remote: { enabled: boolean; eligibleCountryCodes: string[]; searchLocations: Array<{ city: string; countryCode: string }>; includeWorldwide: boolean; includeUnspecified: boolean };
  exclusions: { companies: string[]; keywords: string[] };
  tailoring: { suggestCv: boolean };
  additionalRequirements: { scope: "semantic_role_fit_only"; values: string[] };
};

export const LIMITS = { roles: 12, keywords: 30, companies: 30, languages: 8, locations: 8, remoteCountries: 30, remoteSearchLocations: 8 } as const;

export const DEFAULT_SEARCH_SETTINGS: SearchSettingsValues = {
  minimumFitScore: 60,
  followUpDays: 14,
  targetRoles: [],
  languages: [],
  excludedCompanies: [],
  excludedKeywords: [],
  locations: [],
  workModes: [],
  remote: { enabled: false, countries: [], searchLocations: [], includeWorldwide: false, includeUnspecified: false },
  schedule: { enabled: false, frequency: "weekdays", time: "09:00", days: [], maxJobs: 15 },
  tailorCvSuggestions: true,
  notesMd: null,
};

export const DEFAULT_TIME_ZONE = "UTC";

/**
 * The sole operational search policy. This deliberately excludes schedule and
 * follow-up preferences because changing them cannot alter a job decision.
 */
export function effectiveSearchPolicy(settings: SearchSettingsValues): EffectiveSearchPolicy {
  const configuredRemoteLocations = normalizeRemoteSearchLocations(settings.remote.searchLocations);
  const remoteSearchLocations = configuredRemoteLocations.length
    ? configuredRemoteLocations
    : normalizeRemoteSearchLocations(settings.locations);
  return {
    schema: "compass.effective-search-policy",
    schemaVersion: 1,
    minimumFitScore: settings.minimumFitScore,
    roles: { targets: [...settings.targetRoles] },
    languages: { accepted: [...settings.languages] },
    office: {
      workModes: [...settings.workModes],
      locations: settings.locations.map(({ city, country, radiusKm }) => ({ city, countryCode: country, radiusKm })),
    },
    remote: {
      enabled: settings.remote.enabled,
      eligibleCountryCodes: [...settings.remote.countries],
      searchLocations: remoteSearchLocations.map(({ city, country }) => ({ city, countryCode: country })),
      includeWorldwide: settings.remote.includeWorldwide,
      includeUnspecified: settings.remote.includeUnspecified,
    },
    exclusions: { companies: [...settings.excludedCompanies], keywords: [...settings.excludedKeywords] },
    tailoring: { suggestCv: settings.tailorCvSuggestions },
    additionalRequirements: { scope: "semantic_role_fit_only", values: settings.notesMd?.trim() ? [settings.notesMd.trim()] : [] },
  };
}

export function parseList(value: string | null | undefined) {
  return (value ?? "")
    .split(/[\n,;]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item, index, all) => all.indexOf(item) === index);
}

export function uniqueTokens(values: readonly unknown[], limit: number, maxLength = 120) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const text = String(value ?? "").trim().replace(/\s+/g, " ").slice(0, maxLength);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

const COUNTRY_CODE = /^[A-Z]{2}$/;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function normalizeLocations(value: unknown): OfficeLocation[] {
  if (!Array.isArray(value)) return [];
  const out: OfficeLocation[] = [];
  for (const item of value) {
    const record = asRecord(item);
    const city = String(record.city ?? "").trim().slice(0, 80);
    const country = String(record.country ?? "").trim().toUpperCase();
    const radius = Number(record.radiusKm);
    if (!city || !COUNTRY_CODE.test(country)) continue;
    if (out.some((existing) => existing.city.toLowerCase() === city.toLowerCase() && existing.country === country)) continue;
    out.push({ city, country, radiusKm: Number.isFinite(radius) ? Math.min(500, Math.max(0, Math.round(radius))) : 0 });
    if (out.length >= LIMITS.locations) break;
  }
  return out;
}

export function normalizeRemoteSearchLocations(value: unknown): RemoteSearchLocation[] {
  if (!Array.isArray(value)) return [];
  const out: RemoteSearchLocation[] = [];
  for (const item of value) {
    const record = asRecord(item);
    const city = String(record.city ?? "").trim().replace(/\s+/g, " ").slice(0, 80);
    const country = String(record.country ?? record.countryCode ?? "").trim().toUpperCase();
    if (!city || !COUNTRY_CODE.test(country)) continue;
    if (out.some((existing) => existing.city.toLowerCase() === city.toLowerCase() && existing.country === country)) continue;
    out.push({ city, country });
    if (out.length >= LIMITS.remoteSearchLocations) break;
  }
  return out;
}

export function normalizeRemote(value: unknown): NormalizedRemoteSettings {
  const record = asRecord(value);
  const countries = Array.isArray(record.countries) ? uniqueTokens(record.countries.map((code) => String(code).trim().toUpperCase()).filter((code) => COUNTRY_CODE.test(code)), LIMITS.remoteCountries) : [];
  return {
    enabled: Boolean(record.enabled),
    countries,
    searchLocations: normalizeRemoteSearchLocations(record.searchLocations),
    includeWorldwide: Boolean(record.includeWorldwide),
    includeUnspecified: Boolean(record.includeUnspecified),
  };
}

export function normalizeSchedule(value: unknown): SearchSchedule {
  const record = asRecord(value);
  const frequency = SCHEDULE_FREQUENCIES.some((option) => option.id === record.frequency) ? (record.frequency as ScheduleFrequency) : "weekdays";
  const time = typeof record.time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(record.time) ? record.time : "09:00";
  const rawDays: unknown[] = Array.isArray(record.days) ? record.days : [];
  const days = WEEKDAYS.map((day) => day.id).filter((day) => rawDays.includes(day));
  const maxJobs = Number(record.maxJobs);
  return {
    enabled: record.enabled === true,
    frequency,
    time,
    days: frequency === "weekly" ? days.slice(0, 1) : frequency === "custom" ? days : [],
    maxJobs: Number.isFinite(maxJobs) ? Math.min(100, Math.max(1, Math.round(maxJobs))) : 15,
  };
}

export function scheduleSummary(schedule: SearchSchedule, timeZone: string) {
  if (!schedule.enabled) return "Paused";
  const label = (id: Weekday) => WEEKDAYS.find((day) => day.id === id)?.label ?? id;
  const when = schedule.frequency === "weekdays" ? "Weekdays" : schedule.frequency === "daily" ? "Daily" : schedule.days.length ? schedule.days.map(label).join(", ") : "No days chosen";
  return `${when} · ${schedule.time} ${timeZone.split("/").pop()?.replaceAll("_", " ") ?? timeZone}`;
}

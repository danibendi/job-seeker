export function formatDate(value: Date | string | null | undefined, options?: Intl.DateTimeFormatOptions) {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat("en-GB", options ?? { day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
}

export function formatShortDate(value: Date | string | null | undefined, timeZone?: string) {
  return formatDate(value, { day: "numeric", month: "short", ...(timeZone ? { timeZone } : {}) });
}

export function formatDateTime(value: Date | string | null | undefined, timeZone?: string) {
  return formatDate(value, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    ...(timeZone ? { timeZone, timeZoneName: "short" } : {}),
  });
}

export function formatTime(value: Date | string | null | undefined, timeZone?: string) {
  return formatDate(value, { hour: "2-digit", minute: "2-digit", ...(timeZone ? { timeZone } : {}) });
}

export function formatWeekday(value: Date | string | null | undefined, timeZone?: string) {
  return formatDate(value, { weekday: "short", day: "numeric", month: "short", ...(timeZone ? { timeZone } : {}) });
}

export function formatDateTimeInput(value: Date | string, timeZone: string) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}

export function slugify(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 220);
}

export function normalizeDedupePart(value?: string | null) {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(s\.?r\.?o\.?|a\.?s\.?|ltd\.?|limited|inc\.?|gmbh|corp\.?|company)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function makeDedupeKey(company: string, title: string, location?: string | null) {
  const city = (location ?? "").split(/[·,–—|-]/)[0];
  return [normalizeDedupePart(company), normalizeDedupePart(title), normalizeDedupePart(city)].join("::");
}

export function fitBand(score: number | null | undefined) {
  if (score == null) return "Awaiting analysis";
  if (score >= 80) return "Apply now";
  if (score >= 60) return "Worth a review";
  if (score >= 40) return "Possible with caveats";
  return "Low fit";
}

export function scoreTone(score: number | null | undefined): "good" | "warn" | "low" {
  if (score == null) return "low";
  if (score >= 80) return "good";
  if (score >= 60) return "warn";
  return "low";
}

export function initials(value: string) {
  return value.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "?";
}

export function daysInStage(value: Date | string) {
  return Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000));
}

export function daysAgo(value: Date | string | null | undefined) {
  if (!value) return "";
  const days = daysInStage(value);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? "1 month ago" : `${months} months ago`;
}

export function humanize(value: string | null | undefined) {
  if (!value) return "";
  const text = value.replaceAll("_", " ");
  return text[0].toUpperCase() + text.slice(1);
}

export function shortSource(value: string | null | undefined) {
  if (!value) return "";
  return value.split(/\s+[—–-]\s+|\s+\/\s+/)[0].trim();
}

export function workModeLabel(value: "onsite" | "hybrid" | "remote" | null | undefined) {
  if (!value) return "";
  return { onsite: "On-site", hybrid: "Hybrid", remote: "Remote" }[value];
}

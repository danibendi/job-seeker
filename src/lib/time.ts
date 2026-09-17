export const DEFAULT_TIME_ZONE = "UTC";

export function isValidTimeZone(timeZone: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}

export function zonedDateParts(date = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return { date: `${value("year")}-${value("month")}-${value("day")}`, weekday: value("weekday"), hour: Number(value("hour")), minute: Number(value("minute")) };
}

/** ISO date (yyyy-mm-dd) of the Monday that starts the week containing `date` in `timeZone`. */
export function startOfWeek(date = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const { date: localDate, weekday } = zonedDateParts(date, timeZone);
  const dayIndex = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(weekday);
  const noonUtc = new Date(`${localDate}T12:00:00Z`);
  noonUtc.setUTCDate(noonUtc.getUTCDate() - Math.max(0, dayIndex));
  return noonUtc.toISOString().slice(0, 10);
}

/** Every IANA zone the runtime knows, with UTC first for an unconfigured install. */
export function timeZoneOptions() {
  const preferred = ["UTC"];
  const all = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : preferred;
  return [...preferred, ...all.filter((zone) => !preferred.includes(zone))];
}

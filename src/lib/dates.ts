const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

const ET_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Returns a Date whose UTC getters reflect Korea Standard Time. */
export function kstNow(base: Date = new Date()): Date {
  return new Date(base.getTime() + KST_OFFSET_MS);
}

/** Today's date in KST as YYYY-MM-DD. */
export function kstDate(base: Date = new Date()): string {
  return toDateString(kstNow(base));
}

/** The US Eastern (America/New_York) date as YYYY-MM-DD. */
export function etDate(base: Date = new Date()): string {
  return ET_DATE_FORMATTER.format(base);
}

/** Formats a Date using its UTC getters as YYYY-MM-DD. */
export function toDateString(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** "YYYY-MM-DD" -> "YYYYMMDD" (KIS compact date). */
export function toCompactDate(date: string): string {
  return date.replaceAll("-", "");
}

/** "YYYYMMDD" -> "YYYY-MM-DD". */
export function fromCompactDate(date: string): string {
  if (date.length !== 8) return date;
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
}

export function isValidDate(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date);
}

/** Adds days to a YYYY-MM-DD string (UTC based). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const base = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1));
  base.setUTCDate(base.getUTCDate() + days);
  return toDateString(base);
}

export function isValidDateString(date: string): boolean {
  if (!isValidDate(date)) return false;
  const [y, m, d] = date.split("-").map(Number);
  const base = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1));
  return toDateString(base) === date;
}

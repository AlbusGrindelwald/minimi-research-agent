const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const STOP_WORDS = new Set([
  "about", "again", "answer", "asked", "check", "correct", "could", "did", "does", "for", "from",
  "have", "help", "here", "how", "into", "last", "latest", "more", "most", "much", "new", "now",
  "on", "our", "please", "since", "still", "that", "the", "then", "there", "these", "this", "those",
  "today", "was", "were", "what", "when", "where", "which", "who", "with", "you", "your",
  ...MONTHS, ...WEEKDAYS,
]);

export type LocalDate = { year: number; month: number; day: number };
export type DateResolution = { localDate: string; start: string; end: string };

export function localDateAt(instant: Date, timeZone: string): LocalDate {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return { year: value("year"), month: value("month"), day: value("day") };
}

function dateKey(date: LocalDate): string {
  return `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

function validDate(date: LocalDate): boolean {
  const check = new Date(Date.UTC(date.year, date.month - 1, date.day));
  return check.getUTCFullYear() === date.year && check.getUTCMonth() === date.month - 1 && check.getUTCDate() === date.day;
}

function localMidnight(date: LocalDate, timeZone: string): Date {
  const desired = Date.UTC(date.year, date.month - 1, date.day);
  let guess = desired;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(guess));
    const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
    const represented = Date.UTC(value("year"), value("month") - 1, value("day"), value("hour"), value("minute"), value("second"));
    const delta = desired - represented;
    if (delta === 0) break;
    guess += delta;
  }
  return new Date(guess);
}

export function toDateResolution(date: LocalDate, timeZone: string): DateResolution {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + 1));
  const nextDate = { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
  return {
    localDate: dateKey(date),
    start: localMidnight(date, timeZone).toISOString(),
    end: localMidnight(nextDate, timeZone).toISOString(),
  };
}

export function resolveDatePhrases(text: string, reference: Date, timeZone: string): DateResolution[] {
  const base = localDateAt(reference, timeZone);
  const normalized = text.toLocaleLowerCase("en-US");

  const weekdayMatch = normalized.match(/\b(last\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (weekdayMatch) {
    const targetWeekday = WEEKDAYS.indexOf(weekdayMatch[2]);
    const baseWeekday = new Date(Date.UTC(base.year, base.month - 1, base.day)).getUTCDay();
    let distance = (baseWeekday - targetWeekday + 7) % 7;
    if (weekdayMatch[1] && distance === 0) distance = 7;
    const resolved = new Date(Date.UTC(base.year, base.month - 1, base.day - distance));
    return [toDateResolution({ year: resolved.getUTCFullYear(), month: resolved.getUTCMonth() + 1, day: resolved.getUTCDate() }, timeZone)];
  }

  const monthPattern = MONTHS.join("|");
  const dayFirst = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthPattern})(?:\\s+(\\d{4}))?\\b`, "i");
  const monthFirst = new RegExp(`\\b(${monthPattern})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, "i");
  const match = normalized.match(dayFirst) ?? normalized.match(monthFirst);
  if (!match) return [];

  const day = Number(match[1]) || Number(match[2]);
  const monthName = (MONTHS.includes(match[2]) ? match[2] : match[1]).toLowerCase();
  const explicitYear = match[3] ? Number(match[3]) : (match[4] ? Number(match[4]) : null);
  const month = MONTHS.indexOf(monthName) + 1;
  if (explicitYear) {
    const resolved = { year: explicitYear, month, day };
    return validDate(resolved) ? [toDateResolution(resolved, timeZone)] : [];
  }

  const years = Array.from({ length: 12 }, (_, index) => base.year - index);
  return years.flatMap((year) => {
    const candidate = { year, month, day };
    if (!validDate(candidate)) return [];
    if (localMidnight(candidate, timeZone).getTime() > reference.getTime()) return [];
    return [toDateResolution(candidate, timeZone)];
  });
}

export function resolveDatePhrase(text: string, reference: Date, timeZone: string): DateResolution | null {
  return resolveDatePhrases(text, reference, timeZone)[0] ?? null;
}

export function memoryTerms(text: string): string[] {
  const tokens = text.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  return [...new Set(tokens.filter((token) => !STOP_WORDS.has(token)))].slice(0, 10);
}

export function ftsQuery(terms: string[]): string | null {
  if (terms.length === 0) return null;
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

export function isFreshnessQuestion(text: string): boolean {
  return /\b(today|currently|current|latest|recent|changed|change|since|still correct|still accurate|as of|new pricing|pricing change|ship(?:ped|s)?|releas(?:e|ed|es)|launch(?:ed|es)?|announc(?:e|ed|ement)|version|new features?|updated|update)\b/i.test(text);
}

export function isPricingQuestion(text: string): boolean {
  return /\b(price|pricing|cost|plans?|subscription|free tier|per[- ]seat|billing)\b/i.test(text);
}


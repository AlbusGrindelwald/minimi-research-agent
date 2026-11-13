import { describe, expect, it } from "vitest";
import {
  ftsQuery,
  isFreshnessQuestion,
  isPricingQuestion,
  localDateAt,
  memoryTerms,
  resolveDatePhrase,
  resolveDatePhrases,
} from "./date-memory";

describe("timezone-aware memory dates", () => {
  it("resolves a weekday using the user timezone and excludes future dates", () => {
    const reference = new Date("2026-11-13T19:00:00.000Z");
    const date = resolveDatePhrase("Last Tuesday I asked about Postgres", reference, "Asia/Kolkata");
    expect(date?.localDate).toBe("2026-11-10");
    expect(date?.start).toBe("2026-11-09T18:30:00.000Z");
    expect(date?.end).toBe("2026-11-10T18:30:00.000Z");
  });

  it("returns prior year candidates for an unqualified month and day", () => {
    const results = resolveDatePhrases("What did I ask on 3 November?", new Date("2026-11-13T12:00:00Z"), "UTC");
    expect(results.slice(0, 3).map((date) => date.localDate)).toEqual([
      "2026-11-03", "2025-11-03", "2024-11-03",
    ]);
  });

  it("calculates local calendar boundaries across daylight saving time", () => {
    const date = resolveDatePhrase("on 8 March 2026", new Date("2026-03-20T12:00:00Z"), "America/New_York");
    expect(date?.start).toBe("2026-03-08T05:00:00.000Z");
    expect(date?.end).toBe("2026-03-09T04:00:00.000Z");
    expect(Date.parse(date!.end) - Date.parse(date!.start)).toBe(23 * 60 * 60 * 1000);
  });

  it("does not resolve invalid calendar dates", () => {
    expect(resolveDatePhrases("31 February 2026", new Date("2026-03-20T12:00:00Z"), "UTC")).toEqual([]);
  });

  it("builds safe FTS terms and detects freshness and pricing intent", () => {
    const terms = memoryTerms("What did I ask about PostgreSQL hosting pricing?");
    expect(terms).toContain("postgresql");
    expect(terms).toContain("hosting");
    expect(ftsQuery(["postgresql", 'host"ing'])).toBe('"postgresql" OR "host""ing"');
    expect(isFreshnessQuestion("Has the pricing changed since last week?" )).toBe(true);
    expect(isPricingQuestion("Compare their per-seat plans" )).toBe(true);
  });

  it("reads the date on the user's side of UTC midnight", () => {
    expect(localDateAt(new Date("2026-11-13T18:45:00.000Z"), "Asia/Kolkata")).toEqual({
      year: 2026, month: 11, day: 14,
    });
  });
});

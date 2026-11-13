import { describe, expect, it } from "vitest";
import { unpaidGeminiRegionRestricted } from "./regions";

describe("free Gemini service regions", () => {
  it("blocks EEA, UK, and Switzerland", () => {
    for (const country of ["DE", "IS", "NO", "CH", "GB"]) {
      expect(unpaidGeminiRegionRestricted(country)).toBe(true);
    }
  });

  it("allows supported regions and local requests without a country", () => {
    expect(unpaidGeminiRegionRestricted("US")).toBe(false);
    expect(unpaidGeminiRegionRestricted(undefined)).toBe(false);
  });
});

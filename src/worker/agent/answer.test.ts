import { describe, expect, it } from "vitest";
import type { Source } from "../../shared/types";
import { normalizeAnswer, parseJsonAnswer } from "./answer";

const source: Source = {
  id: "C1",
  title: "Pricing page",
  url: "https://example.com/pricing",
  domain: "example.com",
  excerpt: "Pricing details.",
  publishedAt: null,
  retrievedAt: "2026-11-13T10:00:00.000Z",
  relevance: 0.9,
  vintage: "current",
};

describe("answer citation validation", () => {
  it("keeps only source IDs present in the retrieved catalog", () => {
    const answer = normalizeAnswer({
      text: "The plan costs $10 [[C1]] and another claim [[C99]].",
      sourceIds: ["C1", "C99", "C1"],
      comparison: [{ label: "Price", then: "$8", now: "$10", sourceIds: ["P1", "C1"] }],
    }, [source]);

    expect(answer.sourceIds).toEqual(["C1"]);
    expect(answer.text).toBe("The plan costs $10 [[C1]] and another claim .");
    expect(answer.comparison[0].sourceIds).toEqual(["C1"]);
  });

  it("removes citation markers from invalid unstructured model output", () => {
    const answer = normalizeAnswer("A claim [[C1]] and a fabricated link [[P8]].", [source]);
    expect(answer.sourceIds).toEqual(["C1"]);
    expect(answer.text).toBe("A claim [[C1]] and a fabricated link .");
  });

  it("parses JSON fences but rejects unreadable structured output", () => {
    expect(parseJsonAnswer("```json\n{\"text\":\"ok\"}\n```" )).toEqual({ text: "ok" });
    expect(parseJsonAnswer("not JSON")).toBeNull();
    expect(() => normalizeAnswer({ surprise: true }, [source])).toThrow("unreadable answer");
  });
});

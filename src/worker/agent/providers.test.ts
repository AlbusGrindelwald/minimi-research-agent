import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../env";
import { gemini, parseWebSearchArgs, ProviderError, runWebSearch } from "./providers";

function fakeDatabase(changes = 1) {
  const run = vi.fn(async () => ({ meta: { changes } }));
  const bind = vi.fn(() => ({ run }));
  const prepare = vi.fn(() => ({ bind }));
  return { db: { prepare } as unknown as D1Database, prepare, bind, run };
}

const database = fakeDatabase();
const env = { TAVILY_API_KEY: "test-key", DB: database.db } as AppEnv;

function tavilyResponse(results: unknown[], status = 200): Response {
  return new Response(JSON.stringify({ results }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("bounded web search", () => {
  it("validates one batch of at most five queries", () => {
    expect(parseWebSearchArgs({ queries: ["Postgres hosting pricing"], depth: "advanced" })?.queries).toHaveLength(1);
    expect(parseWebSearchArgs({ queries: Array(6).fill("long enough query") })).toBeNull();
    expect(parseWebSearchArgs({ queries: ["no"] })).toBeNull();
  });

  it("runs batch queries concurrently and deduplicates sources by URL", async () => {
    const fetchMock = vi.fn(async () => tavilyResponse([
      { title: "Pricing", url: "https://example.com/pricing", content: "Plan price is $10.", score: 0.9 },
      { title: "Bad URL", url: "javascript:alert(1)", content: "Unusable", score: 1 },
    ]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await runWebSearch(env, {
      queries: ["crm tool pricing", "sales crm pricing", "crm updates", "crm releases", "crm plans"],
      depth: "advanced",
    });

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({ id: "C1", url: "https://example.com/pricing", vintage: "current" });
    expect(result.failedQueries).toEqual([]);
  });

  it("keeps successful results when one query fails and reports partial coverage", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce(tavilyResponse([{ title: "Docs", url: "https://example.com/docs", content: "Release notes.", score: 0.8 }]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await runWebSearch(env, { queries: ["vendor release notes", "vendor product updates"] });
    expect(result.sources).toHaveLength(1);
    expect(result.failedQueries).toEqual(["vendor release notes"]);
  });

  it("preserves a provider quota error when every search request is throttled", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => tavilyResponse([], 429)));
    await expect(runWebSearch(env, { queries: ["crm pricing"] })).rejects.toMatchObject<Partial<ProviderError>>({
      code: "tavily_quota",
    });
  });

  it("surfaces Gemini quota exhaustion as a retryable provider error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 429 })));
    await expect(gemini.chooseAction(
      { ...env, GEMINI_API_KEY: "test-key" },
      [{ role: "user", parts: [{ text: "Summarize the question" }] }],
      "System instructions",
      false,
    )).rejects.toMatchObject<Partial<ProviderError>>({ code: "gemini_quota", retryable: true });
  });

  it("reports sanitized Gemini request status without exposing the provider body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: { status: "INVALID_ARGUMENT", message: "private provider details" },
    }), { status: 400, headers: { "content-type": "application/json" } })));
    await expect(gemini.chooseAction(
      { ...env, GEMINI_API_KEY: "test-key" },
      [{ role: "user", parts: [{ text: "Compare database plans" }] }],
      "System instructions",
      false,
    )).rejects.toMatchObject<Partial<ProviderError>>({
      code: "gemini_request_error_400_invalid_argument",
      message: "Gemini rejected the request (HTTP 400, INVALID_ARGUMENT). Check the model and request configuration.",
      retryable: false,
    });
  });

  it("classifies Gemini server errors as retryable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
    await expect(gemini.chooseAction(
      { ...env, GEMINI_API_KEY: "test-key" },
      [{ role: "user", parts: [{ text: "Compare database plans" }] }],
      "System instructions",
      false,
    )).rejects.toMatchObject<Partial<ProviderError>>({
      code: "gemini_server_error_503",
      retryable: true,
    });
  });

  it("reserves two credits per advanced query and stops before Tavily at the global limit", async () => {
    const limitedDb = fakeDatabase(0);
    const limitedEnv = { TAVILY_API_KEY: "test-key", DB: limitedDb.db } as AppEnv;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(runWebSearch(limitedEnv, {
      queries: ["crm pricing", "crm plans"], depth: "advanced",
    })).rejects.toMatchObject({ code: "tavily_monthly_limit" });

    expect(limitedDb.prepare).toHaveBeenCalledOnce();
    expect(limitedDb.bind).toHaveBeenCalledWith(expect.any(String), 4, 800);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

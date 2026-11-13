# Minimi Research Agent — Design

## How it works

The browser app and Hono API run on the same Cloudflare Worker. Better Auth handles Google sign-in and stores sessions in D1. D1 also stores timestamped conversations, user messages, assistant answers, and search snapshots. A small FTS5 index finds prior questions by topic; exact local-date filtering handles prompts such as “what did I ask on 3 November?” Each message keeps its original UTC timestamp and the browser's IANA timezone.

For a new turn, the server loads the recent conversation and up to three matching older turns before calling Gemini. Dated queries use the message's IANA timezone; if a month/day matches more than one year, Minimi asks which year. FTS5 searches stay scoped to the authenticated user. The model has one tool: `web_search`. It may return up to five focused Tavily queries, which run in parallel. A global monthly D1 counter reserves at most 800 free search credits, preserving headroom for the provider's quota and charging advanced queries at two credits. The final response can cite only IDs from the complete saved search snapshot or the current results. The server validates those IDs before saving the answer and source cards. A short D1 lease makes duplicate client request IDs idempotent across concurrent retries. Follow-ups compare the old snapshot with newly retrieved evidence; when the evidence is not comparable, Minimi says it cannot confirm a change.

## Why this design

The agent logic is ordinary TypeScript with an explicit, bounded tool loop. This makes the only external action visible and reviewable, keeps provider secrets on the server, and puts date resolution and per-user history access in deterministic code. FTS5 fits a user’s chat archive without a second embedding model or vector database. D1 keeps auth and memory in one free deployment platform; it also supports local development and the same SQL schema in production.

React, Vite, Hono, Cloudflare Workers/D1, Better Auth, Gemini, and Tavily give the project a runnable `npm install` / `npm run dev` path and a free public-hosting path. The Gemini free tier has quotas and data-use terms, which the UI states before a user begins. The API blocks unpaid Gemini access in restricted regions. Search results and answer dates are visible instead of being hidden behind a polished but unverifiable response.

## Considered and rejected

- A general agent framework would add a second abstraction layer for a single search tool and a short workflow.
- A vector database and embeddings would increase setup and data movement; exact date filters plus full-text search directly cover the task’s “what did I ask, and when?” retrieval needs.
- Paid search, paid inference, and automatic provider fallback conflict with the zero-cost requirement. When free quotas are exhausted, Minimi preserves the prompt and reports the limit.
- Browser-only history would be simpler, but the chosen account-backed D1 history supports the requested cross-device sync and account isolation.

## With another week

Build a labeled regression set from the challenge patterns and score date retrieval, factual changes, source quality, citation validity, latency, and abstention. Add a source-quality layer that prefers primary pricing and release notes, then compare it against the initial Tavily ranking. Add privacy-retention controls and a small operator view for free-quota health without logging user prompts.


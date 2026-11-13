import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { ChatResult, Source } from "../shared/types";
import type { AppEnv } from "./env";
import { retrieveMemory } from "./agent/memory";
import { localDateAt } from "./agent/date-memory";
import { runAgent, type Phase } from "./agent/orchestrator";
import { ProviderError } from "./agent/providers";
import type { AppContext } from "./index";
import { requestCountry, unpaidGeminiRegionRestricted } from "./regions";

const chatRequestSchema = z.object({
  conversationId: z.string().uuid().optional(),
  message: z.string().trim().min(1).max(8_000),
  timeZone: z.string().trim().min(1).max(120),
  clientMessageId: z.string().uuid(),
}).strict();

function safeTimeZone(value: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(); return true; }
  catch { return false; }
}

function messageTitle(message: string): string {
  const oneLine = message.replace(/\s+/g, " ").trim();
  return oneLine.length > 64 ? `${oneLine.slice(0, 61).trimEnd()}…` : oneLine;
}

async function findExistingRequest(env: AppEnv, userId: string, clientId: string) {
  return env.DB.prepare(
    `SELECT id, conversation_id, user_id, content, created_at, time_zone, status, error_code, processing_until
       FROM messages
      WHERE user_id = ? AND role = 'user' AND client_message_id = ?
      LIMIT 1`,
  ).bind(userId, clientId).first<{
    id: string; conversation_id: string; user_id: string; content: string;
    created_at: string; time_zone: string; status: string; error_code: string | null; processing_until: string | null;
  }>();
}

export async function claimRequest(env: AppEnv, userId: string, messageId: string, now: Date): Promise<boolean> {
  const instant = now.toISOString();
  const leaseUntil = new Date(now.getTime() + 180_000).toISOString();
  const result = await env.DB.prepare(
    `UPDATE messages SET status = 'pending', error_code = NULL, processing_until = ?
      WHERE id = ? AND user_id = ? AND role = 'user'
        AND (status = 'failed' OR (status = 'pending' AND (processing_until IS NULL OR processing_until <= ?)))`,
  ).bind(leaseUntil, messageId, userId, instant).run();
  return (result.meta.changes ?? 0) > 0;
}

async function releaseDailyChat(env: AppEnv, userId: string, timeZone: string, now: Date): Promise<void> {
  const day = localDateAt(now, timeZone);
  const key = `${day.year}-${String(day.month).padStart(2, "0")}-${String(day.day).padStart(2, "0")}`;
  await env.DB.prepare(
    `UPDATE user_usage SET chat_count = chat_count - 1
      WHERE user_id = ? AND usage_day = ? AND chat_count > 0`,
  ).bind(userId, key).run();
  await env.DB.prepare(
    "DELETE FROM user_usage WHERE user_id = ? AND usage_day = ? AND chat_count = 0",
  ).bind(userId, key).run();
}

async function removeEmptyConversation(env: AppEnv, userId: string, conversationId: string): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM conversations WHERE id = ? AND user_id = ?
       AND NOT EXISTS (SELECT 1 FROM messages WHERE conversation_id = ?)`,
  ).bind(conversationId, userId, conversationId).run();
}

async function findStoredReply(env: AppEnv, userId: string, userMessageId: string, conversationId: string): Promise<ChatResult | null> {
  const reply = await env.DB.prepare(
    `SELECT id, content, citations_json, comparison_json, created_at
       FROM messages
      WHERE user_id = ? AND reply_to_id = ? AND role = 'assistant'
      LIMIT 1`,
  ).bind(userId, userMessageId).first<{
    id: string; content: string; citations_json: string; comparison_json: string | null; created_at: string;
  }>();
  if (!reply) return null;
  const run = await env.DB.prepare(
    `SELECT searched_at FROM research_runs WHERE user_message_id = ? AND user_id = ? ORDER BY searched_at DESC LIMIT 1`,
  ).bind(userMessageId, userId).first<{ searched_at: string }>();
  let citations: Source[] = [];
  let comparison: ChatResult["comparison"] = [];
  try { citations = JSON.parse(reply.citations_json) as Source[]; } catch { /* Old or malformed snapshot. */ }
  try { comparison = JSON.parse(reply.comparison_json ?? "[]") as ChatResult["comparison"]; } catch { /* Old or malformed snapshot. */ }
  return {
    conversationId,
    userMessageId,
    assistantMessageId: reply.id,
    answer: reply.content,
    citations,
    comparison,
    searchedAt: run?.searched_at ?? null,
    memoryMatches: [],
  };
}

async function reserveDailyChat(env: AppEnv, userId: string, timeZone: string, now: Date): Promise<boolean> {
  const day = localDateAt(now, timeZone);
  const key = `${day.year}-${String(day.month).padStart(2, "0")}-${String(day.day).padStart(2, "0")}`;
  const result = await env.DB.prepare(
    `INSERT INTO user_usage(user_id, usage_day, chat_count)
     VALUES (?, ?, 1)
     ON CONFLICT(user_id, usage_day) DO UPDATE SET chat_count = chat_count + 1
     WHERE chat_count < 30`,
  ).bind(userId, key).run();
  return (result.meta.changes ?? 0) > 0;
}

function phaseLabel(phase: Phase): string {
  if (phase === "history") return "Looking through your earlier chats";
  if (phase === "search") return "Searching the web";
  return "Writing an evidence-based answer";
}

export async function postChat(c: AppContext) {
  let raw: unknown;
  try { raw = await c.req.json(); } catch { return c.json({ error: "invalid_json", message: "Send a valid JSON request." }, 400); }
  const parsed = chatRequestSchema.safeParse(raw);
  if (!parsed.success) return c.json({ error: "invalid_request", message: "Check the message, timezone, and request ID." }, 400);
  const input = parsed.data;
  if (!safeTimeZone(input.timeZone)) return c.json({ error: "invalid_timezone", message: "Use a valid IANA timezone, such as Asia/Kolkata." }, 400);
  const userId = c.get("userId");
  const env = c.env;
  const now = new Date();
  if (unpaidGeminiRegionRestricted(requestCountry(c.req.raw))) {
    return c.json({ error: "region_unavailable", message: "The free Gemini API tier is not available for this demo in your region." }, 403);
  }

  let existing = await findExistingRequest(env, userId, input.clientMessageId);
  let conversationId = existing?.conversation_id ?? input.conversationId ?? crypto.randomUUID();
  let acquired = false;
  if (existing) {
    const stored = await findStoredReply(env, userId, existing.id, conversationId);
    if (stored) {
      return streamSSE(c, async (stream) => {
        await stream.writeSSE({ event: "result", data: JSON.stringify(stored) });
      });
    }
    acquired = await claimRequest(env, userId, existing.id, now);
    if (!acquired) {
      return streamSSE(c, async (stream) => {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ code: "request_in_progress", message: "This message is already being processed. Wait a moment, then retry.", retryable: true, conversationId, userMessageId: existing!.id }),
        });
      });
    }
  }

  if (!existing && input.conversationId) {
    const conversation = await env.DB.prepare(
      "SELECT id FROM conversations WHERE id = ? AND user_id = ?",
    ).bind(input.conversationId, userId).first<{ id: string }>();
    if (!conversation) return c.json({ error: "conversation_not_found", message: "This conversation does not exist." }, 404);
  }

  if (!existing) {
    const allowed = await reserveDailyChat(env, userId, input.timeZone, now);
    if (!allowed) return c.json({ error: "daily_limit", message: "You have reached the 30 message daily demo limit. Your limit resets at midnight in your timezone." }, 429);
    let createdConversation = false;
    try {
      if (!input.conversationId) {
        await env.DB.prepare(
          `INSERT INTO conversations(id, user_id, title, created_at, updated_at, time_zone)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).bind(conversationId, userId, messageTitle(input.message), now.toISOString(), now.toISOString(), input.timeZone).run();
        createdConversation = true;
      }
      const userMessageId = crypto.randomUUID();
      const leaseUntil = new Date(now.getTime() + 180_000).toISOString();
      await env.DB.prepare(
        `INSERT INTO messages(id, user_id, conversation_id, client_message_id, role, content, created_at, time_zone, status, processing_until)
         VALUES (?, ?, ?, ?, 'user', ?, ?, ?, 'pending', ?)`,
      ).bind(userMessageId, userId, conversationId, input.clientMessageId, input.message, now.toISOString(), input.timeZone, leaseUntil).run();
      const updatedAt = new Date().toISOString();
      await env.DB.prepare(
        "UPDATE conversations SET updated_at = ? WHERE id = ? AND user_id = ?",
      ).bind(updatedAt, conversationId, userId).run();
      existing = { id: userMessageId, user_id: userId, conversation_id: conversationId, content: input.message, created_at: now.toISOString(), time_zone: input.timeZone, status: "pending", error_code: null, processing_until: leaseUntil };
      acquired = true;
    } catch (error) {
      // A concurrent retry may win the unique client-message constraint.
      const concurrent = await findExistingRequest(env, userId, input.clientMessageId);
      await releaseDailyChat(env, userId, input.timeZone, now);
      if (createdConversation) await removeEmptyConversation(env, userId, conversationId);
      if (!concurrent) throw error;
      existing = concurrent;
      conversationId = concurrent.conversation_id;
      const stored = await findStoredReply(env, userId, existing.id, conversationId);
      if (stored) return streamSSE(c, async (stream) => stream.writeSSE({ event: "result", data: JSON.stringify(stored) }));
      acquired = await claimRequest(env, userId, existing.id, now);
      if (!acquired) {
        return streamSSE(c, async (stream) => stream.writeSSE({
          event: "error",
          data: JSON.stringify({ code: "request_in_progress", message: "This message is already being processed. Wait a moment, then retry.", retryable: true, conversationId, userMessageId: existing!.id }),
        }));
      }
    }
  }

  if (!existing || !acquired) return c.json({ error: "request_unavailable", message: "The request could not be started. Retry your message." }, 503);
  const userMessage = existing;
  return streamSSE(c, async (stream) => {
    let previousPhase = "";
    const emit = async (phase: Phase) => {
      if (phase === previousPhase) return;
      previousPhase = phase;
      await stream.writeSSE({ event: "status", data: JSON.stringify({ phase, label: phaseLabel(phase) }) });
    };
    try {
      await emit("history");
      const memory = await retrieveMemory(
        env.DB,
        userId,
        conversationId,
        userMessage.id,
        userMessage.content,
        userMessage.created_at,
        userMessage.time_zone,
      );
      const agent = await runAgent({
        env,
        question: userMessage.content,
        history: memory,
        timeZone: userMessage.time_zone,
        now: new Date(),
        onPhase: emit,
      });
      const assistantId = crypto.randomUUID();
      const searchedAt = agent.searchedAt;
      const statements: D1PreparedStatement[] = [];
      if (searchedAt) {
        statements.push(env.DB.prepare(
          `INSERT INTO research_runs(id, user_id, conversation_id, user_message_id, searched_at, queries_json, sources_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          crypto.randomUUID(), userId, conversationId, userMessage.id, searchedAt,
          JSON.stringify(agent.queries), JSON.stringify(agent.searchedSources),
        ));
      }
      statements.push(env.DB.prepare(
        `INSERT INTO messages(id, user_id, conversation_id, reply_to_id, role, content, citations_json, comparison_json, created_at, time_zone, status)
         VALUES (?, ?, ?, ?, 'assistant', ?, ?, ?, ?, ?, 'complete')`,
      ).bind(
        assistantId, userId, conversationId, userMessage.id, agent.payload.text,
        JSON.stringify(agent.citedSources), JSON.stringify(agent.payload.comparison), new Date().toISOString(), userMessage.time_zone,
      ));
      statements.push(env.DB.prepare(
        `UPDATE messages SET status = 'complete', error_code = NULL, processing_until = NULL WHERE id = ? AND user_id = ?`,
      ).bind(userMessage.id, userId));
      statements.push(env.DB.prepare(
        `UPDATE conversations SET updated_at = ? WHERE id = ? AND user_id = ?`,
      ).bind(new Date().toISOString(), conversationId, userId));
      await env.DB.batch(statements);

      const result: ChatResult = {
        conversationId,
        userMessageId: userMessage.id,
        assistantMessageId: assistantId,
        answer: agent.payload.text,
        citations: agent.citedSources,
        comparison: agent.payload.comparison,
        searchedAt,
        memoryMatches: memory.matches.slice(0, 3).map((match) => ({
          id: match.user.id,
          content: match.user.content,
          createdAt: match.user.created_at,
          role: "user" as const,
        })),
      };
      await stream.writeSSE({ event: "result", data: JSON.stringify(result) });
    } catch (error) {
      const provider = error instanceof ProviderError ? error : null;
      const code = provider?.code ?? `request_failed_${previousPhase || "unknown"}`;
      const message = provider?.message ?? "I couldn't finish that response. Your message is saved; try again.";
      await env.DB.prepare(
        `UPDATE messages SET status = 'failed', error_code = ?, processing_until = NULL WHERE id = ? AND user_id = ?`,
      ).bind(code, userMessage.id, userId).run();
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ code, message, retryable: provider?.retryable ?? true, conversationId, userMessageId: userMessage.id }),
      });
    }
  });
}


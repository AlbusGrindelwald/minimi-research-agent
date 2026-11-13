import type { ConversationMessage, ConversationSummary, Source, ComparisonRow } from "../shared/types";
import type { StoredMessage } from "./agent/memory";

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

export async function listConversations(db: D1Database, userId: string): Promise<ConversationSummary[]> {
  const result = await db.prepare(
    `SELECT c.id, c.title, c.created_at AS createdAt, c.updated_at AS updatedAt, c.time_zone AS timeZone,
            COUNT(m.id) AS messageCount
       FROM conversations c
       LEFT JOIN messages m ON m.conversation_id = c.id AND m.user_id = c.user_id
      WHERE c.user_id = ?
      GROUP BY c.id
      ORDER BY c.updated_at DESC
      LIMIT 60`,
  ).bind(userId).all<ConversationSummary>();
  return result.results ?? [];
}

export async function getConversation(db: D1Database, userId: string, conversationId: string) {
  const conversation = await db.prepare(
    `SELECT id, title, created_at AS createdAt, updated_at AS updatedAt, time_zone AS timeZone
       FROM conversations WHERE id = ? AND user_id = ?`,
  ).bind(conversationId, userId).first<Omit<ConversationSummary, "messageCount">>();
  if (!conversation) return null;

  const result = await db.prepare(
    `SELECT id, role, content, citations_json, comparison_json, created_at, time_zone, status, error_code
       FROM messages
      WHERE conversation_id = ? AND user_id = ?
      ORDER BY created_at ASC
      LIMIT 300`,
  ).bind(conversationId, userId).all<Pick<StoredMessage, "id" | "role" | "content" | "citations_json" | "comparison_json" | "created_at" | "time_zone" | "status"> & { error_code: string | null }>();
  const messages: ConversationMessage[] = (result.results ?? []).map((row) => ({
    id: row.id,
    role: row.role,
    content: row.content,
    citations: parseJson<Source[]>(row.citations_json, []),
    comparison: parseJson<ComparisonRow[]>(row.comparison_json, []),
    createdAt: row.created_at,
    timeZone: row.time_zone,
    status: row.status,
    errorCode: row.error_code,
  }));
  return { ...conversation, messageCount: messages.length, messages };
}


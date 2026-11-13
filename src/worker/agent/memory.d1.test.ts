import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimRequest } from "../chat";
import type { AppEnv } from "../env";
import { getConversation, listConversations } from "../conversations";
import { buildMemoryPrompt, retrieveMemory } from "./memory";
import { createLocalD1, type LocalD1 } from "../test/sqlite-d1";

const sqliteAvailable = await createLocalD1();
const sqliteDescribe = sqliteAvailable ? describe : describe.skip;
let database: LocalD1 | null = sqliteAvailable;
const createdUsers: string[] = [];

async function createUser(): Promise<string> {
  const id = crypto.randomUUID();
  createdUsers.push(id);
  const now = Date.now();
  await database!.prepare(
    `INSERT INTO user(id, name, email, emailVerified, image, createdAt, updatedAt)
     VALUES (?, 'Test User', ?, 1, NULL, ?, ?)`,
  ).bind(id, `${id}@example.test`, now, now).run();
  return id;
}

async function createConversation(userId: string, at: string, title = "Research"): Promise<string> {
  const id = crypto.randomUUID();
  await database!.prepare(
    `INSERT INTO conversations(id, user_id, title, created_at, updated_at, time_zone)
     VALUES (?, ?, ?, ?, ?, 'Asia/Kolkata')`,
  ).bind(id, userId, title, at, at).run();
  return id;
}

async function createUserMessage(userId: string, conversationId: string, content: string, at: string, clientId?: string): Promise<string> {
  const id = crypto.randomUUID();
  await database!.prepare(
    `INSERT INTO messages(id, user_id, conversation_id, client_message_id, role, content, created_at, time_zone, status, processing_until)
     VALUES (?, ?, ?, ?, 'user', ?, ?, 'Asia/Kolkata', 'complete', NULL)`,
  ).bind(id, userId, conversationId, clientId ?? null, content, at).run();
  return id;
}

beforeEach(async () => { if (!database) database = await createLocalD1(); });
afterEach(() => {
  database?.close();
  database = null;
  createdUsers.length = 0;
});

sqliteDescribe("SQLite/D1 memory integration", () => {
  it("recalls an exact local calendar day and the complete saved search snapshot", async () => {
    const userId = await createUser();
    const oldConversationId = await createConversation(userId, "2025-11-03T08:00:00.000Z", "Postgres hosts");
    const oldUserId = await createUserMessage(userId, oldConversationId, "Compare PostgreSQL hosting prices", "2025-11-03T15:00:00.000Z");
    const sourceSnapshot = [{
      id: "C1", title: "Provider pricing", url: "https://example.test/pricing", domain: "example.test",
      excerpt: "The standard plan was $10 per month.", publishedAt: "2025-11-01", retrievedAt: "2025-11-03T15:01:00.000Z",
      relevance: 0.9, vintage: "current",
    }];
    await database!.prepare(
      `INSERT INTO messages(id, user_id, conversation_id, reply_to_id, role, content, citations_json, comparison_json, created_at, time_zone, status)
       VALUES (?, ?, ?, ?, 'assistant', 'Provider A was $10 per month [[C1]].', '[]', '[]', ?, 'Asia/Kolkata', 'complete')`,
    ).bind(crypto.randomUUID(), userId, oldConversationId, oldUserId, "2025-11-03T15:01:00.000Z").run();
    await database!.prepare(
      `INSERT INTO research_runs(id, user_id, conversation_id, user_message_id, searched_at, queries_json, sources_json)
       VALUES (?, ?, ?, ?, ?, '[]', ?)`,
    ).bind(crypto.randomUUID(), userId, oldConversationId, oldUserId, "2025-11-03T15:01:00.000Z", JSON.stringify(sourceSnapshot)).run();

    const currentConversationId = await createConversation(userId, "2026-11-13T12:00:00.000Z");
    const currentMessageId = await createUserMessage(userId, currentConversationId, "What did I ask on 3 November? Is the answer still correct today?", "2026-11-13T12:00:00.000Z");
    const memory = await retrieveMemory(
      database as unknown as D1Database, userId, currentConversationId, currentMessageId,
      "What did I ask on 3 November? Is the answer still correct today?",
      "2026-11-13T12:00:00.000Z", "Asia/Kolkata",
    );

    expect(memory.dateMatched).toBe("2025-11-03");
    expect(memory.dateMatchOptions).toEqual(["2025-11-03"]);
    expect(memory.matches[0].user.content).toBe("Compare PostgreSQL hosting prices");
    expect(memory.previousSources[0]).toMatchObject({ id: "P1", vintage: "previous", url: "https://example.test/pricing" });
    expect(buildMemoryPrompt(memory)).toContain("The standard plan was $10 per month.");
  });

  it("asks for the year when a month/day has matches in more than one year", async () => {
    const userId = await createUser();
    for (const at of ["2024-11-03T10:00:00.000Z", "2025-11-03T10:00:00.000Z"]) {
      const conversationId = await createConversation(userId, at);
      await createUserMessage(userId, conversationId, `Question from ${at.slice(0, 4)}`, at);
    }
    const currentConversationId = await createConversation(userId, "2026-11-13T12:00:00.000Z");
    const currentMessageId = await createUserMessage(userId, currentConversationId, "What did I ask on 3 November?", "2026-11-13T12:00:00.000Z");
    const memory = await retrieveMemory(database as unknown as D1Database, userId, currentConversationId, currentMessageId, "What did I ask on 3 November?", "2026-11-13T12:00:00.000Z", "UTC");
    expect(memory.dateMatchOptions).toEqual(["2025-11-03", "2024-11-03"]);
    expect(buildMemoryPrompt(memory)).toContain("Ask which year the user means");
  });

  it("keeps FTS results inside the account and cascades conversation deletion", async () => {
    const owner = await createUser();
    const otherUser = await createUser();
    const ownerConversation = await createConversation(owner, "2026-10-20T12:00:00.000Z", "Owner conversation");
    const otherConversation = await createConversation(otherUser, "2026-10-20T12:00:00.000Z", "Other conversation");
    const ownerOldMessageId = await createUserMessage(owner, ownerConversation, "Postgres hosting price comparison", "2026-10-20T12:00:00.000Z");
    await createUserMessage(otherUser, otherConversation, "Postgres hosting price comparison", "2026-10-20T12:00:00.000Z");
    const currentConversationId = await createConversation(owner, "2026-11-13T12:00:00.000Z");
    const currentMessageId = await createUserMessage(owner, currentConversationId, "Find my Postgres hosting price question", "2026-11-13T12:00:00.000Z");
    const memory = await retrieveMemory(database as unknown as D1Database, owner, currentConversationId, currentMessageId, "Find my Postgres hosting price question", "2026-11-13T12:00:00.000Z", "UTC");

    expect(memory.matches.map((match) => match.user.user_id)).toEqual([owner]);
    expect((await listConversations(database as unknown as D1Database, owner)).some((conversation) => conversation.id === otherConversation)).toBe(false);
    expect(await getConversation(database as unknown as D1Database, owner, otherConversation)).toBeNull();

    await database!.prepare("DELETE FROM conversations WHERE id = ? AND user_id = ?").bind(ownerConversation, owner).run();
    const messageCount = await database!.prepare("SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?").bind(ownerConversation).first<{ count: number }>();
    const ftsCount = await database!.prepare("SELECT COUNT(*) AS count FROM messages_fts WHERE message_id = ?").bind(ownerOldMessageId).first<{ count: number }>();
    expect(messageCount?.count).toBe(0);
    expect(ftsCount?.count).toBe(0);
  });

  it("grants only one D1 processing lease to concurrent retries", async () => {
    const userId = await createUser();
    const conversationId = await createConversation(userId, "2026-11-13T12:00:00.000Z");
    const messageId = crypto.randomUUID();
    await database!.prepare(
      `INSERT INTO messages(id, user_id, conversation_id, client_message_id, role, content, created_at, time_zone, status, processing_until)
       VALUES (?, ?, ?, ?, 'user', 'Retry this prompt', ?, 'UTC', 'pending', ?)`,
    ).bind(messageId, userId, conversationId, crypto.randomUUID(), "2026-11-13T12:00:00.000Z", "2026-11-13T12:01:00.000Z").run();
    const env = { DB: database } as unknown as AppEnv;
    const now = new Date("2026-11-13T12:02:00.000Z");
    const claims = await Promise.all([
      claimRequest(env, userId, messageId, now),
      claimRequest(env, userId, messageId, now),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.filter((claim) => !claim)).toHaveLength(1);

    await database!.prepare("UPDATE messages SET status = 'failed', processing_until = NULL WHERE id = ?").bind(messageId).run();
    expect(await claimRequest(env, userId, messageId, now)).toBe(true);
    expect(await claimRequest(env, userId, messageId, now)).toBe(false);
  });
});

import type { Source } from "../../shared/types";
import { ftsQuery, localDateAt, memoryTerms, resolveDatePhrases } from "./date-memory";

export type StoredMessage = {
  id: string;
  user_id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  citations_json: string;
  comparison_json: string | null;
  created_at: string;
  time_zone: string;
  status: "pending" | "complete" | "failed";
};

export type MemoryItem = {
  user: StoredMessage;
  assistant: StoredMessage | null;
  sources: Source[];
  localDate: string;
};

export type MemoryContext = {
  history: StoredMessage[];
  matches: MemoryItem[];
  previousSources: Source[];
  dateMatched: string | null;
  dateMatchOptions: string[];
  dateRequested: boolean;
};

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

export async function retrieveMemory(
  db: D1Database,
  userId: string,
  conversationId: string,
  currentMessageId: string,
  text: string,
  createdAt: string,
  timeZone: string,
): Promise<MemoryContext> {
  const currentHistory = await db.prepare(
    `SELECT id, user_id, conversation_id, role, content, citations_json, comparison_json, created_at, time_zone, status
       FROM messages
      WHERE user_id = ? AND conversation_id = ?
      ORDER BY created_at DESC
      LIMIT 17`,
  ).bind(userId, conversationId).all<StoredMessage>();
  const history = (currentHistory.results ?? []).reverse();

  const dateCandidates = resolveDatePhrases(text, new Date(createdAt), timeZone);
  let matchedDates: string[] = [];
  const exactDateIds = new Set<string>();
  const terms = memoryTerms(text);
  let candidateRows: StoredMessage[] = [];
  if (dateCandidates.length > 0) {
    const ranges = dateCandidates.map(() => "(created_at >= ? AND created_at < ?)").join(" OR ");
    const exactDays = await db.prepare(
      `SELECT id, user_id, conversation_id, role, content, citations_json, comparison_json, created_at, time_zone, status
         FROM messages
        WHERE user_id = ? AND role = 'user' AND id != ? AND (${ranges})
        ORDER BY created_at DESC
        LIMIT 36`,
    ).bind(userId, currentMessageId, ...dateCandidates.flatMap((candidate) => [candidate.start, candidate.end])).all<StoredMessage>();
    candidateRows = exactDays.results ?? [];
    for (const row of candidateRows) exactDateIds.add(row.id);
    const matched = new Set(candidateRows.map((row) => {
      const local = localDateAt(new Date(row.created_at), timeZone);
      return `${local.year}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")}`;
    }));
    matchedDates = dateCandidates.map((candidate) => candidate.localDate).filter((date) => matched.has(date));
  }

  const expression = ftsQuery(terms);
  if (expression) {
    const topical = await db.prepare(
      `SELECT m.id, m.user_id, m.conversation_id, m.role, m.content, m.citations_json, m.comparison_json,
              m.created_at, m.time_zone, m.status
         FROM messages_fts f
         JOIN messages m ON m.id = f.message_id
        WHERE messages_fts MATCH ? AND f.user_id = ? AND m.role = 'user' AND m.id != ?
        ORDER BY bm25(messages_fts)
        LIMIT 8`,
    ).bind(expression, userId, currentMessageId).all<StoredMessage>();
    const seen = new Set(candidateRows.map((row) => row.id));
    for (const row of topical.results ?? []) {
      if (!seen.has(row.id)) candidateRows.push(row);
    }
  }

  const ranked = candidateRows
    .map((row) => ({ row, exactDate: exactDateIds.has(row.id), overlap: memoryTerms(row.content).filter((term) => terms.includes(term)).length }))
    .sort((left, right) => Number(right.exactDate) - Number(left.exactDate) || right.overlap - left.overlap || right.row.created_at.localeCompare(left.row.created_at));
  const matches = await Promise.all(ranked.slice(0, 3).map(async ({ row }) => {
    const assistant = await db.prepare(
      `SELECT id, user_id, conversation_id, role, content, citations_json, comparison_json, created_at, time_zone, status
         FROM messages
        WHERE user_id = ? AND conversation_id = ? AND role = 'assistant' AND created_at >= ?
        ORDER BY created_at ASC LIMIT 1`,
    ).bind(userId, row.conversation_id, row.created_at).first<StoredMessage>();
    const savedRun = await db.prepare(
      `SELECT sources_json FROM research_runs
        WHERE user_id = ? AND user_message_id = ?
        ORDER BY searched_at DESC LIMIT 1`,
    ).bind(userId, row.id).first<{ sources_json: string }>();
    const citedSources = assistant ? parseJson<Source[]>(assistant.citations_json, []) : [];
    const sources = savedRun ? parseJson<Source[]>(savedRun.sources_json, citedSources) : citedSources;
    return {
      user: row,
      assistant: assistant ?? null,
      sources: sources.map((source) => ({ ...source, vintage: "previous" as const })),
      localDate: new Intl.DateTimeFormat("en-CA", { timeZone, dateStyle: "medium" }).format(new Date(row.created_at)),
    } satisfies MemoryItem;
  }));

  const previousSources: Source[] = [];
  let previousIndex = 1;
  for (const match of matches) {
    for (const source of match.sources) {
      if (previousSources.some((item) => item.id === source.id)) continue;
      previousSources.push({ ...source, id: `P${previousIndex++}`, vintage: "previous" });
    }
  }

  return {
    history: history.filter((message) => message.id !== currentMessageId).slice(-16),
    matches,
    previousSources,
    dateMatched: matchedDates[0] ?? null,
    dateMatchOptions: matchedDates,
    dateRequested: dateCandidates.length > 0,
  };
}

export function buildMemoryPrompt(context: MemoryContext): string {
  const memory = context.matches.map((match, index) => {
    const priorSources = match.sources.map((source) => {
      const alias = context.previousSources.find((candidate) => candidate.url === source.url)?.id;
      return alias ? `${alias} ${source.title} | ${source.url} | published=${source.publishedAt ?? "unknown"} | retrieved=${source.retrievedAt} | excerpt=${source.excerpt}` : "";
    }).filter(Boolean).join("\n");
    return [
      `Memory ${index + 1} (${match.localDate}, timezone ${match.user.time_zone})`,
      `User: ${match.user.content}`,
      match.assistant ? `Assistant: ${match.assistant.content}` : "Assistant: no saved answer",
      priorSources ? `Saved source evidence:\n${priorSources}` : "Saved source evidence: none",
    ].join("\n");
  }).join("\n\n");
  const dateInstruction = context.dateRequested && !context.dateMatched
    ? "The requested calendar date has no exact saved match. Do not silently substitute a similar conversation from another date; state that the exact date was not found and ask a concise clarification if needed.\n\n"
    : "";
  const ambiguousDateInstruction = context.dateMatchOptions.length > 1
    ? `The requested month and day match saved conversations in more than one year (${context.dateMatchOptions.join(", ")}). Ask which year the user means before summarizing; do not select a year.\n\n`
    : "";
  return dateInstruction + ambiguousDateInstruction + (memory || "No relevant prior conversation was found for this account.");
}


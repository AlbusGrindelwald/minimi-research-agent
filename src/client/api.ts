import type { ChatRequest, ChatResult, ConversationSummary, ConversationMessage } from "../shared/types";

type ApiErrorBody = { error?: string; message?: string };

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
    this.name = "ApiError";
  }
}

async function responseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let body: ApiErrorBody = {};
    try { body = await response.json() as ApiErrorBody; } catch { /* Use the status fallback. */ }
    throw new ApiError(body.message ?? `Request failed (${response.status}).`, response.status, body.error);
  }
  return response.json() as Promise<T>;
}

export async function getHealth() {
  return responseJson<{ ok: boolean; configured: { gemini: boolean; search: boolean; googleAuth: boolean; regionAvailable: boolean } }>(
    await fetch("/api/health", { credentials: "same-origin" }),
  );
}

export async function getConversations() {
  const value = await responseJson<{ conversations: ConversationSummary[] }>(
    await fetch("/api/conversations", { credentials: "same-origin" }),
  );
  return value.conversations;
}

export async function getConversation(id: string) {
  const value = await responseJson<{ conversation: ConversationSummary & { messages: ConversationMessage[] } }>(
    await fetch(`/api/conversations/${encodeURIComponent(id)}`, { credentials: "same-origin" }),
  );
  return value.conversation;
}

export async function deleteConversation(id: string) {
  await responseJson<{ deleted: boolean }>(await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "same-origin",
  }));
}

export async function deleteAllConversations() {
  await responseJson<{ deleted: boolean }>(await fetch("/api/conversations", {
    method: "DELETE",
    credentials: "same-origin",
  }));
}

export type ChatStreamEvent =
  | { event: "status"; data: { phase: string; label: string } }
  | { event: "result"; data: ChatResult }
  | { event: "error"; data: { code: string; message: string; retryable: boolean; conversationId: string; userMessageId: string } };

function decodeSseBlock(block: string): ChatStreamEvent | null {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return null;
  try {
    return { event, data: JSON.parse(data.join("\n")) } as ChatStreamEvent;
  } catch {
    return null;
  }
}

export async function sendChat(
  request: ChatRequest,
  onEvent: (event: ChatStreamEvent) => void,
): Promise<void> {
  const response = await fetch("/api/chat", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    let body: ApiErrorBody = {};
    try { body = await response.json() as ApiErrorBody; } catch { /* Use the status fallback. */ }
    throw new ApiError(body.message ?? `Request failed (${response.status}).`, response.status, body.error);
  }
  if (!response.body) throw new ApiError("The connection ended before an answer arrived.", 0, "stream_unavailable");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  while (true) {
    const { value, done } = await reader.read();
    pending += decoder.decode(value, { stream: !done });
    let separator = pending.search(/\r?\n\r?\n/);
    while (separator >= 0) {
      const delimiter = pending.slice(separator).match(/^\r?\n\r?\n/)?.[0] ?? "\n\n";
      const block = pending.slice(0, separator);
      pending = pending.slice(separator + delimiter.length);
      const decoded = decodeSseBlock(block);
      if (decoded) onEvent(decoded);
      separator = pending.search(/\r?\n\r?\n/);
    }
    if (done) break;
  }
  if (pending.trim()) {
    const decoded = decodeSseBlock(pending);
    if (decoded) onEvent(decoded);
  }
}


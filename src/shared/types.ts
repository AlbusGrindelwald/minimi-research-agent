export type ChatRequest = {
  conversationId?: string;
  message: string;
  timeZone: string;
  clientMessageId: string;
};

export type Source = {
  id: string;
  title: string;
  url: string;
  domain: string;
  excerpt: string;
  publishedAt: string | null;
  retrievedAt: string;
  relevance: number;
  vintage: "current" | "previous";
};

export type ComparisonRow = {
  label: string;
  then: string;
  now: string;
  sourceIds: string[];
};

export type AnswerPayload = {
  text: string;
  sourceIds: string[];
  comparison: ComparisonRow[];
};

export type ChatResult = {
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  answer: string;
  citations: Source[];
  comparison: ComparisonRow[];
  searchedAt: string | null;
  memoryMatches: Array<{
    id: string;
    content: string;
    createdAt: string;
    role: "user" | "assistant";
  }>;
};

export type ConversationSummary = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  timeZone: string;
  messageCount: number;
};

export type ConversationMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: Source[];
  comparison: ComparisonRow[];
  createdAt: string;
  timeZone: string;
  status: "pending" | "complete" | "failed";
  errorCode: string | null;
};


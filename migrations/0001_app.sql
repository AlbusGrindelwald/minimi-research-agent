CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  time_zone TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS conversations_user_updated_idx
  ON conversations(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  reply_to_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  client_message_id TEXT,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  citations_json TEXT NOT NULL DEFAULT '[]',
  comparison_json TEXT,
  created_at TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'complete' CHECK (status IN ('pending', 'complete', 'failed')),
  error_code TEXT,
  UNIQUE(user_id, client_message_id)
);

CREATE INDEX IF NOT EXISTS messages_user_time_idx
  ON messages(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS messages_conversation_time_idx
  ON messages(conversation_id, created_at ASC);
CREATE UNIQUE INDEX IF NOT EXISTS messages_reply_to_unique_idx
  ON messages(reply_to_id) WHERE reply_to_id IS NOT NULL;

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  user_id UNINDEXED,
  message_id UNINDEXED,
  content,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS messages_fts_insert
AFTER INSERT ON messages
WHEN new.role = 'user'
BEGIN
  INSERT INTO messages_fts(user_id, message_id, content)
  VALUES (new.user_id, new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_delete
AFTER DELETE ON messages
WHEN old.role = 'user'
BEGIN
  DELETE FROM messages_fts WHERE message_id = old.id;
END;

CREATE TABLE IF NOT EXISTS research_runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  searched_at TEXT NOT NULL,
  queries_json TEXT NOT NULL,
  sources_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS research_runs_user_time_idx
  ON research_runs(user_id, searched_at DESC);
CREATE INDEX IF NOT EXISTS research_runs_message_idx
  ON research_runs(user_message_id);

CREATE TABLE IF NOT EXISTS user_usage (
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  usage_day TEXT NOT NULL,
  chat_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id, usage_day)
);


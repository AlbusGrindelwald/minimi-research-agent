import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

export type LocalD1 = {
  raw: { exec(sql: string): unknown; prepare(sql: string): { all(...values: unknown[]): unknown[]; get(...values: unknown[]): unknown; run(...values: unknown[]): { changes: number | bigint }; } };
  prepare(sql: string): {
    bind(...values: unknown[]): {
      run(): Promise<{ meta: { changes: number } }>;
      all<T>(): Promise<{ results: T[] }>;
      first<T>(): Promise<T | null>;
    };
  };
  close(): void;
};

export async function createLocalD1(): Promise<LocalD1 | null> {
  let sqlite: typeof import("node:sqlite");
  try { sqlite = await import("node:sqlite"); } catch { return null; }
  const raw = new sqlite.DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
  const directory = resolve(process.cwd(), "migrations");
  const files = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) {
    const migration = await readFile(resolve(directory, file), "utf8");
    // Node's bundled SQLite does not always include FTS5; the Worker query below uses a simple MATCH adapter.
    const sqliteCompatible = migration.replace(
      /CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5\([\s\S]*?\);/i,
      "CREATE TABLE IF NOT EXISTS messages_fts (user_id TEXT, message_id TEXT PRIMARY KEY, content TEXT);",
    );
    raw.exec(sqliteCompatible);
  }

  const database: LocalD1 = {
    raw,
    prepare(sql) {
      return {
        bind(...values) {
          if (sql.includes("messages_fts MATCH ?")) {
            const expression = String(values[0] ?? "");
            const userId = values[1];
            const currentMessageId = values[2];
            const terms = [...expression.matchAll(/"((?:[^"]|"")*)"/g)].map((match) => match[1].replaceAll('""', '"'));
            const matching = terms.map(() => "f.content LIKE ? COLLATE NOCASE").join(" OR ") || "0";
            return {
              async run() { throw new Error("The FTS query adapter supports reads only."); },
              async first<T>() { return null as T | null; },
              async all<T>() {
                const statement = raw.prepare(
                  `SELECT m.id, m.user_id, m.conversation_id, m.role, m.content, m.citations_json, m.comparison_json,
                          m.created_at, m.time_zone, m.status
                     FROM messages_fts f JOIN messages m ON m.id = f.message_id
                    WHERE f.user_id = ? AND m.role = 'user' AND m.id != ? AND (${matching})
                    ORDER BY m.created_at DESC LIMIT 8`,
                );
                return { results: statement.all(userId, currentMessageId, ...terms.map((term) => `%${term}%`)) as T[] };
              },
            };
          }
          return {
            async run() {
              const statement = raw.prepare(sql);
              const result = statement.run(...values);
              return { meta: { changes: Number(result.changes) } };
            },
            async all<T>() {
              const statement = raw.prepare(sql);
              return { results: statement.all(...values) as T[] };
            },
            async first<T>() {
              const statement = raw.prepare(sql);
              return (statement.get(...values) as T | undefined) ?? null;
            },
          };
        },
      };
    },
    close() { raw.close(); },
  };
  return database;
}

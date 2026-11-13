import { z } from "zod";
import type { AnswerPayload, Source } from "../../shared/types";

const answerSchema = z.object({
  text: z.string().trim().min(1).max(12_000),
  sourceIds: z.array(z.string()).max(20).default([]),
  comparison: z.array(z.object({
    label: z.string().trim().max(120),
    then: z.string().trim().max(800),
    now: z.string().trim().max(800),
    sourceIds: z.array(z.string()).max(20),
  })).max(8).default([]),
});

export function parseJsonAnswer(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(trimmed); } catch { return null; }
}

/** Keep only citations backed by the retrieved source catalog. */
export function normalizeAnswer(raw: unknown, allSources: Source[]): AnswerPayload {
  const parsed = answerSchema.safeParse(raw);
  const allowed = new Set(allSources.map((source) => source.id));
  if (!parsed.success) {
    if (typeof raw === "string" && raw.trim()) {
      const markers = [...raw.matchAll(/\[\[((?:C|P)\d+)\]\]/g)].map((match) => match[1]);
      const sourceIds = [...new Set(markers)].filter((id) => allowed.has(id));
      let text = raw.slice(0, 12_000);
      for (const marker of text.match(/\[\[((?:C|P)\d+)\]\]/g) ?? []) {
        const id = marker.slice(2, -2);
        if (!sourceIds.includes(id)) text = text.replaceAll(marker, "");
      }
      return { text: text.trim(), sourceIds, comparison: [] };
    }
    throw new Error("The assistant returned an unreadable answer. Retry the message.");
  }
  const sourceIds = [...new Set(parsed.data.sourceIds)].filter((id) => allowed.has(id));
  const comparison = parsed.data.comparison.map((row) => ({
    ...row,
    sourceIds: [...new Set(row.sourceIds)].filter((id) => allowed.has(id)),
  }));
  let text = parsed.data.text;
  for (const marker of text.match(/\[\[((?:C|P)\d+)\]\]/g) ?? []) {
    const id = marker.slice(2, -2);
    if (!allowed.has(id) || !sourceIds.includes(id)) text = text.replaceAll(marker, "");
  }
  return { text: text.trim(), sourceIds, comparison };
}

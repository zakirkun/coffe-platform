import { z } from 'zod';
import { REVIEW_FENCE, TEST_REPORT_FENCE } from '../context/context-bundle.js';

export const AgentTestReport = z.object({
  status: z.enum(['passed', 'failed']),
  passed: z.number().int().min(0).default(0),
  failed: z.number().int().min(0).default(0),
  skipped: z.number().int().min(0).default(0),
  command: z.string().nullish(),
  failures: z.array(z.object({ name: z.string(), message: z.string().nullish() })).default([]),
});
export type AgentTestReport = z.infer<typeof AgentTestReport>;

export const ReviewVerdict = z.object({
  verdict: z.enum(['approve', 'request_changes']),
  comments: z.array(z.string()).default([]),
});
export type ReviewVerdict = z.infer<typeof ReviewVerdict>;

const FENCE = '```';

/** Body of the last fenced block tagged `fence` (```fence … ```), or `null`. */
function lastFence(text: string, fence: string): string | null {
  const pattern = new RegExp(`${FENCE}${fence}[^\\n]*\\n([\\s\\S]*?)${FENCE}`, 'g');
  let body: string | null = null;
  for (const match of text.matchAll(pattern)) body = match[1] ?? null;
  return body;
}

function parseFence<T>(text: string | null, fence: string, schema: z.ZodType<T>): T | null {
  if (!text) return null;
  const body = lastFence(text, fence);
  if (body === null) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The tester's machine-readable report at the end of its final message. */
export function parseTestReport(text: string | null): AgentTestReport | null {
  return parseFence(text, TEST_REPORT_FENCE, AgentTestReport);
}

/** The reviewer's verdict at the end of its final message. */
export function parseReviewVerdict(text: string | null): ReviewVerdict | null {
  return parseFence(text, REVIEW_FENCE, ReviewVerdict);
}

/**
 * The JSON a planning run answered with: the CLI's schema-constrained output, a ```json block,
 * or the whole text.
 */
export function extractJson(text: string | null): unknown {
  if (!text) return null;
  const candidates = [text.trim(), lastFence(text, 'json'), lastFence(text, '')].filter(
    (candidate): candidate is string =>
      typeof candidate === 'string' && candidate.trim().length > 0,
  );
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next candidate
    }
  }
  // A JSON object embedded in prose: from the first `{` to the last `}`.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

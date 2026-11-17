import type { PersonaRole } from '@coffe/contracts';
import type { ContextFile, RunKind } from '@coffe/protocol';

/** Fenced block a tester persona ends its final message with. */
export const TEST_REPORT_FENCE = 'coffe-test-report';
/** Fenced block a reviewer persona ends its final message with. */
export const REVIEW_FENCE = 'coffe-review';
/** Total size of the files written to `.coffe/context/` (architecture §11.4). */
export const MAX_BUNDLE_BYTES = 512 * 1024;

export interface ContextSection {
  title: string;
  body: string;
}

export interface BundleInput {
  kind: RunKind;
  ticket: { key: string; title: string; description: string; acceptanceCriteria: string[] } | null;
  requirement: { title: string; body: string } | null;
  persona: { name: string; role: PersonaRole; instructions: string } | null;
  /** Enabled project rules and knowledge, in display order. */
  rules: ContextSection[];
  knowledge: ContextSection[];
  /** What the previous workflow step handed over. */
  handoff: string | null;
}

const BASE_RULES = [
  '- Work only inside the current directory (a git worktree COFFE prepared). Do not read or change files outside of it.',
  '- Never push: do not run `git push` and do not change remotes.',
  "- Don't rewrite history: no rebase, amend, reset or force operations on existing commits.",
  '- Do not commit; the runner commits your changes when you are done.',
  '- Finish with a short summary of what you did.',
];

function coffeRules(input: BundleInput): string {
  const lines = ['# COFFE rules', ''];
  if (input.kind === 'planning') {
    lines.push(
      'You are planning work for this repository. Read whatever you need, but do not modify any file.',
      '',
      'Answer with JSON only, no prose and no code fence, matching this shape:',
      '',
      '{"tickets": [{"title": "…", "description": "markdown", "acceptance_criteria": ["…"], "depends_on": [0], "suggested_role": "implementer" | null, "estimate": "S" | null}]}',
      '',
      '- `depends_on` lists zero-based indexes of tickets in the same answer that must be done first.',
      '- Every ticket is independently reviewable and has at least one testable acceptance criterion.',
    );
    return `${lines.join('\n')}\n`;
  }
  lines.push(
    input.ticket
      ? `You are working on ticket ${input.ticket.key} in a git worktree that COFFE prepared for it.`
      : 'You are working in a git worktree that COFFE prepared.',
    '',
    ...BASE_RULES,
  );
  if (input.persona?.role === 'tester') {
    lines.push(
      '',
      '## Test report',
      '',
      'End your final message with this fenced block (valid JSON):',
      '',
      `\`\`\`${TEST_REPORT_FENCE}`,
      '{"status": "passed" | "failed", "passed": 0, "failed": 0, "skipped": 0, "command": "…", "failures": [{"name": "…", "message": "…"}]}',
      '```',
    );
  }
  if (input.persona?.role === 'reviewer') {
    lines.push(
      '',
      '## Review verdict',
      '',
      'Do not modify any file. End your final message with this fenced block (valid JSON):',
      '',
      `\`\`\`${REVIEW_FENCE}`,
      '{"verdict": "approve" | "request_changes", "comments": ["concrete, actionable comment", "…"]}',
      '```',
    );
  }
  return `${lines.join('\n')}\n`;
}

function sectionsFile(heading: string, sections: ContextSection[]): string {
  return `# ${heading}\n\n${sections.map((section) => `## ${section.title}\n\n${section.body.trim()}\n`).join('\n')}`;
}

function ticketFile(ticket: NonNullable<BundleInput['ticket']>): string {
  const criteria =
    ticket.acceptanceCriteria.length > 0
      ? ticket.acceptanceCriteria.map((item) => `- [ ] ${item}`).join('\n')
      : '_None given._';
  return [
    `# ${ticket.key}: ${ticket.title}`,
    '',
    '## Description',
    '',
    ticket.description.trim() || '_No description._',
    '',
    '## Acceptance criteria',
    '',
    criteria,
    '',
  ].join('\n');
}

/**
 * Drops (then truncates) knowledge and rules, least important last, until the bundle fits
 * `MAX_BUNDLE_BYTES`; COFFE rules, the persona, the ticket and the handoff are always kept.
 */
function withinCap(input: BundleInput, measure: (input: BundleInput) => number): BundleInput {
  let current = input;
  for (const key of ['knowledge', 'rules'] as const) {
    while (measure(current) > MAX_BUNDLE_BYTES && current[key].length > 0) {
      const sections = current[key];
      const last = sections.at(-1);
      if (!last) break;
      const overflow = measure(current) - MAX_BUNDLE_BYTES;
      const remaining = Buffer.byteLength(last.body) - overflow - 64;
      const trimmed =
        remaining > 256
          ? [
              ...sections.slice(0, -1),
              {
                title: last.title,
                body: `${Buffer.from(last.body).subarray(0, remaining).toString()}\n\n_[truncated by COFFE]_`,
              },
            ]
          : sections.slice(0, -1);
      current = { ...current, [key]: trimmed };
    }
  }
  return current;
}

function files(input: BundleInput): ContextFile[] {
  const result: ContextFile[] = [{ name: '00-coffe-rules.md', content: coffeRules(input) }];
  if (input.rules.length > 0)
    result.push({
      name: '10-project-rules.md',
      content: sectionsFile('Project rules', input.rules),
    });
  if (input.persona) {
    result.push({
      name: '20-persona.md',
      content: `# Your role: ${input.persona.name} (${input.persona.role})\n\n${input.persona.instructions.trim() || '_No extra instructions._'}\n`,
    });
  }
  if (input.knowledge.length > 0)
    result.push({
      name: '30-knowledge.md',
      content: sectionsFile('Project knowledge', input.knowledge),
    });
  if (input.ticket) result.push({ name: '40-ticket.md', content: ticketFile(input.ticket) });
  if (input.requirement) {
    result.push({
      name: '40-requirement.md',
      content: `# Requirement: ${input.requirement.title}\n\n${input.requirement.body.trim()}\n`,
    });
  }
  if (input.handoff?.trim())
    result.push({
      name: '50-handoff.md',
      content: `# Handoff from the previous step\n\n${input.handoff.trim()}\n`,
    });
  return result;
}

/** The files a run gets in `<worktree>/.coffe/context/`, in the order the agent should read them. */
export function buildContextFiles(input: BundleInput): ContextFile[] {
  const measure = (candidate: BundleInput) =>
    files(candidate).reduce(
      (total, file) => total + Buffer.byteLength(file.name) + Buffer.byteLength(file.content),
      0,
    );
  return files(withinCap(input, measure));
}

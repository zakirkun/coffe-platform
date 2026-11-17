import type { PersonaRole } from '@coffe/contracts';
import { type TicketBrief, ticketPrompt } from '../runs/run-context.js';
import type { AgentTestReport, ReviewVerdict } from './reports.js';

/** Longest previous-step summary copied into a handoff note. */
const SUMMARY_CHARS = 4_000;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (truncated)` : text;
}

/** The task of one workflow step for a persona of `role`. */
export function stepPrompt(ticket: TicketBrief, role: PersonaRole, hasHandoff: boolean): string {
  const handoff = hasHandoff
    ? '\n\nRead `.coffe/context/50-handoff.md` first: it describes what the previous step did and what must change.'
    : '';
  switch (role) {
    case 'tester':
      return `Verify ticket ${ticket.key}: ${ticket.title}. Run the existing test suite, add tests that prove each acceptance criterion, and change only test code. End with the test report block described in your rules.${handoff}`;
    case 'reviewer':
      return `Review the changes on this branch for ticket ${ticket.key}: ${ticket.title} against its acceptance criteria and the project rules. Do not modify any file. End with the review verdict block described in your rules.${handoff}`;
    default:
      return `${ticketPrompt(ticket, undefined)}${handoff}`;
  }
}

export interface StepRunSummary {
  personaName: string;
  role: PersonaRole;
  summary: string | null;
  testReport: AgentTestReport | null;
  verdict: ReviewVerdict | null;
}

export interface DiffStat {
  additions: number;
  deletions: number;
  files: { path: string; additions: number | null; deletions: number | null }[];
}

/** What the next step needs to know about the previous one (`50-handoff.md`). */
export function handoffNote(
  stepName: string,
  outcome: string,
  runs: StepRunSummary[],
  diff: DiffStat | null,
): string {
  const lines = [`## ${stepName}: ${outcome}`, ''];
  for (const run of runs) {
    lines.push(`### ${run.personaName} (${run.role})`, '');
    lines.push(
      run.summary?.trim() ? truncate(run.summary.trim(), SUMMARY_CHARS) : '_No summary._',
      '',
    );
    if (run.testReport) {
      const report = run.testReport;
      lines.push(
        `Tests ${report.status}: ${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped.`,
      );
      for (const failure of report.failures)
        lines.push(`- ${failure.name}${failure.message ? `: ${failure.message}` : ''}`);
      lines.push('');
    }
    if (run.verdict) {
      lines.push(
        `Verdict: ${run.verdict.verdict === 'approve' ? 'approve' : 'changes requested'}.`,
      );
      for (const comment of run.verdict.comments) lines.push(`- ${comment}`);
      lines.push('');
    }
  }
  if (diff && diff.files.length > 0) {
    lines.push(`### Changes on the branch (+${diff.additions} −${diff.deletions})`, '');
    for (const file of diff.files.slice(0, 100)) {
      lines.push(`- ${file.path} (+${file.additions ?? 0} −${file.deletions ?? 0})`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

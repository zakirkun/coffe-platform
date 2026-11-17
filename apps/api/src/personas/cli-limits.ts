import type { PermissionPolicyJson } from '../db/schema/index.js';

/**
 * What each CLI can enforce natively (architecture Appendix A.2/A.3). Limits a CLI cannot
 * enforce are listed on the persona as "not enforceable" instead of silently ignored; the runner
 * always enforces the run timeout and blocks `git push` for every CLI.
 */
interface CliLimits {
  name: string;
  /** Allow/deny rules for individual tools or command prefixes. */
  toolRules: boolean;
  /** Network access can be switched off. */
  network: boolean;
  maxTurns: boolean;
  /** USD budget cap (needs CLI-side cost accounting). */
  budget: boolean;
  /** A read-only mode that prevents edits. */
  readOnly: boolean;
}

export const CLI_LIMITS: Record<string, CliLimits> = {
  'claude-code': { name: 'Claude Code', toolRules: true, network: true, maxTurns: true, budget: true, readOnly: true },
  codex: { name: 'Codex', toolRules: false, network: true, maxTurns: false, budget: false, readOnly: true },
  gemini: { name: 'Gemini CLI', toolRules: true, network: false, maxTurns: true, budget: false, readOnly: true },
  opencode: { name: 'OpenCode', toolRules: true, network: false, maxTurns: false, budget: false, readOnly: true },
  antigravity: { name: 'Antigravity', toolRules: false, network: false, maxTurns: false, budget: false, readOnly: true },
  grok: { name: 'Grok Build', toolRules: true, network: false, maxTurns: false, budget: false, readOnly: true },
  muse: { name: 'Muse Code', toolRules: false, network: false, maxTurns: false, budget: false, readOnly: true },
  pi: { name: 'Pi', toolRules: true, network: false, maxTurns: false, budget: false, readOnly: true },
  kiro: { name: 'Kiro CLI', toolRules: true, network: false, maxTurns: false, budget: false, readOnly: true },
  fake: { name: 'Fake CLI', toolRules: true, network: true, maxTurns: true, budget: true, readOnly: true },
};

export const KNOWN_CLI_IDS = Object.keys(CLI_LIMITS);

/** Human-readable list of the persona's limits that `cliId` cannot enforce. */
export function unenforceableLimits(cliId: string, policy: PermissionPolicyJson): string[] {
  const limits = CLI_LIMITS[cliId];
  if (!limits) return [`${cliId}: unknown CLI, no limit can be guaranteed`];
  const missing: string[] = [];
  if (!limits.toolRules && (policy.allow_tools.length > 0 || policy.deny_tools.length > 0)) {
    missing.push(`tool allow/deny rules: ${limits.name} has no per-tool rules`);
  }
  if (!limits.network && !policy.network) {
    missing.push(`no network: ${limits.name} cannot switch network access off`);
  }
  if (!limits.maxTurns && policy.max_turns != null) {
    missing.push(`max turns: ${limits.name} has no turn limit`);
  }
  if (!limits.budget && policy.max_budget_usd != null) {
    missing.push(`budget: ${limits.name} reports no cost to cap`);
  }
  if (!limits.readOnly && policy.mode === 'read_only') {
    missing.push(`read-only: ${limits.name} has no read-only mode`);
  }
  if (cliId === 'pi' && policy.mode !== 'full_auto') {
    missing.push('approvals: Pi has no permission system (run it in a container target)');
  }
  return missing;
}

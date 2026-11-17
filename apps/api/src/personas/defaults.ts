import { eq } from 'drizzle-orm';
import type { DbExecutor } from '../db/db.module.js';
import { type PermissionPolicyJson, personas, workflows } from '../db/schema/index.js';

/** CLI of the seeded personas when the project names none. */
export const DEFAULT_PERSONA_CLI = 'claude-code';

const READ_ONLY: PermissionPolicyJson = { mode: 'read_only', allow_tools: [], deny_tools: [], network: true };
const WORKSPACE_WRITE: PermissionPolicyJson = {
  mode: 'workspace_write',
  allow_tools: [],
  deny_tools: [],
  network: true,
};

const DEFAULT_PERSONAS = [
  {
    key: 'planner',
    name: 'Planner',
    role: 'planner',
    color: '#8b5cf6',
    permissions: READ_ONLY,
    instructions:
      'You turn requirements into small, independently shippable tickets. Read the code to ground every ticket in real files, modules and conventions. Never edit files.',
  },
  {
    key: 'implementer',
    name: 'Implementer',
    role: 'implementer',
    color: '#0ea5e9',
    permissions: WORKSPACE_WRITE,
    instructions:
      "You implement the ticket in this worktree. Keep the change focused on the acceptance criteria, follow the project's rules and existing patterns, and add or update tests for what you change.",
  },
  {
    key: 'tester',
    name: 'Tester',
    role: 'tester',
    color: '#22c55e',
    permissions: WORKSPACE_WRITE,
    instructions:
      'You verify the implementation: run the test suite, add tests that prove each acceptance criterion, and change only test code. Report failures precisely.',
  },
  {
    key: 'reviewer',
    name: 'Reviewer',
    role: 'reviewer',
    color: '#f59e0b',
    permissions: READ_ONLY,
    instructions:
      'You review the change against the acceptance criteria and the project rules: correctness, edge cases, tests, readability. Never edit files; request changes with concrete, actionable comments.',
  },
] as const;

/**
 * Gives a workspace its starter personas and the default "Implement → Test → Review" workflow
 * when its first project is created. Workspaces that already have personas are left alone.
 */
export async function seedWorkspaceDefaults(
  executor: DbExecutor,
  workspaceId: string,
  userId: string,
  cliId: string,
): Promise<void> {
  const [existing] = await executor
    .select({ id: personas.id })
    .from(personas)
    .where(eq(personas.workspaceId, workspaceId))
    .limit(1);
  if (existing) return;

  const created = await executor
    .insert(personas)
    .values(
      DEFAULT_PERSONAS.map(({ name, role, color, permissions, instructions }) => ({
        workspaceId,
        name,
        role,
        color,
        permissions,
        instructions,
        cliId,
        createdBy: userId,
      })),
    )
    .returning({ id: personas.id, role: personas.role });
  const idOf = (role: string) => {
    const persona = created.find((row) => row.role === role);
    if (!persona) throw new Error(`seeding the ${role} persona failed`);
    return persona.id;
  };

  await executor.insert(workflows).values({
    workspaceId,
    name: 'Implement → Test → Review',
    isDefault: true,
    steps: [
      { key: 'implement', name: 'Implement', persona_ids: [idOf('implementer')], parallel: false, on_fail: 'stop', max_loops: 0 },
      { key: 'test', name: 'Test', persona_ids: [idOf('tester')], parallel: false, on_fail: 'goto:implement', max_loops: 2 },
      { key: 'review', name: 'Review', persona_ids: [idOf('reviewer')], parallel: false, on_fail: 'goto:implement', max_loops: 2 },
    ],
  });
}

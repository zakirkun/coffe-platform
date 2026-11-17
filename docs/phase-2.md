# Phase 2 — Orchestration

Demo: a requirement is planned into tickets by a planner persona → the board orders them and shows
what waits for what → a ticket's workflow hands it from implementer to tester to reviewer (looping
back on failed tests or requested changes) → the review gate shows the diff, the test command and
the tester's report → usage is attributed to personas, tickets, projects, CLIs and models. Every
supported CLI can be assigned to a persona.

## What ships

| Feature | Where |
|---|---|
| **F2 Personas**: name, role, instructions, CLI, model, mode (structured/terminal), driver (native/ACP), permission limits (access, network, tool allow/deny, max turns, budget, timeout). Limits a CLI cannot enforce are listed live in the editor and stored on the persona. Four starter personas and the default workflow are created with the first project. | `apps/api/src/personas`, `packages/contracts/src/clis.ts`, web **Personas** |
| **F3 Project context**: rules and knowledge-base entries sent with every run as `.coffe/context/00…50-*.md` (COFFE rules, project rules, persona, knowledge, ticket or requirement, handoff), 512 KiB cap (knowledge is dropped before rules), exact bundle preview. | `apps/api/src/context`, web board → **Context** |
| **F4 Planning**: requirement → read-only planner run in a detached worktree (plan JSON schema sent as `output_schema` where the CLI supports it) → editable draft tickets (title, description, criteria, role, add/discard) → approve → Backlog tickets with dependencies. A dependent ticket shows "After …" and its workflow refuses to start until the dependency is Done. | `apps/api/src/planning`, web board → **Plan** |
| **F5 Kanban**: drag and drop between and within columns (`@dnd-kit/react`, fractional positions computed by the server), **Start** on Backlog/Ready cards, event-driven status (run start → In Progress, completion → In Review, failure flag, merge → Done), live updates. | web board |
| **F1 Multi-agent workflows**: steps of one or several personas, several read-only personas of one step in parallel (joined before the next step), handoff notes between steps, tester/reviewer verdicts from fenced JSON blocks, loops back to an earlier step with a loop limit, cancel, resume after an API restart. | `apps/api/src/workflows`, web board → **Workflows**, ticket → **Agents** |
| **F6b Review gate tests**: the latest test-command result and tester report side by side; optional project setting **Block approval until tests pass** (enforced by the API). | web ticket → **Review**, board → **Settings** |
| **F8/F9 CLIs**: adapters for Codex, Gemini CLI, OpenCode, Antigravity, Grok Build, Muse Code, Pi and Kiro next to Claude Code; ACP driver for Gemini, OpenCode, Antigravity, Grok, Muse and Kiro; detection on PATH and per-user install directories. | `crates/coffe-adapters/src/adapters`, [cli-support.md](cli-support.md) |
| **F10 Usage monitor**: tokens, reported and estimated cost, credits and agent time grouped by day, project, ticket, persona, CLI, model, member or run; editable price table for CLIs that report no cost. | `apps/api/src/usage`, web **Usage** |
| **F18b Multiple runners per project**: bind the same repository on several runners; the scheduler picks an online runner with the persona's CLI and a free slot (primary binding first) and keeps a ticket on the runner holding its worktree. | `apps/api/src/runs/run-scheduler.ts`, web board → **Repositories** |

## Run it (development)

Setup is the same as [Phase 1](phase-1.md#run-it-development); `pnpm dev` applies the new
migration (`0003_phase2_run_policy`). Then:

1. **Projects → New project.** The workspace gets four personas (Planner, Implementer, Tester,
   Reviewer) on the project's default CLI (Claude Code unless set) and the workflow
   "Implement → Test → Review".
2. **Personas**: choose CLI, model and limits per persona; a warning lists what the chosen CLI
   cannot enforce.
3. Board → **Context**: add rules and knowledge; **Bundle preview** shows what a run receives.
4. Board → **Plan**: write a requirement, **Plan tickets**, edit the drafts, **Approve**.
5. Board: drag cards between columns; **Start** (or ticket → **Agents → Start workflow**) runs the
   workflow. Each step appears in the timeline with its runs, verdict and loops; the ticket lands in
   **In Review**.
6. **Review**: diff, test command and tester report; approve or request changes (Phase 1).
7. **Usage**: switch the grouping; owners and members edit the price table.
8. Board → **Repositories**: add the same repository from a second runner to spread tickets.

With the fake CLI (Phase 1 setup), switch the personas' CLI to **Fake CLI**. A requirement that
contains `[[fake:plan]]` makes the fake planner answer with a two-ticket plan.

## Tests

| Suite | Command | Result (Windows 11, 2026-11-17) |
|---|---|---|
| Rust: protocol, adapters (incl. the 8 new adapters against documented stream shapes), fake CLI, runner, supervisor | `cargo test --workspace` | 121 passed (adapters 46, fake CLI 9, protocol 8, runner 58; the real-CLI smoke test skips itself) |
| API integration (Nest app + Postgres + protocol-level fake runner): personas, context, workflows, planning, usage, review gate, restart resume | `pnpm --filter @coffe/api test` | 52 passed |
| Web units (board grouping/move requests, persona limits form, realtime, patch, run options) | `pnpm --filter @coffe/web test` | 20 passed |
| End to end, Phase 1 and Phase 2 (browser → API → real runner → fake CLI) | `cargo build -p coffe-runner -p coffe-fake-cli && pnpm --filter "@coffe/api..." build && pnpm test:e2e` | 2 passed with `E2E_BROWSER_CHANNEL=msedge` (Phase 2: personas switched in the editor, card dragged to Ready, Implement → Test → Review to In Review, requirement planned and approved with a dependency, usage per persona) |
| Real CLIs (opt-in, sends prompts) | `COFFE_SMOKE_REAL_CLIS=1 cargo test -p coffe-runner --test real_clis` | not run (consumes tokens) |

## CLI limitations

Reported in [cli-support.md](cli-support.md) (L1–L16). The ones that shape Phase 2:

- **Approvals** (L1, L4, L5, L10): Codex `exec`, Gemini headless and Antigravity headless never ask;
  Claude Code's stdio permission answers are undocumented. Personas grant permissions up front;
  choose the **ACP** driver (Gemini, OpenCode, Antigravity, Grok, Muse, Kiro) to answer permission
  prompts from the UI.
- **Cost** (L2, L3): Codex, Gemini, Antigravity and Muse report tokens only (estimated from the
  price table, labelled "estimated"); Kiro reports credits only.
- **Limits** (L15, L16): tool rules, network switches, turn limits and budgets exist only in some
  CLIs; the persona editor shows exactly which limits are not enforceable for the chosen CLI.
- **Pi** (L7) has no permission system: run Pi personas only where full access is acceptable.
- **Unverified CLIs** (L12): Gemini, Antigravity, Grok, Muse and Kiro are not installed on the
  reference machine. Options: (a) run the opt-in smoke test on a machine that has them, (b) keep
  them marked experimental in the persona editor until it passed, (c) restrict them with the
  runner policy `allowed_clis`.

## Not finished in Phase 2

- The planning run's terminal is not viewable (planning runs have no ticket page); the requirement
  shows its status and the planner's error.
- Workflow editor: steps are reordered with up/down buttons (no drag and drop); no conditional
  steps or per-step model override. Personas created on the Personas page are workspace-wide
  (project-scoped personas only through the API); persona colors are not editable.
- Dependencies come only from planning; they cannot be added or removed by hand yet.
- Usage is a table (no charts, no budget alerts).
- After an API restart between two workflow steps, the next step starts without the lost handoff
  note (the previous step's summary is still in its run).
- Real-CLI verification: detection was verified for the installed CLIs (Claude Code, Codex,
  OpenCode, Pi); no prompts were sent. Gemini, Antigravity, Grok, Muse and Kiro are verified only
  against their documented stream shapes (L12).
- Docker, preview browser, database manager and SSH → Phase 3. Canvas, wiki, dependency graph,
  invitations, presence and comments → Phase 4.

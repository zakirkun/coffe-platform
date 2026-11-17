# Phase 1 — Pairing → Run → Terminal → Review

Demo: pair a runner → create a project and a ticket → run an agent CLI on the ticket in its own
git worktree → watch and interact in the browser terminal → review the diff → approve (merge) or
request changes (the feedback goes back to the agent).

## What ships

| Feature | Where |
|---|---|
| Runner pairing with a one-time token (10 min, single use), revocable runner token, online/offline status, fingerprint | `apps/api/src/runners`, `crates/coffe-runner` (`pair`, `start`), web **Runners** page |
| Local-only repository registry | `coffe-runner repo add/list/remove` |
| One ticket = one worktree + branch (`coffe/<KEY>`), context files in `.coffe/context/`, push blocked for the agent | `crates/coffe-runner/src/git.rs`, `supervisor` |
| Claude Code adapter (headless `stream-json`, follow-ups on stdin, PTY mode) + fake CLI fixture | `crates/coffe-adapters/src/adapters/{claude_code,fake}.rs`, `crates/coffe-fake-cli` |
| Live terminal (xterm.js): replay + live output, input, pause/resume, interrupt, stop | web ticket page → **Runs** |
| Review gate: Monaco diff (files fetched from the runner on demand), test command results, approve → merge, request changes → new run with the feedback | web ticket page → **Review** |
| Audit log (REST mutations, every runner command, agent `execute` tool calls, terminal input lines) | web **Audit** page |
| Run resume across disconnects (spool + cumulative acks) and runner restarts (`interrupted`) | `crates/coffe-runner/src/spool.rs`, `daemon.rs` |

## Prerequisites

- Node.js ≥ 22.12 and pnpm 12, Rust 1.100 (rustup reads `rust-toolchain.toml`), Docker, git ≥ 2.38.
- For a real agent: Claude Code installed and logged in on the runner machine (`claude --version`).
  Without it, enable the fake CLI (below).

## Run it (development)

```bash
pnpm install
docker compose -f deploy/docker-compose.dev.yml up -d          # PostgreSQL 18 on :55432
cp apps/api/.env.example apps/api/.env                           # set AUTH_SECRET (32+ chars)
pnpm build                                                       # protocol + contracts + api + web
pnpm dev                                                         # api :4000 (migrates), web :3000
cargo build --release -p coffe-runner -p coffe-fake-cli
```

1. Open http://localhost:3000, sign up, create a workspace.
2. **Runners → Pair a runner**, copy the command and run it on the machine with your repositories:

   ```bash
   ./target/release/coffe-runner pair --server http://localhost:4000 --token coffe_pt_…
   ./target/release/coffe-runner repo add ~/code/my-project
   ./target/release/coffe-runner start
   ```

   Compare the printed fingerprint with the one in the web app. The runner appears **online** with
   its detected CLIs and repositories.
3. **Projects → New project**, pick the repository. **Settings** on the board sets the test
   command, the default CLI/mode and the merge strategy.
4. Create a ticket with acceptance criteria, open it, **Run → Start run** (Claude Code, structured).
5. Watch the terminal; send a follow-up message; try **Pause**/**Resume** (Linux/macOS) and **Stop**.
   In interactive (PTY) mode click the terminal and type: keystrokes go to the CLI.
6. When the run completes the ticket moves to **In Review**. **Review** shows the diff (Monaco),
   test results (when the project has a test command), **Approve** merges `coffe/<KEY>` into the
   base branch on the runner, **Request changes** starts a new run with your feedback.

### Using the fake CLI instead of a real agent

`coffe-runner pair` writes the whole `[policy]` table to the runner's `runner.toml`
(`coffe-runner status` prints its path); set `enable_fake_cli = true` in it:

```toml
[policy]
enable_fake_cli = true
```

and start the runner with `coffe-runner start --fake-cli-dir ./target/release`. Select **Fake CLI**
when starting a run. Scenarios (`edit`, `slow`, `fail`, `permission`, `long_output`) are chosen with
the `COFFE_FAKE_SCENARIO` environment variable of the runner process, or per turn with a
`[[fake:<scenario>]]` directive in the prompt.

## Tests

| Suite | Command | Needs |
|---|---|---|
| Rust (protocol, adapters, fake CLI, runner incl. git, spool, connection, PTY shells, supervisor) | `cargo test --workspace` (the supervisor tests build the fake CLI themselves) | git |
| Protocol package | `pnpm --filter @coffe/protocol test` | – |
| API integration (real Nest app + Postgres + protocol-level fake runner) | `pnpm --filter @coffe/api test` | dev Postgres (`coffe_test` DB) |
| Web units | `pnpm --filter @coffe/web test` | – |
| End-to-end (browser → api → real runner → fake CLI → merge) | `cargo build -p coffe-runner -p coffe-fake-cli && pnpm --filter "@coffe/api..." build && pnpm test:e2e` | dev Postgres; Playwright Chromium (`pnpm --filter @coffe/e2e exec playwright install chromium`) or an installed browser via `E2E_BROWSER_CHANNEL=msedge` / `chrome` |
| Protocol drift | `pnpm protocol:check` | Rust toolchain |

Verified on Windows 11 (runner, API, web and browser on one machine): all suites pass, including
the end-to-end demo with `E2E_BROWSER_CHANNEL=msedge`.

## Not finished in Phase 1

Delivered in later phases by design:

- Personas, project knowledge/rules, workflows (implementer → tester → reviewer), planning, Kanban
  drag and drop, usage monitor, multi-runner scheduling, the other eight CLI adapters → Phase 2.
  Phase 1 runs use the ticket's repository runner and a fixed `workspace_write` policy.
- Test results come only from the project's test command; agent-reported test results
  (review gate F6b) → Phase 2.
- Docker, preview browser, database manager, SSH → Phase 3. Canvas, wiki, dependency graph,
  invitations, presence and comments → Phase 4.

Known limitations of what shipped:

- **Windows runners**: pause/resume and interrupt/terminate signals need Unix process groups.
  On Windows, Pause/Resume report "not supported", Interrupt works only in PTY mode (Ctrl+C) or
  through the CLI's own protocol (Claude Code, fake CLI), and Stop escalates to kill. Use WSL for
  the full control set.
- **Claude Code permission prompts** cannot be answered from the UI with the native driver
  (limitation L5): personas grant permissions up front (`acceptEdits` + allow/deny lists).
- Follow-up messages after a structured run finished are not accepted (the session is closed when
  its last turn completes); use **Request changes** to continue in the same CLI session.
- The diff shown in review is the one stored at run completion; **Refresh diff** asks the runner
  for a new one. Files are fetched from the runner on demand, so side-by-side review needs the
  runner online (the stored unified patch is shown otherwise).
- Approve merges locally on the runner; pushing requires `push_on_approve` in the project settings
  **and** `allow_push = true` in the runner policy.
- Usage is shown per run (tokens and the CLI-reported cost); aggregation and price tables → Phase 2.

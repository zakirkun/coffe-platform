# CLI support, drivers and limitations

COFFE drives each agent CLI through its own headless/structured interface when it has one, falls
back to the CLI's interactive TUI in a PTY otherwise, and never calls model APIs itself. This page
is the user-facing summary of `docs/architecture.md` Appendix A; the adapter implementations live
in `crates/coffe-adapters/src/adapters/`.

Verified against official docs and the installed CLIs on 2026-11-16. CLIs change often: every
runner re-detects versions on start and on **Re-detect CLIs**.

## Drivers

| Driver | What runs | When to use |
|---|---|---|
| **Native** (default) | The CLI's headless JSON stream | Unattended ticket runs |
| **ACP** | Agent Client Protocol over stdio | Live permission prompts, steering, cancel |
| **PTY** | The CLI's own TUI in a terminal | Interactive sessions; CLIs without a headless mode |

## Matrix

| CLI | `cli_id` | Native | ACP | Follow-up messages | Tokens | Cost | Resume |
|---|---|---|---|---|---|---|---|
| Claude Code | `claude-code` | `claude -p --input-format/--output-format stream-json` | — (adapter only) | same process | ✓ | ✓ (CLI estimate) | ✓ |
| OpenAI Codex | `codex` | `codex exec --json` | — (adapter only) | respawn `exec resume` | ✓ | — → estimated | ✓ |
| Gemini CLI | `gemini` | `gemini -p -o stream-json` | `gemini --acp` | respawn `-r` | ✓ | — → estimated | ✓ |
| OpenCode | `opencode` | `opencode run --format json` | `opencode acp` | respawn `-s` | ✓ | ✓ | ✓ |
| Google Antigravity | `antigravity` | `agy --input/--output-format stream-json` | `agy acp` | same process | ✓ | — → estimated | ✓ |
| xAI Grok Build | `grok` | `grok -p --output-format streaming-json` | `grok agent stdio` | respawn `-r` | ✓ | API-key traffic only | ✓ |
| Meta Muse Code | `muse` | `muse exec --json` (experimental) | `muse acp` (experimental) | respawn `--session-id` | ✓ | — → estimated | ✓ |
| Pi | `pi` | `pi --mode rpc` | — (community adapter only) | same process | ✓ | ✓ | ✓ |
| Kiro CLI | `kiro` | `kiro-cli chat --v3 --no-interactive --output-format stream-json` | `kiro-cli acp` | respawn `--resume-id` | credits only | credits | ✓ |

"estimated" = tokens × the workspace price table (Usage → Pricing), always labelled as estimated.

## Limitations found (reported, not patched around)

| # | CLI | Limitation | What COFFE does / options |
|---|---|---|---|
| L1 | Codex | `codex exec` never asks for approval (it auto-rejects). | Autonomy is controlled by the sandbox mode of the persona. For interactive approvals: `codex-acp` (third-party) or `codex app-server` (documented as experimental). |
| L2 | Codex, Gemini, Antigravity, Muse | No USD cost in their output. | Cost is estimated from tokens and labelled `estimated`; tokens are exact. |
| L3 | Kiro | Meters credits, no token counts; the stream-json record schema is not published; headless defaults to the V2 engine. | Credits are reported, tokens shown as unavailable; `--v3` is always passed; ACP driver available. |
| L4 | Gemini | No streaming input; headless denies approval prompts. | Follow-ups respawn with `-r <session>`; use the ACP driver for approvals. |
| L5 | Claude Code | Programmatic permission answers over stdio exist only in SDK source, not in the CLI reference. | Permission modes + allow/deny lists from the persona; permission requests are not answered from the UI with the native driver. |
| L6 | OpenCode | V1 and V2 coexist with different server APIs; V2 may drop the last usage record. | `run --format json` works on both; usage reconciled at the end of the run. |
| L7 | Pi | No permission/approval system. | Tool allow-lists only; run Pi personas in a container target. Persona limits are shown as "not enforceable". |
| L8 | Muse Code | Meta does not document the `exec --json` schema; ACP is experimental. | Parser built from community-captured fixtures, marked experimental. |
| L9 | Grok Build | Binary name `grok` collides with a community CLI; cost only for API-key traffic. | Detection checks `--help` for official flags. |
| L10 | Antigravity | Headless soft-denies actions that need approval and still exits 0; headless auth needs a cached login, API key or ADC. | Persona permissions must grant what the ticket needs; denied actions appear in the event log. |
| L11 | All | CLI deny rules are not a security boundary. | Runner-level push blocking (`pushurl` override) + container targets (Phase 3) + audit of executed commands. |
| L12 | Gemini, Antigravity, Grok, Muse, Kiro | Not installed on the reference machine; adapters are tested against documented/synthesized fixtures. | Opt-in smoke tests with `COFFE_SMOKE_REAL_CLIS=1` on a machine that has them. |

## Detection

`coffe-runner cli list` prints what the runner found. Detection looks on `PATH` plus common
per-user install directories (`~/.local/bin`, `~/.npm-global/bin`, `%APPDATA%\npm`, …), runs only
`--version` (and a non-consuming auth check where the CLI has one), and never sends prompts.

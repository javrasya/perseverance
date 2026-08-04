# Agent CLI surfaces: capability matrix for the wayfinder adapter contract

Research for [issue #5 — Codex and Pi CLI surfaces for adapter parity](https://github.com/javrasya/perseverance/issues/5).

**Date checked:** 2026-08-01. **Method:** where a CLI was installed on the research machine, `--help` output and on-disk state were inspected directly (observed beats documented) and are marked **(observed)**. Everything else comes from the tool's own repo or official docs, cited inline. Anything that could not be established from a primary source is marked **unknown** rather than guessed.

**Versions verified locally (observed, `npm ls -g`):**

| CLI | Version | Binary |
| --- | --- | --- |
| Claude Code (`claude`) | `2.1.220` | `@anthropic-ai/claude-code` |
| Codex CLI (`codex`) | `codex-cli 0.130.0` | `@openai/codex` |
| Pi (`pi`) | `0.83.0` | `@earendil-works/pi-coding-agent` |

Gemini CLI, opencode, `cursor-agent`, and aider were **not** installed on this machine (observed: `Get-Command` returned nothing for each), so their rows are documentation-only and **their versions are not pinned** — they were read from each project's current docs/`main` on 2026-08-01, so treat version-specific details as current-at-date. A `cursor` binary *is* on PATH but it is the Cursor **editor**'s VS Code-style launcher (`C:\Program Files\cursor\resources\app\bin\cursor.cmd` → `Cursor.exe out/cli.js`, reporting `3.4.17`, observed), not the `cursor-agent` coding CLI — do not confuse the two.

**Which CLIs were included, and why.** Codex and Pi were required by the ticket. Gemini CLI, opencode and Cursor CLI earn their rows: each is a general-purpose agent CLI that can take an opening prompt and stay interactive, and each contributes a capability the others lack (Gemini an explicit `--prompt-interactive` flag and shell hooks; opencode the best per-run config isolation via `OPENCODE_CONFIG`; Cursor the richest hook set and native worktrees). **aider is included only to record a negative result** — it cannot seed a prompt and remain interactive, which disqualifies it from this harness's spawn model (§8). Nothing else was added for volume.

**The headline finding, if you read nothing else:** every targetable CLI accepts an opening prompt into an interactive session, but **the delivery mechanism is not portable** — argv positional for Codex/Pi/Cursor/Claude, `--prompt-interactive` for Gemini (whose `-p` means the *opposite* of Claude's), and `--prompt` for opencode (whose positionals are headless). "Append the prompt to argv" is not a valid shared abstraction. See §9.1.

---

## 1. Capability matrix

Legend: **Y** = supported, **N** = not supported, **~** = partial or with caveats, **unknown** = could not establish from a primary source.

### 1a. Getting a session started

| CLI | Interactive start | Initial prompt into an *interactive* session | Headless / print mode | Working directory | Session resume |
| --- | --- | --- | --- | --- | --- |
| **Claude Code** | `claude` | **Y** — `claude "<prompt>"` positional (observed, `claude --help`) | `-p` / `--print` (observed) | spawn cwd; `--add-dir` widens tool access, does not move cwd (observed) | `-c` / `--continue`, `-r` / `--resume [id]`, `--session-id <uuid>` (observed) |
| **Codex CLI** | `codex` | **Y** — `codex [PROMPT]`, help says "Optional user prompt to start the session" (observed, `codex --help`) | `codex exec` (alias `e`) (observed) | **`-C` / `--cd <DIR>`** — "Tell the agent to use the specified directory as its working root" (observed) | `codex resume [SESSION_ID] [PROMPT]`, `--last`; `codex fork` (observed) |
| **Pi** | `pi` | **Y** — `pi "<prompt>"`; help example is literally "Interactive mode with initial prompt" (observed, `pi --help`) | `-p` / `--print` (observed) | **spawn cwd only** — no `--cd` flag in `pi --help` (observed) | `-c`/`--continue`, `-r`/`--resume`, `--session <path\|id>`, `--session-id`, `--fork` (observed) |
| **Gemini CLI** | `gemini` | **Y, explicitly** — `-i`/`--prompt-interactive` "Execute prompt and continue in interactive mode"; bare positional also stays interactive in a TTY. ⚠ **`-p` forces *non*-interactive** | `-p` / `--prompt` | **spawn cwd only** — no cwd flag; `--include-directories` only widens the workspace | `-r`/`--resume` (`latest`, index, or UUID); `gemini -r "<id>" "query"` reseeds |
| **opencode** | `opencode` | **Y** — **`--prompt`** keeps the session interactive. ⚠ positionals belong to `run`, not the TUI | `opencode run "<query>"` | **`--dir`** sets the working directory | `--session <ID>`, `-c`/`--continue`, `--fork` |
| **Cursor CLI** | `cursor-agent` | **Y** — argv positional, `agent "<prompt>"` | `-p` / `--print` | no `--cwd`; `--workspace` exists, semantics **unknown** | `--resume [chatId]`; `--continue` (= `--resume=-1`) |
| **aider** | `aider` | **N — disqualifying.** `-m/--message` and `--message-file` both "process reply **then exit**"; no documented way to seed a prompt and stay interactive | `-m/--message`, `--message-file` (same flags — headless *is* the only prompt path) | spawn cwd (no flag found) | **unknown** |

### 1b. Observability surfaces

| CLI | Hooks / events | On-disk transcript | Structured output | Local server / RPC |
| --- | --- | --- | --- | --- |
| **Claude Code** | **Y** — shell hooks on lifecycle events, JSON on stdin | **Y** — JSONL session files | **Y** — `--output-format json\|stream-json` (print mode only) (observed) | Remote Control (`--remote-control`) (observed) |
| **Codex CLI** | **Y** — `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `UserPromptSubmit`, `SubagentStop`, `Stop`, `SessionStart`, `SessionEnd`, `SubagentStart`; JSON on stdin incl. `transcript_path` | **Y** — `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` (observed) + `session_index.jsonl` + `history.jsonl` | **Y** — `codex exec --json` JSONL; `--output-schema`; `-o/--output-last-message` (observed) | **Y** — `codex app-server` (stdio/unix/ws), `codex mcp-server` (observed) |
| **Pi** | **Y but in-process** — TypeScript *extensions*, not shell hooks. ~30 events incl. `session_start`, `tool_call` (can block), `agent_settled`, `session_shutdown` | **Y** — `~/.pi/agent/sessions/<slugified-cwd>/<ts>_<uuid>.jsonl` (observed) | **Y** — `--mode json` (JSONL event stream) | **Y** — `--mode rpc` (bidirectional JSONL over stdin/stdout) |
| **Gemini CLI** | **Y** — shell hooks in `settings.json`, JSON on stdin/stdout: `BeforeTool`, `AfterTool`, `BeforeAgent`, `AfterAgent`, `BeforeModel`, `BeforeToolSelection`, `AfterModel`, `SessionStart`, `SessionEnd`, `Notification`, `PreCompress`; `continue:false` halts the whole loop | **Y** — `~/.gemini/tmp/<project_hash>/chats/`; file format **unknown**. `--list-sessions` / `--delete-session` enumerate without parsing | **Y** — `-o/--output-format text\|json\|stream-json` (JSONL) | `--experimental-acp` (agent-client-protocol), `--experimental-zed-integration` |
| **opencode** | **Y but in-process** — JS/TS *plugins*, not shell hooks. Rich event set incl. **`session.idle`** (completion), `tool.execute.before/after`, `permission.asked/replied`, `file.edited`, `tui.prompt.append` | **unknown** — config docs do not cover runtime data location | **Y** — `opencode run --format json` (raw JSON events); `--print-logs`, `--log-level` | **Y** — `serve` (HTTP) and `acp` subcommands |
| **Cursor CLI** | **Y — richest surveyed** — `hooks.json`; `sessionStart/End`, `preToolUse`, `postToolUse`, `beforeShellExecution`, `afterFileEdit`, `beforeSubmitPrompt`, `preCompact`, **`stop`**, `afterAgentResponse`, `subagentStart/Stop`, …; stdin JSON incl. `transcript_path`; exit 2 blocks. ⚠ **which fire under the CLI is undocumented** | **Y, indirectly** — `transcript_path` in every hook payload; on-disk location/format **unknown** | **Y** — `--output-format text\|json\|stream-json` (requires `--print`); `--stream-partial-output` | **unknown** |
| **aider** | **N** — none documented | **~** — `.aider.chat.history.md` is **Markdown prose, not machine-readable**; `--llm-history-file` for raw LLM log | **N** — no JSON output mode documented | **N** |

### 1c. Configuration, extensibility, and PTY behaviour

| CLI | Slash / skill system | Per-run config injection | Auth | PTY-renderer hazards |
| --- | --- | --- | --- | --- |
| **Claude Code** | Skills + custom slash commands + plugins | **Y, strong** — `--settings <file-or-json>`, `--setting-sources`, `--plugin-dir`, `--mcp-config`, `--agents`, `--safe-mode`, `--bare` (observed) | OAuth or `ANTHROPIC_API_KEY` | Full-screen TUI |
| **Codex CLI** | **Y** — Agent Skills (`SKILL.md`, `$skill` explicit or implicit), ~50 built-in slash commands, `$CODEX_HOME/prompts/*.md` custom prompts (**deprecated** in favour of skills) | **Partial** — `-c key=value` TOML overrides (all subcommands, observed); `CODEX_HOME` env var (observed to work, but **relocates auth too**); `--ignore-user-config` (**`exec` only**, observed); `--profile` | `codex login` (ChatGPT OAuth) or API key; `auth.json` under `CODEX_HOME` (observed) | **Alternate screen by default**; `--no-alt-screen` exists for inline mode (observed). Non-interactive prompts (trust, approval, login) can block a spawned TUI. |
| **Pi** | **Y** — Agent Skills (`/skill:name`), prompt templates (`/name` from `*.md`), extension-registered commands | **Y, strong** — `PI_CODING_AGENT_DIR` relocates the whole config dir; `--skill`, `--prompt-template`, `--extension`, `--session-dir`, `--approve`/`--no-approve`, `--no-skills`, `--no-extensions`, `--append-system-prompt` (all repeatable/per-run, observed) | `/login` OAuth or one of ~30 `*_API_KEY` env vars; `~/.pi/agent/auth.json` (observed) | Full TUI. **Requires a bash shell on Windows** (Git Bash / Cygwin / MSYS2). Interactive project-trust prompt on first run in a folder. |
| **Gemini CLI** | **Y** — Agent Skills (`skills.md`, `using-agent-skills.md`) plus custom slash commands (`custom-commands.md`) | **Weakest of the surveyed set** — no `--settings`, no `--config`, no `-c key=value`. Hooks live in `settings.json`, so enabling them means **writing a settings file**. Only `--extensions`, `--model`, `--approval-mode` are per-run. Config-dir env var **unknown** | **unknown** | Full TUI. `--skip-trust` bypasses the trusted-folders prompt; `--approval-mode=yolo` prevents approval modals; `--screen-reader` flattens output as a renderer fallback. Windows behaviour **unknown** |
| **opencode** | **unknown** — skill support not established; `command.executed` event implies commands exist | **Y, strongest surveyed** — **`OPENCODE_CONFIG` env var points at a custom config file for one run**. Unlike `CODEX_HOME`/`PI_CODING_AGENT_DIR` it relocates *config only*, **not** credentials | **unknown** | **unknown** |
| **Cursor CLI** | **unknown** | **Partial** — `--plugin-dir` (per-run plugin injection), `--api-key` (per-run auth), `--model`, `--mode`. No `--config` found | **`--api-key`** flag, or a login flow (**unknown**) | `--trust` skips the trust prompt; `-f/--force`/`--yolo` prevents approval modals; `--sandbox`, `--approve-mcps`. ⚠ Community reports (secondary, unverified) of a **UTF-8 BOM in hook stdin JSON on Windows** breaking `JSON.parse()` |
| **aider** | In-chat `/` commands only (`/add`, `/ask`, `/architect`, `/commit`, `/run`, …) — **reachable only by typing into the TUI** | **unknown** | **unknown** | **unknown** |

---

## 2. Claude Code (baseline row)

Included only as the reference point the other adapters are measured against; the harness already targets it.

- **Interactive start + initial prompt:** `claude [options] [prompt]`. Help text: "Claude Code - starts an interactive session by default, use -p/--print for non-interactive output", with `prompt` as a positional argument (observed, `claude --help`, v2.1.220).
- **Headless:** `-p, --print` — "Print response and exit (useful for pipes)". Structured output via `--output-format` with choices `text`, `json`, `stream-json`; note these are documented as "(only works with --print)" (observed).
- **Hook events in the stream:** `--include-hook-events` — "Include all hook lifecycle events in the output stream (only works with --output-format=stream-json)" (observed).
- **Per-run config injection:** the richest of any CLI surveyed — `--settings <file-or-json>`, `--setting-sources <user,project,local>`, `--mcp-config`, `--strict-mcp-config`, `--plugin-dir`, `--agents <json>`, `--system-prompt`, `--append-system-prompt`, plus `--safe-mode` and `--bare` to disable customisations wholesale (observed).
- **Session resume:** `-c/--continue`, `-r/--resume [id]`, `--session-id <uuid>`, `--fork-session` (observed).

---

## 3. OpenAI Codex CLI

Version checked: **`codex-cli 0.130.0`** (observed, `codex --version`, 2026-08-01).

### 3.1 Interactive start and initial prompt

Usage line (observed, `codex --help`):

```
Usage: codex [OPTIONS] [PROMPT]
       codex [OPTIONS] <COMMAND> [ARGS]

Arguments:
  [PROMPT]
          Optional user prompt to start the session
```

So a single argv positional both starts the TUI *and* seeds the first turn — the same shape as `claude "<prompt>"`. `codex resume [SESSION_ID] [PROMPT]` takes an optional prompt too, so a resumed session can also be seeded (observed).

Images can be attached to that opening prompt with `-i/--image <FILE>...` (observed).

### 3.2 Headless mode

`codex exec` (alias `e`) — "Run Codex non-interactively" (observed). Prompt delivery is flexible:

> "Argument form: `codex exec "your prompt here"` … Stdin with prompt: piping data while providing a prompt argument treats the prompt as instruction and stdin as context … Stdin as prompt: `codex exec -` or omitting the argument reads the entire prompt from stdin" — [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)

The `--help` text confirms: "If not provided as an argument (or if `-` is used), instructions are read from stdin. If stdin is piped and a prompt is also provided, stdin is appended as a `<stdin>` block" (observed).

### 3.3 Structured output

Three separate mechanisms, all `exec`-scoped (observed, `codex exec --help`):

- `--json` — "Print events to stdout as JSONL". Event types are `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.*`, `error`; item types cover assistant messages, reasoning, command executions, file changes, MCP tool calls, web searches, and plan updates ([Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)).
- `-o, --output-last-message <FILE>` — "Specifies file where the last message from the agent should be written".
- `--output-schema <FILE>` — "Path to a JSON Schema file describing the model's final response shape", constraining the final response for downstream automation ([Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)).

There is no `--json` on the interactive `codex` path (observed: the flag appears only under `codex exec --help`). **For a PTY-hosted interactive session, structured stdout is not available** — see §3.4 for the alternative.

### 3.4 Hooks

Codex has a hook system deliberately close to Claude Code's. Events ([Hooks](https://learn.chatgpt.com/docs/hooks)):

- Turn-scoped: `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `UserPromptSubmit`, `SubagentStop`, `Stop`
- Session-scoped: `SessionStart`, `SessionEnd`, `SubagentStart`

Configuration and payload:

- Discovered from `~/.codex/hooks.json` or `[hooks]` in `~/.codex/config.toml`, then `<repo>/.codex/hooks.json` or `<repo>/.codex/config.toml`, then plugin manifests. "Higher-precedence config layers don't replace lower-precedence hooks." ([Hooks](https://learn.chatgpt.com/docs/hooks))
- **"Project-local hooks load only when the project `.codex/` layer is trusted."** ([Hooks](https://learn.chatgpt.com/docs/hooks)) — this is the same trust gate as project config; see §3.7.
- Hooks receive a single JSON object on stdin with common fields `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, plus `turn_id` and `permission_mode` for turn-scoped hooks, and event-specific fields such as `tool_name` / `tool_input` / `tool_response` ([Hooks](https://learn.chatgpt.com/docs/hooks)).
- Hooks can deny a tool call (`hookSpecificOutput.permissionDecision: "deny"`, or exit code `2` with a reason on stderr), rewrite tool input via `updatedInput`, and inject `additionalContext` ([Hooks](https://learn.chatgpt.com/docs/hooks)).
- Default hook timeout is 600s; `SessionEnd` is the exception at 1s default / 3s max ([Hooks](https://learn.chatgpt.com/docs/hooks)).

**Why this matters for the harness:** if `SessionStart`/`Stop`/`SessionEnd` hooks fire in the *interactive* TUI, Codex can push a live completion signal even though its interactive stdout is unparseable, and the payload's `transcript_path` hands the harness a transcript pointer for free. **Caveat — this is an inference, not a documented guarantee:** the hooks page describes hooks as a Codex-wide feature and **makes no statement scoping them to a surface** (interactive CLI vs `codex exec` vs IDE extension vs cloud); the only execution-context sentence is "Commands run with the session cwd as their working directory." Treat interactive-TUI hook delivery as **unverified** and confirm it empirically before the adapter depends on it.

#### `notify` — the more robust Codex completion signal

Separate from hooks, and better suited to this harness, is the `notify` config key: "Command invoked for notifications; receives a JSON payload from Codex" ([Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)). The details matter ([Advanced configuration](https://learn.chatgpt.com/docs/config-file/config-advanced)):

- **Only one event is supported: `agent-turn-complete`.** That is precisely the "the agent stopped working" edge the harness needs, and nothing more.
- The payload is delivered as a **single JSON argv argument** — *not* on stdin, unlike hooks.
- Configured as an argv array, e.g. `notify = ["python3", "/path/to/notify.py"]`.
- Payload fields: `type`, `thread-id`, `turn-id`, `cwd`, `input-messages`, `last-assistant-message`.

Why this beats the hook route for a per-ticket harness: `cwd` and `thread-id` in the payload let a single notifier binary attribute the event to the right ticket when several sessions run concurrently; there is no 1–3 s timeout cliff as with `SessionEnd`; and it is a plain external program, so no TypeScript or plugin manifest is involved. The trade-off is that it fires per *turn*, not per session, so the harness must still decide when a ticket is done — which is exactly what GitHub issue-state polling is for.

Caveat: `notify` is one of the keys **ignored** in project-local config (§3.7), so it must be set at user level or injected per run with `-c`.

**Per-run injection of `notify` is verified (observed, 0.130.0).** `codex debug prompt-input -c 'notify=[\"echo\",\"hi\"]' "test prompt"` exits 0 and renders the prompt input, i.e. the array-valued override parses and is accepted. This means a Codex adapter can point `notify` at a harness-supplied notifier binary **for one run, without writing to the user's `config.toml`** — the cleanest live-signal wiring available on any CLI surveyed.

**Windows argv-quoting hazard, worth carrying into the contract.** The same command written as `-c 'notify=["echo","hi"]'` **fails** with `Error: invalid type: string "[echo,hi]", expected a sequence in `notify`` (observed): PowerShell strips the inner double quotes before the native process sees them, so the TOML no longer parses as an array. This is a shell problem, not a Codex problem — a Tauri harness that spawns with an argv array and no intermediate shell avoids it entirely. The rule for the contract: **adapters must build argv as a list and never route `-c` values through a shell string**, or any TOML value containing quotes will silently degrade on Windows.

### 3.5 On-disk transcript

Observed on this machine: `~/.codex/sessions/2026/03/06/rollout-2026-03-06T13-24-36-019cc31b-….jsonl`. The first record is a `session_meta` object carrying `id`, `timestamp`, `cwd`, `originator: "codex_cli_rs"`, `cli_version`, `source`, `model_provider`, the full `base_instructions.text`, and a `git` block with `commit_hash`, `branch`, and `repository_url`. Subsequent lines are `response_item` records.

Also observed: `~/.codex/session_index.jsonl` (one line per session: `id`, `thread_name`, `updated_at`) — a cheap way to enumerate sessions without parsing rollouts. Separately, `history.persistence` controls "whether Codex saves session transcripts to history.jsonl" ([Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)).

`codex exec --ephemeral` — "Run without persisting session files to disk" (observed) — turns the transcript off; the harness must not set it if it wants to read transcripts.

### 3.6 Skills and slash commands

- **Skills:** Codex implements Agent Skills. Loaded from `.agents/skills` walking from cwd up to the repository root, `$HOME/.agents/skills`, `/etc/codex/skills`, and built-in system skills ([Build skills](https://learn.chatgpt.com/docs/build-skills.md)). Observed on this machine: `~/.codex/skills/.system/{imagegen,openai-docs,plugin-creator,skill-creator,skill-installer}`, each with a `SKILL.md`. Frontmatter requires `name` and `description`; invocation is either explicit (`$skill` in Codex CLI) or implicit from the `description`, and implicit matching can be disabled with `allow_implicit_invocation: false` in `agents/openai.yaml` ([Build skills](https://learn.chatgpt.com/docs/build-skills.md)).
- **Slash commands:** ~50 built-ins including `/model`, `/plan`, `/permissions`, `/new`, `/resume`, `/fork`, `/compact`, `/skills`, `/hooks`, `/status` ([Developer commands](https://learn.chatgpt.com/docs/cli/slash-commands)).
- **Custom prompts:** Markdown files in `$CODEX_HOME/prompts/` become `/prompts:<name>` commands, with `$1`–`$9`, `$ARGUMENTS`, named `KEY=value` placeholders, and `$$` for a literal dollar ([Custom prompts](https://learn.chatgpt.com/docs/custom-prompts)). **These are marked deprecated** in favour of skills in the same doc. Observed: `~/.codex/prompts` does not exist by default.

### 3.7 Config and per-run injection

Precedence, highest first ([Config basics](https://learn.chatgpt.com/docs/config-file/config-basic)):

1. CLI flags and `--config` overrides
2. Project config files (`.codex/config.toml`, root → cwd, closest wins, **trusted projects only**)
3. Profile files selected with `--profile`
4. User config (`~/.codex/config.toml`)
5. System config (`/etc/codex/config.toml`)
6. Built-in defaults

Levers available to a harness:

- **`-c key=value`** — available on *every* subcommand including the interactive one (observed on `codex`, `codex exec`, `codex resume`, `codex app-server`, `codex mcp-server`). Dotted paths for nested values, value parsed as TOML. This is the cleanest per-run injection point and does not touch the user's files.
- **`CODEX_HOME`** — "Codex stores its local state under CODEX_HOME (defaults to `~/.codex`)". **Observed to be honoured**: setting `CODEX_HOME` to an empty temp dir and running `codex login status` printed `Not logged in` and created a `memories/` dir there. **Caveat: this relocates `auth.json` too**, so a fresh `CODEX_HOME` starts unauthenticated. It is therefore *not* a safe way to isolate config alone.
- **`--ignore-user-config`** — "Do not load `$CODEX_HOME/config.toml`; auth still uses `CODEX_HOME`" (observed). This is exactly the isolate-config-but-keep-auth lever — but it exists **only on `codex exec`**, not on the interactive `codex` command (observed from both `--help` outputs). For a PTY-hosted interactive session the harness must fall back to `-c` overrides.
- `--profile <name>`, `--enable <FEATURE>` / `--disable <FEATURE>` (sugar for `-c features.<name>=…`) (observed).

Keys ignored in project-local `.codex/config.toml` (must be set at user level): `openai_base_url`, `chatgpt_base_url`, `apps_mcp_product_sku`, `model_provider`, `model_providers`, `notify`, `profile`, `profiles`, `experimental_realtime_ws_base_url`, `otel` ([Config basics](https://learn.chatgpt.com/docs/config-file/config-basic)).

"For security, Codex loads project-scoped config files only when the project is trusted. If the project is untrusted, Codex ignores project `.codex/` layers, including `.codex/config.toml`, project-local hooks, and project-local rules." ([Config basics](https://learn.chatgpt.com/docs/config-file/config-basic)) — observed corroboration: this machine's `~/.codex/config.toml` contains `[projects.'\\?\C:\…'] trust_level = "trusted"` entries, i.e. **trust is recorded per project path in the user-level config**. A harness that spawns Codex in a fresh worktree path will hit an untrusted project unless it pre-seeds that entry or accepts that project-local hooks/config are silently ignored.

### 3.8 Working directory, auth, PTY hazards

- **cwd:** `-C, --cd <DIR>` — "Tell the agent to use the specified directory as its working root"; `--add-dir <DIR>` adds extra writable roots (observed). Codex is the only surveyed CLI with a first-class cwd flag on the interactive path.
- **Git repo:** `codex exec --skip-git-repo-check` — "Allow running Codex outside a Git repository" (observed). This flag is **absent from the interactive `codex --help`** (observed); the interactive behaviour outside a repo remains **unknown**. String-inspecting `codex.exe` (v0.130.0) for a warning or trust prompt was inconclusive — the only matches were internal git plumbing messages ("not inside a git repository", "Failed to compute diff") with no user-facing gate text recoverable. **Test this empirically before relying on it.** In practice the harness spawns into a git worktree per ticket, so this is unlikely to bite.
- **Auth:** `codex login` / `codex logout` subcommands; `auth.json` under `CODEX_HOME` (observed). A spawned process with no valid auth will need an interactive login flow — the harness must pre-check (`codex login status` exits cleanly and prints `Not logged in`, observed).
- **PTY hazards:**
  - Alternate screen is the default. `--no-alt-screen` — "Disable alternate screen mode. Runs the TUI in inline mode, preserving terminal scrollback history. This is useful in terminal multiplexers like Zellij that follow the xterm spec strictly and disable scrollback in alternate screen buffers." (observed). A harness that wants scrollback in its own renderer should pass this.
  - Approval prompts. `-a/--ask-for-approval` with `never` — "Never ask for user approval. Execution failures are immediately returned to the model" — plus `-s/--sandbox` and `--dangerously-bypass-approvals-and-sandbox` (observed). Without these, an unattended session can stall on a modal.
  - Windows sandbox: this machine's config carries `[windows] sandbox = "elevated"` (observed); sandbox behaviour is platform-specific and worth pinning explicitly rather than inheriting.

---

## 4. Pi

**Identification.** "Pi" here is unambiguous once resolved on-disk: the `pi` binary is `@earendil-works/pi-coding-agent` v0.83.0, whose `--help` banner reads "pi - AI coding assistant with read, bash, edit, write tools" (observed). Repo: [github.com/earendil-works/pi](https://github.com/earendil-works/pi) (`repository.url` in its `package.json`, observed), author Mario Zechner, MIT licence, docs hosted at `pi.dev`. Confirmed against the repo itself: live and active, MIT, described as "AI agent toolkit: unified LLM API, agent loop, TUI, coding agent CLI", and containing `@earendil-works/pi-coding-agent` ("Interactive coding agent CLI") under `packages/`. The `pi-mono` name that appears in the shipped docs' source links refers to the same project's monorepo history, not a different tool. Docs are also **shipped inside the npm package** under `docs/`, which is the highest-trust primary source available and is what the citations below point at (paths are relative to the installed package: `node_modules/@earendil-works/pi-coding-agent/docs/`). It is **not** Raspberry Pi, not the `pi` constant utility, and not any of the several unrelated PyPI/npm packages named `pi`.

Pi is architecturally the most harness-friendly of the three, and the least like Claude Code in its extension model.

### 4.1 Interactive start and initial prompt

`pi [options] [@files...] [messages...]`. The help's own examples (observed):

```
  # Interactive mode
  pi

  # Interactive mode with initial prompt
  pi "List all .ts files in src/"

  # Include files in initial message
  pi @prompt.md @image.png "What color is the sky?"

  # Multiple messages (interactive)
  pi "Read package.json" "What dependencies do we have?"
```

Two things a harness can exploit that neither Claude Code nor Codex offers. First, **`@file` references** splice file contents (including images) into the opening message — documented in `docs/quickstart.md` as `pi @README.md "Summarize this"` and `pi @src/app.ts @src/app.test.ts "Review these together"`. A harness that renders a long chart/work-ticket prompt can write it to a temp file and pass `@ticket.md` rather than fighting Windows argv length limits — a concrete, useful lever. Second, **multiple positional messages** are accepted; the help labels the example "Multiple messages (interactive)". *That they become successive turns rather than one concatenated message is an inference from the label — the docs do not state the delivery semantics, so treat it as **unknown** and verify before depending on it.*

Pi also accepts a prompt on **stdin** in headless mode: `cat README.md | pi -p "Summarize this text"` (`docs/quickstart.md`), so the argv-length escape hatch exists twice over.

### 4.2 Headless and structured modes

Pi has **three** non-TUI modes, selected by `--print` or `--mode` (observed, `pi --help`; [`docs/extensions.md` §Mode Behavior](https://github.com/earendil-works/pi)):

| Mode | Flag | `ctx.mode` | `ctx.hasUI` |
| --- | --- | --- | --- |
| Interactive | (default) | `"tui"` | `true` |
| RPC | `--mode rpc` | `"rpc"` | `true` |
| JSON | `--mode json` | `"json"` | `false` |
| Print | `-p` / `--print` | `"print"` | `false` |

- **JSON mode** (`docs/json.md`): "Outputs all session events as JSON lines to stdout." First line is a session header `{"type":"session","version":3,"id":"uuid","timestamp":"…","cwd":"/path"}`, then events: `agent_start`, `turn_start`, `message_start`, `message_update`, `message_end`, `turn_end`, `agent_end`, plus `tool_execution_start/update/end`, `queue_update`, `compaction_start/end`, `auto_retry_start/end`.
- **RPC mode** (`docs/rpc.md`): "enables headless operation of the coding agent via a JSON protocol over stdin/stdout … Commands: JSON objects sent to stdin, one per line; Responses: JSON objects with `type: "response"`; Events: agent events streamed to stdout as JSON lines." Commands include `prompt`, `steer`, and `follow_up`, all accepting base64 images. **Steering is first-class**: `{"type":"prompt","message":"…","streamingBehavior":"steer"}` delivers a message "after the current assistant turn finishes executing its tool calls, before the next LLM call", and `"followUp"` waits until the agent stops. Skill commands (`/skill:name`) and prompt templates are expanded before sending.
  - Framing caveat worth carrying into the contract: "RPC mode uses strict JSONL semantics with LF (`\n`) as the only record delimiter… Node `readline` is not protocol-compliant for RPC mode because it also splits on `U+2028` and `U+2029`, which are valid inside JSON strings." (`docs/rpc.md`)

**RPC mode is the strongest live-signal surface of any CLI surveyed** — it is bidirectional, so a harness could inject follow-up prompts mid-run rather than only at spawn. It is, however, *not* a PTY session: choosing RPC means giving up the TUI the harness renders.

### 4.3 Hooks / events — in-process, not shell

Pi has no shell-hook system. Its equivalent is **extensions**: TypeScript modules loaded into the pi process that subscribe via `pi.on(event, handler)` (`docs/extensions.md`). The documented lifecycle (`docs/extensions.md` §Lifecycle Overview) includes:

`project_trust` → `session_start` → `resources_discover` → `input` (can intercept/transform) → `before_agent_start` (can inject a message, modify the system prompt) → `agent_start` → `turn_start` → `context` (can modify messages) → `before_provider_headers` / `before_provider_request` / `after_provider_response` → `tool_execution_start` → `tool_call` (can block) → `tool_result` (can modify) → `tool_execution_end` → `turn_end` → `agent_end` → **`agent_settled`** ("no retry/compaction/follow-up left"), plus `session_before_switch`, `session_shutdown`, `session_before_fork`, `session_before_compact`, `session_compact`, `session_before_tree`, `session_tree`, `session_info_changed`, `model_select`, `thinking_level_select`.

`agent_settled` is the natural completion signal — it is strictly better than `agent_end` because it fires only once retries, compaction, and queued follow-ups are exhausted.

Consequences for an adapter:

- Extensions load with `--extension <path>` / `-e` (repeatable) and run in **all four modes**, including the TUI — so unlike Codex, pi's live signal is available *without* leaving interactive mode. But it costs the harness a small TypeScript file rather than a shell script.
- In print/JSON mode "Extensions run but can't prompt"; use `ctx.mode === "tui"` before TUI-specific APIs (`docs/extensions.md` §Mode Behavior).
- Extension errors are non-fatal ("Extension errors are logged, agent continues"), except `tool_call` errors which block the tool fail-safe (`docs/extensions.md` §Error Handling).
- A harness extension has real teeth if wanted: `pi.registerCommand`, `pi.sendUserMessage`, `pi.appendEntry`, `pi.setSessionName`, `pi.registerTool`, `ctx.shutdown()`, and `pi.exec(command, args, options?)` to shell out.

**How much code does the completion-signal extension actually cost?** Very little. Pi ships `examples/extensions/notify.ts`, which is exactly this pattern, and its whole body is:

```ts
export default function (pi: ExtensionAPI) {
	pi.on("agent_end", async () => {
		notify("Pi", "Ready for input");
	});
}
```

A harness adapter would swap `agent_end` for `agent_settled` (fires only once retries, compaction and queued follow-ups are exhausted) and swap the notifier for a POST or a write to a file the harness watches. So the real cost is a single small `.ts` file passed with `-e` — not a plugin system. Note the shipped example also demonstrates the hazard directly: it writes raw OSC sequences to stdout (`\x1b]777;notify;…\x07`, Kitty's `\x1b]99;…`), which a custom PTY renderer must tolerate or strip.

**There is no external-program equivalent of Codex's `notify`.** Searching pi's shipped docs for notification config turns up only `ctx.ui.notify(...)` — an in-TUI/RPC toast API for extensions — and an RPC `notify` method that emits an `extension_ui_request` on stdout for the client to render (`docs/extensions.md`, `docs/rpc.md`). So a Pi adapter that wants a push completion signal in a PTY session **must** ship an extension; it cannot be done with a config key pointing at a shell script. This is the single clearest asymmetry between the Codex and Pi adapters.

### 4.4 On-disk transcript

"Sessions auto-save to `~/.pi/agent/sessions/`, organized by working directory. Each session is a JSONL file with a tree structure." (`docs/sessions.md`)

Observed on this machine: `~/.pi/agent/sessions/--C--Users-ahmet-Workspace-controlayer--/2026-07-31T14-44-02-280Z_019fb8a1-….jsonl`, whose first line is `{"type":"session","version":3,"id":"019fb8a1-…","timestamp":"…","cwd":"C:\\Users\\ahmet\\Workspace\\controlayer"}` — **identical in shape to the `--mode json` header**, i.e. the transcript and the event stream share a format.

The transcript is a **tree, not a list**: "Every entry has an `id` and `parentId`, and the current position is the active leaf" (`docs/sessions.md`). A naive tail-the-file parser will therefore see abandoned branches interleaved with the live one — a real hazard for any harness that treats the JSONL as linear.

Session location is overridable per run: precedence is `--session-dir`, then `PI_CODING_AGENT_SESSION_DIR`, then `sessionDir` in settings.json (`docs/settings.md`). `--no-session` runs ephemerally.

Pi also exposes the session path to its own bash tool as `PI_SESSION_FILE`, alongside `PI_SESSION_ID`, `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL` (`docs/environment-variables.md`) — and sets `PI_CODING_AGENT=true` on every child process, which is a clean way for harness-invoked scripts to detect they are inside pi.

### 4.5 Skills and slash commands

- **Skills:** "Pi implements the [Agent Skills standard](https://agentskills.io/specification)" (`docs/skills.md`). Loaded from `~/.pi/agent/skills/`, `~/.agents/skills/`, project `.pi/skills/` and `.agents/skills/` (trusted projects only), package `skills/` dirs, a `skills` array in settings, and `--skill <path>` on the CLI ("repeatable, additive even with `--no-skills`"). Skills register as `/skill:name` commands, and "Arguments after the command are appended to the skill content as `User: <args>`."
  - Notably, the docs explicitly bless cross-harness reuse: adding `"skills": ["~/.claude/skills", "~/.codex/skills"]` to settings is a documented configuration (`docs/skills.md`). Pi deliberately relaxes the standard's name-must-match-directory rule "because that standard requirement is suboptimal for shared skill directories used across multiple agent harnesses."
- **Prompt templates:** Markdown files where "the filename becomes the command name. `review.md` becomes `/review`" (`docs/prompt-templates.md`). Loaded from `~/.pi/agent/prompts/*.md`, project `.pi/prompts/*.md`, packages, settings, and **`--prompt-template <path>` (repeatable)** on the CLI. Arguments support `$1`…`$N`, `$@`/`$ARGUMENTS`, `${1:-default}`, `${@:N}`, `${@:N:L}`.
- **Built-in slash commands:** `/model`, `/settings`, `/resume`, `/new`, `/name`, `/session`, `/tree`, `/trust`, `/fork`, `/clone`, `/compact`, `/copy`, `/export`, `/import`, `/share`, `/reload`, `/login`, `/logout`, `/quit`, and others (`docs/usage.md`).

**Per-run template injection is a genuine differentiator:** `--prompt-template` and `--skill` let a harness hand pi a ticket-specific command set for one run without writing anything into the user's config. Codex has no equivalent flag (skills and prompts are discovered from fixed paths only).

### 4.6 Config and per-run injection

Two files: `~/.pi/agent/settings.json` (global) and `.pi/settings.json` (project, deep-merged over global) (`docs/settings.md`).

Per-run levers (observed, `pi --help`, plus `docs/environment-variables.md`):

- **`PI_CODING_AGENT_DIR`** — "Override the config directory; default is `~/.pi/agent`". Same caveat as Codex's `CODEX_HOME`: `auth.json` lives in that directory (observed), so a fresh dir starts unauthenticated. Pi mitigates this better than Codex, because `--api-key` and ~30 provider env vars are first-class alternatives.
- `--skill`, `--prompt-template`, `--extension`, `--theme` (all repeatable, additive)
- `--no-skills`, `--no-prompt-templates`, `--no-extensions`, `--no-context-files`, `--no-tools`, `--no-builtin-tools`
- `--tools` / `--exclude-tools` allow/denylists
- `--system-prompt <text>`, `--append-system-prompt <text-or-file>` (repeatable)
- `--session-dir`, `--session-id`, `--no-session`, `--name`
- `--approve`/`-a` and `--no-approve`/`-na` — override project trust for a single run
- `--offline` / `PI_OFFLINE=1` — disables update checks, package update checks, and telemetry at startup (worth setting for deterministic harness spawns)

There is **no** single `--config <file>` flag; injection is a set of orthogonal flags plus the directory env var.

### 4.7 Working directory, trust, auth, PTY hazards

- **cwd: no flag.** `pi --help` lists no `--cd`/`-C` equivalent (observed). The harness **must** spawn the process with the correct working directory. Session storage is keyed off cwd, so getting this wrong also misfiles the transcript.
- **No git-repo requirement** documented; skills discovery walks "up to git repo root, or filesystem root when not in a repo" (`docs/skills.md`), so non-repo directories are supported.
- **Project trust is an interactive prompt** and a real hazard for an automated spawn: "On interactive startup, pi asks before trusting a project folder that contains project-local settings, resources, or project `.agents/skills` and has no saved decision" (`docs/settings.md`). Decisions persist in `~/.pi/agent/trust.json` (observed to exist). Non-interactive modes never prompt — they fall back to `defaultProjectTrust` (`ask`/`never` ignore project resources; `always` trusts). **For a PTY-hosted interactive spawn the harness should pass `--approve` or `--no-approve` explicitly** rather than risk a modal on first run in a new worktree.
- **Auth:** `/login` OAuth or provider env vars; `~/.pi/agent/auth.json` (observed). "Built-in subscription logins include Claude Pro/Max, ChatGPT Plus/Pro (Codex), and GitHub Copilot" (`docs/quickstart.md`) — i.e. Pi can run *on the user's existing Claude or Codex subscription*, which makes it a cheaper adapter to add than its unfamiliarity suggests. `pi auth print-api-key` / `print-bearer-token` subcommands exist for external clients (observed) — useful if the harness needs to hand credentials to a sibling process.
- **PTY hazards:**
  - **Windows requires a bash shell.** "Pi requires a bash shell on Windows. Checked locations (in order): custom path from settings; Git Bash (`C:\Program Files\Git\bin\bash.exe`); `bash.exe` on PATH (Cygwin, MSYS2, WSL)." (`docs/windows.md`). A Tauri harness on Windows must verify this before spawning, or pi's `bash` tool fails at runtime rather than at startup.
  - Terminal image rendering is on by default (`terminal.showImages: true`, `terminal.imageWidthCells: 60`) and emits terminal graphics sequences a PTY renderer may not understand; `images.blockImages` / `terminal.showImages: false` disable it (`docs/settings.md`).
  - `terminal.clearOnShrink` is documented as "can cause flicker" (`docs/settings.md`).
  - Startup network calls (version check, package update check, telemetry ping to `pi.dev`) run by default; `--offline` suppresses them (`docs/settings.md`).
  - `quietStartup` hides the startup header, which otherwise prints shortcuts, context files, templates, skills, and extensions (`docs/settings.md`) — useful to reduce noise in a harness-rendered pane.

---

## 5. Gemini CLI

**Not installed on this machine** (observed: `Get-Command gemini` found nothing), so this section is documentation-only — but the documentation is first-party and unusually precise, read directly from [`google-gemini/gemini-cli`](https://github.com/google-gemini/gemini-cli) `docs/` on `main` via the GitHub contents API (2026-08-01). **Version not pinned:** `main` was read rather than a tagged release, so treat version-specific details as current-at-date rather than tied to a release number.

**Verdict: worth targeting, and the easiest non-Claude adapter after Codex.** It is the only surveyed CLI that has an *explicit, documented flag* for the exact thing this harness does.

### 5.1 Interactive start and initial prompt

From `docs/cli/cli-reference.md`:

| Form | Documented behaviour |
| --- | --- |
| `query` (positional, variadic) | "Positional prompt. **Defaults to interactive mode in a TTY.** Use `-p/--prompt` for non-interactive execution." |
| `-p` / `--prompt` | "Prompt text. Appended to stdin input if provided. **Forces non-interactive mode.**" |
| `-i` / `--prompt-interactive` | "**Execute prompt and continue in interactive mode**" |

`-i/--prompt-interactive` is precisely the harness's spawn contract expressed as a first-class flag. The bare positional also works and stays interactive under a TTY. Note the trap: **`-p` is the opposite of what the harness wants** — unlike Claude Code and Pi, where the positional is the interactive path and `-p` the headless one, Gemini's `-p` *forces* headless. An adapter that reaches for `-p` by analogy will silently get a one-shot run.

### 5.2 Headless and structured output

`-p` for non-interactive. `-o` / `--output-format` with choices `text` (default), `json`, `stream-json` (`docs/cli/cli-reference.md`). Per `docs/cli/headless.md`: JSON "Returns a single JSON object containing the response and usage statistics"; stream-json "Returns a stream of newline-delimited JSON (JSONL) events". Standard exit codes are documented.

### 5.3 Hooks — a real, Claude-Code-shaped system

Gemini CLI has genuine shell hooks (`docs/hooks/reference.md`), configured in **`settings.json` under a `hooks` object**. Mechanics: "`stdin` for Input (JSON), `stdout` for Output (JSON)". Events:

- **Tool:** `BeforeTool`, `AfterTool` (with matchers on tool names)
- **Agent:** `BeforeAgent`, `AfterAgent`
- **Model:** `BeforeModel`, `BeforeToolSelection`, `AfterModel`
- **Lifecycle/system:** `SessionStart`, `SessionEnd`, `Notification`, `PreCompress`

Common output fields include `continue` — "If `false`, stops the entire agent loop immediately" — with `stopReason` shown to the user. `AfterAgent` is the natural completion signal and carries `stop_hook_active` to guard against re-entrancy.

This puts Gemini CLI on par with Codex and **ahead of Pi** for live signals: a plain shell script, no TypeScript, no per-turn-only limitation, and no documented 3-second timeout cliff of the kind Codex's `SessionEnd` has.

### 5.4 Transcript, resume, skills

- **Transcript:** "Sessions are stored in `~/.gemini/tmp/<project_hash>/chats/`" (`docs/cli/session-management.md`). Note the path is keyed by a **project hash**, so an adapter must derive it rather than guess. Exact on-disk file format **unknown** — not established from the docs read.
- **Resume:** `--resume` / `-r`, accepting `latest`, an index (`--resume 1`), or a full session UUID; `gemini -r "<session-id>" "query"` resumes *and* seeds a prompt. `/resume` in-session opens a picker, with save/list/named checkpoints.
- **Skills and commands:** `docs/cli/` contains `skills.md`, `creating-skills.md`, `using-agent-skills.md`, `skills-best-practices.md`, and `custom-commands.md` — so both an Agent-Skills implementation and custom slash commands exist. Details **not** read in depth; the harness does not need them, since prompt text is the portable channel.
- **Other notable docs** implying harness-relevant behaviour: `trusted-folders.md` (a trust gate like Codex's and Pi's — expect a first-run prompt or a silent ignore in a fresh worktree), `git-worktrees.md` (worktrees are an explicitly supported workflow, which matches this harness's model), `acp-mode.md` (an agent-client-protocol mode — a possible non-PTY transport), `notifications.md`, `sandbox.md`, `checkpointing.md`, `rewind.md`.

### 5.5 Working directory, config injection, PTY hazards

The complete long-flag set from `docs/cli/cli-reference.md` is: `--allowed-mcp-server-names`, `--allowed-tools`, `--approval-mode`, `--debug`, `--delete-session`, `--experimental-acp`, `--experimental-zed-integration`, `--extensions`, `--help`, `--include-directories`, `--list-extensions`, `--list-sessions`, `--model`, `--output-format`, `--prompt-interactive`, `--prompt`, `--resume`, `--sandbox`, `--screen-reader`, `--skip-trust`, `--version`, `--worktree`, `--yolo`. That settles several questions:

- **No cwd flag.** There is no `--cwd`/`-C`. `--include-directories` is "Additional directories to include in the workspace" — the analogue of Codex's `--add-dir`, not a cwd control. So Gemini behaves like Pi: **the harness must spawn with the correct working directory**, and session storage is keyed off it (via `<project_hash>`).
- **No per-run config-file flag.** There is no `--settings`/`--config` equivalent, and no `-c key=value`. Since hooks live in `settings.json`, **a harness that wants Gemini hooks must write to a settings file** rather than inject them per run. This is the weakest per-run isolation of any CLI surveyed, and the main cost of the Gemini adapter. (Whether an env var relocates the config dir, à la `CODEX_HOME` / `PI_CODING_AGENT_DIR`, is **unknown**.)
- **`--skip-trust`** is the trust-prompt escape hatch, matching Pi's `--approve` and answering the `trusted-folders.md` hazard directly.
- **`--approval-mode`** with `default | auto_edit | yolo | plan` is the blocking-modal lever, matching Codex's `-a never`. (`--yolo`/`-y` is deprecated in favour of `--approval-mode=yolo`.)
- **`--worktree`** means git worktrees are a first-class, supported workflow — a good sign for this harness's per-ticket-worktree model.
- **`--list-sessions` / `--delete-session`** let the harness enumerate and clean up sessions without parsing on-disk files, which partly compensates for the undocumented transcript format.
- **`--screen-reader`** produces flattened output and is worth knowing about as a fallback if the TUI proves hostile to the renderer.
- **`--experimental-acp`** (agent-client-protocol) is a potential non-PTY transport, alongside `--experimental-zed-integration`.

### 5.6 Remaining gaps

Still **unknown** and worth closing by installing the CLI and reading `--help` directly, as was done for Codex and Pi: the on-disk transcript file format under `~/.gemini/tmp/<project_hash>/chats/`; whether a config-dir env var exists for per-run isolation; auth mechanism and what a spawn does when unauthenticated; Windows-specific PTY behaviour.

---

## 6. opencode

**Not installed on this machine** (observed). Documentation-only, from the project's official docs at [opencode.ai/docs](https://opencode.ai/docs) (2026-08-01); source at [`sst/opencode`](https://github.com/sst/opencode). **Version not pinned — unknown.**

**Verdict: worth targeting.** It has the best per-run config isolation of any CLI surveyed, including Codex.

### 6.1 Interactive start and initial prompt

`opencode` alone launches the TUI. An initial prompt is delivered with **`--prompt`, which keeps the session interactive** ([CLI docs](https://opencode.ai/docs/cli/)). Note the inversion relative to Codex/Pi/Claude: **positional arguments are not the interactive path** — they belong to the `run` subcommand. An adapter must use `--prompt`, not a bare positional.

### 6.2 Headless and structured output

`opencode run "<query>"` executes non-interactively, with `--format` accepting `default` (formatted) or `json` (raw JSON events). Also `--print-logs` (logs to stderr) and `--log-level DEBUG|INFO|WARN|ERROR`.

Two additional non-PTY transports exist as subcommands: **`serve`** (HTTP server) and **`acp`** (agent-client-protocol) — the same shape of alternative-transport option that Codex's `app-server` and Gemini's `--experimental-acp` provide.

### 6.3 Plugins — in-process, like Pi, not shell hooks

"A plugin is a **JavaScript/TypeScript module** that exports one or more plugin functions. Each function receives a context object and returns a hooks object" ([Plugins](https://opencode.ai/docs/plugins/)). Loaded from `.opencode/plugins/` (project) and `~/.config/opencode/plugins/` (global), or as npm packages via the `"plugin"` config key.

Events are numerous and well-named:

- **Session:** `session.created`, `session.updated`, **`session.idle`**, `session.compacted`, `session.deleted`, `session.diff`, `session.error`, `session.status`
- **Tool:** `tool.execute.before`, `tool.execute.after`
- **Permission:** `permission.asked`, `permission.replied`
- **File:** `file.edited`, `file.watcher.updated`
- **Message:** `message.updated`, `message.removed`, `message.part.updated`, `message.part.removed`
- **TUI:** `tui.prompt.append`, `tui.command.execute`, `tui.toast.show`
- **Other:** `command.executed`, `lsp.updated`, `lsp.client.diagnostics`, `server.connected`, `installation.updated`, `todo.updated`, `shell.env`

**`session.idle` is the completion signal** and is a cleaner match for "the agent stopped working" than anything Codex or Pi expose. But as with Pi, **there is no shell-command hook system** — the docs are explicit that shell interaction happens through the `shell.env` event, not a separate mechanism. So an opencode adapter, like a Pi adapter, ships a small JS/TS file.

`tui.prompt.append` is notable: a plugin can push text into the prompt, which is a possible mid-run injection route.

### 6.4 Config — the strongest per-run isolation

Config files are `opencode.json` / `opencode.jsonc` (plus `tui.json`), global at `~/.config/opencode/opencode.json`, project-level in the project root: "When OpenCode starts up, it first looks for a config file in the current directory, then traverses up to the nearest Git directory" ([Config](https://opencode.ai/docs/config/)).

Crucially: **"Specify a custom config file path using the `OPENCODE_CONFIG` environment variable."** A single env var points the process at a harness-authored config for one run — no global-state mutation, no auth relocation (unlike `CODEX_HOME` and `PI_CODING_AGENT_DIR`, this points at a *config file*, not the whole state directory). That makes opencode the only surveyed CLI where the harness can inject plugins and settings for one run **without any risk to the user's credentials or config**.

### 6.5 Working directory, sessions, gaps

- **cwd:** `--dir` sets the working directory — a first-class flag, matching Codex's `-C`.
- **Sessions:** `--session <ID>`, `-c`/`--continue`, `--fork` (branch a session when continuing). Subcommands `session`, `export`, `import`, `stats`.
- **Full documented subcommand set:** `agent`, `attach`, `auth`, `github`, `mcp`, `models`, `run`, `serve`, `session`, `stats`, `export`, `import`, `web`, `acp`, `plugin`, `pr`, `db`, `debug`, `uninstall`, `upgrade`.
- **Unknown:** on-disk session/transcript path and format (the config docs do not cover runtime data); skill system (whether Agent Skills are supported); auth failure behaviour on spawn; PTY hazards and Windows support.

---

## 7. Cursor CLI (`cursor-agent`)

**Not installed on this machine.** A `cursor` binary is on PATH but it is the **editor** launcher (v3.4.17, observed) — see the note in the preamble. Documentation-only, from [cursor.com/docs](https://cursor.com/docs) (2026-08-01). **Version not pinned — unknown.**

**Verdict: worth targeting on capability, with a caveat.** Its hook system is the richest of any surveyed CLI, but how much of it actually fires in the CLI (as opposed to the IDE) is not clearly documented.

### 7.1 Interactive start, prompt, headless

Interactive agent mode is the default with no subcommand, and **an initial prompt is an argv positional** — `agent "your prompt here"` ([CLI parameters](https://cursor.com/docs/cli/reference/parameters)). Headless is `-p`/`--print`. Structured output is `--output-format text|json|stream-json` (requires `--print`), plus `--stream-partial-output` for text deltas under `stream-json`.

Full documented flag set: `-v/--version`, `--api-key`, `-H/--header`, `-p/--print`, `--output-format`, `--stream-partial-output`, `--resume`, `--continue`, `--model`, `--mode`, `--plan`, `--list-models`, `-f/--force`, `--yolo`, `--sandbox`, `--approve-mcps`, `--trust`, `--workspace`, `--plugin-dir`, `-w/--worktree`, `--worktree-base`, `--skip-worktree-setup`, `-h/--help`.

Harness-relevant highlights: **`--plugin-dir`** is per-run extension injection (like Claude Code's flag of the same name); **`--trust`** answers the trust-prompt hazard; **`-f/--force`** / `--yolo` prevents approval modals; **`-w/--worktree` + `--worktree-base`** make worktrees first-class, matching this harness's model; **`--api-key`** allows auth to be supplied per run rather than relying on a login flow — the only surveyed CLI with a plain auth flag.

- **Sessions:** `--resume [chatId]`; `--continue` is an alias for `--resume=-1`.
- **cwd:** no `--cwd`; `--workspace` is the nearest equivalent, but whether it sets cwd or merely widens the workspace is **unknown**.

### 7.2 Hooks — richest event set surveyed

Configured in `hooks.json` at `<project-root>/.cursor/hooks.json`, `~/.cursor/hooks.json`, and enterprise system paths (`C:\ProgramData\Cursor\hooks.json` on Windows) ([Hooks](https://cursor.com/docs/hooks)).

Agent events: `sessionStart`, `sessionEnd`, `preToolUse`, `postToolUse`, `postToolUseFailure`, `subagentStart`, `subagentStop`, `beforeShellExecution`, `afterShellExecution`, `beforeMCPExecution`, `afterMCPExecution`, `beforeReadFile`, `afterFileEdit`, `beforeSubmitPrompt`, `preCompact`, **`stop`**, `afterAgentResponse`, `afterAgentThought`. Plus Tab hooks (`beforeTabFileRead`, `afterTabFileEdit`) and `workspaceOpen`.

Every hook receives base stdin fields `conversation_id`, `generation_id`, `model`, `model_id`, `model_params`, `hook_event_name`, `cursor_version`, `workspace_roots`, `user_email`, and **`transcript_path`**. Blocking: "Exit code `2` - Block the action (equivalent to returning `permission: \"deny\"`)".

`stop` / `afterAgentResponse` are the completion signals, and `transcript_path` hands over the transcript pointer — the same useful property as Codex's hook payload.

### 7.3 The caveat

The hooks documentation is written primarily for the IDE. The only explicit CLI statement found is that `workspaceOpen` "Runs in the Cursor desktop app and CLI"; **which of the agent hooks fire under `cursor-agent` is not documented**, and is marked **unknown**.

Community bug reports (Cursor's own forum — **secondary sources, not verified here, recorded only because they would be expensive to discover later**) claim that (a) the CLI sends only a subset of configured hook events, and (b) on Windows the hook stdin JSON payload carries a UTF-8 BOM that breaks a standard `JSON.parse()`, causing guards to silently fail open. If a Cursor adapter is built, **both must be verified empirically before any safety or completion logic depends on hooks** — a silently-failing-open security hook is exactly the failure mode a harness must not inherit.

### 7.4 Gaps

**Unknown:** on-disk transcript location and format (only reachable via `transcript_path` in a hook payload); whether a skill system exists; whether `--workspace` sets cwd; per-run config injection beyond `--plugin-dir`; auth failure behaviour.

---

## 8. aider — considered and rejected

**Not worth targeting.** This is a capability judgement, not an oversight, and it turns on a single disqualifying fact.

From [aider's own options reference](https://aider.chat/docs/config/options.html):

- `--message COMMAND` — "Specify a single message to send the LLM, **process reply then exit**"
- `--message-file MESSAGE_FILE` — "Specify a file containing the message to send the LLM, process reply, **then exit**"

Both flags **disable interactive chat mode**. There is no documented way to seed a prompt *and* leave the session interactive — which is lowest-common-denominator requirement #2 (§9.1) and the entire basis of the harness's spawn model. An aider adapter would have to type into the TUI, which no other adapter needs to do and which the contract should not have to accommodate.

The supporting picture is consistently weaker:

- **No hooks.** Nothing comparable to Claude Code / Codex / Gemini / Cursor hooks is documented.
- **No structured output.** "The documentation does not mention a JSON output mode among the listed options."
- **Transcript is prose, not data.** `--chat-history-file` defaults to `.aider.chat.history.md` — Markdown, not JSONL. `--llm-history-file` logs the raw LLM conversation. Neither is a machine-readable transcript of the kind the other adapters offer.
- Slash commands exist in-chat (`/add`, `/drop`, `/ask`, `/architect`, `/commit`, `/undo`, `/run`, `/test`, `/model`, …), but they are only reachable by typing into the TUI.

Aider is a good pair-programming tool; it is simply not built to be driven by a harness. **Recommendation: exclude from the adapter matrix** unless a user explicitly asks for it, in which case it needs a bespoke type-into-the-TUI adapter that the general contract should not be bent to accommodate.

---

## 9. Implications for the adapter contract

### 9.1 The lowest common denominator

Only these hold across every CLI worth targeting. They are the whole of the required contract:

1. **Spawn in a PTY, with the working directory set on the child process.** Only Codex (`-C/--cd`) and opencode (`--dir`) have a cwd flag; Pi and Gemini have none, and Cursor's `--workspace` has unverified semantics. cwd-on-spawn is the only mechanism that works everywhere, so cwd belongs in the spawn parameters and any `--cd`-style flag is an adapter-internal detail. For Pi and Gemini this is load-bearing well beyond tool access: session storage (Pi's cwd-slug directories, Gemini's `<project_hash>`), skill discovery and context-file discovery are all keyed off it.
2. **One opening prompt of plain text, injected at spawn, leaving the session interactive — but the *mechanism is not portable*.** Every targetable CLI can do this; **no two agree on how**, and two of them actively punish the obvious guess:

   | CLI | Interactive prompt injection | Trap |
   | --- | --- | --- |
   | Claude Code | argv positional | — |
   | Codex CLI | argv positional | — |
   | Pi | argv positional | — |
   | Cursor CLI | argv positional | — |
   | Gemini CLI | `-i` / `--prompt-interactive` (positional also works in a TTY) | **`-p` forces *non*-interactive** — the opposite of Claude/Pi |
   | opencode | **`--prompt`** | **positionals belong to `run`**, i.e. headless |

   **This is the single most contract-shaping finding in the document.** "Append the rendered prompt to argv" is *not* a valid abstraction: it silently produces a one-shot headless run on Gemini and opencode. The contract needs an adapter-implemented `buildInvocation(cwd, promptText) → argv` (or `deliverInitialPrompt`), with the harness supplying only the text. That the harness already owns prompt rendering and adapters only deliver text is exactly right — it just has to own *rendering*, not *placement*.
3. **No portable skill or slash-command invocation.** Codex, Pi and Gemini all implement Agent Skills, and all have slash commands — but the invocation syntax differs (`$skill` vs `/skill:name`), the discovery roots differ, and the argument-substitution grammars differ. Nothing here is portable, which confirms the assumption in the ticket: prompt text is the channel, and an "invoke skill X" contract method should not exist.
4. **Completion detected by GitHub issue state, with process exit as the only universal secondary signal.** Nothing richer is common: Pi and opencode have no shell hooks at all (both use in-process JS/TS), Codex's `SessionEnd` is capped at 1 s default / 3 s max, and Cursor's CLI hook coverage is undocumented. The guaranteed-signal decision is well founded and should stay.
5. **Auth is out of band and adapters must not attempt to drive it.** Every CLI expects the user to be logged in before spawn, and for most, credentials live in the very state directory that per-run config isolation would relocate (`CODEX_HOME` → `auth.json`, `PI_CODING_AGENT_DIR` → `auth.json`; the Codex case verified observationally). Two exceptions are worth noting as upgrades, not as the rule: opencode's `OPENCODE_CONFIG` relocates a config *file* and so never touches credentials, and Cursor exposes a plain `--api-key` flag. The contract should say: the adapter inherits the user's environment, performs a cheap pre-flight auth check, and surfaces a clean "not authenticated" failure rather than rendering a login flow into the PTY.
6. **A per-adapter pre-flight that makes the invocation non-blocking and renderer-safe.** Every CLI has at least one thing that stalls or corrupts an unattended PTY session, and the fix differs each time. This must be a contract *responsibility* ("produce a safe invocation"), never a fixed flag list:

   | CLI | What blocks or corrupts | Suppressed by |
   | --- | --- | --- |
   | Codex | approval modals | `-a never` (or `--dangerously-bypass-approvals-and-sandbox`) |
   | Codex | alternate-screen takeover destroys scrollback | `--no-alt-screen` |
   | Pi | project-trust modal on first run in a new worktree | `--approve` / pre-seeded `trust.json` / `defaultProjectTrust` |
   | Pi | inline terminal graphics sequences | `terminal.showImages: false`, `images.blockImages` |
   | Pi | startup network calls (version check, telemetry) | `--offline` / `PI_OFFLINE=1` |
   | Pi | noisy startup header | `quietStartup` |
   | Gemini CLI | trusted-folders prompt | `--skip-trust` |
   | Gemini CLI | approval modals | `--approval-mode=yolo` |
   | Cursor CLI | trust prompt | `--trust` |
   | Cursor CLI | approval modals | `-f`/`--force` (`--yolo`) |
   | opencode | **unknown** — no trust/approval hazard established | — |

   Note the shape is identical everywhere — a trust gate and an approval gate — but the flag name differs in all five cases, and one CLI's hazards are simply not documented. This is the clearest argument for making pre-flight an adapter responsibility rather than a shared implementation.

### 9.2 Genuine per-adapter upgrades

These are real capability differences. They belong behind optional interfaces that the harness feature-detects, not in the required contract.

| Upgrade | Codex | Pi | Gemini | opencode | Cursor |
| --- | --- | --- | --- | --- | --- |
| **Push completion signal, PTY intact** | **Y, cheapest** — `notify` runs an external program on `agent-turn-complete` (JSON as argv). No timeout cliff | **Y, costs a `.ts` file** — extension on `agent_settled`, passed with `-e` | **Y** — `AfterAgent` shell hook, but must be written into `settings.json` | **Y, costs a `.ts` file** — plugin on **`session.idle`** | **Y on paper** — `stop` / `afterAgentResponse` hooks; **CLI delivery undocumented** |
| **Shell hooks (vs in-process code)** | **Y** — 11 events, JSON stdin, can block | **N** — TypeScript extensions | **Y** — 11 events, JSON stdin/stdout | **N** — JS/TS plugins | **Y** — ~20 events, richest surveyed |
| **Live structured event stream** | **Y, not in a PTY** — `exec --json` only | **Y** — `--mode json`; `--mode rpc` bidirectional | **Y** — `-o stream-json` | **Y** — `run --format json` | **Y** — `--output-format stream-json` (needs `--print`) |
| **Mid-run prompt injection** | ~ `app-server` (experimental) | **Y** — RPC `steer` / `follow_up`, defined semantics | **unknown** | **~** — plugin `tui.prompt.append` | **unknown** |
| **Transcript tailing** | **Y** — `sessions/**/rollout-*.jsonl` | **Y** — but **tree-structured**; "last line" ≠ current state | **Y** — path known, **format unknown** | **unknown** | **Y via `transcript_path`** in hook payload |
| **Structured final answer** | **Y** — `--output-schema` | **N** | **unknown** | **unknown** | **unknown** |
| **Per-run config isolation** | **Y** — `-c key=value` everywhere; `--ignore-user-config` (`exec` only) keeps auth | **~** — `PI_CODING_AGENT_DIR` + orthogonal flags; no key=value | **Weakest** — no config flag at all; hooks require writing `settings.json` | **Y, best** — `OPENCODE_CONFIG` points at a config file; **never touches credentials** | **~** — `--plugin-dir`, `--api-key` |
| **Per-run prompt/skill injection** | **N** — fixed discovery paths | **Y** — `--skill`, `--prompt-template`, repeatable | **~** — `--extensions` (allowlist only) | **unknown** | **Y** — `--plugin-dir` |
| **Native worktree support** | **N** | **N** | **Y** — `--worktree` | **unknown** | **Y** — `-w/--worktree`, `--worktree-base` |
| **Session resume** | Y | Y | Y | Y | Y |

Two things stand out. **Shell hooks are a majority feature but not a universal one** — Codex, Gemini and Cursor have them; Pi and opencode instead want a small JS/TS file. So the optional interface should be *"deliver a completion event"*, implemented per adapter by whichever mechanism that CLI offers, rather than *"register a hook script"*. And **session resume is universal in fact but the identifiers are mutually incompatible** (UUIDs, indices, `latest`, `-1`), so resume must be modelled as an **opaque adapter-held token**, never a shared ID format.

### 9.3 Which CLIs are worth targeting

The ticket asked for a judgement rather than a padded matrix. Six of the seven examined are targetable; one is not.

| CLI | Verdict | Reasoning |
| --- | --- | --- |
| **Codex CLI** | **Target — first** | Argv-positional prompt, `-C/--cd`, `-c key=value` on every subcommand, and `notify` as a cheap external-program completion signal. The least friction of any non-Claude adapter. |
| **Gemini CLI** | **Target — second** | The only CLI with an *explicit* flag for the harness's exact use case (`--prompt-interactive`), plus real shell hooks, `--skip-trust`, `--approval-mode`, and native `--worktree`. Main cost: no per-run config injection, so hooks mean writing a settings file. |
| **Pi** | **Target** | Argv positional, Agent Skills, per-run `--skill`/`--prompt-template` injection, and an RPC mode that is the best non-PTY transport surveyed. Costs a small TypeScript extension for live signals, and needs a bash on Windows. |
| **opencode** | **Target** | Best config isolation of all (`OPENCODE_CONFIG`), a `--dir` cwd flag, and `session.idle` as a precise completion event. Watch the `--prompt`-not-positional trap. |
| **Cursor CLI** | **Target — but verify first** | Argv positional, `--plugin-dir`, `--api-key`, native worktrees, and the richest hook set surveyed. Held back only because *which hooks fire under the CLI is undocumented*, with unverified community reports of dropped events and a Windows BOM bug in the hook payload. Verify empirically before depending on hooks. |
| **aider** | **Do not target** | `-m/--message` "process reply **then exit**" — no way to seed a prompt and stay interactive. Fails the core spawn model. No hooks, no JSON output, Markdown-only transcript. |
| **Claude Code** | Already targeted | Reference row. |

A useful sequencing observation: **Codex and Gemini together cover the "shell hooks" adapter shape, and Pi and opencode together cover the "in-process JS/TS" shape.** Building one of each early would exercise both halves of the optional-signal interface and prove the contract generalises, which two shell-hook adapters would not.

### 9.4 Constraints that leak into the contract

- **Config isolation and auth are coupled.** Any "run with harness-controlled config" feature must either seed credentials or use a narrower lever. For Codex that lever exists (`--ignore-user-config` — though only on `exec`); for Pi it does not, so isolation there means supplying `--api-key` or provider env vars.
- **Project trust is a near-universal third state, and the failure modes are opposite.** Codex records `trust_level` per project path in the *user-level* config (observed on this machine); Pi records decisions in `~/.pi/agent/trust.json`; Gemini has `trusted-folders.md` and `--skip-trust`; Cursor has `--trust`. **A harness spawning into a fresh git worktree per ticket hits an untrusted path every time.** For Codex the consequence is *silent* — project-local config, hooks and rules are simply ignored, so a hook-based completion signal would quietly never fire. For Pi it is *loud* — an interactive modal blocks the session. A contract that only handles one of these will break on the other.
- **Windows is not uniform.** Pi requires an external bash (Git Bash / Cygwin / MSYS2 / WSL) or its `bash` tool fails at *runtime*, not startup — so a Tauri harness must pre-check. Codex has a separate `[windows] sandbox` axis. Cursor reportedly emits a UTF-8 BOM in hook stdin JSON on Windows (unverified). Gemini and opencode Windows behaviour is unknown. Adapter availability should be platform-gated rather than assumed.
- **Prefer worktree-native CLIs where the harness already uses worktrees.** Gemini (`--worktree`) and Cursor (`-w/--worktree`, `--worktree-base`) treat git worktrees as first-class. Since this harness spawns one agent per ticket and worktrees are the natural isolation unit, those flags may let the adapter delegate setup rather than reimplement it — worth evaluating rather than assuming the harness must own worktree creation for every adapter.
- **Do not model "the agent is done" on a single hook.** Codex's `notify` fires per *turn*, not per session; `SessionEnd` is capped at 3 s; Pi's `session_shutdown` runs in-process on SIGTERM with no documented budget. Every push signal is a hint that should trigger a poll, not a replacement for one.
- **Adapters must construct argv as a list, never as a shell string.** Verified on Windows (observed): passing Codex's `-c 'notify=["echo","hi"]'` through PowerShell silently mangles it to `[echo,hi]` and the run fails with `invalid type: string … expected a sequence`; the same override with escaped quotes exits 0. Any config value containing quotes, spaces or brackets is at risk the moment a shell is interposed. Since the harness is a Tauri app spawning processes directly, this is free — but it should be stated in the contract so no adapter reintroduces a shell for convenience.

---

## 10. What is still unknown

Listed so the adapter-contract ticket knows what it is inheriting rather than discovering it late. Everything here is marked **unknown** in the matrix above.

**Cheap to close by installing the CLI and reading `--help` / the config dir**, exactly as was done for Codex and Pi:

- Gemini CLI: transcript file format under `~/.gemini/tmp/<project_hash>/chats/`; whether a config-dir env var exists for per-run isolation; auth mechanism and unauthenticated-spawn behaviour; Windows PTY behaviour.
- opencode: on-disk session/transcript path and format; skill support; auth and PTY hazards; trust/approval gates (none were found documented, which is itself suspicious).
- Cursor CLI: transcript location/format; whether `--workspace` sets cwd or only widens it; skill system; auth failure behaviour.

**Requires an empirical test, not more reading:**

- **Do Codex hooks fire in the interactive TUI?** The docs never scope hooks to a surface (§3.4). The whole "live signal without leaving the PTY" story for Codex rests on this. *Test before designing around it.*
- **Does interactive `codex` refuse to run outside a git repo?** `--skip-git-repo-check` is `exec`-only; binary string inspection was inconclusive (§3.8).
- **Which Cursor hooks actually fire under `cursor-agent`,** and does the reported Windows UTF-8 BOM in the hook stdin payload exist? A security hook that silently fails open is not a defect the harness should inherit unknowingly (§7.3).
- **Do Pi's multiple positional messages become successive turns or one concatenated message?** Inferred from a help-text label only (§4.1).

---

*Research date: 2026-08-01. Claude Code 2.1.220, Codex CLI 0.130.0 and Pi 0.83.0 were inspected directly on a Windows 11 machine — `--help` output, on-disk config, session files, and the vendor's own bundled documentation. Gemini CLI, opencode, Cursor CLI and aider are documentation-only, read from each project's official docs or repo on the date above, with versions unpinned. Claims marked (observed) were verified on this machine; all others carry a source URL. No secondary sources are cited except where explicitly flagged as unverified community reports in §7.3.*


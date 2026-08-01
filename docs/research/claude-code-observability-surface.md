# Claude Code observability surface

Research for [issue #2 — Claude Code observability surface](https://github.com/javrasya/perseverance/issues/2).

## The question

What can a desktop harness observe about a running Claude Code session, live, without asking the user to modify their own configuration?

Concretely:

- Which hook events exist, what payload does each carry, and which of them see a `gh issue create` / `gh issue close` / label change at the moment it happens?
- Can hook configuration be injected per-run, so the harness never writes into the user's global or project settings?
- What is in the on-disk session transcript, where does it live, and does tailing it give the same events with less setup?
- Is there a reliable signal for "the turn ended" and "the session exited"?

## Method and provenance

**Date checked:** 2026-08-01. **Version under test:** Claude Code `2.1.220` (`claude --version`), Windows 11, npm install at `C:\Users\ahmet\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code`.

Claims are tagged:

- **(observed)** — I ran it on this machine and captured the output. Verbatim payloads below are real captures, not reconstructions.
- **(binary)** — extracted from the shipped executable `…\node_modules\@anthropic-ai\claude-code-win32-x64\claude.exe` via `strings`. First-party but internal.
- **(docs)** — from the official reference at <https://code.claude.com/docs/en/hooks> and <https://code.claude.com/docs/en/settings>. Note that `docs.claude.com/en/docs/claude-code/*` now 301-redirects to `code.claude.com/docs/en/*` (observed).
- **(unverified)** — stated explicitly where I could not establish something.

Where **(observed)** and **(docs)** disagree, the observed behaviour of the running build wins and the disagreement is called out. There is exactly one such case (§1.2).

The experiment scaffolding lived in `C:\Users\ahmet\AppData\Local\Temp\cchooktest\` (throwaway; not part of the repo).

> **Scope caveat that colours everything below:** all live-run experiments were done in `--print` (headless) mode. I could not drive an *interactive* (TUI/PTY) session from this environment — `winpty`-driven attempts never got Claude Code to start at all (no transcript file was created for those attempts, observed). Where a finding might differ between print mode and a PTY session, I say so.

---

## 1. Hook events: what exists and what each carries

### 1.1 The event catalogue

The shipped binary contains this union of hook-event names **(binary)**:

```
PreToolUse, PostToolUse, PostToolUseFailure, PostToolBatch, Notification,
UserPromptSubmit, UserPromptExpansion, SessionStart, SessionEnd, Stop, StopFailure,
SubagentStart, SubagentStop, PreCompact, PostCompact, PermissionRequest,
PermissionDenied, Setup, TeammateIdle, TaskCreated, TaskCompleted, Elicitation,
ElicitationResult, ConfigChange, WorktreeCreate, WorktreeRemove, InstructionsLoaded,
CwdChanged, FileChanged, DirectoryAdded, MessageDisplay
```

Source: `strings claude.exe | grep -oE '\["(PreToolUse|…)"(,"[A-Za-z]+")+\]'`.

**Almost all of these are public API.** The official hooks reference **(docs)** documents 30 events, in this order:

> SessionStart, Setup, UserPromptSubmit, UserPromptExpansion, PreToolUse, PermissionRequest, PermissionDenied, PostToolUse, PostToolUseFailure, PostToolBatch, Notification, MessageDisplay, SubagentStart, SubagentStop, TaskCreated, TaskCompleted, Stop, StopFailure, TeammateIdle, InstructionsLoaded, ConfigChange, CwdChanged, FileChanged, WorktreeCreate, WorktreeRemove, PreCompact, PostCompact, Elicitation, ElicitationResult, SessionEnd

The only binary name absent from the docs list is `DirectoryAdded` — treat that one as internal. So the surface is genuinely broad; even `WorktreeCreate`, `FileChanged`, and `CwdChanged` are supported.

The binary's own validation error names the mainstream subset **(binary)**:

> `Not a recognized hook event. Common events: PreToolUse, PostToolUse, UserPromptSubmit, SessionStart, SessionEnd, Stop. Check spelling and capitalization.`

I verified those six end-to-end. The other 24 are documented but **unverified here**.

### 1.2 Observed payloads (verbatim captures)

Registered every event below as a `command` hook that appended its stdin to a file, then ran:

```
claude -p "Run exactly this shell command and then stop: echo hello-from-test" \
  --settings /tmp/cchooktest/settings.json --setting-sources "" \
  --model sonnet --permission-mode bypassPermissions \
  --output-format stream-json --include-hook-events --verbose
```

All six fired. Captured payloads **(observed)**:

**`SessionStart`**

```json
{
 "session_id": "630353a6-511a-4a3c-8d3e-88b64ed1a8f0",
 "transcript_path": "C:\\Users\\ahmet\\.claude\\projects\\C--Users-ahmet-AppData-Local-Temp-cchooktest\\630353a6-511a-4a3c-8d3e-88b64ed1a8f0.jsonl",
 "cwd": "C:\\Users\\ahmet\\AppData\\Local\\Temp\\cchooktest",
 "hook_event_name": "SessionStart",
 "source": "startup"
}
```

`source` enum, identical in **(binary)** and **(docs)**: `startup` (new session), `resume` (`--resume`/`--continue`/`/resume`), `clear` (`/clear`), `compact` (auto or manual compaction), `fork` (`--fork-session`, `/fork`, `/branch`).

**`UserPromptSubmit`**

```json
{
 "session_id": "…", "transcript_path": "…", "cwd": "…",
 "prompt_id": "c6454cf4-42a1-469c-b6bb-a567ac09ba24",
 "permission_mode": "bypassPermissions",
 "hook_event_name": "UserPromptSubmit",
 "prompt": "Run exactly this shell command and then stop: echo hello-from-test"
}
```

**`PreToolUse`** — this is the one that sees the `gh` call before it runs:

```json
{
 "session_id": "…", "transcript_path": "…", "cwd": "…",
 "prompt_id": "c6454cf4-42a1-469c-b6bb-a567ac09ba24",
 "permission_mode": "bypassPermissions",
 "effort": { "level": "high" },
 "hook_event_name": "PreToolUse",
 "tool_name": "Bash",
 "tool_input": {
   "command": "echo hello-from-test",
   "description": "Echo test string"
 },
 "tool_use_id": "toolu_01Bd8SWpZwxX3Qth9aLGEvKH"
}
```

This matches the documented `PreToolUse` example field-for-field **(docs)** — `session_id`, `prompt_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`, `tool_name`, `tool_input`, `tool_use_id`.

**`PostToolUse`** — same plus the result:

```json
{
 …,
 "hook_event_name": "PostToolUse",
 "tool_name": "Bash",
 "tool_input": { "command": "echo hello-from-test", "description": "Echo test string" },
 "tool_response": {
   "stdout": "hello-from-test", "stderr": "",
   "interrupted": false, "isImage": false, "noOutputExpected": false
 },
 "tool_use_id": "toolu_01Bd8SWpZwxX3Qth9aLGEvKH",
 "duration_ms": 769
}
```

> **Documentation discrepancy — read this before writing a parser.** The running build delivers the result as **`tool_response`** (observed, captured above and again in the HTTP-hook run of §1.5). A read of the official hooks reference reports the input field as **`tool_output`** **(docs)** — though I could not retrieve the page's verbatim `PostToolUse` input example to confirm that directly, so the docs claim is second-hand within the docs themselves.
>
> Note also that `updatedToolOutput` is a real field but a *different* one: it belongs to the hook's **output**, not its input — *"PostToolUse: `updatedToolOutput` replaces the tool's result"* **(docs)**. It is plausible the two got conflated.
>
> **Defensive read:** `payload.get("tool_response") or payload.get("tool_output")`. Do not hard-code either name.

**`Stop`**

```json
{
 …,
 "hook_event_name": "Stop",
 "stop_hook_active": false,
 "last_assistant_message": "hello-from-test",
 "background_tasks": [],
 "session_crons": []
}
```

**`SessionEnd`**

```json
{
 "session_id": "…", "transcript_path": "…", "cwd": "…",
 "prompt_id": "…",
 "hook_event_name": "SessionEnd",
 "reason": "other"
}
```

`reason` enum, identical in **(binary)** and **(docs)** (*"`SessionEnd`: why the session ended"*): `clear`, `resume`, `logout`, `prompt_input_exit`, `bypass_permissions_disabled`, `other`. Note there is **no** value meaning "killed" or "crashed" — see §4.2.

Common fields present on every payload **(observed)**: `session_id`, `transcript_path`, `cwd`, `hook_event_name`. Present on everything after the prompt is submitted: `prompt_id`, `permission_mode`. Present on tool events: `effort.level`, `tool_use_id`.

### 1.3 Can a hook see a `gh issue create` / `gh issue close` / label change?

**Yes — via `PreToolUse` and `PostToolUse` with `matcher: "Bash"`, and the literal command string is in `tool_input.command` (observed).** That covers all three mutations, because `gh issue create`, `gh issue close`, `gh issue edit --add-label`, and `gh api …` are all just Bash invocations.

Three caveats that matter for correctness:

1. **One Bash call is not one mutation.** From this repo's own session transcript (`~/.claude/projects/C--Users-ahmet-Workspace-perseverance/9f66d17f-….jsonl`, observed) a single `tool_use` carried a shell script that ran **four** `gh issue create` commands in sequence, with a shell variable for the repo:

   ```
   R=javrasya/perseverance

   gh issue create --repo $R --label "wayfinder:research" --title "Claude Code observability surface" --body '…'
   gh issue create --repo $R --label "wayfinder:research" --title "GitHub sub-issue and dependency API coverage" --body '…'
   …
   ```

   The harness must parse the command string for *all* `gh` invocations, and cannot assume a 1:1 mapping between tool calls and issue mutations. Shell variables, `--body-file`, heredocs, and `&&` chains all appear in practice.

2. **`PreToolUse` is a *proposal*, not a fact.** The command may still be denied by permissions, or fail. Only `PostToolUse` (with `tool_response.stdout`) confirms the mutation happened — and for `gh issue create` the stdout *is* the new issue URL, e.g. `https://github.com/javrasya/perseverance/issues/1` (observed in the same transcript). That is the cheapest way to learn the new issue number.

3. **If the agent uses an MCP GitHub server instead of `gh`, `matcher: "Bash"` sees nothing.** The `tool_name` would be `mcp__<server>__<tool>`. A harness that wants to be safe should match `"Bash|mcp__.*github.*"` or use an empty/`*` matcher and filter itself.

### 1.4 Blocking and modifying

Hooks can block. The output schema the binary advertises **(binary)**:

```
{
  continue:            boolean (optional)
  suppressOutput:      boolean (optional)
  stopReason:          string (optional)
  decision:            "approve" | "block" (optional)
  reason:              string (optional)
  systemMessage:       string (optional)
  terminalSequence:    string (optional)
  permissionDecision:  "allow" | "deny" | "ask" (optional)
  hookSpecificOutput:
    for PreToolUse:       { hookEventName: "PreToolUse",
                            permissionDecision: "allow"|"deny"|"ask"|"defer",
                            permissionDecisionReason: string,
                            updatedInput: object   // Modified tool input to use
                          }
    for UserPromptSubmit: { hookEventName: "UserPromptSubmit", additionalContext: string (required) }
    for PostToolUse:      { hookEventName: "PostToolUse", additionalContext: string }
    for PostToolBatch:    { hookEventName: "PostToolBatch", additionalContext: string }
    for Stop/SubagentStop:{ hookEventName: "Stop"|"SubagentStop", additionalContext: string }
}
```

Notably `PreToolUse.hookSpecificOutput.updatedInput` lets a hook **rewrite the tool input**. **For a read-only harness this is a hazard to avoid, not a feature to use** — return exit 0 and empty stdout and nothing is changed (observed: my capture hooks returned empty stdout and the session was unaffected).

### 1.5 Hook *types* — and the one that matters most here

The hook entry is a discriminated union on `type` **(binary)**, not just shell commands:

| `type` | Shape | Notes |
| --- | --- | --- |
| `command` | `{ type, command, timeout?, statusMessage?, once?, if? }` | Spawns a process, payload on stdin. |
| `http` | `{ type, url, timeout?, headers?, allowedEnvVars?, if?, once? }` | **POSTs the hook input JSON to a URL.** |
| `prompt` | `{ type, prompt, model?, continueOnBlock?, statusMessage?, once?, if? }` | Runs a small-model prompt as the hook. |
| `mcp_tool` | `{ type, server, tool, input?, timeout?, … }` | Calls a tool on a configured MCP server; `input` string values support `${tool_input.file_path}`-style interpolation. |

`http` is the headline finding for a Tauri harness — and it is **officially documented, not an internal accident (docs)**. The reference gives this schema, whose example URL is itself a localhost callback:

```json
{
  "type": "http",
  "url": "http://localhost:8080/hooks/pre-tool-use",
  "timeout": 30,
  "headers": { "Authorization": "Bearer $MY_TOKEN" },
  "allowedEnvVars": ["MY_TOKEN"]
}
```

with `url` — *"URL to send the POST request to"*; `headers` — *"Additional HTTP headers as key-value pairs. Values support environment variable interpolation using `$VAR_NAME` or `${VAR_NAME}` syntax. Only variables listed in `allowedEnvVars` are resolved"*; `allowedEnvVars` — *"List of environment variable names that may be interpolated into header values"* **(docs)**.

The `allowedEnvVars` + `headers` combination means the harness can hand the spawned session a per-run bearer token in the env and have Claude Code authenticate its callbacks to the local listener — worth doing, since any local process could otherwise POST fake events at it.

The corresponding binary description **(binary)**:

> `type: v.literal("http").describe("HTTP hook type"), url: v.string().url().describe("URL to POST the hook input JSON to")`

and, explicitly:

> `HTTP hook blocked: ${e} resolves to ${t} (private/link-local address). Loopback (127.0.0.1, ::1) is allowed for local dev.`

**Verified end-to-end (observed).** I ran a Python HTTP server on `127.0.0.1:8793`, pointed four hooks at it, and it received:

```
PreToolUse  | {"tool_name":"Bash","tool_input":{"command":"echo http-hook-test","description":"Echo test string"}}
PostToolUse | {"tool_name":"Bash","tool_input":{…},"tool_response":{"stdout":"http-hook-test","stderr":"", …}}
Stop        | {}
SessionEnd  | {"reason":"other"}
```

So a Tauri harness can listen on a loopback port and receive hook payloads directly as HTTP POSTs — no helper script on disk, no shell, no stdout parsing, no Windows path-quoting problems.

**One observed defect:** a `SessionStart` hook of `type: "http"` **did not fire**, while a `command` hook in the *same* hook block did. Capture from a run with both registered on `SessionStart` (observed):

```
STREAM: hook_started  SessionStart:startup
STREAM: hook_response SessionStart:startup success 'SS_CMD\n'      <- the command hook
=== HTTP SERVER RECEIVED ===  (only Stop and SessionEnd, no SessionStart)
```

Only one `hook_started` appeared for `SessionStart`, so the HTTP handler was not merely failing — it was never invoked. `Stop` and `SessionEnd` HTTP hooks in the same run worked. I have **not** established whether this is Windows-specific, print-mode-specific, or a general bug; treat `SessionStart` over HTTP as unreliable and use a `command` hook (or the `system/init` stream message) for session start.

Two managed-settings controls exist that an enterprise policy could use to neuter all of this **(binary)**:

- `allowedHttpHookUrls` — *"Allowlist of URL patterns that HTTP hooks may target… If empty array, no HTTP hooks"*.
- A managed-settings flag whose description reads *"…only hooks from managed settings run. User, project, and local hooks are ignored."*

The harness should degrade gracefully if hooks silently never arrive.

---

## 2. Per-run hook injection without touching user config

**Yes. `--settings` does exactly this, and it is additive by default (observed).**

From `claude --help` (observed):

```
--settings <file-or-json>       Path to a settings JSON file or a JSON string
                                to load additional settings from
--setting-sources <sources>     Comma-separated list of setting sources to load
                                (user, project, local).
```

Note `--settings` accepts **either a path or an inline JSON string**, and neither flag is annotated `(only works with --print)` — unlike `--output-format`, `--include-hook-events`, `--fallback-model`, etc., which are explicitly marked print-only in the same help output. That is good evidence they are global flags, though see the scope caveat.

Neither flag is documented on the settings reference page **(docs)** — that page does not mention `--settings` syntax at all and does not mention `--setting-sources` anywhere. `claude --help` is the authority here.

The precedence order the settings page *does* document **(docs)** explains why injection works cleanly:

> 1. **Managed** (highest): can't be overridden by anything
> 2. **Command line arguments**: temporary session overrides
> 3. **Local**: overrides project and user settings
> 4. **Project**: overrides user settings
> 5. **User** (lowest): applies when nothing else specifies the setting

with locations: managed = *"Server-managed, plist/registry, or system-level `managed-settings.json`"*; user = `~/.claude/settings.json`; project = `.claude/settings.json`; local = `.claude/settings.local.json`; and *"On Windows, paths shown as `~/.claude` resolve to `%USERPROFILE%\.claude`."*

`--settings` sits at tier 2 — above everything the user owns, below enterprise policy. For the `hooks` key specifically the effect is **union, not replacement** (measured, below).

### 2.1 Additive vs. isolated — measured

I injected `{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"echo INJECTED_HOOK_RAN"}]}]}}` and ran the same prompt twice with `--include-hook-events` (observed):

**With the user's settings still loaded (no `--setting-sources`):**

```
hook_started  SessionStart:startup      (x4 — user + plugin hooks)
hook_response SessionStart:startup 'CAVEMAN MODE ACTIVE — level: full…'
hook_started  UserPromptSubmit          (x3)
hook_started  PreToolUse:Bash           (x2)
hook_response PreToolUse:Bash 'INJECTED_HOOK_RAN\n'     <- mine
hook_response PreToolUse:Bash ''                        <- the user's own Bash hook
hook_started  PostToolUse:Bash
hook_started  Stop                      (x2)
```

**With `--setting-sources ""`:**

```
hook_started  PreToolUse:Bash
hook_response PreToolUse:Bash 'INJECTED_HOOK_RAN\n'
```

So:

- `--settings <file>` alone **merges** the harness's hooks in alongside the user's. Nothing in `~/.claude/settings.json` or `.claude/settings.json` is written or altered. This is the mode a read-only harness wants: the user's session behaves exactly as it normally would, plus the harness's observers.
- `--setting-sources ""` gives a hermetic run with *only* the injected settings. It also throws away the user's permissions, model choice, plugins, statusline, and CLAUDE.md-adjacent config — so it is the wrong default for a harness that is supposed to run the user's normal agent.

### 2.2 Other injection levers

| Lever | Effect | Verdict for the harness |
| --- | --- | --- |
| `--settings <file-or-json>` | Adds settings (incl. `hooks`) for one run **(observed)** | **Use this.** |
| `--setting-sources user,project,local` | Chooses which config files load at all **(observed)** | Only if isolation is wanted. |
| `CLAUDE_CONFIG_DIR` env var | Relocates the entire `~/.claude` directory **(binary; not on the settings docs page — undocumented)** | Too blunt — it moves credentials, plugins, history, *and* the transcripts. |
| `--plugin-dir <path>` / `--plugin-url` | Loads a plugin "for this session only" **(observed, `--help`)** | Viable alternative packaging; heavier than `--settings`. |
| `--mcp-config` / `--agents` / `--append-system-prompt` | Per-run injection of other surfaces **(observed, `--help`)** | Not needed for observation. |
| `--bare` | *"Minimal mode: **skip hooks**, LSP, plugin sync…"* **(observed, `--help`)** | Actively hostile to observation — never use. |
| `--safe-mode` | Disables all customizations including hooks **(observed, `--help`)** | Same. |

### 2.3 Environment visible to `command` hooks

Captured by dumping `env | grep ^CLAUDE` from inside a `PreToolUse` hook (observed):

```
CLAUDECODE=1
CLAUDE_CODE_AGENT=claude
CLAUDE_CODE_ENTRYPOINT=sdk-cli
CLAUDE_CODE_EXECPATH=C:\Users\ahmet\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe
CLAUDE_CODE_SESSION_ID=74ad7d6b-085f-4d44-bb08-d9b51b351ad4
CLAUDE_CODE_VERSION=2.1.220 (Claude Code)
CLAUDE_EFFORT=high
CLAUDE_JOB_DIR=C:\Users\ahmet\.claude\jobs\9e1fcb3e
CLAUDE_PID=114636
CLAUDE_PROJECT_DIR=C:/Users/ahmet/Workspace/perseverance/.claude/worktrees/wayfinder-research
```

`CLAUDE_CODE_SESSION_ID` is the child session's own id and is a reliable correlation key. `CLAUDE_PROJECT_DIR` and `CLAUDE_PID` were also present in the *parent* environment in my test, so I cannot fully separate "set by Claude Code for the hook" from "inherited" for those two — treat them as **partially unverified**. `session_id` is in the JSON payload regardless, which is the safer source.

### 2.4 The option the question did not ask about, which may beat hooks entirely

`claude --help` (observed) also documents:

```
--include-hook-events    Include all hook lifecycle events in the output stream
                         (only works with --output-format=stream-json)
--input-format <format>  "text" (default), or "stream-json" (realtime streaming input)
--output-format <format> "text" (default), "json", or "stream-json"
```

Running with `--print --input-format stream-json --output-format stream-json` gives a **fully programmatic bidirectional session with no PTY at all**, where every assistant message — including every `tool_use` block with its full `input.command` — arrives on stdout as JSONL. Observed message types in one run: `system/init`, `system/hook_started`, `system/hook_response`, `assistant`, `user`, `rate_limit_event`, `result`.

Real capture of a `gh`-class tool call on that stream (observed):

```json
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_01Bd8…","name":"Bash",
  "input":{"command":"echo hello-from-test","description":"Echo test string"},
  "caller":{"type":"direct"}}], …},
 "session_id":"630353a6-…","uuid":"d5068214-…","timestamp":"2026-08-01T10:45:20.336Z"}
```

`--include-hook-events` adds `hook_started` / `hook_response` frames, but those carry only `hook_id`, `hook_name`, `hook_event`, `stdout`, `stderr`, `exit_code`, `outcome` — **not** the tool payload. So the flag is for observing *hooks*, not for replacing them; the tool arguments come from the `assistant` messages themselves.

The trade-off is real and should be a deliberate decision: stream-json mode means the harness owns the whole UI (the user never sees a Claude Code TUI), whereas PTY + hooks preserves the familiar interactive session.

---

## 3. The on-disk transcript

### 3.1 Where it lives

Pattern (observed):

```
~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl
```

`<encoded-cwd>` is the absolute working directory with `:`, `\`, and `.` each replaced by `-`. Observed examples:

| cwd | directory |
| --- | --- |
| `C:\Users\ahmet\Workspace\perseverance` | `C--Users-ahmet-Workspace-perseverance` |
| `C:\Users\ahmet\Workspace\perseverance\.claude\worktrees\wayfinder-research` | `C--Users-ahmet-Workspace-perseverance--claude-worktrees-wayfinder-research` |
| `C:\Users\ahmet\AppData\Local\Temp\cchooktest` | `C--Users-ahmet-AppData-Local-Temp-cchooktest` |

**The harness should never derive this path.** Every hook payload carries `transcript_path` verbatim (observed, §1.2), and the `system/init` stream-json message carries `session_id`. Deriving is a portability trap; reading it off the payload is free.

Sibling files in the same directory (observed): a `memory/` subdirectory for auto-memory. Sibling state elsewhere under `~/.claude/`: `history.jsonl` (global prompt history), `sessions/`, `session-env/`, `file-history/`, `jobs/`.

### 3.2 Record shapes

Record types observed in one real interactive session (`9f66d17f-….jsonl`, 313 records):

| `type` | Count | Notable keys |
| --- | --- | --- |
| `assistant` | 94 | `message` (Anthropic message: `content[]`, `usage`, `stop_reason`), `uuid`, `parentUuid`, `timestamp`, `requestId`, `cwd`, `gitBranch`, `sessionId`, `isSidechain`, `version` |
| `user` | 62 | `message.content[]`, **`toolUseResult`**, `sourceToolUseID`, `promptId`, `permissionMode`, `isMeta` |
| `system` | 47 | `subtype`, `content`, `durationMs`, `hookCount`, `hookInfos`, `hookErrors`, `preventedContinuation`, `stopReason`, `toolUseID`, `messageCount` |
| `attachment` | 32 | `attachment` |
| `file-history-snapshot` / `file-history-delta` | 19 / 8 | file backup tracking |
| `last-prompt`, `mode`, `permission-mode`, `ai-title` | 16/16/16/14 | UI state, no timestamps |
| `queue-operation` | 4 | `operation`, `content` |
| `frame-link` | 1 | `frameUrl`, `path`, `title` |

`system` subtypes observed: `stop_hook_summary`, `turn_duration`, `away_summary`, `local_command`.

**Tool calls do appear, with full arguments.** Real record from this repo's session (observed):

```json
{"parentUuid":"6059a2d1-…","isSidechain":false,
 "message":{"model":"claude-opus-5","id":"msg_011Cdb3U2S7dauy6PPETtgLP","role":"assistant",
   "content":[{"type":"tool_use","id":"toolu_01V3Sk5unSiHjQrrbHAJ9K9R","name":"Bash",
     "input":{"command":"gh issue create --repo javrasya/perseverance --title \"Wayfinder harness\" --label \"wayfinder:map\" --body-file \"…/map-body.md\"",
              "description":"Create the wayfinder map issue"},
     "caller":{"type":"direct"}}],
   "stop_reason":"tool_use", …},
 "type":"assistant","uuid":"bf476c93-…","timestamp":"2026-07-31T23:59:01.707Z",
 "session_id":"9f66d17f-…","cwd":"C:\\Users\\ahmet\\Workspace\\perseverance",
 "version":"2.1.220","gitBranch":"main"}
```

**Tool results do too**, as the *next* `user` record, with a `toolUseResult` sibling field carrying the raw stdio (observed):

```json
{"parentUuid":"bf476c93-…","type":"user",
 "message":{"role":"user","content":[
   {"tool_use_id":"toolu_01V3Sk5unSiHjQrrbHAJ9K9R","type":"tool_result",
    "content":"https://github.com/javrasya/perseverance/issues/1","is_error":false}]},
 "toolUseResult":{"stdout":"https://github.com/javrasya/perseverance/issues/1",
                  "stderr":"","interrupted":false,"isImage":false,"noOutputExpected":false},
 "sourceToolAssistantUUID":"bf476c93-…","uuid":"4d8ab49a-…",
 "timestamp":"2026-07-31T23:59:06.265Z", …}
```

Structural facts a tailer must handle (observed):

- **A single assistant message is split across multiple JSONL lines** that share the same `message.id` — one line per content block. A `thinking` block and a `tool_use` block from one API response arrive as two records.
- `thinking` blocks include a long base64 `signature`; a naive line-length assumption will break.
- **Subagent activity is inline**, marked `isSidechain: true`. A subagent's `gh` calls land in the same file. The harness must decide whether to count them.
- Several record types (`last-prompt`, `mode`, `ai-title`) have **no `timestamp`** and no `uuid`.
- Not every record is an event; `file-history-*`, `mode`, `permission-mode`, `ai-title` are UI/state bookkeeping.

### 3.3 Flush latency — measured

I instrumented hooks to stat the transcript at the moment they fired, checking whether the record for the *current* tool call was already on disk (observed):

```
PreToolUse  tid=toolu_017Lkc… t=…173.259 transcript_lines=9  contains_tool_use_id=1
PostToolUse tid=toolu_017Lkc… t=…174.341 transcript_lines=9  contains_tool_use_id=1
PreToolUse  tid=toolu_01BNzU… t=…175.989 transcript_lines=11 contains_tool_use_id=1
PostToolUse tid=toolu_01BNzU… t=…176.396 transcript_lines=11 contains_tool_use_id=1
Stop                          t=…177.738 transcript_lines=13
```

Cross-referencing against the transcript's own timestamps for the same session:

| line | record | transcript timestamp | corresponding hook fired at |
| --- | --- | --- | --- |
| 9 | `assistant` / `tool_use:Bash` | `10:46:12.564` | `PreToolUse` at `10:46:13.259` |
| 10 | `user` / `tool_result` | `10:46:14.390` | `PostToolUse` at `10:46:14.341` |

So:

- The **`tool_use` record is durable on disk ~0.7 s *before* the `PreToolUse` hook fires.** Tailing is not slower than hooks for seeing the command — it is marginally *earlier*.
- The **`tool_result` record lands ~50 ms after the `PostToolUse` hook.** Effectively the same instant.
- Writes are **line-appended and unbuffered enough to tail** — the file was never observed lagging behind by more than one record.

**Conclusion: tailing the transcript gives the same tool-level events at the same latency, with no configuration injection at all.** The setup cost is lower (find the file, tail it) but the parsing cost is higher (multi-line messages, sidechains, no explicit turn boundaries in print mode).

### 3.4 How a tailer correlates a record to a `gh` mutation

1. Read new lines; `json.loads` each.
2. `type == "assistant"` → for each `message.content[]` with `type == "tool_use"` and `name == "Bash"` (or `name.startswith("mcp__")` for MCP GitHub servers), scan `input.command` for `gh issue|gh api|gh label|gh sub-issue`. Record `id` (the `toolu_…`) as pending.
3. `type == "user"` → for each `message.content[]` with `type == "tool_result"`, match `tool_use_id` against the pending set. Read `toolUseResult.stdout` (issue URL for `create`) and `is_error`.
4. Ignore records with `isSidechain: true` unless subagent mutations should count.
5. De-duplicate against the GitHub poller by issue number, not by event.

The same shape works for hooks: `PreToolUse.tool_use_id` ↔ `PostToolUse.tool_use_id`.

### 3.5 Print-mode differences

A `--print` session's transcript is a strict subset (observed). One full `-p` run produced:

```
queue-operation, queue-operation, user, attachment ×3, ai-title,
assistant(thinking), assistant(tool_use:Bash), user(tool_result),
assistant(tool_use:Bash), user(tool_result), assistant(text), last-prompt
```

— no `system/turn_duration`, no `mode`/`permission-mode` records, no `stop_hook_summary`. Turn boundaries in print mode come from the `result` message on stdout instead (§4).

---

## 4. Turn end and session exit

### 4.1 Turn end

Three independent signals, in decreasing reliability:

1. **`Stop` hook (observed).** Fires when the assistant finishes a turn. Payload carries `stop_hook_active` (guards against re-entrancy when a Stop hook itself restarts the turn) and `last_assistant_message`. There is also a `SubagentStop` event for subagent turns **(binary, unverified)**.
2. **`system` / `subtype: "turn_duration"` transcript record (observed, interactive sessions only).** Real capture:
   ```json
   {"type":"system","subtype":"turn_duration","durationMs":29226,"messageCount":26,
    "timestamp":"2026-07-31T22:04:43.730Z","uuid":"a43d01d7-…",
    "sessionId":"9f66d17f-…","cwd":"C:\\Users\\ahmet\\Workspace\\perseverance",
    "gitBranch":"main","version":"2.1.220"}
   ```
   Immediately preceded by `system` / `subtype: "stop_hook_summary"`, which reports which Stop hooks ran, their `durationMs`, `hookErrors`, and `preventedContinuation`. **This record was absent from every `-p` transcript I produced (observed)** — do not rely on it in print mode.
3. **`result` message on the stream (print mode only, observed).** Full key set:
   ```
   type, subtype, is_error, result, stop_reason, terminal_reason, session_id, uuid,
   num_turns, duration_ms, duration_api_ms, time_to_request_ms, ttft_ms, ttft_stream_ms,
   total_cost_usd, usage, modelUsage, permission_denials, api_error_status,
   fast_mode_state, fast_mode_disabled_reason
   ```
   with `"subtype":"success"`, `"stop_reason":"end_turn"`, `"terminal_reason":"completed"` on a clean finish.

A tailer working from the transcript alone in an interactive session should key on `system/turn_duration`; a harness owning the stream should key on `result`.

### 4.2 Session exit

**`SessionEnd` fires and is the intended signal (observed).** It carries `reason`, enumerated **(binary)** as `["clear","resume","logout","prompt_input_exit","other","bypass_permissions_disabled"]`. In `--print` mode I observed `reason: "other"`. `prompt_input_exit` is presumably the interactive Ctrl-D / `/exit` path (**unverified** — I could not drive a PTY session).

**Is it reliable? No — measured (observed).** The binary contains `getSessionEndHookTimeoutMs`, `executeSessionEndHooks`, and `markSessionEndedByModel: transcript append failed:` **(binary)** — i.e. an in-process, best-effort, timeout-bounded flush during shutdown, which a forced kill cannot run.

I confirmed this directly. I spawned a long-lived session (`-p --input-format stream-json`, stdin held open), drove one real turn through it, verified the process was still alive, then hard-killed it with `taskkill /F /T`:

```
alive before kill: True
hard-killed at 1785582000.42

=== HTTP hook events received ===
1785581977.600  UserPromptSubmit
1785581979.844  PreToolUse   {'command': 'echo alive-marker', …}
1785581980.775  PostToolUse  {'command': 'echo alive-marker', …}
1785581982.018  Stop
                                          <- nothing further; no SessionEnd, checked +5 s
```

All four hooks registered before the kill fired normally, so the delivery path was healthy. **`SessionEnd` never arrived.** (In the clean-exit runs of §1.2 and §1.5 it always did.)

This test also incidentally confirms that `--settings`-injected hooks work across a real multi-turn `stream-json` session, not just a single `-p` shot.

**Therefore: PTY process exit is the only guaranteed exit signal.** `SessionEnd` is an *informative* exit notification — it tells you *why* the session ended, and it is reliable for graceful exits — but it is silently absent on kill or crash. The harness needs both: `SessionEnd` alone can be missed, and process exit alone gives no `reason`.

### 4.3 What has no reliable signal

- **"The agent is idle but the session is alive"** — `Stop` approximates this, but a `TeammateIdle` event exists in the binary **(binary, unverified)** and may be the real one.
- **Crash vs. clean exit, from hooks alone** — since `SessionEnd` is simply absent on an abnormal exit (§4.2), its absence is the *only* in-band signal, and absence is indistinguishable from "the hook was blocked by policy" or "the listener missed it". The PTY exit code is the discriminator, and it lives outside the hook system.

---

## Implications for the harness

**What the harness can rely on:**

1. **Per-run hook injection is real and non-invasive.** `--settings <file-or-json>` merges harness hooks into the run without writing a byte into `~/.claude/settings.json` or the project's `.claude/`, and without disturbing the user's own hooks (measured, §2.1). This fully answers the "don't ask the user to modify their config" constraint.
2. **`PreToolUse` + `PostToolUse` with `matcher: "Bash"` see the literal `gh` command string and its stdout** (§1.2, §1.3). `gh issue create`'s stdout *is* the new issue URL, so the harness learns the issue number without a round trip to GitHub.
3. **`type: "http"` hooks POST straight to `127.0.0.1` and loopback is explicitly whitelisted** (verified, §1.5). A Tauri app can run a tiny local listener and skip helper scripts, shells, and Windows path quoting entirely. This is the single best fit for this architecture.
4. **The transcript is a valid, equally-live alternative.** Tool calls are on disk ~0.7 s *before* `PreToolUse` fires and results ~50 ms after `PostToolUse` (measured, §3.3). Tailing needs zero config injection. Its cost is parsing complexity, not latency.
5. **Turn end is well-signalled**: `Stop` hook, or `system/turn_duration` in an interactive transcript, or the `result` stream message in print mode.
6. **The harness never needs to compute the transcript path** — every hook payload hands it over as `transcript_path`.

**What the harness cannot rely on:**

1. **One Bash call ≠ one issue mutation.** Real sessions batch four `gh issue create`s into one command string with shell variables (§1.3). Any "node appeared" logic driven off tool calls must parse the command, and must tolerate being wrong. **This is the strongest argument for keeping GitHub polling as the source of truth and treating hooks purely as a "poll now" trigger.**
2. **`PreToolUse` is a proposal.** The command can still be denied or fail. Only `PostToolUse`/`tool_result` confirms.
3. **`SessionEnd` does not survive a forced kill — measured, not inferred (§4.2).** A live session that was hard-killed emitted `UserPromptSubmit`/`PreToolUse`/`PostToolUse`/`Stop` normally and then nothing. **PTY process exit must be the authoritative exit signal;** `SessionEnd` is a graceful-exit nicety that supplies the `reason`.
4. **`SessionStart` over HTTP did not fire** in the tested build (§1.5). Use a `command` hook, the `system/init` stream message, or simply the moment the harness spawns the process.
5. **Managed/enterprise settings can disable hooks wholesale** (`allowedHttpHookUrls: []`, or managed-settings-only hook mode) (§1.5). Hooks must be an optimisation that can vanish, never a correctness dependency.
6. **`gh` is not the only path to GitHub.** If the session uses an MCP GitHub server, a `Bash` matcher sees nothing.
7. **Nothing here was verified in an interactive PTY session.** All live evidence is from `--print` mode; `winpty` could not start Claude Code in this environment. The flags involved are not marked print-only in `--help`, and hooks demonstrably run in interactive sessions — this repo's own interactive transcript contains `stop_hook_summary` records naming the hook commands that ran (observed):

   ```json
   {"type":"system","subtype":"stop_hook_summary","hookCount":2,
    "hookInfos":[{"command":"bash \"${CLAUDE_PLUGIN_ROOT}/hooks/sg-python.sh\" …"},
                 {"command":"${CLAUDE_PLUGIN_ROOT}/scripts/on-stop.sh","durationMs":79}],
    "hookErrors":[],"preventedContinuation":false, …}
   ```

   — but those came from installed *plugins*, not from `--settings`. **The specific combination "`--settings`-injected hooks fire in a PTY session" remains unconfirmed and should be the first thing the harness spike proves.** It is a five-minute check once a PTY is available.

**Recommended shape**, given the above:

- Spawn with `--settings <tempfile>` (additive — no `--setting-sources`), registering `type: "http"` hooks on `PreToolUse`(Bash), `PostToolUse`(Bash), `Stop`, `SessionEnd` pointed at a loopback port the Tauri app owns. Mint a per-run token, pass it in the child's environment, and reference it from the hook's `headers` + `allowedEnvVars` (§1.5) — otherwise any local process can POST fabricated events at the listener.
- Treat every hook as **"something may have changed — reconcile now"**, not as the change itself. Fire a targeted GitHub read on `PostToolUse` when the command matched `gh issue|gh api`; fall back to the existing poll tick otherwise.
- Keep transcript tailing in the back pocket as the zero-config fallback if hooks are policy-disabled, and as the recovery path for reconstructing what happened after a crash.
- Watch PTY exit for session death; use `SessionEnd.reason` when it arrives, but never wait for it.
- **Consider whether the PTY is needed at all.** `--print --input-format stream-json --output-format stream-json` gives every tool call with full arguments on stdout with no hooks and no config injection whatsoever (§2.4). It costs the harness the Claude Code TUI, which may or may not be a price worth paying for the wayfinder use case.

---

## Appendix: sources

Everything above traces to one of these. No secondary write-ups were used.

**Local first-party files inspected:**

- `C:\Users\ahmet\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\package.json` — version `2.1.220`, native-binary packaging.
- `C:\Users\ahmet\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\node_modules\@anthropic-ai\claude-code-win32-x64\claude.exe` — 265 MB native build; all **(binary)** claims come from `strings -n 8` over this file (431 816 lines). The zod schemas for the hook-entry union, the hook-output schema, the `SessionStart.source` / `SessionEnd.reason` enums, `allowedHttpHookUrls`, and the HTTP-hook loopback message are all verbatim from it.
- `C:\Users\ahmet\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\sdk-tools.d.ts` — checked; contains tool-input type definitions only, **no** hook types (single incidental match for "hook").
- `C:\Users\ahmet\.claude\settings.json` — user settings shape (top-level keys incl. `hooks`, `permissions`, `statusLine`, `enabledPlugins`).
- `C:\Users\ahmet\.claude\projects\C--Users-ahmet-Workspace-perseverance\9f66d17f-9f12-4332-9ab4-17e7d0f293b8.jsonl` — a real interactive session transcript (313 records); source of the `gh issue create` `tool_use`/`tool_result` pair, the batched-four-issues command string, `turn_duration`, and `stop_hook_summary`.
- `C:\Users\ahmet\.claude\projects\C--Users-ahmet-AppData-Local-Temp-cchooktest\*.jsonl` — the print-mode transcripts produced by the experiments.
- `claude --help` and `claude --version` output.

**Experiments run (scaffolding in `C:\Users\ahmet\AppData\Local\Temp\cchooktest\`, throwaway):**

| # | What it established | § |
| --- | --- | --- |
| 1 | Six hook events fire under `--settings` injection; captured their exact payloads | 1.2 |
| 2 | `type: "http"` hooks POST to `127.0.0.1` and are received | 1.5 |
| 3 | `SessionStart` over HTTP does not fire while a sibling `command` hook does | 1.5 |
| 4 | `--settings` is additive; `--setting-sources ""` isolates | 2.1 |
| 5 | Hook-visible `CLAUDE_*` environment | 2.3 |
| 6 | Transcript flush timing vs. hook firing (per-record, sub-second) | 3.3 |
| 7 | `stream-json` `result` message key set | 4.1 |
| 8 | `SessionEnd` absent after `taskkill /F` on a live session | 4.2 |
| 9 | *(failed)* driving an interactive PTY session via `winpty` — Claude Code never started, no transcript produced | scope caveat |

**Official documentation consulted:**

- <https://code.claude.com/docs/en/hooks> — the hook-event catalogue (30 events), `SessionStart.source` and `SessionEnd.reason` enums, the `PreToolUse` input example, the `http` hook-type schema, and `updatedToolOutput` as a PostToolUse *output* control.
- <https://code.claude.com/docs/en/settings> — settings precedence order and the four settings-file locations. Does **not** document `--settings`, `--setting-sources`, or `CLAUDE_CONFIG_DIR`.
- Note: `https://docs.claude.com/en/docs/claude-code/{hooks,settings}` both 301-redirect to the `code.claude.com/docs/en/*` paths (observed). Older links still work but resolve elsewhere.

**Where the docs and the build disagree:** exactly one place — the `PostToolUse` input field carrying the tool result (`tool_response` observed vs. `tool_output` per the docs page, §1.2). Read defensively. Everything else the docs assert that I could also test matched the build exactly.

Nothing in the recommended shape (§ Implications) depends on a hook event outside the six verified end-to-end here.

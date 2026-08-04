# Interactive-PTY delivery of hooks and completion signals

Research for [issue #14 — Interactive-PTY delivery of hooks and completion signals](https://github.com/javrasya/perseverance/issues/14).

## The question

Do agent-CLI hooks actually fire when the CLI runs in an **interactive** pseudo-terminal, using the now-known-good spawn path?

Two prior tickets stopped at exactly this line. [Claude Code observability surface](https://github.com/javrasya/perseverance/issues/2) verified `--settings`-injected hooks fire, but only in `--print` mode; its PTY attempt failed under `winpty`. [Codex and Pi CLI surfaces](https://github.com/javrasya/perseverance/issues/5) found Codex's `notify` key injectable per-run via `-c`, but could not establish whether it fires in the interactive TUI. [PTY spawn of agent CLIs](https://github.com/javrasya/perseverance/issues/4) then supplied the missing piece — the `ESC[6n` CPR blocker and a verified ConPTY spawn.

## Answer in one line

**Yes — every hook that fires in `--print` mode also fires in an interactive PTY, at the same time and with the same payloads, over both `command` and `http` transports.** The live-update tier of the signal ladder survives. Two defects and one unexpected extra signal channel came out with it.

## Method and provenance

**Date checked:** 2026-08-01. **Versions under test:** `portable-pty` 0.9.0, Claude Code `2.1.220`, Codex CLI `0.130.0`, Pi `0.83.0`, Windows 11 Pro 26200, rustc 1.92.0, Python 3.13.12.

Claims are tagged **(observed)** — run on this machine against the real CLI, with the byte captures quoted verbatim — or **(docs)** / **(unverified)**.

The scaffolding was a throwaway cargo project (`probe`) plus two Python helpers, all outside the repo:

| Piece | Role |
| --- | --- |
| `probe` (Rust, `portable-pty` 0.9.0) | Spawns the CLI in a ConPTY, answers `ESC[6n`, captures every byte, optionally types late input (`/exit`), kills on deadline. |
| `hooklistener.py` | Loopback HTTP server; logs one line per POST — arrival time, URL path (carries the event name), `Authorization` header, body. |
| `append.py` | Body of every `command` hook and of Codex `notify`; appends `<epoch> <TAG> argv=… stdin=…` to a marker file. Captures **both** transports because Claude Code delivers on stdin and Codex on argv. |

Injection used the additive form established in #2 — `--settings <file>`, no `--setting-sources`, so the user's own hooks stayed loaded. The settings file registered a `command` **and** an `http` hook on the same event wherever possible, so each event is its own control for the other transport. The `http` hooks carried `Authorization: Bearer $WAYFINDER_RUN_TOKEN` with `allowedEnvVars: ["WAYFINDER_RUN_TOKEN"]`.

Runs referenced below:

- **Run 1** — hooks injected, prompt as argv, session **hard-killed** at 100 s. Inherited env left untouched.
- **Run 2** — same, but harness env markers scrubbed, and `/exit` typed into the TUI at 45 s for a **graceful** shutdown.
- **Runs 3–7** — Codex; **Run 5** — Pi.

---

## 1. Claude Code: hooks fire in an interactive PTY

### 1.1 The spawn reproduces #4 exactly

Before touching hooks, `claude --version` through the probe **(observed)**:

```
[probe] resolved claude -> C:\Users\ahmet\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe
[probe] answered CPR at 21.1184ms
[probe] done: 161 bytes in 104.1366ms, exit=Some(0), injected=false
```

161 bytes, exit 0, CPR at ~21 ms — the same numbers #4 recorded. The `ESC[6n` responder is load-bearing exactly as documented there.

For the interactive runs, alt-screen (`ESC[?1049h`) arrived at **1.00 s** and **1.06 s** **(observed)** — considerably later than the ~223 ms #4 measured for a bare start, because these runs load the user's real project config. Treat 223 ms as a floor, not a typical value.

### 1.2 The full event timeline

Run 2, times relative to the `SessionStart` `command` hook (t = 0). The two clocks were aligned on the `Stop` event, which both transports recorded **(observed)**:

| Event | `command` hook | `http` hook | Note |
| --- | --- | --- | --- |
| `SessionStart` | **+0.00 s** | **never** | The defect — see 1.3 |
| `UserPromptSubmit` | *(not registered)* | +0.70 s | Prompt arrived from argv, not typing |
| `PreToolUse` (`Bash`) | +3.22 s | +3.22 s | |
| `PostToolUse` (`Bash`) | +4.07 s | +4.06 s | |
| `Stop` | +5.78 s | +5.78 s | |
| `Notification` | *(not registered)* | +63 s (run 1) | Fires on idle-waiting-for-input |
| `SessionEnd` | +44.73 s | +44.73 s | Only on graceful exit — see 1.4 |

**The two transports fire within ~10 ms of each other**, for every event where both were registered. There is no latency argument for preferring `command` over `http`; pick on ergonomics.

Payloads are byte-identical in shape to the print-mode captures in #2. `PreToolUse` in the interactive PTY **(observed)**:

```json
{"session_id":"deb05d74-…","transcript_path":"C:\\Users\\ahmet\\.claude\\projects\\C--Users-ahmet-Workspace-perseverance\\deb05d74-….jsonl",
 "cwd":"C:\\Users\\ahmet\\Workspace\\perseverance","prompt_id":"e181258f-…","permission_mode":"auto",
 "effort":{"level":"high"},"hook_event_name":"PreToolUse","tool_name":"Bash",
 "tool_input":{"command":"echo probe-marker-alpha","description":"Echo probe marker"},"tool_use_id":"toolu_01JSWQ…"}
```

and `PostToolUse` carries the result, including `duration_ms` **(observed)**:

```json
{…,"hook_event_name":"PostToolUse","tool_name":"Bash",
 "tool_input":{"command":"echo probe-marker-alpha",…},
 "tool_response":{"stdout":"probe-marker-alpha","stderr":"","interrupted":false,"isImage":false,"noOutputExpected":false},
 "tool_use_id":"toolu_01JSWQ…","duration_ms":659}
```

So the finding in #2 §1.3 — that a `Bash` matcher sees the literal `gh` command line, and therefore every issue mutation the agent makes — holds unchanged in interactive mode. **The harness can watch the agent close a ticket in real time.**

The bearer token round-tripped correctly: every POST arrived with `auth=Bearer probe-token-456` **(observed)**. `allowedEnvVars` interpolation works in a PTY session, so the loopback listener can reject anything that is not this run.

### 1.3 `SessionStart` over HTTP does not fire — and it is **not** a print-mode artifact

#2 saw an `http` `SessionStart` hook silently no-fire in `--print` mode and could not tell whether it was print-specific, Windows-specific, or general. This run settles half of it.

Both runs registered `SessionStart` with a `command` **and** an `http` hook in the same block. In both, the `command` hook fired and the `http` hook did not — zero POSTs to `/hooks/SessionStart` across both runs, while `Stop` and `SessionEnd` HTTP hooks in the *same* settings file worked **(observed)**:

```
markers.txt : 1785583397.935  SESSIONSTART_CMD  {"session_id":"deb05d74-…","hook_event_name":"SessionStart","source":"startup","model":"claude-opus-5[1m]"}
hooks.log   : (no /hooks/SessionStart line in either run)
```

**Conclusion: the `SessionStart`-over-HTTP defect is general, not print-mode-specific.** It remains **(unverified)** whether it is Windows-specific.

Consequence for the harness: session start is the one event that must use a `command` hook, or be taken from the in-band stream (section 3), or be inferred from the first `UserPromptSubmit`. Since the harness needs *something* at session start to bind a run to a ticket, this is worth designing around explicitly rather than discovering at integration time.

### 1.4 `SessionEnd` fires on graceful exit, not on kill — confirmed both ways

#2 established that `SessionEnd` does not survive a kill. Both halves are now observed in a PTY:

- **Run 1**, master dropped and child killed at the deadline: no `SessionEnd`, on either transport **(observed)**.
- **Run 2**, `/exit` typed into the TUI at 45 s: `SessionEnd` fired on both transports at +44.73 s, and the child exited cleanly — `exit=Some(0)` **(observed)**, with `"reason":"prompt_input_exit"`.

Typing into the PTY is enough to drive a clean shutdown. `probe` wrote the literal bytes `/exit` followed by `\r` to the master; the TUI accepted them as ordinary input. That confirms #4 §6.4's injection mechanics work for slash commands mid-session, not just for opening prompts.

**PTY exit therefore remains authoritative** — decision 4's "completion is read from issue state, not parsed output" is unaffected — but a harness that *asks* the session to leave gets a clean `SessionEnd` with a reason code, which a kill never produces.

### 1.5 The env leak that silently disables transcript tailing

Run 1 inherited the harness's own Claude Code environment. The TUI said so, in the status area **(observed)**:

```
⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker · restart with CLAUDE_CODE_FORCE_SESSION_PERS…
```

The consequence is not cosmetic. The hook payloads still advertised a `transcript_path`, but **the file at that path was never created** **(observed)**:

```
run 1 session=53883e5f-…    ls: …\53883e5f-….jsonl: No such file or directory
run 2 session=deb05d74-…    -rw-r--r-- 52543 bytes   …\deb05d74-….jsonl
```

Run 2 differed only in calling `env_remove` on `CLAUDE_CODE_CHILD_SESSION`, `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT` before spawning.

This matters more than it looks. Transcript tailing is the **fallback** tier of the signal ladder — the thing that is supposed to work when hooks do not. It fails *silently, while still reporting a path*, if the harness leaks its own markers. A production Tauri harness launched from a normal desktop session will not have these set, so this will never bite in the shipped product — but it will bite every developer who tests the harness from inside an agent session, which is most of them. #4 §5.3 flagged the `env_remove` line; this run shows what it costs to omit it.

**Recommendation:** scrub the marker set explicitly and assert the transcript file appears, rather than trusting `transcript_path`.

---

## 2. Codex: `notify` fires from the interactive TUI

**Answer: yes (observed).** Run 3 spawned the real `codex.exe` in a ConPTY with

```
-c notify=["python","…\append.py","…\markers.txt","CODEX_NOTIFY"]
```

and a one-line prompt as argv. The marker file was created by Codex itself **(observed)**:

```
1785583631.441  CODEX_NOTIFY
```

That closes the question #5 left open. Two qualifications:

- **The payload shape was not captured.** Codex passes its JSON as an appended **argv** element, and the capture script in use for run 3 only read stdin. `append.py` was fixed afterwards to record both, but by then the environment had broken (below), so the payload shape stays **(docs)** rather than observed. The delivery *mechanism* — argv, not stdin — is **(observed)**, and it is the part that matters for the adapter contract: a hook body written for Claude Code will silently receive nothing under Codex.
- **`notify` marks turn completion, not liveness.** Run 4 ended in an API error rather than a completed turn, and `notify` did **not** fire **(observed)**. A harness cannot treat "no notify yet" as "still working" — a failed turn looks identical to a hung one.

**Environment caveat.** Runs 4–7 could not complete a turn on this machine. The `codex`/`codex.cmd` shims were removed from `%APPDATA%\npm` during a reinstall mid-session and never replaced, leaving only a temp package directory holding `codex.exe` 0.130.0, while `~/.codex/config.toml` pins `model = "gpt-5.6-luna"`. That combination returns:

```
{"type":"error","status":400,"error":{"type":"invalid_request_error",
 "message":"The 'gpt-5.6-luna' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again."}}
```

and every model override reachable from a ChatGPT account (`gpt-5.1-codex`, `gpt-5.1-codex-max`) returns `"… is not supported when using Codex with a ChatGPT account"`. This is an artefact of the local install, not a finding about Codex. Re-run the payload capture once the CLI is whole.

### 2.1 Codex cannot be resolved by #4's PE-image heuristic

`resolve_native_exe("codex")` returned `None` **(observed)** — `codex` on PATH is only a `sh` script plus a `.cmd` shim, both of which invoke `node bin/codex.js`, which in turn `require.resolve`s a platform package and re-spawns the real binary. The actual image lives at:

```
…\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\codex\codex.exe
```

— nested one level deeper than the top-level `@openai` directory, and on no `PATH` anywhere. `claude` only resolved cleanly because it ships a native `claude.exe` launcher; that is the exception, not the rule.

**This changes the adapter contract.** #5 already concluded the contract needs `buildInvocation(cwd, prompt) → argv` rather than "append to argv". This run shows the *resolution* half needs the same treatment: **the adapter must return an argv vector, not an executable path.** Pi makes the point unarguable — its only entry point is `node <…>/pi-coding-agent/dist/cli.js`, so no single-path resolver can ever express it.

---

## 3. The unlooked-for finding: in-band terminal signalling

While reading the raw PTY capture for something else, the byte stream turned out to carry a structured event feed of its own. Claude Code emits **OSC 777 notify** sequences directly on the terminal, verbatim **(observed)**:

```
ESC]777;notify;warp://cli-agent;{"v":1,"agent":"claude","event":"session_start","session_id":"deb05d74-…","cwd":"C:\\Users\\ahmet\\Workspace\\perseverance","project":"perseverance","plugin_version":"2.1.0"}BEL
ESC]777;notify;warp://cli-agent;{"v":1,"agent":"claude","event":"prompt_submit","session_id":"deb05d74-…","query":"Run exactly this bash command and then stop: echo probe-marker-bravo"}BEL
ESC]777;notify;warp://cli-agent;{"v":1,"agent":"claude","event":"tool_complete","session_id":"deb05d74-…","tool_name":"Bash"}BEL
ESC]777;notify;warp://cli-agent;{"v":1,"agent":"claude","event":"stop","session_id":"deb05d74-…","query":"…","response":"Done. Output: …"}BEL
ESC]777;notify;warp://cli-agent;{"v":1,"agent":"claude","event":"idle_prompt","session_id":"…","summary":"Claude is waiting for your input"}BEL
```

Observed event vocabulary: `session_start`, `prompt_submit`, `tool_complete`, `stop`, `idle_prompt`, each carrying `session_id`, `cwd` and `project`.

This is a **third rung on the signal ladder**, and in several ways the most attractive one:

- **Zero injection.** No `--settings` file, no loopback listener, no port, no token, no helper script on disk. The harness already reads every byte off the master to render the terminal; parsing OSC 777 is free.
- **It carries `session_start`** — precisely the event the `http` hook fails to deliver (1.3).
- **It is transport-independent.** No firewall, no localhost binding, nothing an enterprise `allowedHttpHookUrls` policy can switch off.

Caveats, honestly stated:

- The payload is namespaced `warp://cli-agent` and versioned `"v":1` — this is an integration surface for the Warp terminal, **(unverified)** as a stable public contract. It could change without notice. Do not make it the only signal.
- It is **not** a substitute for hooks where hooks do work: it has no pre-tool event and no tool *input*, so it cannot see a `gh issue close` command the way `PreToolUse` can. It answers "what phase is this session in", not "what did it just do".
- Whether it can be disabled by config is **(unverified)**.

**Pi** emits a different in-band vocabulary — OSC 133 shell-integration prompt marks (`ESC]133;A`, `ESC]133;B`) and OSC 0 title updates that track the running command (`ESC]0;npm view pi-claude-bridge version`) **(observed)**. OSC 133;A ("prompt start") is a genuine ready-for-input signal. **Codex** emits only OSC 0 title updates, carrying a braille spinner while busy and the bare project name when idle **(observed)** — enough to distinguish busy from idle, and nothing more.

So all three CLIs say *something* in band, but in three different dialects. A "parse the terminal" tier is real, but it is per-adapter work, not one parser.

---

## 4. Readiness detection does not generalise

#4 established alt-screen entry (`ESC[?1049h`) as Claude Code's readiness signal. It does not transfer:

| CLI | Alt-screen? | Readiness signal available |
| --- | --- | --- |
| Claude Code | yes, ~1.0 s under real config | `ESC[?1049h`, then OSC 777 `session_start` |
| Codex | **no** — never emitted **(observed)** | OSC 0 title settling to the project name |
| Pi | **no** — renders inline **(observed)** | OSC 133;A prompt mark |

The adapter contract therefore needs a **`readinessSignal`** member alongside `buildInvocation`. A shared implementation is not available.

---

## 5. Implications for the harness

### Safe to build on

- **The live-update tier survives interactive mode.** `--settings`-injected hooks fire in a ConPTY with the same payloads and timing as `--print`. The signal ladder's middle rung is real, and decision 5 stands.
- **`http` hooks to loopback work from a PTY**, with bearer-token authentication intact. For a Tauri harness this stays the best transport — no helper script, no shell, no Windows path quoting.
- **`command` and `http` fire within ~10 ms of each other.** Choose on ergonomics.
- **`PreToolUse`/`PostToolUse` see the literal `gh` command**, so the harness can watch ticket mutations live.
- **Typed input drives the TUI**, including slash commands, so a graceful `/exit` is available.

### Must be designed around

- **`SessionStart` over HTTP never fires.** Use a `command` hook, the in-band `session_start`, or the first `UserPromptSubmit`. Not print-specific.
- **Adapters must return an argv vector, not a path.** Codex hides its PE image in a nested platform package; Pi has no native image at all. The `resolve_native_exe` heuristic from #4 is Claude-specific.
- **Hook payload delivery is not portable.** Claude Code uses stdin, Codex uses argv. #5's "deliver a completion event" framing is confirmed necessary — an interface, not a shared script.
- **Readiness is per-adapter.** Alt-screen is Claude-only.
- **Scrub `CLAUDE_CODE_CHILD_SESSION`, `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT` before spawning**, or transcript tailing silently dies while still reporting a path.
- **`notify`/`Stop` mean *turn completed*, not *turn succeeded*.** A failed turn emits nothing. Timeouts remain the harness's job.

### Worth a decision

- **Whether to add an in-band OSC tier at all.** It is free, it covers `session_start`, and it needs no injection — but it is an undocumented third-party integration surface, per-adapter, and blind to tool inputs. It belongs in the adapter contract as an optional capability, not as the floor.

### Still open

- Codex `notify` **payload shape**, blocked on a working local install.
- Everything **macOS** — no run on this ticket touched it. Hook delivery is very unlikely to differ, but the resolver and readiness findings above are all Windows-shaped.
- Whether the `SessionStart`-over-HTTP defect is Windows-specific.
- Whether Pi can deliver a completion event at all; its only per-run lever is `--extension, -e <path>` **(observed, `--help`)**, an in-process TypeScript extension rather than a spawned hook.

## Appendix: reproducing

The probe is a three-file cargo project plus two Python helpers, kept outside the repo. Shape:

```
probe <program|abs-path> <deadline-secs> [args…]
  env PROBE_LOG   -- raw pty byte capture
  env PROBE_LATE  -- "<secs>:<text>", types text + CR at a fixed offset (used for "45:/exit")
```

Its two load-bearing details are the `ESC[6n` responder (without it nothing starts) and `env_remove` on the Claude marker variables (without it transcripts vanish). Both are quoted in full in #4 §3.3 and §4.

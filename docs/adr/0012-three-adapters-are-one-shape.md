# 12. Three adapters are one shape, and the two new ones are what the shim gate and the override were built for

Status: accepted (2026-08-08)
Context: [#46 Codex and Pi
adapters](https://github.com/javrasya/perseverance/issues/46), under the spec
[#28](https://github.com/javrasya/perseverance/issues/28). It consumes the
contract ADR 0010 drew and the resolution ADR 0011 drew, and it is the first
ticket to give `perseverance_pty::accept` and #45's override real subjects. The
measurements it leans on are #21's (entry-point shapes, measured on a Mac) and
the CLI parity research (`--help` output from one Windows machine and one Mac,
two days in 2026-08).

## Context

The product must not be shaped like one vendor's CLI. With one adapter in the
tree that was a claim about intent; with three it is a claim that can be checked,
and the checking is the point of this ticket.

Three facts about the shipped CLIs settle most of it. All three — Claude Code,
Codex and Pi — take **one plain-text opening prompt as an argv positional** and
stay interactive; that is observed for each. `claude` is a native Mach-O image.
`codex` and `pi`, installed the way both research machines installed them, are
not: `codex` on macOS is `#!/usr/bin/env node` script text that spawns a vendored
native image as a child, and the nested platform package is not a Windows
artifact but the universal shape; `pi` is a symlink to `.../dist/cli.js` behind
the same shebang. On Windows both are `.cmd` shims.

`perseverance_pty::accept` refuses `#!` as `ScriptShim` and `@` as `BatchShim`.
So **both new adapters resolve to programs the shim gate refuses, on both
platforms**, while the one previously shipped adapter never touched that path.
#21 measured what the refusal is protecting against: `zsh -lc` resolves
`/usr/local/bin/codex`, which then dies `env: node: No such file or directory`,
exit 127.

## Decision

**One shape for all three.** Each adapter plans `[program, prompt]` — two
elements, identical on both platforms modulo the program the harness resolved.
Each states `TERM=xterm-256color`, the same value, because the terminal type is a
fact about the PTY *this harness* presents and not about a vendor. Each takes the
default `watch`. What is allowed to differ between adapters is declared and only
declared: candidates, per-platform probes, a scrub set, a readiness rule.

**Four flags are declined, deliberately and across the board.**

1. **No `-C/--cd` for Codex**, though it is the only surveyed CLI that has one.
   The child's working directory is a spawn parameter; a `--cd`-style flag is an
   adapter-internal detail that could disagree with the process it is set on.
2. **No `@file` for Pi.** Semantics travel inline, never by pointer. An absolute
   application-data path is exactly what a sandboxed agent refuses, and it
   refuses it as a mid-run permission prompt rather than as a clean error.
3. **No multi-positional prompt for Pi.** `pi "a" "b"` is accepted and labelled
   *multiple messages*, but whether those become successive turns or one
   concatenated message is unknown and flagged in the research as needing an
   empirical test. An adapter is not the place to bet on it.
4. **No trust, approval, alt-screen or offline flags** — `-a never`,
   `--no-alt-screen`, `--approve`, `--offline`. ADR 0010 declined
   `--dangerously-skip-permissions` for Claude as *a policy this ticket did not
   decide*, and the same reasoning holds three times over. Declining the same
   class for all three is what makes the behaviour identical; picking them per
   vendor is what would shape the product like three vendors' CLIs.

**The scrub sets are asymmetric, and the asymmetry is the finding.**

*Codex scrubs nothing*, and the empty set is a measurement rather than a gap. No
environment variable in this repo's evidence can suppress a Codex session record:
transcripts land at `$CODEX_HOME/sessions/**/rollout-*.jsonl`, suppression is
`codex exec --ephemeral` (a flag, and `exec`-only) and `history.persistence` (a
config key), and no nesting marker of the `CLAUDE_CODE_CHILD_SESSION` kind is
recorded anywhere. For Codex the risk runs the other way: the tempting variable,
`CODEX_HOME`, is the one that must not be touched.

*Pi scrubs three names*, and every one is a statement about a session that is not
this one: `PI_CODING_AGENT` (set on every child, the documented *you are inside
pi* marker), `PI_SESSION_ID` and `PI_SESSION_FILE` (a pointer at the **parent's**
transcript). A harness launched from inside pi's own bash tool carries all three,
and this project's whole workflow is agents running commands.

**The not-scrubbed list is the more important half**, and it is written into the
adapters' doc comments rather than left implicit:

| Left alone | Why |
| --- | --- |
| `CODEX_HOME` | Relocates the sessions directory *and* `auth.json` in one move |
| `PI_CODING_AGENT_DIR` | Same, for pi — `auth.json` lives there |
| `PI_CODING_AGENT_SESSION_DIR` | The operator's chosen session directory, one underscore from `PI_SESSION_FILE`, which **is** scrubbed |
| `CLAUDE_CONFIG_DIR` | Moves credentials, plugins, history *and* transcripts; Claude's set stays exactly one name and does not widen to the `CLAUDE_*` family |
| `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL` | Plausibly things an operator exports as their own defaults |
| The `*_API_KEY` family | The environment is the operator's; the delta may say what this run is, never who they are |

The line drawn is: **scrub a pointer at another session, leave anything that
could be a preference.**

**The four PowerShell profile-path variables are never injected — and now never
scrubbed.** `crates/env/src/shell.rs` is explicit that PowerShell 5.1 derives
`$PROFILE` from `USERPROFILE`, `HOME`, `HOMEDRIVE` and `HOMEPATH` rather than
from the registry, so *scrubbing* one of them loads a different profile, or none,
exactly as overriding it does. The existing guard inspected `env_add` alone; a
scrub set containing `HOME` would have passed every test in the tree. #46 added
the `env_remove` half.

**Criterion 1 as written is not literally satisfiable, and was already inaccurate
against #44 as shipped. This ADR proposes an amendment; it does not claim the
criterion is met.** *One file, one variant, one match arm* — but the shipped
registry already had two wildcard-free match arms (`AgentId::as_str` and
`registry::agent`), a hand-written `ALL`, and a `static` per adapter. Nothing in
this branch records criterion 1 as satisfied, and the registry's own doc comment
says so at the point somebody adding a fourth adapter will read it.

**The measured cost, after removing the part of it that was not registration.**
An adapter is one new file in `crates/agent/src/`, plus **two files touched**:
one `mod` and one `pub use` in `lib.rs`, and in `registry.rs` a variant, an `ALL`
entry, an `as_str` arm, an `agent` arm and a `static`. Every one of those but the
`pub use` and the `ALL` entry is a compile error naming the missing thing; the
`ALL` entry is caught by this file's own wildcard-free match, which the compiler
names the day a variant appears.

`crates/app` was a third file and is not one any more. Its purity scan held a
hand-written list of `crates/agent/src`'s files — nine `include_str!` lines, a
tenth per adapter — and #46 replaced the list with a read of the directory,
following `crates/model/src/bindings.rs`, which already walks its fixture
directory from `CARGO_MANIFEST_DIR`. That is a strict improvement independent of
the criterion: a list of the haystack was never registration, it was a second
place to forget the same file, and the set comparison against the crate's own
`mod` declarations now catches the opposite failure — a file on disk that no
`mod` compiles, read here as evidence.

A dependency-free `macro_rules!` registry *would* make it literally one line and
was **rejected**: it discards the property ADR 0010 explicitly paid for —
*forgetting the arm is a compile error naming one function* — to satisfy prose
written before #44 landed, and it makes the registration mechanism ungreppable in
a codebase whose entire house style is explicit hand-written declaration. The
defensible restatement, **which needs ratifying on #46 rather than assuming**:
registration is one new file, one variant and one arm per lookup, plus the four
supporting lines above, and all but two of them fail the build by name.

## Consequences

**Criterion 5 stopped being vacuous and is now held by real code.**
`crates/app`'s `adapters_in` — written at #45 against one adapter — loops
`AgentId::ALL`, resolves through `locate_in`, and selects probes with
`probes.on(Platform::host())`. It picked up two more adapters **without a line
changing**. That it needed no edit is the evidence, and the app tests were
rewritten to assert against `AgentId::ALL` by id rather than against index 0, so
a future adapter cannot be quietly excluded by a positional assumption.

**Pi is the first producer for per-platform `Probes`.** That type landed at #45
with no adapter declaring different lists; pi now declares `node --version` on
unix and `node --version` plus `bash --version` on Windows, because pi requires a
bash shell there and its `bash` tool fails at *runtime* rather than at startup.
It is a probe and not a `PlanError::NotOnThisPlatform` because pi does run on
Windows — the requirement is made inspectable, which is ADR 0011's posture, and a
plan-time refusal would also have made a Windows golden unwritable. The `bash`
probe is a **bare name** resolved against the folder's `PATH`, never the vendor
docs' hardcoded install directory, which is what ADR 0011 refuses.

**A declared probe now reads *not on this PATH* on a perfectly good install.** A
Homebrew or standalone-release Codex is a native image with no `node` behind it.
ADR 0011's inspectable-not-detected posture covers it and the resolved absolute
path sits beside it, but the panel copy has no sentence saying *a probe that
answered nothing may be fine*. Worth one line of copy in a later ticket.

**Both new adapters will be refused by `accept` on a stock npm install, and
nothing spawns yet to prove it.** That is the designed loud failure, and #45's
argv override is the answer — an operator whose install is an npm shim has no
single file to point at that is also a native image, which is why the override is
a vector. The path stays untested end to end until #47. What has changed is that
there is now something to test it with.

**The override is app-global and now visibly applies to all three at once.** #45
decided one row and one key with one adapter in the tree, where that was
invisible; at three it reads like a bug unless the panel says so, so the panel
says so. A per-adapter key is a different decision and not this ticket's.

**The closed state of the folder panel stopped being adapter zero.** It was
`readout.adapters[0]`'s own line — positional rather than an identity branch, and
accurate while one adapter shipped. At three it hid two thirds of the panel, so
it counts instead.

**`missingCli()` became an `every`, because at three adapters `some` is a nag.**
The first cut of this ticket left it as *any adapter resolved to nothing* and
recorded here that it had no consumer. **That was wrong on both counts.** It is
consumed: `App.tsx`'s `settleFolder` calls it on every folder resolution and
raises the `cliMissing` note from it, which `FolderList` renders under *Not on
this folder's PATH*. And at three adapters *any of three* is true on every
machine that has fewer than all three CLIs installed — nearly every machine — so
an operator with only Claude got a permanent error beside every folder saying
codex and pi are not on the PATH. That is precisely this ticket's own failure
mode inverted: the two new vendors bolted on so loudly they nag about
themselves.

It now means *no agent at all answers on this folder's PATH*, and an empty
adapter list is not a missing CLI. That is the reading that cannot be wrong
before there is a picker: what the note wants to say is *the adapter this
crossing picked resolved to nothing*, nothing on the readout says which adapter
this folder selected, and predicting that rule in TypeScript would be the
WebView deciding something Rust owns. The predicate can only get narrower when
the crossing lands.

No test caught it because every fixture state was all-resolved or all-notFound —
the mixed state, which is the real-world one, was not represented. It is now:
`partlyResolved`, one resolved and two not, asserted to raise no note.

**`Ready::Quiet`, `PlanError::NotOnThisPlatform` and `Signal::Idle` remain
producerless.** All three adapters declare `AltScreen`, none refuses a platform,
and all three take the default `watch`. That is deliberate and is what keeps
criterion 5 true rather than merely stated. Pi was the obvious candidate for a
real `Watch` producer and is deliberately not one: v1 cuts the out-of-band tier,
and a live signal can only mean *poll GitHub sooner*.

### Inherited unknowns

Recorded so the next reader inherits them rather than rediscovering them.

**Neither new adapter's readiness is measured.** Codex's alternate-screen-by-
default is observed but its time-to-alt-screen is not; Pi's alternate screen is
*inferred* from *full TUI* and was never seen. Both declare Claude's ten seconds,
which is ~45× a 223 ms measurement belonging to a different program. The constant
is per adapter and deliberately not hoisted, so either can be tightened alone.

**No Codex nesting marker has ever been looked for.** The research measured
`--help`, config files and session files; nobody has diffed the environment
inside a codex child. So *Codex has no nesting marker* is an absence of evidence,
and the empty scrub set rests on it. One measurement closes it, and it is worth a
research ticket rather than a guess: every other adapter fact in this tree is
traceable to `docs/research`.

**Whether pi reads its three session variables at startup is undocumented.** The
shipped docs say pi *sets* them for children; they never say pi reads them.
Scrubbing was chosen as the direction that cannot be wrong, but this scrub set is
inference where Claude's is measurement, and the doc comment says so rather than
blurring the two.

**The declined flags are a policy somebody should ratify.** The concrete
consequence: a first run in a fresh worktree will sit on Pi's trust modal until
the ten-second expiry, and Codex's project-local config will be silently ignored
in an untrusted worktree. Note the asymmetry — Codex's trust failure is *silent*
and Pi's is *loud*, so Pi is the adapter that will actually exercise the timeout.
Both are #50's to diagnose. If somebody wants those flags set, that is a decision
to take deliberately, not to smuggle into an adapter.

**The `pi` name collides.** It is `pi`, observed twice, and it is also a common
name for unrelated binaries. A candidate list cannot disambiguate; the only place
an operator sees *which* `pi` resolved is the absolute path in the per-folder
readout. That is an argument for keeping that row prominent, not for adding a
second candidate.

**The goldens rest on two machines and two days.** Exactly as README and ADR 0010
already record for Claude: a release that moved a prompt behind a flag leaves
every test here green. Inherited, not introduced.

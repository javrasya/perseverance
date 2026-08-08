# 10. The adapter contract is four members and a value, and the shim check is a type

Status: accepted (2026-08-08)
Context: [#44 the adapter contract, and the Claude Code
adapter](https://github.com/javrasya/perseverance/issues/44), under the spec
[#28](https://github.com/javrasya/perseverance/issues/28). It fills the
`crates/agent` half of the boundary ADR 0002 drew when it moved the environment
harvest out of this crate, produces the `Signal::Idle` ADR 0009 predicted and
this ticket then declined to produce, and puts a check in front of the spawn
#47 will write. `docs/research/pty-spawn-agent-clis.md` is where every measured
number below comes from.

## Context

An agent CLI is a program, a prompt and a terminal, and the tempting shape for
that is a driver: something that finds the program, spawns it, waits for it to
be ready, types into it, watches it, and decides when it is done. Every one of
those verbs is a place a second adapter has to reimplement a policy, and four of
them need a running process before anything about them can be checked.

Three things made the tempting shape worse than it looks.

**Claude Code takes its opening prompt as a positional argument.** `claude
[options] [command] [prompt]` starts an interactive session with that prompt,
and slash commands work through it — `claude "/help"` painted the help panel
under a real ConPTY with no keystrokes injected, while `claude -p "/help"`
answered *not available in this environment* **(observed)**. So the operation
the driver shape exists for is not an operation at all.

**Readiness is a measurement, and it is the harness that can take it.**
`ESC[?1049h` arrives at ~223 ms, emitted by the app rather than by ConPTY,
immediately before the TUI paints. An adapter that timed that would need the PTY
the harness owns.

**A shim is not a program.** npm installs `claude.cmd` on Windows; spawning
through it interposes `cmd.exe`, so `child.kill()` orphans the agent and the
exit code is the shim's. Beside it npm leaves two more — an extensionless POSIX
shim that Windows matches by name and cannot run (`os error 193`), and
`claude.ps1`, the one `Get-Command claude` reports and `where.exe` does not
**(observed)** — and a WindowsApps execution alias is a zero-length reparse
point. All four are things that look like the program right up until the tree
is orphaned, and all four are found by whoever spawns — not by whoever planned.

## Decision

**Four members, and a value.**

```rust
pub trait Agent: Sync + 'static {
    fn id(&self) -> AgentId;
    fn discovery(&self) -> &Discovery;
    fn plan(&self, cx: &LaunchContext<'_>) -> Result<Launch, PlanError>;
    fn watch(&self) -> Box<dyn Watch> { Box::new(NoWatch) }
}
```

An adapter names itself, says what to look for, plans, and optionally classifies
bytes. It does not spawn, wait, inject or decide it is done. *The adapter is not
a driver* is not a doc comment: there is no member on which it could be one.

**`plan` is pure by signature, not by promise.** `&self`, no `async`, no future
in the return type. `LaunchContext` derives `Copy`, and that derive is the
enforcement — `File`, `TcpStream`, `Sender`, `Command` and `Box<dyn Fn>` are
none of them `Copy`, so the day someone adds a field a plan could write through,
the crate stops compiling. The environment arrives as `&[(&str, &[u8])]` rather
than as a closure for the same reason: a closure can close over a socket, a
slice cannot close over anything.

`Copy` only rules out the writes, and that is not the whole of purity. A
`&Path` field is `Copy` and carries `exists`, `metadata`, `read_dir`,
`canonicalize` and `read_link` as *inherent* methods needing no import at all,
so `cx.program().exists()` would have compiled, done syscalls, and named nothing
any scan of the source could see. The two directory-shaped fields are therefore
`Program<'a>` and `Cwd<'a>`, newtypes over `&OsStr` with `as_os_str`, `Display`
and no `Deref` — the harness converts on its own side of the boundary, and the
adapter side never holds a value with a filesystem method on it. Nothing handed
to `plan` can write, and now nothing handed to `plan` can read either.

**No fifth *required* member is enforced by a double.** `agent.rs`'s test module
implements three members and inherits the fourth, so a fifth member without a
default body would stop that file compiling. A fifth member *with* one would
not: nothing counts the members, and an optional one is caught by review rather
than by the compiler.

**Criterion 7 — nothing can express a write to global config — is three
properties and a test, in the order a reviewer should walk them.** The output
has nowhere to put one: `Launch` is argv, an environment delta and a readiness
rule, with private fields, no setter, and `PartialEq` so a golden test compares
the *whole* value rather than the fields somebody thought of. The input has
nothing to write through: `LaunchContext` is `Copy`, its paths are `Program` and
`Cwd`, `Discovery` is `&'static` throughout, and a `Watch` takes `&[u8]` and
answers `Option<Signal>`. And the escape hatch is closed mechanically:
`crates/agent` has no dependencies, so `std` is the only tool in scope, and a
test in `crates/app` reads every source file in the crate and fails the build
unless every `std` path they name is one of `ffi`, `fmt`, `time` and `error`.

That last one is an **allowlist, and the first version of it was not** — it was
six forbidden substrings, `"std::fs"` and five like it, which a brace-grouped
import walks straight past. `use std::{env, fs};` contains none of the six, and
`fs::write(global_config, bytes)` after it passes the scan, passes
`check:agent-solitude`, and compiles. An allowlist cannot be got round by import
syntax, because every route to a module of `std` in a crate with no dependencies
has to name it after `std::` somewhere: the scan strips comments, then reads the
segment after each `std::`, walking a brace group at its own depth so
`std::{path::Path, env::var}` reports two modules and not zero. `use std as
anything;` reports `std` bound whole, which is not on the list either.

Two things the allowlist cannot see are refused beside it by *token*, since
neither has a path for a reader over paths to walk. Prelude macros that reach
the **build** machine: `env!`, `option_env!`, `include_str!`, `include_bytes!`
and `include!`, the last of which reads the same disk and then splices what it
finds in as code. And names in `std::time` that read a **clock**:
`SystemTime`, `Instant` and `UNIX_EPOCH` — `time` is on the allowlist whole
because `Duration` lives there, so a plan that asked the wall clock would name
only a permitted module and stop being the same launch for the same context.
Both lists are named tokens *among others* and neither is a proof: `include!`
and `UNIX_EPOCH` were each absent at first and each passed the whole scan, and
what would make either list closed is an allowlist over the names inside a
module, which a reader over text cannot express. The `time` entry is the one
knowingly soft place in the allowlist, and it is recorded as such rather than
counted.

The scan is itself put through known-bad input as well as good — bypassing
imports, clock reads that name only `time`, build-machine macros that name no
module of `std` at all — for the reason `check:agent-solitude` puts known-bad
`cargo tree` output through its verdict function: a check that passes is not
the same as a check that works.

Per-run configuration is therefore argv and environment as a *property of three
types*, rather than as a rule anyone has to remember. Forbidding the environment
module is the sharp exclusion — an adapter that read `HOME` from its own process
would be planning against a launchd stub rather than against what
`perseverance-env` harvested for the folder — and forbidding `path` is the quiet
one, since a path is the single value in `std` that does filesystem I/O through
inherent methods and so the single one that could have got in while naming
nothing.

**The platform is a parameter, never a `cfg!`.** `Platform::host()` is the only
`cfg!` in the crate and an adapter is handed the answer. #44 asks for a golden
argv *per platform*, and a `cfg`-gated golden is a golden that is checked on one
of the two runners; a parameter is checked on both from either. Two variants,
not three: macOS and Linux differ nowhere in argv construction, and
unix-versus-Windows is the axis every measurement was actually taken against.

**Ready is declared and Signal cannot say `Completed`.** `Ready::AltScreen` and
`Ready::Quiet` say which rule applies; the harness runs the clock. `Signal` has
three variants and no payloads, because a live signal means exactly one thing —
poll GitHub sooner — and is never evidence in its own right. There is no
`Completed`, and the absence of the variant is what enforces that completion is
a GitHub state transition: a rule in a doc comment is a rule someone adds a
variant next to.

**Registration is a closed enum and a lookup.** `AgentId`, one variant, one
match arm with no wildcard, one golden-argv test. The set of adapters is a fact
about the binary rather than about the order modules happened to initialise in,
and forgetting the arm is a compile error naming one function.
`AgentId::ClaudeCode` spells itself `"claude"` because that string is already in
`folders.adapter`, already under the `default_adapter` app key and already
crossing to the WebView; a registry that spelled it more nicely would be a
migration. Config-defined adapters are deferred, not refused — a later
`AgentId::Configured(..)` costs the shipped adapters nothing. What is refused is
a registry whose contents are not knowable at compile time.

**The shim gate is a type in `crates/pty`, not a check in `plan`.**

```rust
pub fn accept(launch: Launch) -> Result<Accepted, SpawnRefusal>;
```

`Accepted` has private fields and `accept` is its only constructor, so #47's
spawn takes an `Accepted` and the check cannot be routed around. The rule is a
positive allowlist of native-image magics read from the file's first bytes — `MZ`,
`\x7fELF`, the Mach-O set — and everything else is a shim, including `#!`, `@`
and a zero-length file. A blacklist of filenames can miss; an allowlist of
shapes cannot. It catches all four forms above without naming a single filename,
and it accepts the symlink the native installer ships, because `File::open`
follows links and reads the real image at the end of one.

**The Claude Code adapter is two argv elements.** `[program, prompt]`,
`CLAUDE_CODE_CHILD_SESSION` scrubbed, `TERM=xterm-256color` set,
`AltScreen { timeout: 10s }` declared — identical on both platforms modulo the
program, and the test asserts that identity *as a property*, so the day an
adapter needs a real platform branch the claim fails on whichever runner is
already there. It takes the default `watch`, which makes the shipped adapter
itself the proof that no call site branches on whether an adapter produces
signals.

## Alternatives

**A fifth member: `capabilities()`.** The whole out-of-band tier is cut from v1
— loopback listener, port, nonce, bearer token, hook-config injection, Codex
`notify`, all verify-then-degrade machinery, the transcript tier. A capability
type exists to decide what to degrade to, and there is nothing to degrade from,
because polling never stopped. It would have been a member every adapter
answered the same way and no call site could act on.

**A `Completed` signal.** Cheap to add, and it would mean the app had two
accounts of whether a ticket was done — one from GitHub and one from a regex
over terminal bytes — with nothing to reconcile them when they disagreed.
Claims only ever decay, and absence of an event is not evidence.

**An `inject_prompt` operation.** It would be a method the shipped adapter
implements by doing nothing, because the prompt is a positional argument; a
second adapter that needed keystrokes would then be typing into a PTY the
adapter does not own, which is the driver shape again.

**Shim rejection inside `plan`.** It reads a file, so `plan` would stop being
pure and the byte scan above would have to allow the file module back in — and
every adapter would have to remember to do it. The check lives at the boundary
precisely so it is not remembered per adapter.

**`cfg`-gated goldens.** One golden per runner, each unchecked on the other, and
a Windows argv nobody on a Mac can break. Rejected for the parameter.

**`Send + Sync` on `Agent`.** Only `Sync` is needed: the registry hands out
`&'static dyn Agent` and nothing ever owns one, because nothing ever moves one.

## Consequences

`crates/agent` still depends on nothing, and now has to keep doing so with an
adapter in it. `PlanError` is a hand-written `Display` and `std::error::Error`
while `SpawnRefusal` next door derives them with `thiserror`, because
`crates/pty` is allowed dependencies and this crate is not. That asymmetry is
the price of the solitude check, and it will be paid again at #46.

The byte scan is a list of filenames, which is exactly the kind of list that
rots. It now checks itself against the crate's own `mod` declarations — and the
first time that check ran, it failed: `watch.rs` had never been in the list. A
file added to `crates/agent/src` without a line in the scan is a failing test
rather than a quiet hole.

The guard is a comparison of *name sets* and not of counts, because the count
form of it was quietly satisfiable. `modules_declared_in` read `mod ` behind an
optional visibility and nothing else, so `#[cfg(windows)] mod
platform_windows;` counted as zero, `declared + 1 == AGENT_SOURCES.len()` went
on holding, and the new file was never read for `std::fs` — two errors
cancelling inside one subtraction. A set has no arithmetic for them to cancel
in and it names the file that is on one side and not the other; the reader
strips leading attributes as well as visibility, which closes the spelling that
found the hole. What the set form does not model is `#[path = "elsewhere.rs"]
mod name;`, where the module's name and the file's differ on purpose: that
fails the guard rather than passing it, which is the safe direction to be wrong
in.

`crates/pty`'s scan has no equivalent guard and its two-file list is still a
list; README records it.

The allowlist is a reader over text and not a parse tree. It strips comments
with a hand-rolled scanner that does not know raw string literals, and it lets
`println!` through — I/O in a function documented as doing none. Neither is a
route to the operator's config, both are visible where a filesystem read would
not have been, and both are the sort of thing a lint would catch better than a
scan. The `&Path`-shaped hole it replaced was none of those things.

The shim gate has no consumer. Nothing spawns until #47, so `accept` is a
constructor nobody calls outside its own tests. That is the shape it was built
for — a type is a boundary whether or not anyone has walked through it yet — but
it means the *routing-around* it prevents has never been attempted.

`Signal::Idle` has a type and no producer, and now for a reason rather than for
a gap. The shipped adapter classifies nothing, so the poller's idle poke is
unreachable in a running build; #46 and #50 are where a producer could arrive.

Nothing in CI ever spawns `claude`. The golden argv is checked against
`claude --help` as recorded in `docs/research/pty-spawn-agent-clis.md`, and that
recording is a snapshot of one machine on one day. A future release that moved
the prompt behind a flag would leave every test here passing.

`--dangerously-skip-permissions` is not set, and that is a decision this ticket
declined to make rather than one it made. A first run in an untrusted directory
will sit on the trust modal until the ten-second `AltScreen` timeout expires,
and diagnosing that expiry as *something is waiting for the operator* is #50's.

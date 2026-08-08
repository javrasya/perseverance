# 14. A quit is one confirmation and one deadline

**Status:** accepted, #51

## Context

[#51 quitting: one confirmation, clean shutdown, no
orphans](https://github.com/javrasya/perseverance/issues/51), under the spec
[#28](https://github.com/javrasya/perseverance/issues/28). It takes what
[ADR 0013](0013-lag-drop-cannot-mean-dropping-bytes.md) handed over in its own
closing sentence — *how a run ends, and how a quit ends every run* — and it
inherits two constraints it does not get to revisit:
[ADR 0002](0002-the-environment-harvest-is-its-own-crate.md) drew the line
between a *session* and a *measurement* and scoped this ticket's *no orphans*
to the first kind, and refused a `libc` process-group kill on the way past;
[ADR 0010](0010-the-adapter-contract-is-four-members-and-a-value.md) fixed the
adapter contract at four members and recorded what a `.cmd` shim does to a
process tree when the thing you kill is not the thing that is running.

The ticket states the mechanism in one line: close the PTY master so the child
gets EOF, wait two seconds, then tree-kill via the job object. Read literally,
that sequence is a no-op on one platform and a hard kill on the other.

`ConPtyMasterPty` holds the `PsuedoCon`, and `impl Drop for PsuedoCon` is
`ClosePseudoConsole`, which terminates every process attached to the
pseudoconsole — measured, at eighteen processes, in
`docs/research/pty-spawn-agent-clis.md` §8.1. The slave is dropped immediately
after the spawn, so on Windows the session's master is the last holder and
dropping it *is* the kill. A grace period after that is a wait for corpses.

`UnixMasterPty` hands out `dup`s: one to the drain thread's reader, one to the
writer. Dropping the session's own master closes one of three descriptors and
delivers nothing at all while the drain thread is still blocked in `read` on
its own — which is the reason `Session::drop` already kills the child first and
says so.

So the word *master* names two handles that mean opposite things, and the
sequence has to be stated in terms of the handles rather than the word.

## Decision

**A quit is one question, one clock, and a kill that consults nothing.**

**The master has two ends, and neither of them is the same thing on both
platforms.** The write end is what a quit releases: on unix it is a `dup` of the
master fd whose `Drop` writes `\n` and the terminal's `VEOF` into the line
discipline — a request a child may read or ignore — and on Windows it is the
pseudoconsole's input pipe closing, which the console host answers by breaking
the console session. That second one is not a request. **Measured on this
repository's own harness**: a run of `ping -n 31`, a child that never reads its
input at all, is over inside a tenth of a second with `STATUS_CONTROL_C_EXIT`.
So the asking is an end-of-file on unix and an interrupt on Windows, and the
grace behind it is in practice a unix mechanism. `Session::hang_up` still
**deliberately keeps the read end**, because dropping the master is
`ClosePseudoConsole` — an unconditional terminate of every attached process —
and an interrupt a child may answer is not the same offer as one it may not.
That is a weaker reason than *the grace would be a wait for corpses*, and it is
the true one. It is also, honestly, one **no test in this crate can pin**:
releasing the read end as well produces the same observable ending on both
platforms — a dead tree on Windows, nothing at all on unix — so the difference
is in what the child was given the chance to do and not in what can be asserted
about it afterwards.

`hang_up` `try_lock`s the writer and skips a session it cannot take. The drain
thread holds that same lock across a blocking `write_all` into the child's
input, and a child that has stopped reading can hold it shut; a quit that waited
there would never reach its own deadline, let alone the kill. The asking is the
phase allowed to fail, because a run that was never asked and a run that refused
are handled identically by the two phases after it.

**The grace is one deadline across the quit and not one per run.**
`Runs::shut_down` takes a single `Instant::now() + GRACE` **before** it hangs
anything up, then hangs up every session, polls at 25 ms and breaks the moment
every run reports `over`. Four terminals cost one grace, not four; an app that
takes eight seconds to close is an app that looks hung, and a run that has
already ended is not owed any of it. The clock starting before the asking is
what keeps the bound honest: no phase of a quit can push the kill past it.
`GRACE` is two seconds and is a labelled guess with its basis and its revisit
trigger in its own doc comment, and again in the README's *Honest limits*.

**The kill is `Session::drop`, and it is the owned child's kill rather than a
cloned signaller's.** The third phase is `Runs::close_all`, which drops each
session; the field order in `Session` is load-bearing and is not reordered to
match the new sequence. On Windows that is `TerminateProcess` on the direct
child, then `ClosePseudoConsole` taking the tree, then the `Guard`'s job object
closing behind it with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.

On unix it is `SIGHUP`, five 50 ms looks at the child, then `SIGKILL` — and
which of the two spellings is used decides whether that sentence is true.
`portable-pty`'s `clone_killer` returns a `ProcessSignaller` whose unix `kill`
is one `libc::kill(pid, SIGHUP)` and nothing else; the escalation lives on `impl
ChildKiller for std::process::Child`. #47 kept the cloned killer and moved the
owned child into the thread that waits on it, so the escalation was documented
and unreachable, and a direct child that traps `SIGHUP` would have survived the
app outright — the kernel's hangup does not cover for it either, because the
drain thread holds a `dup` of the master, so this side dropping its own copy
closes nothing. So `Session` now keeps the child behind an `Arc<Mutex<..>>` and
the wait thread polls `try_wait` at 25 ms instead of owning it. The price is a
poll rather than a block, and up to a quarter of a second in `Drop` for a child
that ignores the hangup; the return is that *no process survives the app* is
about a mechanism the code has.  After the leader is gone the kernel hangs up
the controlling terminal's foreground process group, which is the platform's own
answer to the job object and the one ADR 0002 pointed at rather than reaching
for `libc`. `Drop` stays the backstop and keeps working on the paths where
nothing gets to run at all, which is the guarantee that must not be traded for a
tidier orderly path.

**No adapter is consulted at any phase.** Nothing in hang-up, grace or kill asks
what is running: the first is a handle lifetime, the second is a clock, the third
is the operating system. `trait Agent` stays at `id`, `discovery`, `plan` and
`watch`, and `crates/pty` learns no product vocabulary — the byte scan in
`crates/app` still holds over every file in that crate, because no file was
added to it.

**What each run loses is named in `crates/app`, from a side table.** A `Run`
carries a `RunId` and nothing else, on purpose. `Terminals` keeps
`BTreeMap<RunId, Stakes>` beside the registry — a ticket, a folder, and whether
the run is work or research — because a ticket number is product knowledge and
the byte scan exists to keep it out of the crate that owns terminals. A work run
loses the run and not the claim: the claim is a GitHub assignment this process
does not hold, so the next launch reads it back as a claimed node with no live
run beside it. A research run keeps nothing. **A live run with no row in the
table is still named**, as one this app cannot describe — a confirmation that
quietly omitted a run would under-report exactly when the app is most confused.

*Work or research* is not a third vocabulary. `TicketType` in `crates/model` is
the noun this repository already has, and `Attendance` in
`src/views/route/route.ts` is the same one-bit split of it the frontend already
draws — its own comment calls itself *a rule with exactly one home*. `RunKind`
is that home's Rust half, and `RunKind::of(TicketType)` is the mapping, written
once so #48 calls it rather than writing it a second time.

**One confirmation, and the operating system asks it.** One dialog however many
runs are live, for the same reason the grace is one deadline: a question asked
four times is a question answered without being read. It is shown through
`tauri_plugin_dialog`'s `blocking_show`, in Rust, on a thread of its own — the
event loop is the thread that has to draw the box, which is why `choose_folder`
is already `#[tauri::command(async)]`. Answering in Rust also means
`capabilities/default.json` is not widened: the WebView calls no plugin command,
so it is granted no plugin permission. The gate is three states — not asked,
asking, confirmed — read by a pure `on_close` so that the two ways of getting it
wrong, an unquittable app and a confirmation that is skipped, are testable
without a window.

**The question is asked on the close request, and never on `ExitRequested`.**
This is the load-bearing correction to the obvious design. `tauri-runtime-wry`
emits `RunEvent::ExitRequested` from tao's `Destroyed` arm — the window has
already been torn down by then, and `on_close_requested` ran before it — so a
confirmation asked there with `prevent_exit` would answer *Keep working* with a
headless process holding every PTY, every agent still burning rate limit, no
terminal reachable and nothing to close but Task Manager. That is precisely the
failure the `Guard` exists to survive rather than a state to route an operator
into. So `WindowEvent::CloseRequested` asks, `prevent_close` keeps the window
that the answer is about, and `ExitRequested` is left as shutdown only.

**macOS is given a menu of this app's own, because its quit reaches no window.**
`[NSApp terminate:]` — the default menu's Quit item, `Cmd+Q`, the Dock — is
answered by tao's `applicationWillTerminate:`, which becomes `LoopDestroyed` and
then `RunEvent::Exit`; `applicationShouldTerminate:` is not implemented, and no
`CloseRequested` and no `ExitRequested` happen anywhere in it. Left alone, macOS
would quit with no confirmation and no shutdown at all — two of the five
criteria unmet on one of the two platforms named. So the builder declines
`enable_macos_default_menu` and installs the same menu minus the predefined Quit
and plus one of ours, whose handler is the same `may_quit` the window uses. The
Dock's Quit still goes straight to AppKit, which is why `RunEvent::Exit` runs
the shutdown too: it is the only event that path delivers, and running the
shutdown twice on the ordinary path costs nothing because the second one has an
empty registry.

**Three doors, one gate.** The window's close button, macOS's Quit item, and the
confirmed dialog's own `exit` all go through `may_quit`, which takes **one**
snapshot of the runs and decides on its length. Counting the live runs and
naming them used to be two reads with the lock released in between, and a child
that exited between them produced *0 runs are still live* with nothing named
under it — a confirmation about nothing, which is the thing the `(0, _)` arm
exists to prevent. The `Asking` state is released from a `Drop`, so a panic
inside `blocking_show` cannot leave an app that refuses every subsequent quit.

**The frontend's anti-modal rule is untouched, because it is about something
else.** *No modal* in this repository is a rule about **conditions on the graph**:
a stale read, a revoked token, a rate limit — states the app discovers and the
operator did not ask about — which render inline, next to the thing they are
true of, and never as an overlay that has to be dismissed before the app can be
used. `tests/dev-web.test.tsx` pins that as zero `[role="dialog"]`,
`role="alertdialog"` and `aria-live="assertive"` nodes across every fixture. A
quit confirmation is the opposite kind of thing: the operator initiated it, it is
about the request they just made, and there is no inline surface it could belong
to because the surface is what is closing. It belongs to the window manager's
idiom rather than to the chrome's, and it is not in the chrome at all — no
TypeScript changed, so those assertions hold by construction rather than by
exemption.

**Nothing about a run is written down.** No store table, no serialised session,
no run id on disk — `nothing_about_a_run_is_written_down_when_the_app_quits`
asserts the shipped schema is still `folders`, `app` and `graph_cache` and that
no file in `crates/store` names a session or a run. There is therefore no
reattach machinery, and none to build later either: what survives a quit is the
GitHub assignment, which nothing here had to keep.

## Consequences

**What it costs.** A quit can block the event loop for up to `GRACE` while the
children are given their two seconds, and that is deliberate — the window has
nothing left to draw, and returning before the children are gone is the orphan
the whole promise is about. The two seconds are unmeasured. `Session` waits on
its child by polling `try_wait` every 25 ms rather than blocking in `wait`, which
is what buys the escalating kill; the cost is one poll per run per 25 ms and up
to a further quarter second in `Drop` for a child that ignores `SIGHUP`. A
hung-up session refuses anything typed at it rather than accepting bytes that
could reach nobody, which is a new error a caller could see on the way out.

On unix the end-of-file is a *request*: `\n` plus `VEOF` is a real end-of-file to
a child in canonical mode and a `Ctrl-D` to a full-screen agent in raw mode, and
most TUIs quit on it — but nothing guarantees it, which is the reason there is a
deadline at all. **The `\n` is not free.** It is `portable-pty`'s, written by
`UnixMasterWriter::drop` immediately before the `VEOF`, and to an agent in raw
mode the tty interprets neither: what arrives is a literal `0x0A`, which most
prompt widgets read as *submit*. A work run with a half-typed prompt in it can
therefore have that prompt sent as the last thing that happens before the
deadline ends it — a turn on the operator's claim they did not ask for and will
not see. There is no way to write the `VEOF` without it from this side, and the
quit it belongs to has already been confirmed against a sentence saying the run
is about to end, so it is accepted and named rather than treated as inert.

A macOS *grandchild* that both ignores `SIGHUP` and has left the controlling
terminal's foreground process group would still survive; the direct child no
longer can, because the kill escalates. The job object has no such gap, and that
asymmetry is the shape of the platform difference rather than an oversight in
the code.

**What it buys.** No orphans, and checkably. `no_grandchild_survives_a_quit`
spawns a shell that backgrounds a *grandchild* ticking into a marker file, quits,
and asserts the file has stopped growing. It is a grandchild rather than the
child because killing the direct child is the easy half, and it is a file rather
than a process enumeration because this crate forbids `unsafe` and takes no
`libc`, so *is it still running* cannot be asked of the operating system from
here — but *is it still doing anything* can, and it fails in the direction that
matters. It settles for half a second before taking its baseline, because on unix
`shut_down` returns once the kill has been *sent* and a tick landing in that
window would read as a survivor. `a_run_that_ignores_the_hangup_does_not_survive_the_quit`
is the same evidence for the direct child with `trap '' HUP`, which is the case
the cloned signaller could not have reaped. Deleting the `shut_down` call makes
the first of them fail on Windows with a marker that grew by more than a
kilobyte. One question rather than N. And the absence of any local record of a
run means there is nothing to reattach to, nothing to keep in sync, and nothing
to be wrong about after a crash.

**What it does not decide.** What ever puts a row in the stakes table in the
shipped app: nothing opens a run there yet, so `Terminals::staked` has no
product caller until #48 *Start Working*. The rule it feeds is exercised end to
end against runs a test opens through the registry, so what #48 supplies is the
caller and not the behaviour. What a *stranded* claim looks like once it is
picked back up, and what Resume does with it, are #49's — this ADR discharges
only the half that makes them possible, which is that nothing about a run is
written down. **The acceptance criterion *a stranded claim is reachable through
Resume on the next launch* is therefore not ticked by this ticket**; it needs
#48 to make a claim and #49 to surface it, and an absence test is not evidence
that something can be reached. So is what kind of ending a run had — this ADR
ends every run the same way on the way out and says nothing about the difference
between spent and exited-but-unresolved.

## Alternatives turned down

**One confirmation per live run.** Four dialogs is not a decision, it is an
interrogation, and the fourth one is answered by whichever button the hand is
already over. The same argument as the shared deadline, one layer up.

**A confirmation in the WebView.** It would need a plugin permission added to
`crates/app/capabilities/default.json`, which currently grants two core event
permissions and says in its own description that it needs nothing more because
the picker is answered in Rust. It would also land against
`tests/dev-web.test.tsx`'s counted-zero assertions on `[role="dialog"]`,
`role="alertdialog"` and `dialog`, so shipping it means either breaking a
required check or weakening a rule the repo went to some trouble to make
falsifiable. Neither is worth a dialog the operating system will draw better.

**`TerminateJobObject` by hand.** `unsafe_code = "forbid"` is set in every
manifest in this workspace, and `win32job` 2.0.3 exposes no wrapper for it — its
own `Drop` is a `CloseHandle`. The dependency is justified in `Cargo.toml`
precisely as the thing that lets this crate own a process tree without any
`unsafe` at all, and reaching past it for one call would spend that. Dropping the
`Guard` is the same reap by the same mechanism, which is what
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` is for.

**A `libc` process-group kill on unix.** Already refused once, in ADR 0002, for
the harvest, on the grounds that it wants `libc` and `unsafe` and that
`unsafe_code = "forbid"` would have to be relaxed for it. Refused again here, and
this time it would also be redundant: the child is a session leader with a
controlling terminal, and the kernel hangs up its foreground process group when
the terminal goes.

**Reordering `Session::drop` to match the new sequence.** `Drop` is the backstop
for a crash, a `SIGKILL` and Task Manager's End Task — the paths where nothing
gets to run — and the field order in `Session` is what makes the guard drop last.
An orderly shutdown that rewrote the disorderly one would be trading the
guarantee that always holds for the one that only holds when the app is well.
`Runs::shut_down` is a new method beside it, and `Drop` runs afterwards with the
same order. What did change inside it is *which* kill it makes — the owned
child's rather than a cloned signaller's — and that is a strengthening of the
backstop on every path, not a reordering of it: the same call, at the same point,
now escalating where before it stopped at a signal a child could ignore.

**Persisting a run so the next launch could pick it back up.** The claim survives
a quit and the run does not — that is the ticket, not a limitation of it. A local
record of a run is the reattach machinery the ticket forbids: something to write,
to migrate, to reconcile against a process that is no longer there, and to be
wrong about after the one failure it exists for. The claim is on GitHub, where a
second machine and a second person can see it too.

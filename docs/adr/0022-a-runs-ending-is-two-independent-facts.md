# 22. A run's ending is two independent facts

Status: accepted (2026-08-31)
Context: [#49 The two endings](https://github.com/javrasya/perseverance/issues/49),
under the spec [#28](https://github.com/javrasya/perseverance/issues/28). It
rests on [ADR 0009](0009-the-failure-taxonomy-is-one-enum-twice.md) for what a
readout is allowed to be, on
[ADR 0013](0013-lag-drop-cannot-mean-dropping-bytes.md) for the rule that nothing
about a stream may be written into it, and on
[ADR 0014](0014-a-quit-is-one-confirmation-and-one-deadline.md) for the side
table this one writes beside.

`0022` and not `0021`: the directory holds two ADRs numbered `0010` and two
numbered `0020`, and `0021` is taken, so `0021` is the highest number in use.

## Context

A run finishes in two completely different ways, and the app is told about them
by two different halves of itself.

The **ticket closes**. GitHub says so, the poller reads it, and the model derives
a `Resolved` node. This is the good ending, and the one the operator is actually
working towards.

The **child exits**. `crates/pty` waits on the process — never inferring it from
end-of-file, because on Windows the output pipe stays open while the harness
holds the pseudoconsole — and flips `Telemetry::over`.

Neither causes the other. An agent can close its ticket and go on printing for
another minute. An agent can die with the ticket open and still assigned, and
nothing about the process says whether that was a crash, a `Ctrl-D` or a job
somebody finished by hand. The two arrive in either order, and a run can sit in
any pairing of them for hours.

The obvious design is a state machine over the run: `starting → running →
exiting → ended`, with the ticket's state as one more input into it. It is wrong
in a way that only shows up later. A machine has *one* current state, so every
pairing has to be collapsed into a single name, and the collapse has to pick a
winner between two facts that were never in competition. *Exited* would overwrite
*spent*, and a finished piece of work would read as an abandoned one because the
process outlived the ticket by a second.

## Decision

**There is no run state machine. There are two facts and one table over them.**

`Ending` in `crates/app/src/lib.rs` is derived, per readout, from exactly two
inputs: `Telemetry::over`, and the last `NodeState` this app saw for the run's
ticket. Nothing is stored that is not one of those two, and no transition is
recorded anywhere — the ending is recomputed three times a second from whatever
the two facts currently say.

Four values, and the crossing is a tagged camelCase string on `RunReadout`:

| ticket \ child | running | exited |
| --- | --- | --- |
| open, claimed | `live` | `exitedUnresolved` |
| open and unclaimed, blocked, or never seen | `live` | `exited` |
| closed | `spent` | `spent` |

Three things follow, and each of them is why a row is where it is.

**Resolution outranks the process, in both columns.** *Spent* is not a state
after an exit; it is what a closed ticket means regardless of the child. That is
what makes the good ending independent of how the agent's process happened to
end.

**Resolution is a latch.** Once a run's ticket has been seen closed, the run is
spent for the rest of its life. The operator opens another map, or this map stops
listing the ticket, or GitHub is unreachable for an hour — none of that is a
ticket re-opening, and a readout that flipped back to `live` because nobody was
looking would be the app forgetting the one thing it exists to notice. A tick
that cannot find the ticket at all writes nothing: absence is not a state, and a
run keeps the ending it had.

**An exit over an open but unassigned ticket is `exited`, not
`exitedUnresolved`.** `Claimed` is the only node state that means the work is
still held by somebody. `Takeable` says the assignment is gone and `Blocked` says
the same with something in the way; calling either of them *unresolved* would
have the readout assert a claim that is not there, which is the one lie in this
enum an operator would act on. A ticket this app has never seen in a model is the
same case for the same reason: nothing observed, so nothing asserted.

## Consequences

**A ticket closing touches no terminal.** `Terminals::noticed` writes one small
table and nothing else: no session is closed, the monitored run stays monitored,
no child is signalled, no pane is unbound and no geometry moves. The graph half —
the node flipping, the frontier moving, the ledger row firing — was already built
and is untouched by this. A test opens a real run, takes a resolution tick and
compares the registry either side of it.

**Spent holds its slot until a press.** `end_run` is the only thing that closes a
session, drops the stakes row, forgets the resolution and lets go of the poller's
handle, and it is reachable from the WebView alone. Nothing on the poller's
thread or a readout thread may call it: an app that closed terminals on the
strength of a GitHub read would be throwing away the last thing the agent
printed, which is exactly what a person goes looking for afterwards.

**The exit poke is where it already was.** #48 holds one `RunHandle` per run from
the moment it is opened and drops it on the readout that first sees `over`, which
sends `Poke::RunExited` and buys an immediate off-cadence read. That read is what
turns *exited* into *spent* when the agent closed its ticket on the way out, so
the falling edge of a run and the ending it gets are one round trip apart rather
than a rung.

**A run learns its ending only while its own folder is the one being watched,
and v1 accepts that window.** `poll_once` reads exactly one map — the folder the
`watching` command last named — and `Terminals::noticed` writes the resolution
table for the runs staked in that folder and no other. A run staked in a folder
the operator has since moved away from therefore stops hearing anything about its
ticket, and selecting another folder is the ordinary way to reach a second one.
So if that ticket closes while the operator is elsewhere and the child then
exits, the table still holds the `Claimed` its last tick saw, and the pane prints
*this run stopped with its ticket still open and still claimed* about work that
in fact finished — the shape of wrong sentence this whole table exists to avoid,
arrived at from the other side. Driving the ending off each run's own folder
instead would multiply every tick by the number of folders the rack has runs in,
against a rate limit this app already spends carefully, and it is out of scope
here: this
ticket accepts the window and writes it down rather than leaving it to be
rediscovered. It closes itself — re-selecting the folder puts its map back under
the poller, the next tick writes the resolution the ticket has had all along, and
the run reads *spent* — and nothing acts on the wrong reading in the meantime,
because both endings hold their slot until a press either way.

**Two facts stay in two threads.** The poller writes the resolution table and the
readout thread reads it; the locks are small, taken one after another and never
nested, and the 3 Hz writer never queues behind the ledger's mutex. A run state
machine would have needed one lock over one state, and would have put those two
threads in each other's way for the sake of a name neither of them could have
agreed on.

**Nothing is persisted.** The ending is derived from a live model and a live
process, so there is no session id, no reattach and no store schema change. A run
that does not survive the process is a claim that does, and Resume picks it up —
which is what `WORK_LOSS` already says.

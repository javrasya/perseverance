# 26. The caret parks when the run under it dies, and the keystrokes spill

Status: accepted (2026-08-31)
Context: [#50 Quiet, wedged and ready](https://github.com/javrasya/perseverance/issues/50),
under the spec [#28](https://github.com/javrasya/perseverance/issues/28). It rests
on [ADR 0022](0022-a-runs-ending-is-two-independent-facts.md) for who is entitled
to say a run has ended, and sits beside
[ADR 0025](0025-silence-is-a-joint-predicate-and-readiness-is-a-declared-rule.md),
which is the same ticket's other half.

`0026` and not `0025`: the directory holds two ADRs numbered `0010` and two
numbered `0020`, `0005` is missing, and `0025` is taken — so `0025` is the
highest number in use and this is the next one.

## Context

A run's child exits while the operator is typing at it. The keystrokes are
already in flight, and the window has to decide two things it cannot avoid
deciding: where the caret goes, and where the text goes.

The tempting answer to the first is that the caret follows the work — the dead
run is finished, another run is live, move the keyboard to it. Every terminal
multiplexer that closes a pane on exit does a version of this.

It is theft. The operator's next keystroke is a sentence they had already begun,
and moving the caret lands that sentence in a different agent's conversation —
one they were not looking at, did not choose, and will not notice they are
talking to until the reply comes back wrong. The keyboard belongs to the run the
person put it on, and nothing that happens in the world is a reason to move it.
A run dying is the world.

The second decision is the same decision one level down. A stopped child leaves a
descriptor that will still accept a write and will never read one, so
`typed_at_run` on a run whose child has exited is not an error — it is bytes
going quietly nowhere. The Rust side cannot help here: `crates/pty`'s `typed`
looks a run up in the map it keeps and only a person's End press removes one, so
by design the write succeeds. The last person who can keep the text is the one
holding it.

There is a third decision hiding behind both, and it is the one that makes the
first two coherent: whether the run stays on screen at all. A run that vanished
when its child exited would be a layout change caused by the world, on the frame
where the operator most needs the layout to hold still — the last thing the agent
printed is the diagnosis of why it stopped.

## Decision

**The caret parks.** When the monitored run's child stops, `monitored` does not
change. Only a press moves the caret: the rail starting or resuming a run, the
idea box, and the End press that empties the pane. No poll, no readout tick and
no death path calls `monitor(...)`, and `src/stores/ui.ts` says so on the
mutator itself. A live run arriving in the same readout set is not an
invitation.

There is exactly one non-press caller and it is named on the mutator too, so
that a reader grepping `monitor(` lands on the boundary rather than on a
precedent: the `dev:web` fixture boot in `src/terminal/fixtures.ts`, which opens
the pane on a hand-written readout because nothing in a browser spawns a run.
`fixtureRunToOpenOn` answers `null` whenever `hasRustBehindIt()`, so there is no
harness it can reach and no conversation for a keystroke to land in. The
substantive rule is unchanged: on a real harness nothing automatic moves the
caret.

**The pane stays bound, and the row stays.** The terminal is not disposed —
`Terminals.forget` is still reached only from the End press — so the node on the
pane is the same node holding the same bytes it held a frame ago. The run keeps
its readout row and reads as `exited`, off Rust's `ending` and never re-derived
here.

**The keystrokes spill.** `src/terminal/spill.ts` keeps what was typed at a run
whose readout says `over`, one register per aimed-at run, and the pane prints
what it holds as a line beside the terminal. Two restrictions are part of the
decision rather than of the implementation:

- **Wholly-printable chunks only, and a chunk with any control byte is dropped
  whole.** What arrives is what xterm.js encoded, one press per chunk; an arrow
  key is `ESC [ A`, and a register that filtered out the escape would show `[A`
  in a sentence nobody typed. The cost is a multi-line paste, which is lost. The
  register recovers words, not sessions.
- **Per run, not one global register.** The pane is parked on the dead run and
  what it prints must be true of that run. One register would print run 3's
  half-typed sentence beside run 5's output and attribute it there.

**The reading is an observation.** *Typed after this run ended, and held rather
than sent*, a count, and the words themselves. Not a modal — nothing has happened
that needs answering, and the operator's own sentence is not an interruption to
be dismissed. Not a toast — a toast is a fact with a timer on it. Not written
into the terminal buffer, where it would afterwards be indistinguishable from
something the agent printed. And no motion, so encoding rule 12 gains nothing to
pay.

## Consequences

The register captures and holds, and stops there. *Offering* the text to the work
run is [#57](https://github.com/javrasya/perseverance/issues/57)'s — the offer
needs a warm/cold temperature model to say which run a spill is worth moving to,
and that model does not exist yet. Deciding it here would be answering #57's
question in a file that cannot see it. The same boundary is why the read-only
pane is not generalised here: a dead run's pane is read-only in effect, and
whether that is a *state the pane has* is the patchbay's call.

The parking rule is proved by absence, which is the hard kind to keep. The tests
in `tests/parked-caret.test.tsx` assert it as a property of the mounted app: the
death arrives on the readout poll, and `monitored`, the bound node, the node's
identity and the End button are all unchanged afterwards — including when a live
run is sitting in the same readout set. Absence is only ever one careless
`monitor(...)` away, and this is the thing that would catch it.

The keystroke handler now reads the readouts when a key is pressed rather than
closing over the array that existed when it was installed. That is deliberate and
narrow: re-registering `onData` on every readout tick would tear down and rebuild
the keyboard's one seam several times a second, and a stale closure is precisely
how a keystroke lands on a child that stopped a millisecond ago. A run with no
readout at all is typed at — nothing has said its child stopped, and refusing the
keyboard on a readout that has not arrived would silence a run that was just
spawned.

Run numbers are issued once and never reused, so a register lives exactly as long
as its run and the End press drops it with the terminal. If numbers were ever
recycled, a new run would inherit a dead one's words — which is a reason for the
numbering to stay monotonic, recorded here so the constraint is written down
somewhere other than in the allocator.

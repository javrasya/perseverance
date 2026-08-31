# 25. `Esc` is a readout, not a binding

Status: accepted (2026-08-31), amended by ADR 0027 (2026-08-31) in the one
place marked *Amended* below.
Context: [#53 The keys are one table](https://github.com/javrasya/perseverance/issues/53),
under the spec [#28](https://github.com/javrasya/perseverance/issues/28). It
rests on
[ADR 0023](0023-the-peek-borrows-the-dial-and-springs-back.md), whose summon
chord was the last key this app bound outside a table, and which said in its own
wiring that #53 would absorb it.

`0025` and not `0024`: the number is one above the highest already on disk, which
is not the file count — `0005` was never written, and `docs/adr/` holds two ADRs
numbered `0010`, two numbered `0020`, two numbered `0022`, two numbered `0023`
and two numbered `0024`.

## Context

`Esc` had been bound to a room change. That is the decision this ADR reverses,
and the reason is not taste: `Esc` is the interrupt of every agent CLI this app
exists to sit in front of. An app that claims it takes away the only way to stop
a run — and it takes it away silently, because the operator presses the key they
have pressed ten thousand times and the run carries on.

The obvious repair is to put `Esc` in the key table with a harmless action. That
does not work either, because there is no single true entry for it. Where it
goes depends on what is on screen: with a run warm and nothing over it, `Esc` is
the run's; with a surface in front of the terminal, that surface is what the
operator is looking at and `Esc` is that surface's. A static row would be a lie
in one of those two states, and the state it lied in would be the one where the
lie costs a run.

## Decision

**`Esc` is not an entry in the routing table. It is a readout computed from
it.**

Three parts, and they are one mechanism rather than three rules.

**Whatever holds the keys holds `Esc`.** When the terminal has them, `Esc` is
unclaimed by the router: it is encoded and sent to the PTY like any ordinary
key, and the custom key handler at the xterm seam returns `true` for it the way
it does for a letter. When a dismissible surface stands in front of the
terminal, the CLI is not being typed at, that surface holds the keys, and `Esc`
takes it away. Those are the only two destinations there are. [Amended by
[ADR 0027](0027-watching-and-typing-are-two-paths.md): there are four, and #57
is what made the third and the fourth reachable. Watching and typing came apart there, so a run
can be on the monitor with the keys on the map — cold and monitored, one press
away at any time. Nothing holds `Esc` in that state: no surface is in front and
no run is warm, so the key is claimed by nobody and reaches nothing at all.
`escDestination` says exactly that — *reaches nothing — the keys are on the map*
— and it reads `warm` rather than `monitored` to know it. Naming the agent CLI
over a cold run would promise an interrupt that never arrives, which is this
ADR's own failure one state over. The mechanism is untouched: whatever holds the
keys holds `Esc`, and here nothing does.

The fourth destination is the same failure a second time, in the state reading
`warm` does not by itself rule out: a run whose child has stopped, with the
caret parked on it and still warm
([ADR 0026](0026-the-caret-parks-and-the-keystrokes-spill.md)).
The temperature there is true — the keys are that run's, and moving them would
drop the next keystroke into a different agent's conversation — but the process
that would have taken the interrupt is gone. What is typed at a parked run stops
in its spill register, and `Esc` does not even do that: the register keeps words
and drops a chunk with a control byte in it whole, so this key is captured by
nobody and read by nobody. `escDestination` says *reaches nothing — this run's
child has stopped*, and it says it above a temperature that has already told the
operator the child is gone; the two lines are adjacent on screen, and the old
answer made them a paragraph that contradicted itself.

Which leaves the third and the fourth worth telling apart, because they are the
same words for different reasons. Cold and monitored is *your keys are somewhere
else* — they are on the map, and one press brings them back. Parked and warm is
*your keys are here and there is nobody home* — nothing to press, because what is
missing is a child rather than a caret. Whether the child has stopped is not in
the UI store and cannot be: it arrives on the readout poll, and that store holds
nothing a poll writes. So the pane hands the readouts to both sentences and they
match the warm run out of them the same way, through one `warmReadout` — one
answer to *is the caret parked*, printed twice rather than derived twice.]

**`Esc` never changes room.** Not the view, not the dial, not which run is on
the pane. Crossing between the map and the terminal is a chord of its own —
`⌘E` on macOS, `Alt+E` elsewhere — for the same reason the peek's summon chord
is what it is: `⌘` never reaches the shell, and `Alt` is the one modifier a
shell does not read as a control character. Dismissing is not crossing, and
conflating them is what put `Esc` on a room change in the first place.

**The readout is computed from the table.** A row that takes a surface off the
screen declares what it dismisses, and `escDestination(state)` finds the live
one by reading the same rows `route(event, state)` routes by. There is no second
list of surfaces anywhere, which is the whole point: a ticket that adds a
command palette adds one row, and the sentence beside the terminal starts saying
so without that component being edited. A readout with a list of its own would
drift from the router within one ticket, and a readout that is wrong about `Esc`
is worse than no readout, because it is the one key an operator would otherwise
test by pressing.

## Consequences

The app can never quietly acquire an `Esc` binding: there is one table, one
window listener over it in the capture phase, and
`tests/no-loose-keys.test.ts` refuses any other file the right to bind a key at
all — two allow-listed files, both named in the check. A chord added outside the
table is a build failure rather than a code-review note.

The cost is that a dismissible surface has to be a row of the table to be
dismissible. It cannot listen for its own `Esc`, and it cannot decide on its own
that it is in front. That is the constraint that makes the readout true, and it
falls on exactly the surfaces — the palette, the keys page, whatever comes next
— whose whole job is to stand in front of a terminal an agent is running in.

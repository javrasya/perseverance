# 25. Silence is a joint predicate, and readiness is a declared rule the harness clocks

Status: accepted (2026-08-31)
Context: [#50 Quiet, wedged and ready](https://github.com/javrasya/perseverance/issues/50),
under the spec [#28](https://github.com/javrasya/perseverance/issues/28). It rests
on [ADR 0022](0022-a-runs-ending-is-two-independent-facts.md) for the latch a
closed ticket is, on
[ADR 0010](0010-the-adapter-contract-is-four-members-and-a-value.md) for what an
adapter is allowed to be, and on
[ADR 0009](0009-the-failure-taxonomy-is-one-enum-twice.md) for what a readout is
allowed to be.

`0025` and not `0023`: the directory holds two ADRs numbered `0010` and two
numbered `0020`, and `0024` is taken, so `0024` is the highest number in use.

## Context

Two questions arrive together and look like one question.

**Has this run stopped?** A terminal that has printed nothing for four minutes is
either an agent thinking, a person reading the screen, or a session that has
stopped and is never coming back. The bytes cannot tell those apart, and the
elapsed is identical in all three.

**Has this run started?** A terminal that has printed nothing for four *seconds*
is either a CLI still loading or a CLI sitting on a trust prompt nobody has
answered. Again the bytes are identical, and again the elapsed alone decides
nothing.

The obvious answer to both is a number. *Wedged after N minutes of silence*, and
*failed to start after N seconds.* One threshold each, tuned once, applied to
every run.

The threshold is wrong for the first question in a way no amount of tuning fixes.
Set it low and every work run whose operator went to make coffee is reported
wedged; a person reading a diff is the most ordinary thing a terminal does, and
an app that calls it a fault is an app whose warnings get ignored. Set it high
and a research run that died at minute two goes unnoticed until minute thirty —
which is the entire failure the reading exists to catch, because nobody is
looking at that pane. There is no single number, because the runs are not one
population: the same ninety seconds is a person thinking on a work run and an
agent that has stopped on a research one. The elapsed was never the whole of the
question. *Who is waiting* is the other half, and it is knowable — the ticket
type says it, `RunKind::of` maps it, and `attendanceOf` in the route already
draws the same line for the same reason.

The second question has a different shape. Every agent CLI announces itself
differently: `claude` takes the alternate screen in a measured ~223 ms, a CLI
that never goes full-screen simply settles into silence. What *ready* means is a
property of the adapter — and an adapter that ran its own clock, watched its own
stream and decided for itself when it had started would be a driver, which
[ADR 0010](0010-the-adapter-contract-is-four-members-and-a-value.md) exists to
refuse. It would also be four implementations of one loop, three of them
untested, each with its own idea of what a timeout does when it expires.

## Decision

**Silence is a joint predicate over two independent facts, and there is no shared
threshold.** `silence()` in `crates/app` takes exactly six values — the child's
exit, the last `NodeState` seen for the ticket, the run's `RunKind`, the byte
silence, the readiness reading, and whether any signal has ever been observed for
this run — and produces one tagged reading. The table, in order:

1. A ticket seen closed is `spent`, and it outranks everything. This is ADR 0022's
   latch, restated: a spent run is never quiet and never wedged, however long it
   has said nothing. The one ending that is good news does not also get to be a
   complaint.
2. A child that has exited says nothing here at all. That is an *ending*, it is on
   the same readout, and saying it twice in two vocabularies is how the two come
   to disagree.
3. Readiness overdue is a wedge of its own, with its own diagnosis: *something is
   waiting for the operator, most likely a trust prompt.*
4. An attended run silent with its ticket still open is `quiet`, carrying the
   elapsed, **for any elapsed and forever**. There is no length at which it
   becomes a fault, because there is somebody in front of it. Under a few
   seconds it reads as nothing at all — see the floor below, which is about
   whether the reading is printed and not about what it means.
5. An unattended run silent with its ticket still open is wedged once the
   applicable number passes. The five-minute byte-silence fallback is that number
   only for a run **no signal has ever been observed for**.

The gate on the last one is a fact about the run's own history and never a
question about its adapter. Nothing anywhere asks *does this adapter watch?* —
every run is drained through a `Box<dyn Watch>` on identical terms, the readout
carries the last signal or `None`, and `None` means *nothing has ever been
classified here*. Five minutes is a provisional guess with a stated basis, and it
is documented as one at `WEDGED`.

**There is a floor on printing a reading, and it is not a threshold on what a
reading means.** A run streaming output is silent for a beat between frames, so
without a floor the fall-through calls every working terminal `quiet · 0s` and
the chrome repeats it three times a second — copy that states an observation
nobody made, which is the failure this taxonomy exists to avoid from the other
end. Under `WORTH_SAYING` the reading is `nothing`. It is a different kind of
number from the one refused above and cannot become that one: both sides of it
are the same state, no run is classified differently for crossing it, and it is
never consulted about a wedge — a diagnosis is printed at any elapsed. It also
lives entirely in Rust, where the predicate already is; `silenceSentence`
switches on the tag and holds no duration comparison, because a threshold on that
side would be a second copy of a predicate it can only see two of the six inputs
to.

**Readiness is a declared rule the harness clocks, and its expiry is a
diagnosis.** The adapter declares `Ready::AltScreen { timeout }` or
`Ready::Quiet { quiet, max }` and does nothing else. `crates/pty` runs the clock:
the drain loop — the only place in the process that reads a child at all —
records when bytes last arrived and watches for `ESC [ ? 1049 h`, and
`Readiness` is computed from that when it is asked for. Three readings, and no
fourth: waiting, ready, overdue.

Alt-screen detection is the harness's and deliberately not the `Watch`'s, so a
`NoWatch` adapter still gets a readiness verdict — which is every shipped adapter
today. *Ready* latches, because a session that has opened does not close again.
*Overdue* closes nothing: the child is not signalled, nothing is ended, and a run
that goes on to take the screen half an hour later reads as ready. It is a
sentence beside the terminal and never an action.

## Consequences

Byte silence is still never an ending, and neither reading here is one. `over`
comes from waiting on the process and from nothing else; a run that has said
nothing for an hour is a run that has said nothing for an hour.

`crates/pty` gains a length, a latched verdict and a last-classification, and
learns nothing about tickets, attendance or thresholds. It cannot: the byte scan
in `crates/app` refuses the vocabulary, and the join happens where the product
words already live — beside `ending`, over plain values, testable without a
child.

The two numbers are guesses and are written down as guesses. Five minutes for the
byte-silence fallback is an order of magnitude above the burst-silence of a
research agent reading a repository; the readiness timeouts are the adapters' own
declared ones, an order of magnitude above a ~223 ms measured alt-screen. What
would settle the first is a distribution of real silences per adapter, and the
revisit trigger is the first report of a working research run called wedged.

The floor is a third number and is deliberately not one of those two, because
nothing is classified by it. Five seconds is how long a working run gets to say
nothing before the chrome bothers mentioning it; moving it changes what is on
screen and never what any run *is*. Its revisit trigger is somebody saying the
sentence arrives too late to be useful, or soon enough to be untrue.

The attendance line is now drawn twice and still only twice — `RunKind` in Rust,
`attendanceOf` in the route — from the same `TicketType`. `RunKind::unattended`
is the predicate over it, and it is the only place in Rust that reads the line.
The day the model carries the distinction itself, both spellings move together.

A fourth `Signal` variant is still refused, and nothing here needs one. `Idle`
buys an off-cadence poke on its rising edge — the readout tick is where the edge
is taken, beside the falling edge of a run that has ended — and `Ready` and
`Busy` are recorded for the chrome and buy nothing at all. Absence of a signal
remains evidence of nothing.

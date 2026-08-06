# 7. The cadence is three floors under one max, and a poke lowers one of them

Status: accepted (2026-08-06), amended by ADR 0008 (2026-08-06) in the three
places marked *amended* below and by ADR 0009 (2026-08-06) in the one marked
*landed*. Still in force everywhere else.
Context: [#38 the cadence ladder and off-cadence
pokes](https://github.com/javrasya/perseverance/issues/38), under the spec
[#28](https://github.com/javrasya/perseverance/issues/28). The two floors this
decision leaves at zero are
[#39](https://github.com/javrasya/perseverance/issues/39) (the rate-limit budget
floor) and [#40](https://github.com/javrasya/perseverance/issues/40) (failure
taxonomy and backoff). The runs whose liveness the fastest rung is a function of
are [#47](https://github.com/javrasya/perseverance/issues/47); the adapter
signal behind the `Idle` poke is
[#44](https://github.com/javrasya/perseverance/issues/44). ADR 0003 already
settled that the read is a blocking socket on a thread, using this ticket's
ten-second rung as its case.

## Context

Three numbers were asked for — ten seconds with a run live, sixty watching, five
minutes unfocused — and three events that fire off-cadence. The interesting part
was never the numbers. It was that two more things will decide the same number
later: #39 stops polling near the rate-limit reserve *(amended: it paces against
the reserve and waits the reset out; it never stops — ADR 0008)*, and #40 backs
off after consecutive failures and stops outright for the conditions retrying
cannot fix.
Whatever shape #38 lands, those two have to fit into it with at most a known,
named edit, or this slice will have pre-decided two tickets by accident.

Two questions had real alternatives.

**Does a poke bypass the schedule, or change it?** The obvious reading of *fires
immediately when you return* is a code path that reads now and tells the
scheduler afterwards. It is one branch, it is easy to write, and it is how a
poke ends up outrunning the rate-limit budget: a bypass is by construction a
route around whatever the budget floor was going to say.

**Where does "a run is live" come from?** Nothing in the tree produces it — runs
are #47 and `crates/pty` is thirty-two lines of doc comment — so the choice was
between a flag somebody sets and clears, and something that is true for as long
as a value exists. A flag looks cheaper right up until the process ends on a
path that forgot to clear it, and then the app polls every ten seconds forever
for a run that finished.

## Decision

**The interval is `max(ladder_floor, budget_floor, backoff_floor)`, and a poke
lowers the ladder term to one second rather than skipping the max.** The ladder
floor answers *how often is useful*; the other two answer *what is permitted*;
`max` is how permission wins. Because a poke is a term rather than an escape,
nothing about pokes has to be re-guarded when #39 and #40 arrive — and #19 §5's
*agent pokes respect backoff, human pokes clear it* lands as `backoff_floor`
reading the `Authority` it is already handed, not as a second code path.

The composition reports **which floor won** alongside the wait, because #39's
*waiting for your budget to reset* clause appears only while the budget is the
winning term, and a bare `Duration` would leave that clause nothing to key on.
The floor type has a `Never` variant with one producer and two waiting for it:
#39 stops at the reserve and #40 stops rather than backs off, and a
`Duration`-only floor would have been reshaped twice. *(Amended: one ticket, not
two. `Never` is absorbing, so a budget answering it would never read again and
never learn of the reset; #39 answers `seconds_to_reset` instead and only #40
still waits for the variant — ADR 0008. Landed: #40 is the second producer, for
`AuthFailed` and `MapGone`. Absorbing is survivable there because a person can
get out of it and a reset cannot be waited for — the human-poke clause sits
above the stop in the same floor — ADR 0009.)*

**#40 is expected to edit one row of that array, and this is the record that it
was foreseen rather than a shape that failed.** *(Landed: it edited that row and
no other. `Cadence` gained `last_fault: Option<Fault>` beside the count,
`backoff_floor` gained a third argument, `Tick::Failed` gained a payload, and
the `max`, the lattice, `Held` and the poke-as-a-term are byte for byte what
this decision left them. `Ahead` widened from `Option<Budget>` to `Tick`, which
is `poller.rs` and not the composition — ADR 0009.)* Stopping rather than retrying
requires knowing *which* condition failed, and nothing in this slice carries
one: `Cadence` keeps `consecutive_failures: u32`, `Tick::Failed` is a unit
variant, and the `ReadFailure` that reaches `crates/app` is stringified into the
view and dropped. Inventing the taxonomy here to spare that edit would have been
#38 deciding #40 — precisely the accident this decision set out to avoid — so
the count stands, `backoff_floor`'s signature is honestly half of #40, and its
doc comment, the doc on `Cadence::consecutive_failures` and this paragraph all
say that #40 adds a failure-kind field, widens `backoff_floor`, and changes the
third row with it. What that costs is one row. What it buys is that nobody
implements the doubling half, reads *a count and an authority and nothing else*,
and ships an app that retries an auth failure forever at five-minute intervals.
Nothing else about the composition — the `max`, the lattice, `Held`, the poke
being a term — moves for either ticket.

**Run-liveness is a count of live `RunHandle`s.** `Poker::run_started()` is the
only way to make one, `Drop` is the only way to end one, and each of those two
lines sends on the channel beside the count it changes — so the rung moving and
the loop hearing about it are one event on both edges and cannot disagree about
when it happened. Both messages are needed for the same reason and neither is
optional: the count is read at the top of a pass and the loop then blocks for
the whole of it, so an edge that changed the number silently would be a rung
that engaged when the *previous* wait expired — a minute late focused, five
unfocused, and never at all for a run shorter than the rung it was supposed to
raise. They differ only in authority. `RunExited` asks for a read, because a run
that has just ended is the state most worth being right about and nothing else
would fetch it soon. `RunStarted` asks for nothing: it moves the ladder to ten
seconds and lets the composition decide, which reads immediately if the last
read is already older than that and otherwise waits out the remainder.
`RunHandle` is deliberately not `Clone`: two handles for one run would be two
runs to the ladder and the count would never come back down. Nothing asserts the
absence of that derive; if somebody adds it while tidying, this paragraph is the
record that it was a choice.

`NodeState::Claimed` is **not** a producer for that count, and the doc comment on
the field says so rather than only `derive.rs` saying it. A claimed ticket is an
assignment; a live run is a process. A ladder that polled every ten seconds
because somebody assigned themselves an issue last week would be spending the
budget on a promise.

**`POKE_FLOOR` is one second rather than zero.** Measured from the last read, so
any real absence longer than a second fires immediately and only alt-tab flicker
inside one second is held back. It is a judgement, not a measurement of the poke
case: the justification borrowed is `read.rs`'s recorded ~0.4 s whole-query
latency, so one second is two whole queries. A reviewer reading *fires
immediately* strictly would set it to zero and leave the flicker case to #39,
and that is a one-constant change.

**`refresh_maps` is deleted rather than kept beside the poller.** Two
independent things reaching GitHub would both be entitled to write `graph_cache`,
and *the cadence decided this read* would stop being true of any particular
read. The WebView now declares what it is looking at with `watching` and is told
what arrived on a `maps` event. That declaration pokes every time it is made,
including when it repeats itself: with the old command gone, clicking a folder
row is the only way anybody has to ask for a read off the rung, and re-opening
the folder you are already in is the commonest form of it. `POKE_FLOOR` is what
rate-limits a repeated click, so nothing is bought by suppressing it. Only a
*changed* declaration forgets the last-read stamp, because re-declaring the same
folder has not made what was read of it any older. *(Amended: nothing forgets it
now. The stamp is the anchor `budget_floor`'s horizon is measured from too, and
erasing it fires every finite floor immediately — a launcher click under the
reserve. The poke on the next line already reads a new folder within a second —
ADR 0008.)* Focus is read from
`WindowEvent::Focused` in
Rust rather than from a `visibilitychange` listener, so a WebView bug cannot
leave the app convinced it is being watched, and the capability file is
untouched.

## Consequences

The composition point exists with two of its three terms returning zero, which
is a shape carried before it is paid for. The defence is
`the_two_floors_that_are_stubbed_cannot_change_any_answer_yet`, which crosses
every budget, failure count and authority the types can express and asserts the
answer is unchanged and `Held::Ladder` throughout. It fails the day #39 or #40
lands, which is the day somebody should be reading it. *(Landed: both days have
come. #39 took the budget dimension out of that test and #40 deleted what was
left of it, replacing it with the five tables in `cadence.rs` that pin what the
backoff actually answers. The shape carried before it was paid for cost one row
of one array in the end — ADR 0009.)*

`Budget { remaining, seconds_to_reset }` decides a sliver of #39 without having
been asked to — seconds rather than the RFC 3339 text GitHub sends, because the
pure module has no clock to reduce one to the other. Nothing populates it in this
slice and the doc says why; #39 may still widen it.

The interval function's purity is a rule that can fail rather than one nobody
declared: a test in `poller.rs` reads `cadence.rs` as bytes and asserts it names
no clock type. It lives in the other file so the needle is not inside the
haystack it searches.

The run-live rung and two of the three pokes are exercised only by tests that
hold a `RunHandle` or send a `Poke`, because #44 and #47 have not landed. That
is stated in README's honest limits rather than left to be discovered. If AC1's
*driven by actual run state* is read as *observable in a running build today*,
no design satisfies it and the ticket needs re-scoping — the run state this
slice can honestly reach is the handle count, and the ladder is a function of
exactly that.

`Timings` carries the idle debounce and must not grow the three rungs. A ladder
configurable from outside the crate is not a ladder anybody can reason about,
and the whole argument for ten / sixty / three hundred lives beside those
constants.

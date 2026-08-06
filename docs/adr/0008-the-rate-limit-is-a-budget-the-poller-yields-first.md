# 8. The rate limit is a budget the poller yields first, by one formula with no thresholds in it

Status: accepted (2026-08-06)
Context: [#39 the rate-limit budget
floor](https://github.com/javrasya/perseverance/issues/39), under the spec
[#28](https://github.com/javrasya/perseverance/issues/28), stories 108 and 109.
It fills the floor ADR 0007 left at zero and reverses **two** things that ADR
settled: the `Never` it predicted at the reserve, and its rule that a changed
`watching` declaration forgets the last-read stamp. Both reversals are argued
below and marked in ADR 0007 where they land. ADR 0003 settled that `perseverance-github` is the only crate that
opens a socket and that classifying failures — `RateLimited` among them —
belongs to [#40](https://github.com/javrasya/perseverance/issues/40) and not
here. ADR 0004 settled that derivation is Rust's and the WebView is paint, which
is what decides where the one new fact crosses.

## Context

GitHub's GraphQL limit is five thousand points an hour, and the poller is not
the only thing spending them. Every `gh` call an agent session makes in the
operator's own terminal draws on the same pool — which is the whole reason this
is framed as *yielding* rather than as *throttling*. A harness cannot slow the
agents down and has no business trying; it can slow itself down, and it is the
only spender here that can be told to.

Three things made this more than an arithmetic exercise.

**The formula as the ticket states it does not survive integer division.**
`2 / ((remaining - 1000) / seconds_to_reset)` reads correctly and evaluates to a
division by zero at a *full* budget: points per second is normally far below
one, so the inner division floors to nothing. `remaining` is also `u32`, so
`remaining - 1000` panics in debug for exactly the operator whose agents have
been busy — the case the reserve exists for.

**ADR 0007 predicted `Floor::Never` at the reserve, and wrote `Never` into the
type before anything produced it.** Following that prediction would have been
the easy path and it is wrong, for a reason only visible once the composition
exists.

**Nothing carried the numbers back.** `Cadence::budget` was hard-wired `None`
and `Tick` was a unit-ish enum, so the `rateLimit` a read parsed had no route
into the loop that would pace against it. The numbers flowed the *other* way —
out to the WebView on the `maps` payload, where nothing read them.

## Decision

**One formula, evaluated as `QUERY_COST * seconds_to_reset / spendable`, ceiled,
and clamped to the horizon.** Read dimensionally it is a sentence: the points
above the reserve, over the seconds they have to last, is points per second; the
cost of one poll over that is *seconds per poll*. Seconds per poll is the same
kind of thing a rung is, which is why the budget composes under ADR 0007's `max`
instead of needing a rule beside it. It is written `COST * T / S` and never
`COST / (S / T)` for the reason above, and `div_ceil` rather than `div` because
a floor that rounds down is a floor that overspends.

`RESERVE = 1000` and `QUERY_COST = 2` are named constants. The cost is a
*measurement* of the one shipped document — `rateLimit { cost }` on the
checked-in answer says two, a test in `read.rs` pins the fixture against the
constant, and the `#[ignore]`d live test asserts the real schema has not
repriced the query *above* it, against the constant rather than against a
literal. That bound is one-sided on purpose: the live call opens no map and
`map-read.graphql` guards the whole issue subtree behind `@include(if: $open)`,
so it sends a strictly smaller query than the fixture was captured from and may
honestly cost less. What the pacing needs to know is that the cost has not
grown. Reading `cost` off each answer instead was rejected: an odd answer
reporting zero would remove the pacing entirely, and the failure mode of that is
*spend everything, silently*.

**Neither number is a threshold and nothing branches on either.** The reserve is
a subtraction inside one expression, and the drained case is a `max(1)` division
guard whose answer the existing clamp already reduces to the horizon — the same
value the curve's own limit tends to, by the same arithmetic every other point
of it takes. An `if spendable == 0` would have produced identical answers and
would have been a case sitting inside the function whose doc denies one exists.

Stopping *at* the reserve is therefore what the formula does at its limit, which
is why the curve degrades smoothly with no step anywhere in it. That is asserted
as *tightness* swept over the whole input space, not as monotonicity over the
table — a step function is monotone, and eighteen pinned rows leave the gaps
between them unconstrained. So the sweep says the pacing never costs more than
the points above the reserve and never waits a second longer than those points
need, and a threshold has to sit between those two bounds. One that hides
entirely between two rows of the table fails the sweep and nothing else.

**At the reserve the answer is `seconds_to_reset`, not `Floor::Never`. This
contradicts ADR 0007's stated expectation and the contradiction is the point.**
`Never` is an *absorbing* state: `later_of` lets it dominate every `AtLeast`, so
a budget answering `Never` means no tick, therefore no read, therefore no
fresher `remaining` ever arrives — and no poke and no rung can get under it,
because ADR 0007's own decision is that a poke is a term and not a bypass. The
poller would be dead for the life of the process, and an acceptance criterion of
this ticket is that recovery at the reset needs no intervention. A wake-at-reset
mechanism would restore that, and it is exactly the timer-and-state-machine the
ticket says not to build.

Waiting the reset out satisfies every clause at once: zero polls between now and
the reset, so zero points drawn; the one poll it schedules lands *at* the reset,
when the budget has refilled; and recovery is `saturating_sub` noticing a
`remaining` that jumped, with nothing to clear because there was never a flag.
It is also not a second rule — `2T/S` exceeds `T` only when fewer than two
points are left, so the clamp is a no-op everywhere except within one poll of
the reserve, where it states what was true anyway: waiting past the reset you
are waiting for is waiting on numbers that are somebody else's.

**The horizon is anchored to the last tick, and both other anchors are wrong.**
A `Floor` means *this long since the last tick*; a `seconds_to_reset` means
*this long since the read that reported it*. Those coincide only while the last
tick **is** that read, and a `Failed` or `NotAttempted` tick moves one without
refreshing the other. So `poller.rs` stores `Seen { budget, at }` — the numbers
with the moment they were taken at, stamped with the same `Instant` as
`last_tick` — and expresses the horizon from the current `last_tick` on every
pass. Re-basing it to *now* instead would double-count against `next_wake`'s own
`since_last_tick` and fire at half the horizon, which is the one of the two
errors that draws under the reserve. Leaving it un-aged would re-arm the whole
horizon on every tick, so one failed poll at the reset would cost another full
hour.

**`Tick::Read` widens to carry what the read saw, and the tick closure is
handed a query rather than a floor.** ADR 0007 foresaw `Tick` being widened and
this is that edit, in the direction it did not foresee: the tick that parsed the
numbers is the only thing that ever holds them, so the return is the route they
travel. In the other direction the tick is handed `Ahead = Fn(Option<Budget>) ->
Held`, and asks it with whatever this poll established.

A fixed `Held` computed before the sleep was the obvious shape and it is wrong,
because a view is read by somebody who is **about to wait**. The wait a tick was
served on and the wait it is handing over to differ exactly where the clause
matters, and in both directions. The poll that fires *at* the reset waited out a
budget-held hour and is the first thing to see the refill — told the term it
waited out, it would put *the poller is yielding* on screen for a whole rung
after the yielding stopped, at the one moment that sentence is most misleading.
A cold start whose first read finds the budget already drained is the mirror: it
was served on a ladder-held wait and would say *not yielding* for the entire
hour it is stopped. A query answered after the read is neither.

Two things the query does beyond substituting the fresh numbers, and both are
the same *tense* argument. It clears the poke, because the poke was spent by the
read that is asking — without which a click at a completely full budget reports
`Held::Budget`, the two-second pacing having merely out-waited the one-second
`POKE_FLOOR`. And a horizon nothing refreshed ages to *now* rather than to the
previous tick, because now is what the next wait is measured from. What it does
not fold in is a failure this tick has not reported yet; `backoff_floor` is a
stub that cannot change any answer, and #40 is where that argument has to be
made.

**`last_tick` is the anchor every floor is measured from, so nothing erases
it — not even a change of folder. This is the second reversal of ADR 0007**,
whose *only a **changed** declaration forgets the last-read stamp* is deleted
here rather than qualified. That rule was right about the only term that existed
when it was written and wrong about the two that were still stubs, which is
exactly the accident ADR 0007 set out to avoid and did not see coming from this
direction. `next_wake` subtracts the anchor from whatever the `max` answered,
and a `None` reaches it as `Duration::MAX`, which `saturating_sub` collapses to
an immediate wake for *every* finite floor. The hour `budget_floor` answers with
at the reserve is a finite floor. So the ADR 0007 rule, left standing, means a
launcher click draws two points from under a reserve this ticket says is
untouchable — at any budget, with nothing under it at all — and switching
launcher rows is an ordinary click, reachable from the WebView through the
`watching` command, with `Watched` carrying the open map as well as the folder.
That is the thing the `max` exists to make impossible, defeated after the `max`
by a subtraction.

What makes the deletion *safe* rather than merely necessary is that the erasure
was buying nothing by the time it was deleted. ADR 0007 wanted *a folder that
has never been read is due now, not a rung from now*, and both halves survive
without it: the unconditional `self.poke = …` on the very next line lowers the
ladder to `POKE_FLOOR`, so a newly opened folder is still read within a second —
the same trade ADR 0007 already took for focus and idle pokes — and a genuinely
cold start has never ticked, so its anchor is already `None` and there is
nothing to erase. The rate limit is an account-wide fact and a folder is not;
per-folder freshness, if it ever needs to short-circuit the rung, has to be a
field only `ladder_floor` reads, never an erased anchor the other two terms are
measured from as well.

**The winning term crosses on `MapsView` and not on `Provenance`.** `Provenance`
is the model crate's, the model crate may not know what a poller is, and
`check-model-purity.mjs` plus ADR 0004's generated-types seam both exist to keep
it that way. `MapsView` is the hand-written mirror where a poller fact belongs.
It crosses as one boolean, `yieldingToRateLimit`, applied in `emit_view` and
nowhere else so that none of `poll_once`'s seven returns can construct a view
and forget it — and it is the *winning term* rather than *a budget exists*,
because the clause is only true while the yielding is what you are waiting for.

**One clause, appended, and it loses to the failure clause by construction.**
`— paced against your rate limit`, added in `describeStamp` after the
failed branches have already returned, so the precedence is a property of the
code rather than an ordering somebody has to keep. It names no number and no
duration: #28 story 109 asks for the state to be stated and not every
adjustment narrated, and the interval moves on every poll. A failure and a yield
can both be true — a failed read does not stop the poller yielding — and of the
two the failure is the one about what is on screen, while the budget is about
what comes next.

*Paced against* rather than *waiting for the reset*, because the clause has to
be true everywhere the flag is. The budget wins the `max` the moment it beats
the rung it is over, which over an hour is `remaining == 1119` while focused —
a sixty-one-second interval, a hundred and nineteen points clear of the reserve,
and nothing at all is being waited for. A clause that announced the far end of
the curve would be wrong across most of it, and the reset is what the *age* on
the same stamp reports on anyway, by growing.

**`epoch_from_rfc3339` is the model crate's, beside its own inverse.** Turning
GitHub's `resetAt` into a number of seconds needs a clock, so the conversion is
sited in `read.rs` on the impure side, but the *text* half is arithmetic and
belongs next to `rfc3339`, which it round-trips against in one assertion because
they are three lines apart. Hand-rolled rather than depended on, for the reason
ADR 0002 hand-rolled base64. It is strict about the one shape GitHub sends and
answers `None` to everything else, because guessing an offset and then pacing an
hour's spending against the guess costs the reserve.

**An answer that said nothing about the budget learns nothing and therefore
forgets nothing.** `Tick::Read(None)` — a `rateLimit: null`, or a `resetAt` in a
shape this build cannot read — leaves whatever was last established pacing the
loop, exactly as a `Failed` and a `NotAttempted` do. Overwriting on silence
treats *no statement* as stronger evidence than the numbers the previous answer
did establish, and the two failure modes are not symmetric: forgetting is
unbounded, because a `resetAt` that stopped parsing would leave the poller
running at the ordinary rung for the life of the process, drawing against a
reserve it no longer knows about; keeping expires by itself, because the horizon
ages against the ticks since and a horizon that has run out is already no
constraint. `budget_floor(None)` — *nothing has ever been reported* — remains
the only real *no constraint*.

## Consequences

`Floor::Never` now has one producer and one ticket waiting for it rather than
two. ADR 0007 introduced the variant partly on #39's account; #39 does not use
it, #40 still will, and this is the record that it was revisited rather than
overlooked. Nothing else about the composition moved: the `max`, the lattice,
the tie kept by the incumbent, `Held`, and the poke being a term are all
untouched, which is what ADR 0007 set out to make possible.

**ADR 0007 keeps its accepted status and carries an amendment note.** It is
overwhelmingly still in force — two reversals against a decision that also
settled the ladder, the poke as a term, the handle count and `POKE_FLOOR` is not
a superseding — but a reader who lands on it first would otherwise believe three
sentences that have stopped being true, so the header says *amended by ADR 0008*
and each of the three is marked where it stands. It is the first ADR here to
carry such a note; a later one that needs the same should follow this shape
rather than invent a second.

`the_two_floors_that_are_stubbed_cannot_change_any_answer_yet` was rewritten
rather than deleted, as `the_backoff_floor_is_stubbed_and_cannot_change_any_answer_yet`.
It keeps the failure-count × authority cross-product and the `Held::Ladder`
assertion and drops the budget dimension, which now has an answer. ADR 0007 said
the day that test failed was the day somebody should be reading it; it was.

**Whether the clause is on depends on which rung it is being compared against,
and the rung depends on the window having the operator.** That follows from the
acceptance criterion — the clause appears while the budget is the *winning term*
— and it is visible in a band: over an hour, a `remaining` between 1024 and 1119
beats the sixty-second watching rung and loses to the five-minute away rung, so
the same budget is *paced against your rate limit* in front of you and silent
behind you. That is honest as far as it goes — a floor at or under `AWAY` costs
an unfocused operator no cadence they would otherwise have had — but it means
the flag reports which term won and not how much yielding is happening. A ticket
that wanted the second thing would need a different question, not a different
copy.

**The `maps` command always answers *not yielding*.** It reads the store and has
no poller behind it, and a cached list is not a statement about an interval. So
first paint never carries the clause; it arrives with the first poll.

**The reserve is defended by this machine's clock against GitHub's `resetAt`.**
The bias is deliberately late: the horizon is anchored at `fetched_at` while the
wait is measured from a `last_tick` stamped after the read returned, so skew
makes the poller poll slightly later than necessary rather than earlier. A badly
wrong clock makes the pacing nonsense in either direction and nothing here
detects that.

**`QUERY_COST` is a measurement of today's document, not a law.** A field added
to `map-read.graphql` that pushed the cost to three would make the pacing
under-wait by a third, and the reserve property would go on passing against a
number that had stopped being true. The fixture test pins it only for as long as
somebody refreshes the fixture; the `#[ignore]`d live test is the only thing that
meets a real schema, and no runner takes it. It bounds the cost from above only,
for the `@include(if: $open)` reason above, so a schema change that made the
query *cheaper* is invisible to it — which costs nothing, because pacing for
more than a poll spends is the safe direction.

The floor is whole seconds. Below about ten seconds the true value is fractional
— 1.8 s at a full budget — and `div_ceil` rounds up, so the pacing is slightly
conservative at the top of the curve, which is exactly where the ladder wins
anyway. Sub-second smoothness would be `from_millis` with the numerator scaled,
and every row of the table would move.

`MapsView::stale` nulls `rate_limit` on a failed poll but leaves the yielding
flag alone, because a read that failed does not stop the poller yielding. That
is a judgement, and it is invisible today only because the failure clause
suppresses the budget one. A later ticket that allowed two clauses on one stamp
would have to re-argue it.

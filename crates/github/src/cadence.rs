//! How long to wait before reading again, as arithmetic.
//!
//! A pure module, and deliberately so. Nothing here opens a socket, reads a
//! clock, holds a handle or remembers anything between calls — [`interval`]
//! called twice with the same [`Cadence`] answers the same, which is what lets
//! every rung, every poke and every tie between the three floors be exercised
//! from a table on a runner that has never signed in to anything. Elapsed time
//! enters as an *argument*, exactly as [`crate::interpret_read`] takes the clock
//! its impure caller read. No clock type is so much as named in this file, and
//! `poller.rs` has a test that reads these bytes and says so.
//!
//! The shape is one line:
//!
//! ```text
//! interval = max(ladder_floor, budget_floor, backoff_floor)
//! ```
//!
//! The ladder floor answers *how often is useful*; the budget floor and the
//! backoff floor (#40) answer *what is permitted*; and `max` is how permission
//! always wins. The three are separate functions meeting in exactly one array so
//! each can be argued about alone — which is the whole reason the composition
//! point landed in #38 with two of its three terms stubbed.
//!
//! #39 filled the budget one in, and the row of the array it edited is none:
//! two constants ([`RESERVE`], [`QUERY_COST`]) and a body. #40 filled the
//! backoff one in and edited exactly the one row ADR 0007 foresaw, because a
//! failure count can say *back off further* and can never say *stop* — so
//! [`backoff_floor`] is handed the last [`Fault`] as well. Nothing else about
//! the `max`, the lattice, [`Held`] or the poke-as-a-term moved, which is what
//! the composition was arranged to make unnecessary.
//!
//! A poke does not skip that composition. It **lowers the ladder term** to
//! [`POKE_FLOOR`] and goes through the same `max` as everything else, so no
//! amount of poking can out-poll #39's budget or #40's backoff. That is also
//! what lets #19 §5's *agent pokes respect backoff, human pokes clear it*
//! arrive later as [`backoff_floor`] reading the [`Authority`] it is already
//! handed, rather than as a second code path someone has to remember to guard.
//!
//! **Run-liveness is a count of live runs and never a flag anyone sets.** The
//! plausible-looking wrong producer is `NodeState::Claimed` — a claimed ticket
//! looks like work in progress and is not: `crates/model/src/derive.rs` already
//! records that claimed is an assignment and liveness is a process, and a reader
//! who arrives at this file never opens that one. The number here is how many
//! `RunHandle`s `poller.rs` has outstanding, and there is no setter for it in
//! this crate.

use std::time::Duration;

use perseverance_model::{epoch_from_rfc3339, Degraded};

/* --------------------------------------------------------- the numbers --- */

/// Something is changing the map right now, and ten seconds is the promise that
/// you see it change. `read.rs` records a whole-query latency of ~0.4 s, so this
/// is roughly twenty-five times the cost of asking.
pub const RUN_LIVE: Duration = Duration::from_secs(10);

/// Open, focused, and only GitHub can change it. Somebody else closing an issue
/// in a browser is the whole of what a minute might miss.
pub const WATCHING: Duration = Duration::from_secs(60);

/// Nobody is looking. Being right costs more than it is worth here, and the
/// staleness this buys is repaid the moment attention comes back — the poke on
/// the way in fires a read before your eyes have settled.
pub const AWAY: Duration = Duration::from_secs(5 * 60);

/// Not a rung: the floor a poke lowers the ladder *to*.
///
/// One second is two whole queries at the latency `read.rs` records. It is not
/// zero because alt-tabbing across a window twice a second is an ordinary thing
/// to do, and [`budget_floor`] is now what stops even that from reaching the
/// reserve. Measured from the *last tick*, so any real absence longer than a
/// second still fires immediately — `saturating_sub` bottoms out at zero.
pub const POKE_FLOOR: Duration = Duration::from_secs(1);

/// The points this poller may never touch.
///
/// **Not a threshold.** Nothing branches on it; it is a subtraction inside one
/// formula, and the poller's stopping *at* it is what that formula does at its
/// limit rather than a case somebody wrote.
///
/// A thousand, because the operator's own agents draw on the same pool. Every
/// `gh` call an agent session makes is spent from the same five thousand points
/// an hour this loop is pacing itself against — so a harness that polled its way
/// to zero would have taken the agents' budget in order to draw a picture of
/// what the agents were doing. That is also the whole reason the poller is what
/// yields: it is the only spender here that can be told to.
pub const RESERVE: u32 = 1_000;

/// The first wait after a read that failed, and every wait after that doubles.
///
/// Ten seconds because it is the fastest rung, so one failure costs a tick and
/// no more; the doubling is what makes an outage cheap rather than the first
/// number being large. An hour offline costs about a dozen requests instead of
/// three hundred and sixty.
pub const BACKOFF_BASE: Duration = Duration::from_secs(10);

/// Where the doubling stops.
///
/// Five minutes is the slowest rung, which is the point: however long an outage
/// lasts, recovery after it is bounded by the longest wait this app would have
/// taken anyway. An uncapped doubling reaches a day inside a morning, and a
/// poller that needs a restart to notice the network came back is the one
/// failure this whole floor exists to avoid.
pub const BACKOFF_CAP: Duration = Duration::from_secs(5 * 60);

/// What one poll costs, in points.
///
/// A measurement rather than a policy: `rateLimit { cost }` on the checked-in
/// answer says two, `read.rs` pins that against the fixture, and the live test
/// there asserts the real schema has not repriced the query *above* it. The
/// live bound is one-sided on purpose — that call opens no map, and
/// `map-read.graphql` guards the whole issue subtree behind `@include(if:
/// $open)`, so it sends a strictly smaller query than the fixture was captured
/// from and may honestly cost less.
///
/// That two-point measurement was recorded before #61 raised both `labels`
/// ceilings from ten to a hundred — one of them nested under `subIssues(first:
/// 100)` — and neither guard can see the reprice: the fixture is a recording of
/// the older document, and the live bound's call opens no map, so
/// `@include(if: $open)` skips the whole subtree the bump lives in. The risk
/// runs one way, towards under-waiting, and the number wants re-measuring the
/// next time a signed-in machine runs that ignored test with a map open.
///
/// A constant rather than the `cost` the last answer happened to report. An odd
/// answer saying zero would remove the pacing entirely — the failure mode being
/// *spend everything*, silently — and *two points per poll* is the sentence the
/// formula below is written to be readable as.
pub const QUERY_COST: u32 = 2;

/* ----------------------------------------------------------- the state --- */

/// Whether the window has the operator.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Attention {
    Focused,
    Unfocused,
}

/// Who asked for the off-cadence read.
///
/// Both authorities lower the ladder identically. They stop being the same one
/// term over: [`backoff_floor`] reads this and answers zero for a person and
/// nothing at all for a machine, which is #19 §5's *agent pokes respect
/// backoff, human pokes clear it*. Carrying it through #38 unused is what let
/// #40 fill a floor in rather than thread a new argument through everything.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Authority {
    Human,
    Agent,
}

/// Which rung of the ladder this app is standing on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rung {
    Away,
    RunLive,
    Watching,
}

/// A lower bound on the wait, or a refusal to poll at all.
///
/// `Never` has two producers, and they are the two things no amount of waiting
/// improves: nothing being watched, and a read that failed for a reason
/// retrying cannot fix. #38 expected #39 to be the second and it was not, for a
/// reason [`budget_floor`] argues at length — `Never` is absorbing, and a floor
/// that stops the loop stops the read that would have told it to start again.
/// A budget that has run out is a long wait with an end on it; a revoked token
/// is not, and neither is a repository that has gone.
///
/// What keeps *absorbing* from meaning *dead* here is the clause above it:
/// [`Authority::Human`] answers zero, so a person saying *try now* is always
/// able to get out of it. That is the difference between the two cases — a
/// budget resets by itself and needs no operator, and an auth failure needs one
/// and has one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Floor {
    AtLeast(Duration),
    Never,
}

/// Which term of the `max` is holding the interval down.
///
/// Reported rather than discarded because #39 needs it: the *paced against your
/// rate limit* clause appears only while the budget is the winning term, and a
/// composition that answered with a bare `Duration` would leave that clause with
/// nothing to key on. `poller.rs` asks for it about the wait a tick is handing
/// over to and never about the one it waited out — the tense is argued there.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Held {
    Ladder,
    Budget,
    Backoff,
}

/// The answer: how long, and which floor decided it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Interval {
    pub wait: Floor,
    pub held_by: Held,
}

/// The two numbers [`budget_floor`] is a function of.
///
/// `seconds_to_reset` rather than `reset_at`, because the text GitHub sent is
/// only a duration once somebody has read a clock, and this module has none.
/// `poller.rs` does the conversion and ages the horizon against its own last
/// tick, which is what makes this number mean *from the tick the wait is
/// measured from* rather than *from whenever you happen to be asking*.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Budget {
    pub remaining: u32,
    pub seconds_to_reset: i64,
}

/// Everything the interval is a function of, and nothing else.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cadence {
    /// Whether anything at all is being watched. A launcher with no folder
    /// picked has no repository to ask about, and asking about one nobody chose
    /// is worse than not asking.
    pub anything_to_read: bool,

    /// A count, not a flag. The `> 0` is the ladder's rule and it lives in
    /// exactly one place, [`Rung::of`]. There is no setter for this anywhere in
    /// the crate: the number is how many `RunHandle`s are alive.
    ///
    /// **`NodeState::Claimed` is not a producer for this.** A claimed ticket is
    /// an assignment and a live run is a process; a ladder that polled every ten
    /// seconds because somebody assigned themselves an issue last week would be
    /// spending the budget on a promise. Runs arrive with the sessions that make
    /// them observable (#47).
    pub runs_live: usize,

    pub attention: Attention,

    /// Somebody asked for a read off-cadence, and who they were.
    pub poke: Option<Authority>,

    /// What the last answer that said anything about the rate limit said, aged
    /// to this tick. `None` only while *nothing has ever been reported*, which
    /// is *no constraint* rather than *stop*. An answer that carried no
    /// `rateLimit` at all does not empty this: it learned nothing, and nothing
    /// learned is not evidence against what was.
    pub budget: Option<Budget>,

    /// How many reads in a row did not land. The doubling is a function of
    /// this and of nothing else.
    ///
    /// It is a count and stays one. What *kind* of failure it was lives in
    /// [`Cadence::last_fault`] beside it — the field #38 predicted and #40
    /// added — because a count can say *back off further* and can never say
    /// *stop*, and folding the two together would make the doubling
    /// unreadable.
    pub consecutive_failures: u32,

    /// What the last read that failed failed *of*, or `None` if the last one
    /// landed.
    ///
    /// A [`Fault`] and not a [`Degraded`]: this module has no clock, so the one
    /// clock-bearing field is reduced to seconds by the caller that has one.
    /// Exactly the move [`Budget`] made against GitHub's `resetAt`.
    ///
    /// Cleared by a read that succeeded and by a human poke, and by nothing
    /// else. It is not cleared by [`Tick::NotAttempted`]: a launch whose
    /// harvest has not settled learned nothing, and nothing learned is not
    /// evidence against what was.
    ///
    /// [`Tick`]: crate::Tick
    pub last_fault: Option<Fault>,
}

/// The model's [`Degraded`], with its one clock-bearing field already reduced
/// to seconds by the caller that has a clock.
///
/// Two enums for one taxonomy, and the split is the same one [`Budget`] made
/// against GitHub's `resetAt`: text is only a duration once somebody has read a
/// clock, and this module deliberately has none. [`Degraded`] crosses the seam
/// and carries a stamp because a stamp is what a WebView renders; this is the
/// same four conditions in the units the arithmetic is done in.
///
/// `Fault` rather than `Failed`, because [`crate::Tick::Failed`] already exists
/// next door and two `Failed`s in one crate is a name nobody can read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fault {
    Unreachable,
    AuthFailed,
    MapGone,
    RateLimited { seconds_to_reset: i64 },
}

impl Fault {
    /// One exhaustive match, so a fifth [`Degraded`] variant is a compile error
    /// here rather than a condition that quietly retries forever.
    ///
    /// A `RateLimited` that named no moment becomes zero seconds, which is *no
    /// constraint from the header* and not *the reset is now* — the two read
    /// alike only because the doubling is the other term of the `max` below,
    /// and zero cannot win a `max`. A header nobody sent leaves the backoff a
    /// run of failures already earned exactly as it was.
    pub fn of(degraded: &Degraded, now: i64) -> Fault {
        match degraded {
            Degraded::Unreachable => Fault::Unreachable,
            Degraded::AuthFailed => Fault::AuthFailed,
            Degraded::MapGone => Fault::MapGone,
            Degraded::RateLimited { resets_at } => Fault::RateLimited {
                seconds_to_reset: resets_at
                    .as_deref()
                    .and_then(epoch_from_rfc3339)
                    .map(|at| at - now)
                    .unwrap_or(0),
            },
        }
    }
}

/// What the loop should do next: sleep for this long, or nothing until somebody
/// pokes it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Wake {
    WhenPoked,
    In(Duration),
}

/* ---------------------------------------------------------- the ladder --- */

impl Rung {
    /// Every rung there is. A test walks this to assert the three floors are
    /// distinct and climb.
    pub const ALL: [Rung; 3] = [Rung::Away, Rung::RunLive, Rung::Watching];

    /// The ladder, strict and top-down. The order of these clauses *is* the
    /// rule, which is why they are three `if`s in one function rather than three
    /// predicates scattered over a file.
    ///
    /// `Away` above `RunLive` is the clause worth defending. An agent working
    /// while you are in another window is the *commonest* reason to be
    /// unfocused, not a rare one — a ladder that let a live run outrank
    /// attention would poll every ten seconds at a window nobody can see, for as
    /// long as the run lasts. What makes that safe is the poke on the way back:
    /// the display is right before your eyes settle either way.
    pub fn of(attention: Attention, runs_live: usize) -> Rung {
        if attention == Attention::Unfocused {
            Rung::Away
        } else if runs_live > 0 {
            Rung::RunLive
        } else {
            Rung::Watching
        }
    }

    /// A `match` rather than a lookup in a `[(Rung, Duration); 3]`, because a
    /// lookup can miss and a match cannot: a fourth rung is a compile error here
    /// rather than a rung quietly polling at whatever the fallback was.
    pub fn floor(self) -> Duration {
        match self {
            Rung::RunLive => RUN_LIVE,
            Rung::Watching => WATCHING,
            Rung::Away => AWAY,
        }
    }
}

/* ---------------------------------------------------------- the floors --- */

/// How often is *useful*. Three clauses, top-down, and the order is the rule.
///
/// `anything_to_read` is first and beats everything: a poke for a folder nobody
/// has picked is still a read of a repository nobody chose.
pub fn ladder_floor(cadence: &Cadence) -> Floor {
    if !cadence.anything_to_read {
        Floor::Never
    } else if cadence.poke.is_some() {
        Floor::AtLeast(POKE_FLOOR)
    } else {
        Floor::AtLeast(Rung::of(cadence.attention, cadence.runs_live).floor())
    }
}

/// What the budget *permits*. One formula, and no thresholds anywhere in it.
///
/// ```text
/// budget_floor = QUERY_COST / ((remaining - RESERVE) / seconds_to_reset)
/// ```
///
/// Read dimensionally it is one sentence: `remaining - RESERVE` is the points
/// this poller may spend, `seconds_to_reset` is how long they have to last, so
/// their quotient is points per second and [`QUERY_COST`] over that is *seconds
/// per poll*. Seconds per poll is the same kind of thing a rung is, which is why
/// this composes with the ladder under one `max` instead of needing a rule of
/// its own. It degrades smoothly, it has no case in it, and it recovers by
/// itself because `remaining` jumps at the reset and the subtraction notices.
///
/// **Evaluated as `COST * T / S`, never as `COST / (S / T)`.** Points per second
/// is normally far below one, so the inner division would floor to zero and take
/// the whole formula to a division by zero at a *full* budget — the state it is
/// least entitled to fail in. `div_ceil` for the reason a floor is a floor:
/// rounding down is overspending.
///
/// **At the reserve it waits the reset out, and it does not answer
/// [`Floor::Never`].** ADR 0007 expected `Never` here and this is where that
/// expectation was revisited rather than forgotten. `Never` is an *absorbing*
/// state: [`later_of`] lets it dominate every `AtLeast`, so a budget answering
/// `Never` means no tick, therefore no read, therefore no fresher `remaining`
/// ever arrives, and no poke and no rung can get under it — the poller would be
/// dead for the life of the process, and the one thing this ticket must not do
/// is need an operator to restart it. So the answer at the reserve is
/// `seconds_to_reset`: wait, exactly, for the thing being waited for.
///
/// That is the same statement as the formula rather than a second rule. `2T/S`
/// exceeds `T` only when fewer than two points are left, so the `min` is a
/// no-op everywhere except within one poll of the reserve, where it says the
/// thing that was true anyway — waiting past the reset you are waiting for is
/// waiting on numbers that are somebody else's. And it satisfies the criteria
/// together: zero polls between now and the reset, so zero points drawn; the one
/// poll it does schedule lands *at* the reset, when the budget has refilled; and
/// it lands late rather than early, because the horizon is measured from when
/// the answer arrived while the wait is measured from a tick stamped after the
/// read returned.
pub fn budget_floor(budget: Option<Budget>) -> Floor {
    // Nothing has ever been reported. Silence is no constraint: a floor that
    // read it as *stop* would stop the read that would have told it otherwise.
    // An answer that merely *said* nothing does not reach here — `poller.rs`
    // keeps the last numbers across one, because forgetting them is unbounded
    // and keeping them expires by itself as the horizon ages out.
    let Some(budget) = budget else {
        return Floor::AtLeast(Duration::ZERO);
    };

    // A reset already in the past, or a clock skewed far enough to put one
    // there, is no horizon — and no horizon is no constraint.
    let to_reset = u64::try_from(budget.seconds_to_reset).unwrap_or(0);
    // Saturating, because `remaining` is unsigned and an operator's agents can
    // put it under the reserve between two polls.
    let spendable = u64::from(budget.remaining.saturating_sub(RESERVE));

    // `max(1)` is a division guard spelled as an expression, and deliberately
    // not a case: at the reserve it evaluates to `2T`, which the clamp on the
    // next line reduces to `T` — the same answer the curve is already heading
    // for, by the same arithmetic every other point of it takes.
    let paced = u64::from(QUERY_COST)
        .saturating_mul(to_reset)
        .div_ceil(spendable.max(1));

    Floor::AtLeast(Duration::from_secs(paced.min(to_reset)))
}

/// What reachability *permits*. Four clauses, top-down, and the order is the
/// rule — the same idiom [`ladder_floor`] uses, for the same reason.
///
/// **1. A person saying *try now* clears everything, including a stop.** This
/// is #19 §5's *same mechanism, different authority* landing as a floor reading
/// the [`Authority`] it was already handed, rather than as a second code path
/// somebody has to remember to guard. It is first because it has to outrank the
/// [`Floor::Never`] below it: `Never` is absorbing, and a stopped poller with
/// no way out is a poller that needs the app restarted.
///
/// **It also outranks the `Retry-After` in clause 3, and that is a real trade
/// rather than an oversight.** #19 §5 asks for the header to be honoured
/// exactly in one row and for a human poke to clear the backoff in another, and
/// a focus regained inside a pause GitHub asked for cannot satisfy both. It is
/// resolved in favour of the person, because *exactly* is a rule about what
/// this app schedules for itself and a poke is somebody in front of the window
/// asking for one read now — and because the alternative is a stop with no way
/// out for whatever the header said, which is the failure `Never` is placed
/// below this clause to avoid. What it costs is bounded and is not the poller's
/// pacing: [`crate::POKE_FLOOR`] is still a term in the same `max`, so clicking
/// buys at most one read a second, and [`budget_floor`] is untouched by any of
/// this — no poke has ever been able to get under the reserve.
///
/// **2. The conditions retrying cannot fix stop rather than wait longer.**
/// Backing off forever on a revoked token is silent failure wearing a retry
/// costume: the operator watches a stamp age, assumes a flaky network, and the
/// fix was one command all along. A deleted map is the same shape — gone is
/// reported as gone. These are the second producer of `Never` that ADR 0007
/// predicted and ADR 0008 narrowed to this ticket alone.
///
/// **3. A `Retry-After` is honoured exactly and never guessed at** — against
/// everything except the person in clause 1, for the reason given there — and
/// it goes through a `max` against the doubling rather than replacing it. That `max` is
/// not a second guess: it is this module's only composition rule, applied once
/// more. A header shorter than the backoff a run of failures has already earned
/// is not permission to go faster.
///
/// **4. Otherwise the doubling**, from [`BACKOFF_BASE`] and clamped at
/// [`BACKOFF_CAP`]. Zero failures is zero, which cannot beat the smallest rung
/// — so a poller that is working is paced by the ladder exactly as it was.
///
/// **An agent poke does nothing here, and that is *agent pokes respect
/// backoff*.** It falls out of not branching on it rather than out of a guard,
/// which is the difference between a rule and a thing somebody remembered.
pub fn backoff_floor(
    consecutive_failures: u32,
    poke: Option<Authority>,
    last: Option<Fault>,
) -> Floor {
    if poke == Some(Authority::Human) {
        return Floor::AtLeast(Duration::ZERO);
    }

    let doubled = doubled_backoff(consecutive_failures);

    match last {
        Some(Fault::AuthFailed) | Some(Fault::MapGone) => Floor::Never,
        Some(Fault::RateLimited { seconds_to_reset }) => Floor::AtLeast(
            // Negative is a reset already passed, which is no constraint — and
            // the doubling is what is left of the `max` when it is.
            Duration::from_secs(seconds_to_reset.max(0) as u64).max(doubled),
        ),
        Some(Fault::Unreachable) | None => Floor::AtLeast(doubled),
    }
}

/// Ten seconds at one failure, doubling, clamped at five minutes.
///
/// Saturating throughout, because `consecutive_failures` is a `u32` and an
/// outage can run away with it: a shift by more than the width of a `u64` is
/// undefined and a multiplication that wrapped would answer a *short* wait for
/// a long outage, which is the one direction that matters.
fn doubled_backoff(consecutive_failures: u32) -> Duration {
    if consecutive_failures == 0 {
        return Duration::ZERO;
    }

    let doublings = (consecutive_failures - 1).min(31);
    let seconds = BACKOFF_BASE
        .as_secs()
        .saturating_mul(2u64.saturating_pow(doublings));

    Duration::from_secs(seconds).min(BACKOFF_CAP)
}

/* ----------------------------------------------------- the composition --- */

/// `max(ladder_floor, budget_floor, backoff_floor)`, and which of them won.
///
/// One array literal and one `reduce`, so the three floors meet in exactly one
/// place and a fourth is a row rather than an edit to a nested expression.
pub fn interval(cadence: &Cadence) -> Interval {
    let floors = [
        (Held::Ladder, ladder_floor(cadence)),
        (Held::Budget, budget_floor(cadence.budget)),
        (
            Held::Backoff,
            backoff_floor(
                cadence.consecutive_failures,
                cadence.poke,
                cadence.last_fault,
            ),
        ),
    ];

    let (held_by, wait) = floors
        .into_iter()
        .reduce(later_of)
        .expect("an array literal of three is not empty");

    Interval { wait, held_by }
}

/// The lattice, stated once: [`Floor::Never`] dominates every `AtLeast`, and the
/// incumbent keeps a tie.
///
/// Written out rather than derived from variant order, because a lattice that
/// depends on where somebody typed a variant is a lattice that changes when
/// somebody tidies the enum. Keeping the incumbent on a tie is what stops
/// [`Held::Budget`] being reported as the winner while it merely *equals* the
/// rung — which matters the day #39 puts a clause on screen behind that answer.
fn later_of(held: (Held, Floor), against: (Held, Floor)) -> (Held, Floor) {
    match (held.1, against.1) {
        (Floor::Never, _) => held,
        (_, Floor::Never) => against,
        (Floor::AtLeast(incumbent), Floor::AtLeast(challenger)) => {
            if challenger > incumbent {
                against
            } else {
                held
            }
        }
    }
}

/// How long the loop may sleep, given what it last did and when.
///
/// `since_last_tick` and `debounce_left` are arguments for the same reason
/// `fetched_at` is one: this module has no clock, and the caller that has one
/// hands the numbers in.
///
/// `saturating_sub` is where *you were away longer than the new rung, so read
/// now* becomes [`Duration::ZERO`] — which is the whole of the immediate fire on
/// focus regained, falling out of the arithmetic rather than being an exception
/// bolted beside it. A tick that has never happened passes [`Duration::MAX`] and
/// is therefore due.
///
/// The `min` against `debounce_left` is what keeps a debounce from ever
/// *delaying* an ordinary tick: whichever deadline is nearer is the one slept
/// to, and the loop works out which of the two it woke for.
pub fn next_wake(
    interval: Interval,
    since_last_tick: Duration,
    debounce_left: Option<Duration>,
) -> Wake {
    let due_in = match interval.wait {
        Floor::Never => None,
        Floor::AtLeast(wait) => Some(wait.saturating_sub(since_last_tick)),
    };

    match (due_in, debounce_left) {
        (None, None) => Wake::WhenPoked,
        (None, Some(left)) => Wake::In(left),
        (Some(due), None) => Wake::In(due),
        (Some(due), Some(left)) => Wake::In(due.min(left)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Watching, focused, nothing running, nothing poked, nothing failed. Every
    /// table below varies one field of this and says which.
    fn watching() -> Cadence {
        Cadence {
            anything_to_read: true,
            runs_live: 0,
            attention: Attention::Focused,
            poke: None,
            budget: None,
            consecutive_failures: 0,
            last_fault: None,
        }
    }

    /// Every condition a read can have failed of, so the tables below cross all
    /// four rather than the two somebody thought of.
    const FAULTS: [Fault; 4] = [
        Fault::Unreachable,
        Fault::AuthFailed,
        Fault::MapGone,
        Fault::RateLimited {
            seconds_to_reset: 30,
        },
    ];

    #[test]
    fn the_ladder_is_read_top_down_and_the_order_is_the_rule() {
        // Every rung, in one table, so the precedence is visible as precedence
        // rather than as five tests that happen to disagree about which wins.
        let rungs = [
            (true, Attention::Focused, 0, None, Floor::AtLeast(WATCHING)),
            (true, Attention::Focused, 1, None, Floor::AtLeast(RUN_LIVE)),
            (true, Attention::Focused, 7, None, Floor::AtLeast(RUN_LIVE)),
            (true, Attention::Unfocused, 0, None, Floor::AtLeast(AWAY)),
            // The clause the design defends: unfocused beats a live run, because
            // an agent working while you are elsewhere is the ordinary case.
            (true, Attention::Unfocused, 1, None, Floor::AtLeast(AWAY)),
            (
                true,
                Attention::Focused,
                0,
                Some(Authority::Human),
                Floor::AtLeast(POKE_FLOOR),
            ),
            (
                true,
                Attention::Unfocused,
                1,
                Some(Authority::Agent),
                Floor::AtLeast(POKE_FLOOR),
            ),
            // Nothing picked outranks every one of them.
            (
                false,
                Attention::Focused,
                1,
                Some(Authority::Human),
                Floor::Never,
            ),
        ];

        for (anything_to_read, attention, runs_live, poke, expected) in rungs {
            let cadence = Cadence {
                anything_to_read,
                runs_live,
                attention,
                poke,
                ..watching()
            };
            assert_eq!(ladder_floor(&cadence), expected, "{cadence:?}");
        }
    }

    #[test]
    fn every_rung_has_its_own_floor_and_they_climb() {
        // A fourth rung with no floor is already a compile error. This is the
        // other failure: a fourth rung that shares a floor with an existing one,
        // which is a rung that changes nothing and reads as though it does.
        let floors: Vec<Duration> = Rung::ALL.iter().map(|rung| rung.floor()).collect();
        for (index, one) in floors.iter().enumerate() {
            for other in &floors[index + 1..] {
                assert_ne!(one, other, "two rungs poll at the same interval");
            }
        }

        assert!(RUN_LIVE < WATCHING && WATCHING < AWAY);
        // The three numbers the ticket is named after.
        assert_eq!(RUN_LIVE, Duration::from_secs(10));
        assert_eq!(WATCHING, Duration::from_secs(60));
        assert_eq!(AWAY, Duration::from_secs(300));
    }

    #[test]
    fn the_run_live_rung_is_a_count_of_runs_and_not_a_setting() {
        assert_eq!(Rung::of(Attention::Focused, 0), Rung::Watching);
        assert_eq!(Rung::of(Attention::Focused, 1), Rung::RunLive);
        assert_eq!(Rung::of(Attention::Focused, 7), Rung::RunLive);
        // Attention first, whatever is running.
        assert_eq!(Rung::of(Attention::Unfocused, 7), Rung::Away);
    }

    #[test]
    fn a_floor_that_never_polls_beats_every_duration_in_the_max() {
        let ten = Floor::AtLeast(RUN_LIVE);
        let minute = Floor::AtLeast(WATCHING);

        assert_eq!(
            later_of((Held::Ladder, Floor::Never), (Held::Budget, minute)),
            (Held::Ladder, Floor::Never)
        );
        assert_eq!(
            later_of((Held::Ladder, minute), (Held::Budget, Floor::Never)),
            (Held::Budget, Floor::Never)
        );
        assert_eq!(
            later_of((Held::Ladder, Floor::Never), (Held::Budget, Floor::Never)),
            (Held::Ladder, Floor::Never)
        );
        assert_eq!(
            later_of((Held::Ladder, ten), (Held::Budget, minute)),
            (Held::Budget, minute)
        );
        assert_eq!(
            later_of((Held::Budget, minute), (Held::Ladder, ten)),
            (Held::Budget, minute)
        );
        // A tie keeps the incumbent, so a floor that merely equals the rung is
        // never reported as the thing holding the interval down.
        assert_eq!(
            later_of((Held::Ladder, minute), (Held::Budget, minute)),
            (Held::Ladder, minute)
        );
    }

    #[test]
    fn the_composition_names_the_floor_that_won_and_not_only_the_wait() {
        assert_eq!(
            interval(&watching()),
            Interval {
                wait: Floor::AtLeast(WATCHING),
                held_by: Held::Ladder,
            }
        );

        // And the winner follows the numbers rather than being a constant this
        // slice can get away with. #39 inherits this assertion.
        assert_eq!(
            later_of(
                (Held::Ladder, Floor::AtLeast(WATCHING)),
                (Held::Budget, Floor::AtLeast(Duration::from_secs(120))),
            ),
            (Held::Budget, Floor::AtLeast(Duration::from_secs(120)))
        );
    }

    /* ---------------------------------------------------------- #39 --- */

    /// The budget curve, from a full limit down past the reserve, as
    /// `(remaining, seconds_to_reset, the floor in seconds)`.
    ///
    /// One table shared by the assertion that pins each answer and the property
    /// that says none of them overspends, so the two cannot come to disagree
    /// about which rows exist. A full GitHub hour throughout, except the last
    /// row, which is the reserve reached mid-hour.
    const CURVE: [(u32, i64, u64); 18] = [
        (5_000, 3_600, 2),
        // The checked-in fixture's own number, so the ordinary state of this
        // machine is a row of the table rather than a thing nobody measured.
        (4_417, 3_600, 3),
        (3_000, 3_600, 4),
        (2_000, 3_600, 8),
        // Exactly the ten-second rung, which is where the composition test says
        // the incumbent keeps the tie.
        (1_720, 3_600, 10),
        (1_600, 3_600, 12),
        // And exactly the minute.
        (1_120, 3_600, 60),
        (1_100, 3_600, 72),
        (1_050, 3_600, 144),
        // And exactly the five minutes of the away rung.
        (1_024, 3_600, 300),
        (1_020, 3_600, 360),
        (1_010, 3_600, 720),
        // Two points left above the reserve, and the curve meets the horizon:
        // one poll, at the reset.
        (1_002, 3_600, 3_600),
        // One point, which cannot buy a poll at all. The clamp is what says so.
        (1_001, 3_600, 3_600),
        // THE RESERVE. Nothing above it, so nothing is spent before the reset.
        (1_000, 3_600, 3_600),
        // And below it, which an operator's own agents can put us at between two
        // polls. The same answer, from the same arithmetic, with no case in it:
        // `2T/1` clamped to `T`.
        (999, 3_600, 3_600),
        (0, 3_600, 3_600),
        (1_000, 900, 900),
    ];

    #[test]
    fn the_budget_floor_walks_down_to_the_reserve_and_stops_there() {
        let mut above: Option<(i64, u64)> = None;

        for (remaining, seconds_to_reset, expected) in CURVE {
            let budget = Budget {
                remaining,
                seconds_to_reset,
            };

            assert_eq!(
                budget_floor(Some(budget)),
                Floor::AtLeast(Duration::from_secs(expected)),
                "{budget:?}"
            );

            // And the rows are in the order they claim to be in: over one
            // horizon, fewer points can only ever mean a longer wait. This
            // compares the table to itself and so catches a re-baselined
            // column rather than a threshold — the property that no step exists
            // *between* these rows is swept over the whole input space by
            // `the_curve_has_no_step_between_the_rows_this_table_pins`.
            if let Some((horizon, sooner)) = above {
                if horizon == seconds_to_reset {
                    assert!(
                        expected >= sooner,
                        "{budget:?} polls sooner than the row with more points in it"
                    );
                }
            }
            above = Some((seconds_to_reset, expected));
        }
    }

    #[test]
    fn the_pacing_never_spends_more_than_the_points_above_the_reserve() {
        // The acceptance criterion, asserted at every point of the curve rather
        // than only at the boundary: either the affordable polls cover the whole
        // horizon, or no poll happens before the reset at all.
        for (remaining, seconds_to_reset, floor) in CURVE {
            let spendable = u64::from(remaining.saturating_sub(RESERVE));
            let horizon = seconds_to_reset as u64;
            let affordable = spendable / u64::from(QUERY_COST);

            assert!(
                floor >= horizon || affordable * floor >= horizon,
                "({remaining}, {seconds_to_reset}) paces {floor}s, which draws under the reserve"
            );
        }
    }

    #[test]
    fn the_curve_has_no_step_between_the_rows_this_table_pins() {
        /*
         * The table above pins eighteen points and compares its own literals to
         * each other, which a step function passes: a threshold is monotone, and
         * between `3_000` and `2_000` there is no row to land on. So the
         * no-step claim is made here instead, over every input rather than over
         * eighteen of them, and as *tightness* rather than as monotonicity.
         *
         * Stated as a rate, because a rate is what `div_ceil` pins. Polling once
         * every `floor` seconds for `horizon` seconds costs
         * `QUERY_COST * horizon / floor` points, and it has `spendable` to do it
         * with — so two bounds, and a threshold has to sit between them:
         *
         * - it never overspends: that cost fits, or the wait swallows the whole
         *   horizon and nothing is drawn before the reset at all; and
         * - it never over-waits: one second sooner would *not* fit, which is
         *   what says this is the shortest wait the points allow.
         *
         * `if remaining < 1_500 { AtLeast(300s) }` passes every `assert_eq!` the
         * table does not cover and passes the monotonicity loop beside it. It
         * fails the second bound here at every point of the band it invented.
         */
        let cost = u64::from(QUERY_COST);

        for seconds_to_reset in [60_i64, 900, 3_600, 7_200] {
            let horizon = seconds_to_reset as u64;
            let mut sooner: Option<u64> = None;

            for remaining in 0..=5_000_u32 {
                let budget = Budget {
                    remaining,
                    seconds_to_reset,
                };
                let Floor::AtLeast(wait) = budget_floor(Some(budget)) else {
                    panic!("{budget:?} refuses to poll at all");
                };
                let paced = wait.as_secs();
                let spendable = u64::from(remaining.saturating_sub(RESERVE));

                assert!(
                    paced >= horizon || paced * spendable >= cost * horizon,
                    "{budget:?} paces {paced}s, which draws under the reserve"
                );
                assert!(
                    paced.saturating_sub(1) * spendable < cost * horizon,
                    "{budget:?} paces {paced}s, which is longer than its own points need"
                );
                if let Some(sooner) = sooner {
                    assert!(
                        paced <= sooner,
                        "{budget:?} waits longer than the same horizon with one point fewer"
                    );
                }
                sooner = Some(paced);
            }
        }
    }

    #[test]
    fn the_reserve_is_a_thousand_points_and_a_poll_costs_two() {
        // The two numbers the formula is made of. `read.rs` is where the cost is
        // checked against what the shipped document actually spends.
        assert_eq!(RESERVE, 1_000);
        assert_eq!(QUERY_COST, 2);
    }

    #[test]
    fn a_budget_nobody_has_reported_yet_is_not_a_reason_to_stop_polling() {
        // Before anything has ever been reported, and only then — an answer
        // that carried no `rateLimit` leaves the last numbers standing next
        // door. Silence is no constraint: a floor that read it as *stop* would
        // be a poller that never made the read that would have told it
        // otherwise.
        assert_eq!(budget_floor(None), Floor::AtLeast(Duration::ZERO));
    }

    #[test]
    fn a_reset_that_has_already_come_and_gone_says_nothing_about_the_budget_now() {
        // Which is also the whole of *recovery needs no intervention*: the same
        // drained numbers, one second past the reset, ask for nothing. Nothing
        // is cleared, because there was never a flag to clear.
        let passed = [
            (1_000, 0),
            (1_000, -1),
            (5_000, -1),
            // A clock a day out. `u64::try_from` refuses it and the answer is no
            // horizon rather than a panic or a wrapped subtraction.
            (1_000, -86_400),
        ];

        for (remaining, seconds_to_reset) in passed {
            let budget = Budget {
                remaining,
                seconds_to_reset,
            };
            assert_eq!(
                budget_floor(Some(budget)),
                Floor::AtLeast(Duration::ZERO),
                "{budget:?}"
            );
        }
    }

    #[test]
    fn the_wait_is_never_longer_than_the_reset_it_is_waiting_for() {
        // Past the reset the numbers are somebody else's, so waiting beyond it
        // is waiting on nothing. It is the same statement as the formula rather
        // than a second rule: `2T/S` exceeds `T` only when fewer than two points
        // are left, which is within one poll of the reserve.
        let clamped = [
            (1_001, 1, 1),
            (1_002, 2, 2),
            // A hostile or nonsensical `resetAt`. The multiplication saturates
            // and the clamp brings it back to the horizon it was given.
            (1_001, i64::MAX, i64::MAX as u64),
        ];

        for (remaining, seconds_to_reset, expected) in clamped {
            let budget = Budget {
                remaining,
                seconds_to_reset,
            };
            assert_eq!(
                budget_floor(Some(budget)),
                Floor::AtLeast(Duration::from_secs(expected)),
                "{budget:?}"
            );
        }
    }

    #[test]
    fn nothing_being_watched_is_never_rather_than_a_long_wait() {
        let launcher = Cadence {
            anything_to_read: false,
            runs_live: 3,
            poke: Some(Authority::Human),
            ..watching()
        };

        assert_eq!(
            interval(&launcher),
            Interval {
                wait: Floor::Never,
                held_by: Held::Ladder,
            }
        );
        assert_eq!(
            next_wake(interval(&launcher), Duration::MAX, None),
            Wake::WhenPoked
        );
    }

    #[test]
    fn a_poke_lowers_the_ladder_and_cannot_get_under_the_other_two() {
        // The design's central claim: a poke is a term of the max, never a way
        // round it. #38 stood a hand-written duration where the stub would one
        // day answer; this is that duration replaced by the real reserve, so the
        // claim is now made against arithmetic rather than against a literal.
        let drained = Budget {
            remaining: RESERVE,
            seconds_to_reset: 3_600,
        };
        let poked = Cadence {
            poke: Some(Authority::Human),
            budget: Some(drained),
            ..watching()
        };
        let budget_says = budget_floor(Some(drained));

        assert_eq!(ladder_floor(&poked), Floor::AtLeast(POKE_FLOOR));
        assert_eq!(
            interval(&poked),
            Interval {
                wait: budget_says,
                held_by: Held::Budget,
            }
        );
    }

    #[test]
    fn the_budget_holds_the_interval_only_when_it_beats_the_rung_it_is_over() {
        // The clause on screen keys on `held_by`, so *which term won* is as much
        // of the acceptance criteria as the wait is. Every exact tie is here,
        // because a tie kept by the challenger would put the yielding clause on
        // a stamp while the ladder was really deciding.
        let hour = |remaining| {
            Some(Budget {
                remaining,
                seconds_to_reset: 3_600,
            })
        };

        let composed = [
            // Twelve seconds beats the ten-second rung a live run is on.
            (
                hour(1_600),
                Attention::Focused,
                1,
                None,
                Interval {
                    wait: Floor::AtLeast(Duration::from_secs(12)),
                    held_by: Held::Budget,
                },
            ),
            // Exactly the run rung. The incumbent keeps it.
            (
                hour(1_720),
                Attention::Focused,
                1,
                None,
                Interval {
                    wait: Floor::AtLeast(RUN_LIVE),
                    held_by: Held::Ladder,
                },
            ),
            // Exactly the minute.
            (
                hour(1_120),
                Attention::Focused,
                0,
                None,
                Interval {
                    wait: Floor::AtLeast(WATCHING),
                    held_by: Held::Ladder,
                },
            ),
            // Exactly the five minutes of the away rung.
            (
                hour(1_024),
                Attention::Unfocused,
                0,
                None,
                Interval {
                    wait: Floor::AtLeast(AWAY),
                    held_by: Held::Ladder,
                },
            ),
            // The same budget against the minute is the budget deciding.
            (
                hour(1_024),
                Attention::Focused,
                0,
                None,
                Interval {
                    wait: Floor::AtLeast(AWAY),
                    held_by: Held::Budget,
                },
            ),
            // A poke lowers the ladder to a second and still cannot get under
            // the reserve.
            (
                hour(RESERVE),
                Attention::Focused,
                0,
                Some(Authority::Human),
                Interval {
                    wait: Floor::AtLeast(Duration::from_secs(3_600)),
                    held_by: Held::Budget,
                },
            ),
            // And a budget nobody has reported changes nothing at all, on every
            // rung — which is what a cold start looks like.
            (
                None,
                Attention::Focused,
                0,
                None,
                Interval {
                    wait: Floor::AtLeast(WATCHING),
                    held_by: Held::Ladder,
                },
            ),
            (
                None,
                Attention::Focused,
                2,
                None,
                Interval {
                    wait: Floor::AtLeast(RUN_LIVE),
                    held_by: Held::Ladder,
                },
            ),
            (
                None,
                Attention::Unfocused,
                0,
                None,
                Interval {
                    wait: Floor::AtLeast(AWAY),
                    held_by: Held::Ladder,
                },
            ),
        ];

        for (budget, attention, runs_live, poke, expected) in composed {
            let cadence = Cadence {
                budget,
                attention,
                runs_live,
                poke,
                ..watching()
            };
            assert_eq!(interval(&cadence), expected, "{cadence:?}");
        }

        // And nothing being watched still outranks a drained budget: a poller
        // reading a folder nobody picked is not made acceptable by having points
        // left to do it with.
        let launcher = Cadence {
            anything_to_read: false,
            budget: hour(RESERVE),
            ..watching()
        };
        assert_eq!(
            interval(&launcher),
            Interval {
                wait: Floor::Never,
                held_by: Held::Ladder,
            }
        );
    }

    #[test]
    fn the_stop_at_the_reserve_ends_at_the_reset_with_nothing_cleared() {
        let stopped = Cadence {
            budget: Some(Budget {
                remaining: RESERVE,
                seconds_to_reset: 3_600,
            }),
            ..watching()
        };
        let at_the_reserve = interval(&stopped);

        assert_eq!(
            at_the_reserve,
            Interval {
                wait: Floor::AtLeast(Duration::from_secs(3_600)),
                held_by: Held::Budget,
            }
        );

        // The whole recovery, as arithmetic. The wait runs out exactly when the
        // reset arrives, the poll fires unpoked, and the answer it brings back
        // carries a `remaining` that has jumped — so the ladder takes the max
        // back on the pass after it. There is no timer, no reset handler and no
        // flag, which is why there is nothing that can fail to be cleared.
        let arriving = [
            (Duration::from_secs(3_599), Wake::In(Duration::from_secs(1))),
            (Duration::from_secs(3_600), Wake::In(Duration::ZERO)),
            // And never negative, however long the machine was asleep.
            (Duration::from_secs(7_200), Wake::In(Duration::ZERO)),
            (Duration::MAX, Wake::In(Duration::ZERO)),
        ];

        for (since_last_tick, expected) in arriving {
            assert_eq!(
                next_wake(at_the_reserve, since_last_tick, None),
                expected,
                "{since_last_tick:?}"
            );
        }

        // A stopped poller still wakes for a debounce that is open, exactly as
        // #38 already held — it is a long wait and not a refusal.
        let debounce = Duration::from_millis(40);
        assert_eq!(
            next_wake(at_the_reserve, Duration::ZERO, Some(debounce)),
            Wake::In(debounce)
        );

        // And once the reset has passed, the same drained numbers ask for
        // nothing: the ladder is back, with nothing having been told about it.
        let recovered = Cadence {
            budget: Some(Budget {
                remaining: RESERVE,
                seconds_to_reset: -1,
            }),
            ..stopped
        };
        assert_eq!(
            interval(&recovered),
            Interval {
                wait: Floor::AtLeast(WATCHING),
                held_by: Held::Ladder,
            }
        );
    }

    #[test]
    fn the_wait_is_measured_from_the_last_tick_and_never_goes_negative() {
        let away = Interval {
            wait: Floor::AtLeast(AWAY),
            held_by: Held::Ladder,
        };
        let minute = Interval {
            wait: Floor::AtLeast(WATCHING),
            held_by: Held::Ladder,
        };
        let stopped = Interval {
            wait: Floor::Never,
            held_by: Held::Budget,
        };
        let debounce = Duration::from_millis(40);

        let waits = [
            // Never ticked, so due now rather than a rung from now.
            (minute, Duration::MAX, None, Wake::In(Duration::ZERO)),
            // Back from five minutes away: the wait is already spent.
            (away, AWAY, None, Wake::In(Duration::ZERO)),
            (
                minute,
                Duration::from_secs(10),
                None,
                Wake::In(Duration::from_secs(50)),
            ),
            (stopped, Duration::MAX, None, Wake::WhenPoked),
            // A floor that says never still wakes for a debounce that is open.
            (stopped, Duration::MAX, Some(debounce), Wake::In(debounce)),
            // And a debounce that closes sooner than the rung is what is slept
            // to, so an ordinary tick can never be delayed by one.
            (
                minute,
                Duration::from_secs(10),
                Some(debounce),
                Wake::In(debounce),
            ),
        ];

        for (interval, since_last_tick, debounce_left, expected) in waits {
            assert_eq!(
                next_wake(interval, since_last_tick, debounce_left),
                expected,
                "{interval:?} {since_last_tick:?} {debounce_left:?}"
            );
        }
    }

    /* ---------------------------------------------------------- #40 --- */

    #[test]
    fn the_backoff_doubles_from_ten_seconds_and_stops_climbing_at_five_minutes() {
        // `(consecutive failures, the floor in seconds)`. One table, hoisted so
        // the ladder of numbers the ticket names and the assertions that walk it
        // cannot come to disagree about which rows exist.
        const LADDER: [(u32, u64); 9] = [
            // Nothing has failed, so nothing is held back — which is what keeps
            // a working poller paced by the rung exactly as it was.
            (0, 0),
            (1, 10),
            (2, 20),
            (3, 40),
            (4, 80),
            (5, 160),
            // 320 would be the doubling; the cap is what says five minutes.
            (6, 300),
            (7, 300),
            // A `u32` an outage ran away with. Saturating arithmetic is what
            // makes this the cap rather than a wrap to something short.
            (u32::MAX, 300),
        ];

        for (failures, expected) in LADDER {
            assert_eq!(
                backoff_floor(failures, None, Some(Fault::Unreachable)),
                Floor::AtLeast(Duration::from_secs(expected)),
                "{failures} failures"
            );
            // And a run of failures nothing has classified doubles the same
            // way, rather than answering something else.
            assert_eq!(
                backoff_floor(failures, None, None),
                Floor::AtLeast(Duration::from_secs(expected)),
                "{failures} failures, unclassified"
            );
        }

        assert_eq!(BACKOFF_BASE, Duration::from_secs(10));
        assert_eq!(BACKOFF_CAP, Duration::from_secs(300));
    }

    #[test]
    fn the_conditions_retrying_cannot_fix_stop_rather_than_waiting_longer() {
        // At every count, including the first failure — where a doubling would
        // still have been short enough to read as an ordinary wait, which is
        // exactly how an operator ends up watching a stamp age for an hour with
        // a revoked token and a one-command fix.
        for failures in [0, 1, 2, 9, u32::MAX] {
            for fault in [Fault::AuthFailed, Fault::MapGone] {
                assert_eq!(
                    backoff_floor(failures, None, Some(fault)),
                    Floor::Never,
                    "{failures} {fault:?}"
                );
                assert_eq!(
                    backoff_floor(failures, Some(Authority::Agent), Some(fault)),
                    Floor::Never,
                    "an agent poke got under a stop: {failures} {fault:?}"
                );
            }
        }
    }

    #[test]
    fn a_person_saying_try_now_clears_a_backoff_and_a_machine_saying_so_does_not() {
        // The two authorities against all four conditions. #19 §5: `Signal::Idle`
        // is machine-generated and may arrive during an outage, so it must not
        // hammer a dead endpoint; a button press or a focus regained is a person
        // saying *try now*, and it clears the backoff outright — including a
        // stop, which is the only way out of one.
        for fault in FAULTS {
            for failures in [1, 5, u32::MAX] {
                assert_eq!(
                    backoff_floor(failures, Some(Authority::Human), Some(fault)),
                    Floor::AtLeast(Duration::ZERO),
                    "{failures} {fault:?}"
                );
                assert_eq!(
                    backoff_floor(failures, Some(Authority::Agent), Some(fault)),
                    backoff_floor(failures, None, Some(fault)),
                    "an agent poke changed the backoff: {failures} {fault:?}"
                );
            }
        }
    }

    #[test]
    fn the_retry_after_github_sent_is_honoured_rather_than_guessed_at() {
        // `(the seconds GitHub named, consecutive failures, the floor in seconds)`.
        let honoured = [
            // Longer than the doubling has earned, so the header decides.
            (900, 1, 900),
            (60, 1, 60),
            // Shorter than the doubling has earned, so it does not. A header
            // under the backoff a run of failures already bought is not
            // permission to go faster, and the `max` that says so is this
            // module's one composition rule applied once more.
            (5, 4, 80),
            (0, 3, 40),
            // Nothing said when, which arrives as zero seconds: no constraint
            // from the header, and the doubling is what is left of the `max`.
            (0, 1, 10),
            (0, 0, 0),
            // A reset already in the past, or a clock skewed enough to put one
            // there. No horizon is no constraint, and never a negative wait.
            (-120, 2, 20),
            (-120, 0, 0),
        ];

        for (seconds_to_reset, failures, expected) in honoured {
            assert_eq!(
                backoff_floor(
                    failures,
                    None,
                    Some(Fault::RateLimited { seconds_to_reset })
                ),
                Floor::AtLeast(Duration::from_secs(expected)),
                "{seconds_to_reset}s named, {failures} failures"
            );
        }
    }

    #[test]
    fn the_backoff_is_one_more_term_in_the_max_and_never_a_second_code_path() {
        // A backoff under the rung leaves the ladder holding the interval, and
        // the same arithmetic above the rung takes it. There is no branch
        // anywhere that says *we are backing off now*; there is a third number
        // in one `max`.
        let one_failure = Cadence {
            consecutive_failures: 1,
            last_fault: Some(Fault::Unreachable),
            ..watching()
        };
        assert_eq!(
            interval(&one_failure),
            Interval {
                wait: Floor::AtLeast(WATCHING),
                held_by: Held::Ladder,
            }
        );

        // Four failures is eighty seconds, which beats the minute.
        let four_failures = Cadence {
            consecutive_failures: 4,
            ..one_failure
        };
        assert_eq!(
            interval(&four_failures),
            Interval {
                wait: Floor::AtLeast(Duration::from_secs(80)),
                held_by: Held::Backoff,
            }
        );

        // And a stop outranks every duration under the `max`, including the
        // hour a drained budget answers with.
        let stopped = Cadence {
            last_fault: Some(Fault::AuthFailed),
            budget: Some(Budget {
                remaining: RESERVE,
                seconds_to_reset: 3_600,
            }),
            ..four_failures
        };
        assert_eq!(
            interval(&stopped),
            Interval {
                wait: Floor::Never,
                held_by: Held::Backoff,
            }
        );
        assert_eq!(
            next_wake(interval(&stopped), Duration::MAX, None),
            Wake::WhenPoked
        );

        // A person gets out of that stop, and still cannot get under the
        // reserve — because clearing the backoff is one term of the `max`
        // rather than a way around it.
        let asked = Cadence {
            poke: Some(Authority::Human),
            ..stopped
        };
        assert_eq!(
            interval(&asked),
            Interval {
                wait: Floor::AtLeast(Duration::from_secs(3_600)),
                held_by: Held::Budget,
            }
        );
    }

    #[test]
    fn every_condition_a_read_can_fail_of_becomes_a_fault_with_no_clock_in_it() {
        // The seam between the model's taxonomy and this module's arithmetic. A
        // stamp is only a duration once somebody has read a clock, and here the
        // clock is an argument — exactly the move `Budget` made against
        // GitHub's own `resetAt`.
        const NOW: i64 = 1_785_888_000;

        let converted = [
            (Degraded::Unreachable, Fault::Unreachable),
            (Degraded::AuthFailed, Fault::AuthFailed),
            (Degraded::MapGone, Fault::MapGone),
            (
                Degraded::RateLimited {
                    resets_at: Some("2026-08-05T00:01:00Z".to_string()),
                },
                Fault::RateLimited {
                    seconds_to_reset: 60,
                },
            ),
            // A reset already gone stays negative here. What that means is the
            // floor's decision, and it decides *no constraint*.
            (
                Degraded::RateLimited {
                    resets_at: Some("2026-08-04T23:59:00Z".to_string()),
                },
                Fault::RateLimited {
                    seconds_to_reset: -60,
                },
            ),
            // Nothing said when, and a stamp this build cannot read. Both are
            // *no constraint from the header*, and neither is *the reset is
            // now* — which they can share safely, because zero cannot win a
            // `max` and the doubling is the other term.
            (
                Degraded::RateLimited { resets_at: None },
                Fault::RateLimited {
                    seconds_to_reset: 0,
                },
            ),
            (
                Degraded::RateLimited {
                    resets_at: Some("the fifth of August".to_string()),
                },
                Fault::RateLimited {
                    seconds_to_reset: 0,
                },
            ),
        ];

        for (degraded, expected) in converted {
            assert_eq!(Fault::of(&degraded, NOW), expected, "{degraded:?}");
        }
    }
}

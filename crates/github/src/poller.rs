//! The loop that spends the arithmetic in [`crate::cadence`].
//!
//! Everything ambient in this slice is here and nowhere else: the one thread,
//! the one clock, and the channel every off-cadence poke arrives on. The
//! decisions are all next door — this file only reads the clock, hands the
//! numbers to [`next_wake`], and does what it was told.
//!
//! **One thread, blocking, no runtime.** `docs/adr/0003` argues this using this
//! ticket's ten-second rung as its case: a runtime acquired to make one blocking
//! request every ten seconds would be a scheduler bought to do what a thread
//! already does. That the loop is a single thread is also the whole of *no two
//! reads at once* — the read's twenty-second deadline is longer than the fastest
//! rung, so a slow answer can still be in flight when the next tick is due, and
//! a design with any concurrency in it would have to remember not to stack them.
//! This one cannot: while a read is running the loop is not back at
//! `recv_timeout` yet, pokes queue in the channel, and the next wait is stamped
//! from when the read *returned*.
//!
//! **The three pokes, and the fourth.** An adapter's `Idle` (#44), a run's
//! process exit (#47), and map-opened / focus-regained are the three the ticket
//! names. [`Poke::EnvironmentSettled`] is a fourth this slice adds: without it a
//! Windows launch spends 1.5–1.9 s harvesting, ticks with no token, and then
//! waits a whole rung before the first read anybody sees.
//!
//! **And one message that is not a poke at all.** [`Poke::RunStarted`] asks for
//! no read; it exists because a wait already scheduled cannot be shortened by a
//! number changing behind the loop's back. The count lives in an atomic that is
//! read at the top of every pass, so a run that begins while the loop is parked
//! on the sixty-second rung would otherwise reach the ten-second rung a whole
//! minute late. Both edges of a run therefore arrive on this channel — the
//! rising one to be recomputed against, the falling one to be read after.
//!
//! **Two of them still have no producer, and now for two different reasons.**
//! `crates/pty` cannot yet spawn anything, so a child process ending is
//! something this loop is *told about* rather than something anything can
//! observe — that waits on #47. `Signal::Idle` is a settled decision rather than
//! a gap: #44 landed the adapter contract and the one adapter in the tree, and
//! Claude Code takes the default `watch`, which classifies nothing. The whole
//! out-of-band tier is cut from v1, a live signal would mean only *poll sooner*,
//! and polling never stopped — so a run that raises no signal is not a degraded
//! run. The type is here and unproduced on purpose.
//!
//! Either way the seam is a channel and a handle rather than a subscription, so
//! #46 and #50 can hang a producer on it without this crate learning what a
//! session or a PTY is.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::cadence::{
    interval, next_wake, Attention, Authority, Budget, Cadence, Fault, Held, Wake,
};

/// Everything that reaches the loop off-cadence.
///
/// One channel rather than several, so a poke and a due tick are the same
/// wake-up and there is no second scheduling mechanism to keep in step with the
/// first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Poke {
    /// The window gained or lost the operator. Losing is not really a poke — it
    /// only changes which rung the ladder is on; gaining is.
    Attention(Attention),

    /// What the WebView is looking at. `None` is the launcher with nothing
    /// picked, which is the state whose ladder floor is *never*.
    Watching(Option<Watched>),

    /// An adapter said the session went quiet. #44's `Signal::Idle`, debounced
    /// here rather than there — see [`Timings::idle_debounce`].
    Idle,

    /// A run's child process began. Sent by [`Poker::run_started`] and by
    /// nothing else. Not a request to read — the ladder has just climbed to the
    /// ten-second rung and this is what gets the loop back to
    /// [`crate::cadence::interval`] to notice, rather than leaving it asleep on
    /// the wait it computed when there was nothing running.
    RunStarted,

    /// A run's child process ended. Sent by [`RunHandle`]'s `Drop` and by
    /// nothing else, so it cannot be forgotten and cannot be sent twice.
    RunExited,

    /// The harvest settled and `gh` has been asked. Not one of the ticket's
    /// three, and the module doc says why it is here anyway.
    EnvironmentSettled,

    /// Somebody is about to spawn and will not until this pass has answered.
    ///
    /// The only poke anybody waits on, and the read it buys is the ordinary one
    /// — same thread, same closure, same emits — so what it learns reaches the
    /// graph and the ledger by the route every other pass uses and this carries
    /// nothing back but the outcome. See [`Poker::revalidate`].
    Revalidate(Reply),
}

/// Where an awaited pass sends its outcome.
///
/// **The reply rides in the enum rather than on a second channel**, because a
/// second channel is a second thing to wake on and this loop has one
/// `recv_timeout` and no runtime to select with. That costs [`Poke`] nothing:
/// the derives every test in this file compares pokes with are kept by writing
/// the two impls below by hand rather than by dropping them. A `Sender` has no
/// identity of its own to compare on this toolchain, so the equality is the one
/// a shared handle does have: two requests are the same request when they are
/// the same allocation.
#[derive(Debug, Clone)]
pub struct Reply(Arc<Sender<Tick>>);

impl PartialEq for Reply {
    fn eq(&self, other: &Reply) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

impl Eq for Reply {}

/// What an awaited pass came to, from the asker's side.
///
/// Two answers rather than one, because *the deadline ran out* is not a tick.
/// [`crate::ladder_floor`] answers `POKE_FLOOR` for a poked pass and the budget
/// and backoff floors answer far more, so a wait with no end is a button that
/// hangs — and a caller that could not tell a held-up pass from a read would
/// spawn on evidence it never got.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Revalidated {
    /// A pass ran on the poller's thread inside the deadline, and this is what
    /// it came to. `NotAttempted` is one of these: a launch whose harvest has
    /// not settled has not failed to read GitHub, and it is still not a read.
    Ticked(Tick),

    /// The deadline ran out with no pass having landed — held under a floor, or
    /// queued behind a read already in flight. Nothing failed and nothing is
    /// known.
    NotInTime,
}

impl Revalidated {
    /// Whether this answer is a **fresh read of GitHub**, which is the only
    /// thing a caller about to spawn may act on.
    pub fn is_fresh(&self) -> bool {
        matches!(self, Revalidated::Ticked(Tick::Read(_)))
    }
}

/// The repository the poller is reading, and the map inside it if one is open.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Watched {
    pub folder_id: i64,

    /// Carried, not yet spent. The read this slice performs asks for the map
    /// list only; opening a map is #33's derivation and the ticket that lands
    /// it. Changing it is still a poke, because a different map has never been
    /// read at all.
    pub map: Option<u64>,
}

impl Poke {
    /// Who asked, as a table over *what* asked rather than as a field beside it.
    ///
    /// A field could disagree with the reason; an exhaustive `match` cannot.
    /// `None` for the three that change what the ladder is a function of
    /// without anybody asking for a read. Losing the window, declaring nothing
    /// watched and starting a run all move the ladder; none of them is a reason
    /// to reach for GitHub before the rung they moved it to says so.
    ///
    /// [`crate::backoff_floor`] is what reads this, and [`Watch::apply`] is the
    /// other half: #19 §5's *agent pokes respect backoff, human pokes clear it*
    /// is this table, a floor clause, and one assignment, and nothing else.
    pub fn authority(&self) -> Option<Authority> {
        match self {
            Poke::Attention(Attention::Focused) => Some(Authority::Human),
            Poke::Attention(Attention::Unfocused) => None,
            Poke::Watching(Some(_)) => Some(Authority::Human),
            Poke::Watching(None) => None,
            Poke::RunStarted => None,
            // A person pressed a button and is watching a spinner, so it clears
            // a backoff exactly as opening a folder does.
            Poke::Revalidate(_) => Some(Authority::Human),
            Poke::Idle | Poke::RunExited | Poke::EnvironmentSettled => Some(Authority::Agent),
        }
    }
}

/// What one tick came to.
///
/// Three outcomes rather than a `Result`, because *nothing was attempted* is
/// neither of the other two: a launch whose harvest has not settled has not
/// failed to read GitHub, it has not asked yet. `crates/app`'s token branch
/// already makes that distinction and this carries it.
///
/// **`Failed` carries what failed**, because a count can only ever say *wait
/// longer* and two of the four conditions have to say *stop*. It carries a
/// [`Fault`] rather than the model's `Degraded` for one reason: this enum is
/// `Copy` and the loop passes it around by value, while a `Degraded` owns a
/// `String`. The conversion happens once, in the tick, at the only place that
/// has a clock to resolve a stamp against.
///
/// Nothing here classifies. The tick is handed a classification the crate that
/// established the failure made, which is what keeps one taxonomy from becoming
/// two.
///
/// **A read carries what it saw of the budget back with it**, which is #39's
/// one change to this shape. #38 left this a unit-ish enum and the numbers a
/// read parsed had no route into the loop at all; the tick that parsed them is
/// the only thing that ever holds them, so the return is where they travel.
///
/// `Read(None)` is an answer that carried no `rateLimit` — a `rateLimit: null`,
/// or a `resetAt` in a shape this build cannot read. It **learns nothing and
/// therefore forgets nothing**: whatever was last established still paces the
/// loop, exactly as it does across a `Failed` and a `NotAttempted`. An answer
/// that said nothing about the budget is not stronger evidence than the numbers
/// the previous answer did establish, and treating it as *no constraint* is
/// unbounded — a `resetAt` that stopped parsing would leave the poller running
/// at the ordinary rung for the life of the process. Keeping the last numbers
/// is bounded in the other direction, and bounded by itself: the horizon ages
/// against the ticks since, and a horizon that has run out is already no
/// constraint. It is [`crate::budget_floor`] answering `None` — nothing has
/// *ever* been reported — that is the real *no constraint*.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tick {
    Read(Option<Budget>),
    Failed(Fault),
    NotAttempted,
}

/// The one number the loop's timing takes from outside itself.
///
/// It carries the idle debounce and nothing else, on purpose. The three rungs
/// are **not** here and must not move here: a ladder that can be configured from
/// outside the crate is not a ladder anybody can reason about, and the whole
/// argument for the three numbers is in `cadence.rs` beside them.
///
/// This exists so a test can close the window in forty milliseconds instead of
/// one second. [`Timings::shipped`] is what the app passes, and it is pinned by
/// its own assertion so an injected value cannot quietly become the real one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Timings {
    /// How long an adapter has to stay quiet before an `Idle` counts.
    ///
    /// Trailing edge: a second `Idle` inside the window restarts it, so an
    /// adapter that chatters never converts one. The debounce can only ever
    /// *delay* a read and never advance one — the ordinary rung stays armed
    /// throughout, because [`next_wake`] sleeps to whichever deadline is nearer.
    pub idle_debounce: Duration,
}

impl Timings {
    /// One second, as the ticket names.
    pub fn shipped() -> Timings {
        Timings {
            idle_debounce: Duration::from_secs(1),
        }
    }
}

/// The handle the rest of the app pokes the loop with.
///
/// Dropping the last one disconnects the channel and the thread ends — which is
/// what makes the loop testable without a global, and what #51's *no orphans*
/// will want when runs learn how to end.
#[derive(Debug, Clone)]
pub struct Poker {
    tx: Sender<Poke>,
    live: Arc<AtomicUsize>,
}

impl Poker {
    /// Tells the loop something happened. Never fails: a poller thread that has
    /// gone is not a reason for a window event to be an error.
    pub fn poke(&self, poke: Poke) {
        let _ = self.tx.send(poke);
    }

    /// One run started. The returned handle **is** the run's liveness — hold it
    /// for as long as the child lives and drop it when the child ends.
    ///
    /// This is the only way the run-live rung can be climbed. There is no setter
    /// and no `Clone` on the handle, so *a run is live exactly while something
    /// is holding it* is a property of the type rather than a rule someone has
    /// to remember on two code paths.
    pub fn run_started(&self) -> RunHandle {
        self.live.fetch_add(1, Ordering::SeqCst);
        // The increment and the wake-up are one event, exactly as the decrement
        // and [`Poke::RunExited`] are. The count is read at the top of a pass
        // and the loop then spends the whole pass blocked, so an increment that
        // sent nothing would leave the ten-second rung waiting out whatever was
        // scheduled before the run existed — up to a minute focused, five
        // unfocused, and for a short run the rung would never engage at all.
        let _ = self.tx.send(Poke::RunStarted);
        RunHandle {
            tx: self.tx.clone(),
            live: Arc::clone(&self.live),
        }
    }

    /// One pass, awaited, for a press that is about to spawn.
    ///
    /// The re-read Start Working and Resume gate on: an ordinary poke, so the
    /// pass it buys is the ordinary pass and a lost race lands in the graph and
    /// feeds the ledger through the tick's own emits. This returns only what
    /// became of it — the caller reads what it learned where every other reader
    /// does.
    ///
    /// **A UX guard and not a correctness guard.** Two machines can revalidate
    /// in the same second and both spawn; the correctness guard is the agent's
    /// conditional claim, because the agent is the only writer.
    ///
    /// `within` is a deadline rather than a courtesy. A poked pass is still
    /// held by [`crate::ladder_floor`]'s `POKE_FLOOR`, and by the budget and
    /// backoff floors for far longer, so the answer has to be able to be
    /// [`Revalidated::NotInTime`].
    pub fn revalidate(&self, within: Duration) -> Revalidated {
        let (tx, rx) = mpsc::channel();
        // A poller thread that has gone answers nothing, which is exactly what
        // the deadline means — and is not a reason to panic on the command
        // thread.
        if self.tx.send(Poke::Revalidate(Reply(Arc::new(tx)))).is_err() {
            return Revalidated::NotInTime;
        }

        match rx.recv_timeout(within) {
            Ok(outcome) => Revalidated::Ticked(outcome),
            Err(_) => Revalidated::NotInTime,
        }
    }

    /// How many runs are live right now. The ladder's own input, exposed so the
    /// property can be asserted from outside.
    pub fn runs_live(&self) -> usize {
        self.live.load(Ordering::SeqCst)
    }
}

/// One live run, for as long as this is held.
///
/// Deliberately not [`Clone`]: two handles for one run would be two runs as far
/// as the ladder is concerned, and the count would never come back down.
#[derive(Debug)]
pub struct RunHandle {
    tx: Sender<Poke>,
    live: Arc<AtomicUsize>,
}

impl Drop for RunHandle {
    fn drop(&mut self) {
        self.live.fetch_sub(1, Ordering::SeqCst);
        // The rung has just fallen from ten seconds to sixty, and a run that has
        // just ended is the state most worth being right about. Without this the
        // finished run sits unread for the rest of a minute. The decrement and
        // the poke are one event, so they cannot disagree about when it happened.
        let _ = self.tx.send(Poke::RunExited);
    }
}

/// What the composition will answer for the wait that follows this tick, given
/// what the tick is about to return.
///
/// A query rather than a value, because the only thing that has parsed a
/// budget or classified a failure is the tick that is asking.
///
/// **It takes the whole [`Tick`]**, which is the honest widening #40 needed and
/// #39 lived without. An `Option<Budget>` could not tell *a read that reported
/// no `rateLimit`* from *nothing was attempted* — a conflation that cost
/// nothing while every failure held the same floor, and costs correctness now
/// that a failure changes which floor holds the next wait. So the value passed
/// here is literally the value the tick is about to return, and
/// [`folded`] is what both this and the loop's own bookkeeping go through, so
/// the prospective answer and the actual one cannot disagree.
pub type Ahead<'a> = dyn Fn(Tick) -> Held + 'a;

/// Starts the loop on its own named thread and hands back the way to poke it.
///
/// `tick` is what one poll *is* — the caller supplies it because reading a
/// folder needs a store, a repository binding and a token, none of which this
/// crate is allowed to reach for. It is called on the poller thread, one call at
/// a time, and never re-entered.
///
/// It is handed an [`Ahead`] rather than a bare [`Held`], and the tense is the
/// whole reason. The tick is the only thing that emits a view, and a view is
/// read by somebody who is about to wait — so what it needs is **which floor
/// holds the wait it is being emitted into**, not which one held the wait it
/// was served on. Those differ exactly where it matters: the poll that fires
/// *at* the reset was served on a budget-held hour and is the first thing to
/// see the refill, and a cold start whose first read finds the budget already
/// drained was served on a ladder-held wait and is the first thing to see the
/// drain. A value fixed before the sleep is one poll behind in both directions;
/// a query answered after the read is neither.
pub fn start<F>(timings: Timings, tick: F) -> std::io::Result<Poker>
where
    F: Fn(&Watched, &Ahead<'_>) -> Tick + Send + 'static,
{
    let (tx, rx) = mpsc::channel();
    let live = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&live);

    std::thread::Builder::new()
        .name("perseverance-poller".to_string())
        .spawn(move || pump(rx, counted, timings, tick))
        .map(|_| Poker { tx, live })
}

/// What the loop is holding between wake-ups.
///
/// A struct rather than six locals so that [`Watch::apply`] can be one
/// exhaustive `match` in one place: every poke's whole effect is in that match,
/// and a seventh poke is a compile error rather than a poke that arrives and
/// changes nothing.
/// `Clone` because the tests build variations of one watch with struct update
/// syntax, which stopped being a copy the moment a list of waiting callers
/// joined the fields.
#[derive(Clone)]
struct Watch {
    attention: Attention,
    watched: Option<Watched>,
    poke: Option<Authority>,
    idle_since: Option<Instant>,
    last_tick: Option<Instant>,
    failures: u32,
    last_fault: Option<Fault>,
    seen: Option<Seen>,
    /// Everybody waiting on the next pass. A list rather than an `Option`,
    /// because two presses inside one wait are two callers owed the same
    /// answer, and dropping one would leave a button on `checking…` until its
    /// own deadline ran out.
    awaiting: Vec<Reply>,
}

/// What a tick does to the two fields the backoff is a function of.
///
/// Extracted because it is asked twice — once prospectively by [`Watch::ahead`]
/// for the floor the tick reports, and once for real by [`pump`] — and two
/// copies of this fold are two answers that disagree about whether the poller
/// is stopped the moment somebody edits one of them.
///
/// A read resets both, which is #19 §5's *reset to zero on the first success*.
/// [`Tick::NotAttempted`] changes neither: a launch whose harvest has not
/// settled has not failed to read GitHub, and nothing learned is not evidence
/// against what was.
fn folded(failures: u32, last: Option<Fault>, tick: Tick) -> (u32, Option<Fault>) {
    match tick {
        Tick::Read(_) => (0, None),
        Tick::Failed(fault) => (failures.saturating_add(1), Some(fault)),
        Tick::NotAttempted => (failures, last),
    }
}

/// What the last answer said about the budget, and **when it said it**.
///
/// The moment is half the value. A `seconds_to_reset` is a horizon measured from
/// the read that reported it, and a [`crate::Floor`] is a wait measured from the
/// last tick — so carrying the numbers without the moment they were taken at
/// would leave nothing able to reconcile the two.
#[derive(Debug, Clone, Copy)]
struct Seen {
    budget: Budget,
    at: Instant,
}

impl Watch {
    /// Seeded focused: the window is in front of the operator when the app
    /// opens, and a launch that assumed otherwise would spend its first five
    /// minutes on the away rung waiting to be told something it already knew.
    fn new() -> Watch {
        Watch {
            attention: Attention::Focused,
            watched: None,
            poke: None,
            idle_since: None,
            last_tick: None,
            failures: 0,
            last_fault: None,
            seen: None,
            awaiting: Vec::new(),
        }
    }

    fn apply(&mut self, arrived: Poke) {
        // A person saying *try now* clears the backoff state, as well as being
        // answered zero by the floor that reads the authority. **Both, and they
        // are not the same thing.** The floor is what makes *this* wait zero;
        // the clearing is what stops the tick that poke bought from falling
        // straight back to `Never` the moment the poke is spent. Without the
        // floor, a stopped poller could not be started at all; without the
        // clearing, it could be started exactly once per click forever.
        if arrived.authority() == Some(Authority::Human) {
            self.failures = 0;
            self.last_fault = None;
        }

        match arrived {
            Poke::Attention(next) => {
                self.attention = next;
                if next == Attention::Focused {
                    self.poke = Some(Authority::Human);
                }
            }
            Poke::Watching(next) => {
                // Reverses ADR 0007's *only a changed declaration forgets the
                // last-read stamp*; `docs/adr/0008` carries that argument.
                //
                // `last_tick` is **not** cleared here, and a change of folder is
                // not an exception to that. It is the anchor every floor under
                // the `max` is measured from, and erasing it hands `next_wake` a
                // `Duration::MAX` that saturates *every* finite floor to zero —
                // including the hour `budget_floor` answers with at the reserve.
                // A folder switch would then draw two points with nothing under
                // it at all, at any budget, which is precisely what this
                // ticket's *no poke and no rung can get under the reserve* says
                // cannot happen. The rate limit is an account-wide fact and a
                // folder is not; a per-folder freshness that must short-circuit
                // the rung would have to be a field only `ladder_floor` reads,
                // never an erased anchor the other two terms are also measured
                // from.
                //
                // Nothing is lost by keeping it. A newly opened folder is still
                // read within a second, because the line below lowers the ladder
                // to `POKE_FLOOR` — the same trade ADR 0007 already took for
                // focus and idle pokes — and a genuinely cold start has a
                // `last_tick` of `None` anyway, having never ticked.
                //
                // Unconditional, and that is the point. Opening a folder is the ticket's
                // *map-opened* poke and its commonest form by far is opening the
                // folder you already had open — a person clicking the row they
                // are looking at is asking for a read, and a guard that
                // suppressed it would leave them waiting out the rung with no
                // other way in the app to ask. Clicking repeatedly costs at most
                // one read a second: `POKE_FLOOR` is what rate-limits it, and it
                // does so through the same `max` as everything else.
                self.poke = Poke::Watching(next).authority();
                self.watched = next;
            }
            // Not a poke yet. It becomes one when the adapter has been quiet for
            // the whole window; until then it is only a deadline to wake at.
            Poke::Idle => self.idle_since = Some(Instant::now()),
            // Nothing to record: the count this announces lives in the atomic
            // and is re-read at the top of every pass. Arriving *is* the whole
            // effect — it returns the loop to the composition, which recomputes
            // against the rung the new count put it on.
            Poke::RunStarted => {}
            Poke::Revalidate(reply) => {
                self.poke = Some(Authority::Human);
                self.awaiting.push(reply);
            }
            Poke::RunExited | Poke::EnvironmentSettled => {
                self.poke = arrived.authority();
            }
        }
    }

    fn cadence(&self, runs_live: usize) -> Cadence {
        Cadence {
            anything_to_read: self.watched.is_some(),
            runs_live,
            attention: self.attention,
            poke: self.poke,
            // Aged to the tick the next wait will be measured from, and to
            // nothing else. The floor next door subtracts `since_last_tick`
            // itself, so a horizon re-based to *now* would be counted twice
            // and the poll would fire at half of it — under the reserve.
            // Leaving it un-aged is the opposite error: every tick that
            // learned nothing would re-arm the whole hour, and one failed
            // poll at the reset would cost another.
            budget: self.aged_to(self.last_tick),
            consecutive_failures: self.failures,
            last_fault: self.last_fault,
        }
    }

    /// The last budget anybody reported, with the seconds between the read that
    /// reported it and `from` taken off its horizon.
    ///
    /// `None` for *from* is *before any tick*, which is also the pass the read
    /// itself was stamped on — `Seen::at` and `last_tick` are the same moment
    /// there, so nothing has aged either way.
    fn aged_to(&self, from: Option<Instant>) -> Option<Budget> {
        self.seen.map(|seen| Budget {
            seconds_to_reset: seen.budget.seconds_to_reset
                - from
                    .map(|at| at.saturating_duration_since(seen.at).as_secs() as i64)
                    .unwrap_or(0),
            ..seen.budget
        })
    }

    /// Which floor will hold the wait that follows a tick reporting `tick`.
    ///
    /// The whole of the [`Ahead`] seam, and four things separate it from
    /// [`Watch::cadence`]:
    ///
    /// - the budget is the one this very read parsed, when it parsed one. That
    ///   is what makes the poll at the reset say *not yielding* and the first
    ///   poll of a drained cold start say *yielding*;
    /// - the failure this tick is about to report is folded in, through the
    ///   same [`folded`] the loop below applies for real. A tick that failed is
    ///   the first thing to be held by the backoff it just earned, and a tick
    ///   that succeeded is the first thing not to be held by the one it just
    ///   cleared;
    /// - the poke is spent. The tick asking is the read that poke bought, so the
    ///   wait it is handing back to is on the rung and not on `POKE_FLOOR` —
    ///   without which every click at a full budget would report `Held::Budget`,
    ///   the two-second pacing having merely out-waited the one-second poke.
    ///   Spending it also stops a human poke reporting a cleared backoff for a
    ///   tick that has just failed again;
    /// - and a kept horizon ages to *now* rather than to the previous tick,
    ///   because now is the moment the next wait will be measured from.
    fn ahead(&self, runs_live: usize, tick: Tick) -> Held {
        // Only a read establishes anything about the budget. A failure and a
        // poll nobody attempted both fall back on what was last established,
        // aged to now.
        let reported = match tick {
            Tick::Read(budget) => budget,
            Tick::Failed(_) | Tick::NotAttempted => None,
        };
        let (consecutive_failures, last_fault) = folded(self.failures, self.last_fault, tick);

        let entering = Cadence {
            poke: None,
            budget: reported.or_else(|| self.aged_to(Some(Instant::now()))),
            consecutive_failures,
            last_fault,
            ..self.cadence(runs_live)
        };

        interval(&entering).held_by
    }
}

/// The loop. Every decision in it is a call into `cadence.rs`; what is left here
/// is reading the clock and doing as it is told.
fn pump<F>(rx: Receiver<Poke>, live: Arc<AtomicUsize>, timings: Timings, tick: F)
where
    F: Fn(&Watched, &Ahead<'_>) -> Tick,
{
    let mut watch = Watch::new();

    loop {
        let cadence = watch.cadence(live.load(Ordering::SeqCst));
        // A tick that has never happened is infinitely overdue, and the
        // saturating subtraction in `next_wake` turns that into *now*.
        let since = watch
            .last_tick
            .map(|at| at.elapsed())
            .unwrap_or(Duration::MAX);
        let debounce_left = watch
            .idle_since
            .map(|at| timings.idle_debounce.saturating_sub(at.elapsed()));

        let arrived = match next_wake(interval(&cadence), since, debounce_left) {
            // Nothing is being watched, so there is no deadline to keep and
            // nothing to spin on. The next thing that happens is somebody
            // telling us something.
            Wake::WhenPoked => match rx.recv() {
                Ok(arrived) => Some(arrived),
                // Every `Poker` has been dropped. There is nobody left to poll
                // for, so the thread ends rather than looping on a dead channel.
                Err(_) => return,
            },
            Wake::In(wait) => match rx.recv_timeout(wait) {
                Ok(arrived) => Some(arrived),
                Err(RecvTimeoutError::Disconnected) => return,
                Err(RecvTimeoutError::Timeout) => None,
            },
        };

        if let Some(arrived) = arrived {
            watch.apply(arrived);
            // Nothing is being watched, so the next wait is `WhenPoked` and no
            // pass will ever run to answer with. `NotAttempted` is the honest
            // answer and it is not a read, which is all a caller about to spawn
            // has to know — and it is given now rather than leaving a button on
            // `checking…` until its own deadline runs out.
            if watch.watched.is_none() {
                answer(&mut watch.awaiting, Tick::NotAttempted);
            }
            continue;
        }

        // Which of the two deadlines woke us. The debounce closing is not a
        // cadence event — it converts a quiet adapter into a poke and lets the
        // composition decide, on the next pass, whether that means read now.
        if watch
            .idle_since
            .is_some_and(|at| at.elapsed() >= timings.idle_debounce)
        {
            watch.idle_since = None;
            watch.poke = Some(Authority::Agent);
            continue;
        }

        let Some(watched) = watch.watched else {
            continue;
        };

        // The query, and it borrows `watch` — so it is scoped to the call and
        // the folding below is what mutates. `runs_live` is re-read inside it
        // rather than reused from the top of the pass, because a read takes up
        // to twenty seconds and a run can begin inside one.
        let outcome = {
            let ahead = |reported| watch.ahead(live.load(Ordering::SeqCst), reported);
            tick(&watched, &ahead)
        };
        // Stamped after the tick returned, never before it. The read's deadline
        // is twenty seconds and the fastest rung is ten, so a wait measured from
        // when the read *started* would come due while it was still running.
        let at = Instant::now();
        watch.last_tick = Some(at);
        watch.poke = None;
        // Only when the answer actually reported one. The same moment
        // `last_tick` was stamped with, so the horizon and the wait it will be
        // reconciled against start together and cannot drift by however long
        // the read took.
        if let Tick::Read(Some(budget)) = outcome {
            watch.seen = Some(Seen { budget, at });
        }
        // The same fold the tick was already answered from, applied for real.
        // `NotAttempted` changes neither field and still moves `last_tick`,
        // which is what stops a launch whose harvest has not settled from
        // spinning on a rung it can do nothing about — and the horizon ages
        // with it, because that pass consumed the same seconds a read would
        // have.
        let (failures, last_fault) = folded(watch.failures, watch.last_fault, outcome);
        watch.failures = failures;
        watch.last_fault = last_fault;
        // Last, after the pass has been folded in for real: what an awaited
        // caller is told is what the loop itself concluded, and never a
        // prediction taken before the fold.
        answer(&mut watch.awaiting, outcome);
    }
}

/// Hands one pass's outcome to everybody who was waiting on it, and forgets
/// them. A receiver that has gone is a caller whose deadline ran out first,
/// which is not this loop's problem.
fn answer(awaiting: &mut Vec<Reply>, outcome: Tick) {
    for reply in awaiting.drain(..) {
        let _ = reply.0.send(outcome);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cadence::{Floor, POKE_FLOOR, RESERVE, RUN_LIVE, WATCHING};

    /// A window small enough that a test waits milliseconds for it, and large
    /// enough that a scheduling hiccup between two sends does not close it.
    ///
    /// Every test here but one sends a single poke into it, so the only hiccup
    /// it has to survive is the one between that send and the assertion. The
    /// exception is [`an_idle_signal_waits_for_quiet_before_it_polls`], which
    /// sends a *chain* — and it does not use this window, for the reason its
    /// own comment gives.
    const WINDOW: Duration = Duration::from_millis(200);

    fn a_folder() -> Watched {
        Watched {
            folder_id: 3,
            map: None,
        }
    }

    /// A *different* one. The launcher is a list and switching rows is an
    /// ordinary click, so `next != self.watched` is a branch the tests have to
    /// take — and the budget floor is account-wide, so it must survive it.
    fn another_folder() -> Watched {
        Watched {
            folder_id: 9,
            map: None,
        }
    }

    /// A poller whose ticks are reported down a channel, so a test asserts what
    /// was read and when rather than sleeping and hoping.
    ///
    /// Its reads report **no budget**, which is also an assertion: every test
    /// below this line is #38's, unchanged, and a loop that is told nothing
    /// about the rate limit still behaves exactly as #38 left it.
    fn watched_by(timings: Timings) -> (Poker, Receiver<Watched>) {
        let (ticks, taken) = mpsc::channel();
        let poker = start(timings, move |watched, _ahead| {
            let _ = ticks.send(*watched);
            Tick::Read(None)
        })
        .expect("spawns");
        (poker, taken)
    }

    /// A poller whose reads all report the same budget, and whose ticks report
    /// back **which floor holds the wait they are handing over to**. That is the
    /// whole of #39's seam in one helper: numbers in, the winning term out.
    fn budgeted_by(budget: Budget) -> (Poker, Receiver<Held>) {
        let (ticks, taken) = mpsc::channel();
        let poker = start(Timings::shipped(), move |_watched, ahead| {
            let _ = ticks.send(ahead(Tick::Read(Some(budget))));
            Tick::Read(Some(budget))
        })
        .expect("spawns");
        (poker, taken)
    }

    /// The whole of #48's *checking…*: the press waits, the pass that answers
    /// it is a pass on the poller's own thread, and what comes back is what
    /// that pass concluded.
    #[test]
    fn an_awaited_revalidation_is_answered_by_the_pass_it_bought() {
        let (poker, taken) = watched_by(Timings::shipped());

        poker.poke(Poke::Watching(Some(a_folder())));
        taken
            .recv_timeout(Duration::from_secs(2))
            .expect("the first read");

        let answered = poker.revalidate(Duration::from_secs(5));

        assert_eq!(answered, Revalidated::Ticked(Tick::Read(None)));
        assert!(answered.is_fresh());
        // And it was a real pass rather than a value invented for the caller:
        // the tick ran, on the one thread, against the folder being watched.
        assert_eq!(
            taken
                .recv_timeout(Duration::from_secs(1))
                .expect("the revalidation's own read"),
            a_folder()
        );
    }

    /// A press with the launcher open reads nothing, and must not hang while
    /// finding that out: with nothing watched the loop parks on `recv` and no
    /// pass is ever due.
    #[test]
    fn a_revalidation_with_nothing_watched_is_answered_and_is_not_a_read() {
        let (poker, _taken) = watched_by(Timings::shipped());

        let answered = poker.revalidate(Duration::from_secs(2));

        assert_eq!(answered, Revalidated::Ticked(Tick::NotAttempted));
        assert!(!answered.is_fresh());
    }

    /// The reason the answer has a second variant at all. The floors apply to
    /// this poke exactly as they apply to every other one, so a drained budget
    /// holds the pass for an hour — and the button gets an answer in
    /// milliseconds instead.
    #[test]
    fn a_revalidation_held_under_a_floor_runs_out_rather_than_waiting_for_it() {
        let (poker, taken) = budgeted_by(Budget {
            remaining: RESERVE,
            seconds_to_reset: 3_600,
        });

        poker.poke(Poke::Watching(Some(a_folder())));
        taken
            .recv_timeout(Duration::from_secs(2))
            .expect("the first read");

        assert_eq!(
            poker.revalidate(Duration::from_millis(300)),
            Revalidated::NotInTime
        );
    }

    #[test]
    fn the_poller_stops_at_the_reserve_and_no_poke_can_get_under_it() {
        let (poker, taken) = budgeted_by(Budget {
            remaining: RESERVE,
            seconds_to_reset: 3_600,
        });

        poker.poke(Poke::Watching(Some(a_folder())));
        // A cold start whose very first read finds the budget already drained by
        // the operator's own agents. The wait it was *served* on was the
        // ladder's — nothing had been reported when it was scheduled — and the
        // hour it is handing over to is the budget's, which is what the stamp
        // has to say.
        assert_eq!(
            taken
                .recv_timeout(Duration::from_secs(2))
                .expect("the first read"),
            Held::Budget
        );

        // Waited out, so what this test times is the reserve rather than the
        // poke floor.
        std::thread::sleep(POKE_FLOOR + Duration::from_millis(100));

        // Everything anybody has to ask for a read with. A poke lowers the
        // ladder to a second and goes through the same `max` as everything else,
        // so none of these can reach GitHub with the budget at the reserve.
        poker.poke(Poke::Attention(Attention::Focused));
        poker.poke(Poke::Watching(Some(a_folder())));
        poker.poke(Poke::RunExited);
        // And the one that used to. Switching launcher rows is an ordinary
        // click, and it erased the anchor every floor is measured from — so an
        // hour-long budget floor became a wake of zero and two points were drawn
        // from under the reserve, at any budget, as fast as somebody could
        // alternate two rows.
        poker.poke(Poke::Watching(Some(another_folder())));

        assert!(
            taken.recv_timeout(Duration::from_secs(1)).is_err(),
            "a poke got under the reserve"
        );
    }

    #[test]
    fn a_budget_a_read_reported_holds_the_next_wait_and_the_tick_is_told_so() {
        // Two points above the reserve and two seconds to the reset: exactly one
        // poll is affordable and it is due at the reset. Two seconds also beats
        // the one second a poke lowers the ladder to, which is what makes this
        // one test cover the route the numbers take — what a read parsed
        // reaching the composition, and no poke getting under the answer.
        let (poker, taken) = budgeted_by(Budget {
            remaining: RESERVE + 2,
            seconds_to_reset: 2,
        });

        poker.poke(Poke::Watching(Some(a_folder())));
        taken
            .recv_timeout(Duration::from_secs(2))
            .expect("the first read");

        poker.poke(Poke::Watching(Some(a_folder())));
        assert!(
            taken.recv_timeout(Duration::from_millis(200)).is_err(),
            "the poke got under the budget"
        );

        taken
            .recv_timeout(Duration::from_millis(2_500))
            .expect("a read once the budget allowed one");
    }

    #[test]
    fn the_tick_is_told_the_floor_it_is_handing_over_to_and_not_the_one_it_waited_out() {
        /*
         * The clause on the stamp keys on this, and a view is read by somebody
         * who is about to wait. Fixing the term before the sleep makes it one
         * poll stale in both directions — and the harmful direction is the
         * false positive, because an absent true clause is quiet and a present
         * false one is not.
         */
        let drained = Budget {
            remaining: RESERVE,
            seconds_to_reset: 3_600,
        };
        let refilled = Budget {
            remaining: 5_000,
            seconds_to_reset: 3_600,
        };
        let watching = Watch {
            watched: Some(a_folder()),
            ..Watch::new()
        };

        // A cold start that finds the budget already drained. Served on the
        // ladder, handing over to an hour of the budget.
        assert_eq!(interval(&watching.cadence(0)).held_by, Held::Ladder);
        assert_eq!(watching.ahead(0, Tick::Read(Some(drained))), Held::Budget);

        // And the mirror, which is the one that puts a false sentence on a
        // stamp: the poll that fires *at* the reset was served on that
        // budget-held hour and is the first thing to see the refill. Told the
        // term that held the wait it waited out, it would say *paced against
        // your rate limit* for a whole rung after the pacing had stopped.
        let now = Instant::now();
        let stopped = Watch {
            seen: Some(Seen {
                budget: drained,
                at: now,
            }),
            last_tick: Some(now),
            ..watching.clone()
        };
        assert_eq!(interval(&stopped.cadence(0)).held_by, Held::Budget);
        assert_eq!(stopped.ahead(0, Tick::Read(Some(refilled))), Held::Ladder);

        // And the poke that bought this read is spent by it. A full budget paces
        // at two seconds and `POKE_FLOOR` is one, so the term that won the wait
        // a *click* bought is the budget — reporting that would put the clause
        // on a stamp with a completely full rate limit.
        let poked = Watch {
            poke: Some(Authority::Human),
            seen: Some(Seen {
                budget: refilled,
                at: now,
            }),
            last_tick: Some(now),
            ..watching.clone()
        };
        assert_eq!(interval(&poked.cadence(0)).held_by, Held::Budget);
        assert_eq!(poked.ahead(0, Tick::Read(Some(refilled))), Held::Ladder);

        // And the tick that *failed* is the first thing held by the backoff it
        // just earned, rather than the last thing held by the floor it waited
        // out. Four failures is eighty seconds, which beats the minute; the
        // fourth one is reported by the tick that made it the fourth.
        let failing = Watch {
            failures: 3,
            last_fault: Some(Fault::Unreachable),
            last_tick: Some(now),
            ..watching
        };
        assert_eq!(interval(&failing.cadence(0)).held_by, Held::Ladder);
        assert_eq!(
            failing.ahead(0, Tick::Failed(Fault::Unreachable)),
            Held::Backoff
        );
        // And the read that ends the run is the first thing not held by it.
        assert_eq!(failing.ahead(0, Tick::Read(None)), Held::Ladder);
    }

    #[test]
    fn an_answer_that_said_nothing_about_the_budget_does_not_unpace_the_poller() {
        /*
         * `rateLimit: null`, or a `resetAt` in a shape this build cannot read.
         * Forgetting what was established is unbounded — a stamp that stopped
         * parsing would leave the poller running at the ordinary rung for the
         * life of the process, drawing against a reserve it no longer knows
         * about — while keeping it expires by itself as the horizon ages out.
         *
         * Eighteen hundred points above the reserve over an hour paces at four
         * seconds, which is long enough to time against the one second a poke
         * lowers the ladder to.
         */
        let paced = Budget {
            remaining: RESERVE + 1_800,
            seconds_to_reset: 3_600,
        };
        let first = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&first);
        let (ticks, taken) = mpsc::channel();
        let poker = start(Timings::shipped(), move |_watched, _ahead| {
            let _ = ticks.send(());
            match counted.fetch_add(1, Ordering::SeqCst) {
                0 => Tick::Read(Some(paced)),
                _ => Tick::Read(None),
            }
        })
        .expect("spawns");

        poker.poke(Poke::Watching(Some(a_folder())));
        taken
            .recv_timeout(Duration::from_secs(2))
            .expect("the read that reported the budget");

        // Waited out, so the poke below is answered by the pacing rather than by
        // a floor that had not expired yet.
        std::thread::sleep(Duration::from_millis(4_200));
        poker.poke(Poke::Watching(Some(a_folder())));
        taken
            .recv_timeout(Duration::from_secs(2))
            .expect("the read that reported no budget at all");

        // Nothing was learned, so the four seconds still stand and the poke
        // cannot get under them. Forgetting would have left `POKE_FLOOR` alone
        // under the `max` and answered this in one second.
        poker.poke(Poke::Watching(Some(a_folder())));
        assert!(
            taken.recv_timeout(Duration::from_millis(2_500)).is_err(),
            "an answer that said nothing about the budget unpaced the poller"
        );
        taken
            .recv_timeout(Duration::from_secs(3))
            .expect("and the pacing still ends");
    }

    #[test]
    fn the_horizon_a_read_reported_is_expressed_from_the_last_tick_however_long_ago_it_was() {
        /*
         * A floor is measured from the last tick; a `seconds_to_reset` is
         * measured from the read that reported it. Those coincide only while the
         * last tick *is* that read — a tick that failed, or that was never
         * attempted, moved one and not the other.
         *
         * Both other anchors are wrong, and wrong in opposite directions.
         * Leaving the horizon un-aged re-arms it on every tick, so one failed
         * poll at the reset costs another whole hour. Re-basing it to now
         * double-counts against `next_wake`'s own subtraction and fires at half
         * the horizon — which is the one of the two that draws under the
         * reserve.
         */
        let seen_at = Instant::now();
        let watch = Watch {
            watched: Some(a_folder()),
            last_tick: Some(seen_at + Duration::from_secs(5)),
            seen: Some(Seen {
                budget: Budget {
                    remaining: 4_000,
                    seconds_to_reset: 3_600,
                },
                at: seen_at,
            }),
            ..Watch::new()
        };

        assert_eq!(
            watch.cadence(0).budget.expect("a budget").seconds_to_reset,
            3_595
        );
    }

    /// A poller whose reads all fail with the same condition, reporting each
    /// attempt down a channel so a test can time the waits between them.
    fn failing_with(fault: Fault) -> (Poker, Receiver<()>) {
        let (ticks, taken) = mpsc::channel();
        let poker = start(Timings::shipped(), move |_watched, _ahead| {
            let _ = ticks.send(());
            Tick::Failed(fault)
        })
        .expect("spawns");
        (poker, taken)
    }

    #[test]
    fn a_run_of_failures_backs_the_poller_off_and_one_success_resets_it() {
        /*
         * Timed against the ladder rather than against the clock: a failure
         * earns ten seconds, which is longer than the fastest rung, so what
         * this measures is a wait that would not exist without the backoff.
         *
         * **The doubling is not what this pins**, and the comments here used to
         * say it was. A human poke clears `failures` and `last_fault` in
         * `Watch::apply` before the read it buys is taken, so the count is back
         * at one after that read and the wait it earns is the first rung again
         * — the second rung is never reached inside this loop, because the only
         * way to get a read out of a backed-off poller is the poke that zeroes
         * it. The ladder of numbers is `backoff_floor`'s and is pinned by its
         * own table next door.
         *
         * What this does pin is the half no table can: that the loop *carries*
         * the state — an agent poke does not get under a standing backoff, a
         * human one does, and one success clears what the failures earned.
         */
        let attempts = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&attempts);
        let (ticks, taken) = mpsc::channel();
        let poker = start(Timings::shipped(), move |_watched, _ahead| {
            let _ = ticks.send(());
            match counted.fetch_add(1, Ordering::SeqCst) {
                0 | 1 => Tick::Failed(Fault::Unreachable),
                _ => Tick::Read(None),
            }
        })
        .expect("spawns");

        poker.poke(Poke::Watching(Some(a_folder())));
        taken
            .recv_timeout(Duration::from_secs(2))
            .expect("the first read, which failed");

        // Ten seconds of backoff now stands, and an agent poke respects it —
        // which is the whole of *`Signal::Idle` must not hammer a dead
        // endpoint*.
        poker.poke(Poke::Idle);
        poker.poke(Poke::RunExited);
        assert!(
            taken.recv_timeout(Duration::from_secs(2)).is_err(),
            "an agent poke got under the backoff"
        );

        // A person can — the poke clears the count and the floor answers zero,
        // both — and the read they buy fails too, so a fresh ten seconds
        // stands behind it.
        poker.poke(Poke::Attention(Attention::Focused));
        taken
            .recv_timeout(Duration::from_secs(2))
            .expect("the read a person asked for");

        poker.poke(Poke::Idle);
        assert!(
            taken.recv_timeout(Duration::from_secs(2)).is_err(),
            "an agent poke got under the backoff the second failure earned"
        );

        // The third attempt lands. The backoff resets on the first success, so
        // an agent poke reaches GitHub again immediately afterwards.
        poker.poke(Poke::Attention(Attention::Focused));
        taken
            .recv_timeout(Duration::from_secs(2))
            .expect("the read that succeeded");

        std::thread::sleep(POKE_FLOOR + Duration::from_millis(100));
        poker.poke(Poke::Idle);
        taken
            .recv_timeout(Duration::from_secs(3))
            .expect("one success is what clears the backoff");
    }

    #[test]
    fn a_revoked_token_stops_the_poller_rather_than_leaving_it_retrying_forever() {
        // The condition the whole taxonomy exists for. A doubling would have
        // read as an ordinary wait here and gone on reading as one for the life
        // of the process; `Floor::Never` is what makes the ladder stop asking.
        let (poker, taken) = failing_with(Fault::AuthFailed);

        poker.poke(Poke::Watching(Some(a_folder())));
        taken
            .recv_timeout(Duration::from_secs(2))
            .expect("the read that found no token worth having");

        // Everything a machine has to ask a read with. None of them may get
        // under a stop — an adapter that went quiet during an outage is exactly
        // what would otherwise hammer a dead endpoint.
        for _ in 0..3 {
            poker.poke(Poke::Idle);
            poker.poke(Poke::RunExited);
            poker.poke(Poke::EnvironmentSettled);
        }
        assert!(
            taken.recv_timeout(Duration::from_secs(2)).is_err(),
            "the poller went on retrying a condition retrying cannot fix"
        );
    }

    #[test]
    fn a_person_can_start_a_stopped_poller_again_and_an_agent_cannot() {
        // `Never` is absorbing, so a stop with no way out is a poller that
        // needs the app restarted. The way out is the authority, and it is the
        // only way out — which is also what stops the ticket a poke bought from
        // falling back into the stop before it has been read.
        let (poker, taken) = failing_with(Fault::MapGone);

        poker.poke(Poke::Watching(Some(a_folder())));
        taken
            .recv_timeout(Duration::from_secs(2))
            .expect("the read that found the map gone");

        poker.poke(Poke::Idle);
        assert!(
            taken.recv_timeout(Duration::from_millis(400)).is_err(),
            "an agent started a stopped poller"
        );

        poker.poke(Poke::Attention(Attention::Focused));
        taken
            .recv_timeout(Duration::from_secs(2))
            .expect("a person saying try now");

        // And it stops again on the read they bought, rather than the clearing
        // outliving the poke that did it.
        poker.poke(Poke::Idle);
        assert!(
            taken.recv_timeout(Duration::from_millis(400)).is_err(),
            "the clearing outlived the poke that bought it"
        );
    }

    #[test]
    fn a_tick_that_was_never_attempted_forgets_neither_the_count_nor_the_condition() {
        // The fold, at the one row where *unchanged* is the answer and the
        // other two rows are not. A launch whose harvest has not settled has
        // learned nothing, and nothing learned is not evidence against what was.
        let held = folded(3, Some(Fault::Unreachable), Tick::NotAttempted);
        assert_eq!(held, (3, Some(Fault::Unreachable)));

        assert_eq!(
            folded(3, Some(Fault::Unreachable), Tick::Failed(Fault::MapGone)),
            (4, Some(Fault::MapGone))
        );
        // One success clears both, and the condition with them: a poller that
        // kept the last fault after a read that landed would go on stopping for
        // a token that has since been renewed.
        assert_eq!(
            folded(3, Some(Fault::AuthFailed), Tick::Read(None)),
            (0, None)
        );
        // And the count cannot wrap however long the outage runs.
        assert_eq!(
            folded(u32::MAX, None, Tick::Failed(Fault::Unreachable)),
            (u32::MAX, Some(Fault::Unreachable))
        );
    }

    #[test]
    fn a_run_is_live_while_its_handle_is_held_and_no_longer_than_that() {
        let (poker, _taken) = watched_by(Timings::shipped());

        assert_eq!(poker.runs_live(), 0);
        let first = poker.run_started();
        let second = poker.run_started();
        assert_eq!(poker.runs_live(), 2);

        drop(first);
        assert_eq!(poker.runs_live(), 1);
        drop(second);
        assert_eq!(poker.runs_live(), 0);
    }

    #[test]
    fn both_edges_of_a_run_reach_the_poller_without_anybody_remembering_to() {
        // The channel is read directly rather than through `start`, because what
        // is being asserted is that the count change sends — not what a loop
        // does with it.
        let (tx, rx) = mpsc::channel();
        let live = Arc::new(AtomicUsize::new(0));
        let poker = Poker { tx, live };

        let run = poker.run_started();

        // The rung rises and falls on the same two lines that change the count,
        // so neither edge can be announced and the other forgotten. A rise that
        // sent nothing would be a ten-second rung that engaged when the previous
        // wait expired rather than when the run began.
        assert_eq!(rx.try_recv().expect("the start message"), Poke::RunStarted);
        assert_eq!(poker.runs_live(), 1);

        drop(run);

        assert_eq!(rx.try_recv().expect("the exit poke"), Poke::RunExited);
        assert_eq!(poker.runs_live(), 0);
    }

    #[test]
    fn every_poke_carries_the_authority_the_backoff_floor_will_read() {
        // Pinned in #38 with no reader, for this day. What reads it now is
        // `backoff_floor`'s first clause and `Watch::apply`'s first three
        // lines, so the second half of this test walks the same table into
        // both of them: a poke that is a person clears a stop, and a poke that
        // is a machine does not.
        let pokes = [
            (Poke::Attention(Attention::Focused), Some(Authority::Human)),
            (Poke::Attention(Attention::Unfocused), None),
            (Poke::Watching(Some(a_folder())), Some(Authority::Human)),
            (Poke::Watching(None), None),
            (Poke::Idle, Some(Authority::Agent)),
            // A run beginning moves the ladder; it does not ask for a read.
            (Poke::RunStarted, None),
            (Poke::RunExited, Some(Authority::Agent)),
            (Poke::EnvironmentSettled, Some(Authority::Agent)),
        ];

        for (poke, expected) in pokes.clone() {
            assert_eq!(poke.authority(), expected, "{poke:?}");
        }

        for (poke, expected) in pokes {
            let mut stopped = Watch {
                failures: 4,
                last_fault: Some(Fault::AuthFailed),
                watched: Some(a_folder()),
                ..Watch::new()
            };
            stopped.apply(poke.clone());

            let cleared = (stopped.failures, stopped.last_fault) == (0, None);
            assert_eq!(
                cleared,
                expected == Some(Authority::Human),
                "{poke:?} cleared the backoff: {cleared}"
            );
            // And the composition agrees with the field, which is what makes
            // the two halves of *human pokes clear it* one rule rather than
            // two. The wait a person gets is the poke floor rather than zero —
            // clearing a backoff is not a way round the `max` — but it is a
            // wait, where every other poke still gets a refusal.
            assert_eq!(
                interval(&stopped.cadence(0)).wait != Floor::Never,
                expected == Some(Authority::Human),
                "{poke:?}"
            );
        }
    }

    #[test]
    fn the_shipped_debounce_is_the_second_the_ticket_names() {
        // So that a test injecting forty milliseconds cannot quietly become what
        // an operator's machine runs.
        assert_eq!(Timings::shipped().idle_debounce, Duration::from_secs(1));
    }

    #[test]
    fn nothing_is_read_until_something_is_being_watched() {
        let (poker, taken) = watched_by(Timings {
            idle_debounce: WINDOW,
        });

        poker.poke(Poke::Attention(Attention::Focused));
        poker.poke(Poke::Idle);
        poker.poke(Poke::RunExited);
        poker.poke(Poke::EnvironmentSettled);

        // A poke for a repository nobody chose is still a read of a repository
        // nobody chose, so every one of those changes nothing.
        assert!(taken.recv_timeout(WINDOW / 2).is_err());

        poker.poke(Poke::Watching(Some(a_folder())));

        assert_eq!(
            taken.recv_timeout(Duration::from_secs(2)).expect("a read"),
            a_folder()
        );
    }

    #[test]
    fn coming_back_to_the_window_reads_before_the_rung_is_due() {
        let (poker, taken) = watched_by(Timings::shipped());

        poker.poke(Poke::Watching(Some(a_folder())));
        taken
            .recv_timeout(Duration::from_secs(2))
            .expect("the first read");
        // The poke floor is measured from the last read, so it is waited out
        // here — otherwise what this test timed would be that floor rather than
        // the return.
        std::thread::sleep(POKE_FLOOR + Duration::from_millis(100));

        poker.poke(Poke::Attention(Attention::Unfocused));
        assert!(
            taken.recv_timeout(WINDOW).is_err(),
            "losing the window is not a reason to read"
        );

        poker.poke(Poke::Attention(Attention::Focused));

        // The rung that was armed is five minutes. This lands inside a second of
        // coming back, which is the whole of *right before your eyes settle*.
        assert_eq!(
            taken.recv_timeout(Duration::from_secs(2)).expect("a read"),
            a_folder()
        );
    }

    #[test]
    fn opening_the_folder_you_are_already_in_is_still_a_read() {
        let (poker, taken) = watched_by(Timings::shipped());

        poker.poke(Poke::Watching(Some(a_folder())));
        taken
            .recv_timeout(Duration::from_secs(2))
            .expect("the first read");
        std::thread::sleep(POKE_FLOOR + Duration::from_millis(100));

        // Byte for byte the declaration that is already standing. Clicking the
        // row you are looking at is the commonest form of the ticket's
        // *map-opened*, and it is the only way anybody has to ask for a read
        // off the rung — so a declaration that merely repeated itself must not
        // be silence.
        poker.poke(Poke::Watching(Some(a_folder())));

        assert_eq!(
            taken.recv_timeout(Duration::from_secs(2)).expect("a read"),
            a_folder()
        );
    }

    /// Slow on purpose: the ten-second rung is not injectable and the whole
    /// point is what the loop does with a wait it had already committed to.
    #[test]
    fn a_run_starting_climbs_the_rung_without_waiting_out_the_minute() {
        let (poker, taken) = watched_by(Timings::shipped());

        poker.poke(Poke::Watching(Some(a_folder())));
        taken
            .recv_timeout(Duration::from_secs(2))
            .expect("the first read");

        // The loop is now asleep on the sixty-second rung. Taking the handle
        // while it sleeps is the case a counter assertion cannot reach: the
        // number changes behind a thread that is already blocked, and unless the
        // change is also a wake-up the old deadline stands.
        let _run = poker.run_started();

        assert!(
            taken.recv_timeout(RUN_LIVE / 2).is_err(),
            "a run beginning moves the ladder, it does not ask for a read"
        );
        assert_eq!(
            taken
                .recv_timeout(RUN_LIVE)
                .expect("a read on the run rung"),
            a_folder()
        );
        // Which is inside the rung that was armed when the run began, and the
        // exact instant is arithmetic that is table-tested next door.
        assert!(RUN_LIVE + RUN_LIVE / 2 < WATCHING);
    }

    #[test]
    fn an_idle_signal_waits_for_quiet_before_it_polls() {
        // A wider window than `WINDOW`, because this is the one test whose
        // premise is a chain rather than a single send: three pokes, each of
        // which has to reach the loop inside the window the one before it
        // opened, and then an assertion that has to run inside the last one.
        // At `WINDOW` the whole chain had a hundred-odd milliseconds of slack
        // end to end, which a three-core runner with eighty tests in flight
        // spends without trying — and when it did, the debounce converted
        // early and the read was already in the channel by the time the
        // *still talking* assertion looked. A second buys the same shape most
        // of a second of slack instead.
        const CHATTER: Duration = Duration::from_secs(1);
        const BETWEEN: Duration = Duration::from_millis(100);
        const STILL_TALKING: Duration = Duration::from_millis(200);

        let (poker, taken) = watched_by(Timings {
            idle_debounce: CHATTER,
        });

        poker.poke(Poke::Watching(Some(a_folder())));
        taken
            .recv_timeout(Duration::from_secs(2))
            .expect("the first read");
        std::thread::sleep(POKE_FLOOR + Duration::from_millis(100));

        // A chattering adapter. Each one restarts the window, so none of them
        // converts on its own.
        let mut last_poke = Instant::now();
        for _ in 0..3 {
            poker.poke(Poke::Idle);
            last_poke = Instant::now();
            std::thread::sleep(BETWEEN);
        }

        let quiet = taken.recv_timeout(STILL_TALKING).is_err();
        // Checked before the assertion it guards, and that order is the point.
        // Widening the window makes the premise likelier to hold; it cannot
        // make it certain, and a machine that took longer than the window to
        // get three sends out has not caught the poller reading early — it has
        // failed to ask the question. Saying so is the difference between a
        // test that is slow and one that lies about what it saw.
        assert!(
            last_poke.elapsed() < CHATTER,
            "the chatter outlasted the window it was meant to sit inside, \
             so this run put no question to the debounce"
        );
        assert!(quiet, "an adapter still talking has not gone quiet");
        taken
            .recv_timeout(Duration::from_secs(2))
            .expect("one read once it went quiet");
        // One, not three.
        assert!(taken.recv_timeout(CHATTER).is_err());
    }

    #[test]
    fn a_read_still_in_flight_does_not_get_a_second_one_stacked_on_it() {
        let inside = Arc::new(AtomicUsize::new(0));
        let most = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&inside);
        let peak = Arc::clone(&most);
        let (entered, entries) = mpsc::channel();
        let (release, released) = mpsc::channel::<()>();

        let poker = start(Timings::shipped(), move |_, _| {
            let now = counted.fetch_add(1, Ordering::SeqCst) + 1;
            peak.fetch_max(now, Ordering::SeqCst);
            let _ = entered.send(());
            let _ = released.recv();
            counted.fetch_sub(1, Ordering::SeqCst);
            Tick::Read(None)
        })
        .expect("spawns");

        poker.poke(Poke::Watching(Some(a_folder())));
        entries
            .recv_timeout(Duration::from_secs(2))
            .expect("the read starts");

        // Everything that could ask for a second read, while the first is still
        // out. There is no in-flight flag anywhere: the loop is simply not back
        // at the channel yet, and these queue.
        poker.poke(Poke::Idle);
        poker.poke(Poke::RunExited);
        poker.poke(Poke::Attention(Attention::Focused));
        assert!(entries.recv_timeout(WINDOW).is_err(), "a second read began");

        let _ = release.send(());
        // The queued pokes are applied once it returns, so they were deferred
        // rather than dropped.
        entries
            .recv_timeout(Duration::from_secs(3))
            .expect("the queued pokes are read once the first returns");
        assert_eq!(most.load(Ordering::SeqCst), 1);
        let _ = release.send(());
    }

    #[test]
    fn a_tick_that_was_never_attempted_is_neither_a_failure_nor_a_spin() {
        let calls = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&calls);
        let poker = start(Timings::shipped(), move |_, _| {
            counted.fetch_add(1, Ordering::SeqCst);
            Tick::NotAttempted
        })
        .expect("spawns");

        poker.poke(Poke::Watching(Some(a_folder())));
        std::thread::sleep(Duration::from_millis(400));

        // The harvest has not settled, so nothing was asked. The stamp still
        // moves, which is what stops the loop asking again as fast as it can.
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    /// The purity claim of `cadence.rs`, as a rule that can fail rather than one
    /// nobody declared. It lives here rather than in that file so the needle is
    /// not inside the haystack it is looking through.
    #[test]
    fn the_interval_function_reads_no_clock() {
        const CADENCE_SOURCE: &str = include_str!("cadence.rs");

        for ambient in [
            "SystemTime",
            "Instant",
            "UNIX_EPOCH",
            ".elapsed(",
            "epoch_seconds",
        ] {
            assert!(
                !CADENCE_SOURCE.contains(ambient),
                "cadence.rs names {ambient}, so the interval is no longer a function of its arguments"
            );
        }
    }
}

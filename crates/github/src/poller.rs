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
//! **Two of them have no producer in the tree yet.** `crates/agent` and
//! `crates/pty` are doc-comment-only stubs, so `Signal::Idle` and a child
//! process ending are things this loop is *told about* rather than things it can
//! observe. That is why the seam is a channel and a handle rather than a
//! subscription: #44 and #47 plug into it without this crate learning what a
//! session or a PTY is.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::cadence::{interval, next_wake, Attention, Authority, Cadence, Wake};

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
    /// #40 is what reads this — #19 §5 binds *agent pokes respect backoff, human
    /// pokes clear it* — so it is pinned by a test before #40 exists.
    pub fn authority(&self) -> Option<Authority> {
        match self {
            Poke::Attention(Attention::Focused) => Some(Authority::Human),
            Poke::Attention(Attention::Unfocused) => None,
            Poke::Watching(Some(_)) => Some(Authority::Human),
            Poke::Watching(None) => None,
            Poke::RunStarted => None,
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
/// Nothing here classifies a failure. [`crate::ReadFailure`] is deliberately not
/// a taxonomy and #40 owns the vocabulary; the count of consecutive failures is
/// all the loop keeps. `Failed` is therefore a unit variant, and #40 is where
/// it learns what failed — that ticket has to stop rather than back off for the
/// conditions retrying cannot fix, and a count can only ever say *wait longer*.
/// [`crate::backoff_floor`] carries the whole of that argument.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tick {
    Read,
    Failed,
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

/// Starts the loop on its own named thread and hands back the way to poke it.
///
/// `tick` is what one poll *is* — the caller supplies it because reading a
/// folder needs a store, a repository binding and a token, none of which this
/// crate is allowed to reach for. It is called on the poller thread, one call at
/// a time, and never re-entered.
pub fn start<F>(timings: Timings, tick: F) -> std::io::Result<Poker>
where
    F: Fn(&Watched) -> Tick + Send + 'static,
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
struct Watch {
    attention: Attention,
    watched: Option<Watched>,
    poke: Option<Authority>,
    idle_since: Option<Instant>,
    last_tick: Option<Instant>,
    failures: u32,
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
        }
    }

    fn apply(&mut self, arrived: Poke) {
        match arrived {
            Poke::Attention(next) => {
                self.attention = next;
                if next == Attention::Focused {
                    self.poke = Some(Authority::Human);
                }
            }
            Poke::Watching(next) => {
                // A folder that has never been read is due *now*, not a rung
                // from now — which is also what makes the first read of a newly
                // opened folder immediate rather than scheduled. Only a change
                // of folder forgets the stamp, because re-declaring the one you
                // are already in has not made what was read of it any older.
                if next != self.watched {
                    self.last_tick = None;
                }
                // Unconditional, though. Opening a folder is the ticket's
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
            // #39 fills this in. Nothing in this crate can turn GitHub's RFC
            // 3339 `resetAt` into a number of seconds without a clock the pure
            // half deliberately has not got.
            budget: None,
            consecutive_failures: self.failures,
        }
    }
}

/// The loop. Every decision in it is a call into `cadence.rs`; what is left here
/// is reading the clock and doing as it is told.
fn pump<F>(rx: Receiver<Poke>, live: Arc<AtomicUsize>, timings: Timings, tick: F)
where
    F: Fn(&Watched) -> Tick,
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

        let outcome = tick(&watched);
        // Stamped after the tick returned, never before it. The read's deadline
        // is twenty seconds and the fastest rung is ten, so a wait measured from
        // when the read *started* would come due while it was still running.
        watch.last_tick = Some(Instant::now());
        watch.poke = None;
        match outcome {
            Tick::Read => watch.failures = 0,
            Tick::Failed => watch.failures = watch.failures.saturating_add(1),
            // Nothing was attempted, so nothing failed. `last_tick` still moves,
            // which is what stops a launch whose harvest has not settled from
            // spinning on a rung it can do nothing about.
            Tick::NotAttempted => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cadence::{POKE_FLOOR, RUN_LIVE, WATCHING};

    /// A window small enough that a test waits milliseconds for it, and large
    /// enough that a scheduling hiccup between two sends does not close it.
    const WINDOW: Duration = Duration::from_millis(200);

    fn a_folder() -> Watched {
        Watched {
            folder_id: 3,
            map: None,
        }
    }

    /// A poller whose ticks are reported down a channel, so a test asserts what
    /// was read and when rather than sleeping and hoping.
    fn watched_by(timings: Timings) -> (Poker, Receiver<Watched>) {
        let (ticks, taken) = mpsc::channel();
        let poker = start(timings, move |watched| {
            let _ = ticks.send(*watched);
            Tick::Read
        })
        .expect("spawns");
        (poker, taken)
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

        for (poke, expected) in pokes {
            assert_eq!(poke.authority(), expected, "{poke:?}");
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
        let (poker, taken) = watched_by(Timings {
            idle_debounce: WINDOW,
        });

        poker.poke(Poke::Watching(Some(a_folder())));
        taken
            .recv_timeout(Duration::from_secs(2))
            .expect("the first read");
        std::thread::sleep(POKE_FLOOR + Duration::from_millis(100));

        // A chattering adapter. Each one restarts the window, so none of them
        // converts on its own.
        for _ in 0..3 {
            poker.poke(Poke::Idle);
            std::thread::sleep(WINDOW / 5);
        }

        assert!(
            taken.recv_timeout(WINDOW / 4).is_err(),
            "an adapter still talking has not gone quiet"
        );
        taken
            .recv_timeout(Duration::from_secs(2))
            .expect("one read once it went quiet");
        // One, not three.
        assert!(taken.recv_timeout(WINDOW).is_err());
    }

    #[test]
    fn a_read_still_in_flight_does_not_get_a_second_one_stacked_on_it() {
        let inside = Arc::new(AtomicUsize::new(0));
        let most = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&inside);
        let peak = Arc::clone(&most);
        let (entered, entries) = mpsc::channel();
        let (release, released) = mpsc::channel::<()>();

        let poker = start(Timings::shipped(), move |_| {
            let now = counted.fetch_add(1, Ordering::SeqCst) + 1;
            peak.fetch_max(now, Ordering::SeqCst);
            let _ = entered.send(());
            let _ = released.recv();
            counted.fetch_sub(1, Ordering::SeqCst);
            Tick::Read
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
        let poker = start(Timings::shipped(), move |_| {
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

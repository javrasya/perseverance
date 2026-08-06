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
//! The ladder floor answers *how often is useful*; the budget floor (#39) and
//! the backoff floor (#40) answer *what is permitted*; and `max` is how
//! permission always wins. The three are separate functions meeting in exactly
//! one array so each can be argued about alone — which is the whole reason the
//! composition point lands in this slice with two of its three terms stubbed.
//!
//! Stubbed is not the same as *finished being designed*. #39 fills a body and
//! touches nothing else; #40 also widens what it is handed, because a failure
//! count can say *back off further* and can never say *stop*, and that is one
//! edited row of the array below. [`backoff_floor`] says so at length. Anything
//! beyond that row is a reshaping this slice was meant to make unnecessary.
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
/// to do and the budget floor that would otherwise stop it is still a literal
/// zero until #39. Measured from the *last tick*, so any real absence longer
/// than a second still fires immediately — `saturating_sub` bottoms out at zero.
pub const POKE_FLOOR: Duration = Duration::from_secs(1);

/* ----------------------------------------------------------- the state --- */

/// Whether the window has the operator.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Attention {
    Focused,
    Unfocused,
}

/// Who asked for the off-cadence read.
///
/// Both authorities lower the ladder identically today. #40 is the ticket where
/// they stop being the same, per #19 §5: an adapter's `Idle` respects backoff,
/// and a person saying *try now* clears it. Carried now so that #40 fills a
/// floor in rather than threading a new argument through everything.
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
/// `Never` ships with one producer and two waiting for it: #39 stops entirely at
/// the 1000-point reserve rather than slowing down, and #40 stops rather than
/// backs off for the conditions that retrying cannot fix. A floor that could
/// only be a [`Duration`] would have to be reshaped twice, and the composition
/// point with it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Floor {
    AtLeast(Duration),
    Never,
}

/// Which term of the `max` is holding the interval down.
///
/// Reported rather than discarded because #39 needs it: the *waiting for your
/// rate limit to reset* clause appears only while the budget is the winning
/// term, and a composition that answered with a bare `Duration` would leave that
/// clause with nothing to key on.
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

/// #39's two numbers.
///
/// `seconds_to_reset` rather than `reset_at`, because the text GitHub sent is
/// only a duration once somebody has read a clock, and this module has none.
/// Nothing populates this in #38 — see [`budget_floor`].
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

    /// #39's input. Always `None` in this slice.
    pub budget: Option<Budget>,

    /// Counted, never classified. [`crate::ReadFailure`] is deliberately not a
    /// taxonomy, and deciding which conditions retry is #40's whole ticket — so
    /// this is a number and nothing more.
    ///
    /// **#40 adds a field beside it**, naming the last failure, because a count
    /// alone can say *back off further* and can never say *stop*. That is the
    /// one place this struct is expected to grow, and [`backoff_floor`] and
    /// [`interval`]'s third row grow with it.
    pub consecutive_failures: u32,
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

/// **Stub — #39 owns this.** Returns zero, which cannot beat the smallest rung.
///
/// #39 is `2 / ((remaining - 1000) / seconds_to_reset)`: one formula, no
/// thresholds, and [`Floor::Never`] at or below the 1000-point reserve — which
/// is why `Never` exists before anything produces it.
///
/// Nothing populates [`Cadence::budget`] in this slice either, and that is
/// deliberate rather than forgotten: `RateLimit::reset_at` is RFC 3339 text and
/// turning it into a number of seconds needs a clock this crate's pure half does
/// not have. Writing that conversion here would be inventing half of #39.
pub fn budget_floor(budget: Option<Budget>) -> Floor {
    let _ = budget;
    Floor::AtLeast(Duration::ZERO)
}

/// **Stub — #40 owns this.** Returns zero, which cannot beat the smallest rung.
///
/// #40 is 10 s doubling to a five-minute cap, reset to zero on the first
/// success, [`Floor::Never`] for the conditions that stop rather than retry, and
/// [`Authority::Human`] clearing the count outright (#19 §5).
///
/// **This signature is half of that, knowingly.** A count and an authority are
/// everything the doubling needs. Refusing to retry needs to know *which*
/// condition failed, and nothing in this slice carries one: [`Cadence`] keeps a
/// number, [`crate::Tick::Failed`] is a unit variant, and the
/// [`crate::ReadFailure`] that reached the loop was stringified into the view
/// and dropped. So #40 widens what this is handed — see
/// [`Cadence::consecutive_failures`] — and edits the third row of
/// [`interval`]'s array with it. **That row is the one edit to the composition
/// point either stub is expected to make**, and it is written down in three
/// places so that nobody reads *a count and an authority*, ships the doubling
/// alone, and leaves an auth failure retrying forever at five-minute intervals.
///
/// What this slice does not do is *classify*: `Unreachable` / `AuthFailed` /
/// `MapGone` / `RateLimited` are #40's vocabulary to invent, and a slice with
/// no reason to name them has not named them.
pub fn backoff_floor(consecutive_failures: u32, poke: Option<Authority>) -> Floor {
    let _ = (consecutive_failures, poke);
    Floor::AtLeast(Duration::ZERO)
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
            backoff_floor(cadence.consecutive_failures, cadence.poke),
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
        }
    }

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

    #[test]
    fn the_two_floors_that_are_stubbed_cannot_change_any_answer_yet() {
        // The day #39 or #40 lands, this fails — which is exactly the day
        // somebody should be reading it.
        let budgets = [
            None,
            Some(Budget {
                remaining: 40,
                seconds_to_reset: 3_000,
            }),
            Some(Budget {
                remaining: 4_900,
                seconds_to_reset: 60,
            }),
        ];
        let pokes = [None, Some(Authority::Human), Some(Authority::Agent)];

        for budget in budgets {
            for failures in [0, 1, 9] {
                for poke in pokes {
                    let cadence = Cadence {
                        budget,
                        consecutive_failures: failures,
                        poke,
                        ..watching()
                    };

                    assert_eq!(
                        budget_floor(budget),
                        Floor::AtLeast(Duration::ZERO),
                        "{budget:?}"
                    );
                    assert_eq!(
                        backoff_floor(failures, poke),
                        Floor::AtLeast(Duration::ZERO),
                        "{failures} {poke:?}"
                    );
                    assert_eq!(
                        interval(&cadence),
                        Interval {
                            wait: ladder_floor(&cadence),
                            held_by: Held::Ladder,
                        },
                        "{cadence:?}"
                    );
                }
            }
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
        // round it. Reduced by the same rule `interval` uses, with #39's floor
        // standing where the stub will one day answer.
        let poked = Cadence {
            poke: Some(Authority::Human),
            ..watching()
        };
        let budget_says = Floor::AtLeast(Duration::from_secs(120));

        let answered = [
            (Held::Ladder, ladder_floor(&poked)),
            (Held::Budget, budget_says),
            (Held::Backoff, Floor::AtLeast(Duration::ZERO)),
        ]
        .into_iter()
        .reduce(later_of)
        .expect("three is not empty");

        assert_eq!(ladder_floor(&poked), Floor::AtLeast(POKE_FLOOR));
        assert_eq!(answered, (Held::Budget, budget_says));
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
}

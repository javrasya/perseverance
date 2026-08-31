use std::time::{Duration, Instant};

use perseverance_agent::{Ready, Signal};

/// The alternate screen, as a byte sequence.
///
/// `ESC [ ? 1049 h` is what a full-screen TUI writes on its way up, and it is
/// the whole of what *the session opened* means for an adapter that declares
/// [`Ready::AltScreen`]. Recognised here rather than in a
/// [`Watch`](perseverance_agent::Watch), which is what keeps a readiness verdict
/// available for an adapter that classifies nothing at all: readiness is a rule
/// the harness clocks, and an adapter with no watch has still declared one.
const ALT_SCREEN: &[u8] = b"\x1b[?1049h";

/// Whether the session has opened. Three readings and no fourth.
///
/// The rule is the adapter's — [`Ready`] is declared and never implemented, and
/// an adapter that timed its own readiness would be a driver — and the clock is
/// this crate's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Readiness {
    /// The rule is unsatisfied and its deadline has not run out. The state every
    /// run starts in, and the only one that says nothing at all.
    Waiting,
    /// The rule was satisfied. **One way**: a session that has opened does not
    /// close again, so a child that goes on printing after taking the alternate
    /// screen, or that breaks a silence it had already settled into, is still a
    /// session that opened.
    Ready,
    /// The deadline ran out with the rule unsatisfied.
    ///
    /// A *diagnosis* rather than a failure, and nothing here acts on it: the
    /// child is not signalled, nothing is closed, and the run goes on exactly as
    /// it was. The declared timeouts are an order of magnitude above the ~223 ms
    /// an alternate screen has been measured to take, so what has run out is not
    /// a slow machine — it is most likely a prompt waiting for the operator. The
    /// reading crosses; what to say about it is the chrome's.
    ///
    /// The elapsed rides along because it is the only place it is knowable, and
    /// because the sentence this reading becomes prints a number: **how long
    /// since the spawn the declared rule has gone unsatisfied**, which is never
    /// the byte silence beside it. A CLI that repaints a spinner while it waits
    /// on a trust prompt has printed a moment ago and has still not opened in
    /// ten seconds, and it is the ten seconds the operator needs to read. Always
    /// at least the declared deadline, so this is never a zero.
    Overdue { unopened_for: Duration },
}

/// What the drain loop learns about a run that is not bytes.
///
/// One value behind one lock, written by the drain thread on every read and
/// sampled by the readout at three hertz. It holds no bytes and grows with
/// nothing: an instant, two flags, the last classification, and a tail shorter
/// than one escape sequence.
pub(crate) struct Pulse {
    /// The rule the accepted launch declared, kept so the verdict can be
    /// computed when it is asked for rather than on a timer thread. A third
    /// thread per run whose only job was to notice a deadline would be a thread
    /// that has to be joined on the way out.
    rule: Ready,
    started: Instant,
    /// The last byte read *from the child*, which is the only honest reading of
    /// silence there is: the ring is written from that same loop and from
    /// nowhere else, so a run that is printing cannot look quiet and a run that
    /// is quiet cannot look busy.
    ///
    /// `None` is a child that has printed nothing yet, and the elapsed for one
    /// of those is measured from `started` — the alternative is a run silent
    /// since launch reporting no silence at all.
    printed: Option<Instant>,
    alt_screen: bool,
    /// Whether the declared rule has been satisfied. Latched, because the
    /// [`Ready::Quiet`] reading is a fact about a moment and *the session
    /// opened* is not.
    opened: bool,
    /// The last state this run was classified as, and `None` for a run that has
    /// never been classified at all.
    ///
    /// **The absence is a fact about this run's history and not a question about
    /// its adapter.** Nothing may ask whether an adapter watches; what is
    /// knowable is whether a signal has ever arrived for this run, which is what
    /// `None` says.
    signal: Option<Signal>,
    /// The tail of the last read that could still be the head of the sequence. A
    /// four-kilobyte read boundary lands inside an eight-byte escape sequence
    /// often enough that a scanner with no memory would miss the alternate
    /// screen exactly when the pipe is busiest.
    carry: Vec<u8>,
}

impl Pulse {
    pub(crate) fn opening(rule: Ready, started: Instant) -> Pulse {
        Pulse {
            rule,
            started,
            printed: None,
            alt_screen: false,
            opened: false,
            signal: None,
            carry: Vec::new(),
        }
    }

    /// Bytes arrived from the child at `at`.
    pub(crate) fn read(&mut self, bytes: &[u8], at: Instant) {
        self.printed = Some(at);

        if self.alt_screen {
            return;
        }

        let mut scanned = std::mem::take(&mut self.carry);
        scanned.extend_from_slice(bytes);

        if scanned
            .windows(ALT_SCREEN.len())
            .any(|window| window == ALT_SCREEN)
        {
            self.alt_screen = true;
            self.carry = Vec::new();
            return;
        }

        // Everything before the tail has been ruled out as a start, so the tail
        // is the whole of what has to be remembered.
        let keep = scanned.len().saturating_sub(ALT_SCREEN.len() - 1);
        self.carry = scanned.split_off(keep);
    }

    /// A watch said this run is now in that state.
    pub(crate) fn classified(&mut self, signal: Signal) {
        self.signal = Some(signal);
    }

    pub(crate) fn signal(&self) -> Option<Signal> {
        self.signal
    }

    /// How long this run has printed nothing.
    pub(crate) fn quiet(&self, now: Instant) -> Duration {
        now.saturating_duration_since(self.printed.unwrap_or(self.started))
    }

    /// The verdict, computed now and latched the first time it is ready.
    pub(crate) fn readiness(&mut self, now: Instant) -> Readiness {
        if self.opened {
            return Readiness::Ready;
        }

        let satisfied = match self.rule {
            Ready::AltScreen { .. } => self.alt_screen,
            // Measured from the spawn for a child that has printed nothing,
            // which is the same reading `quiet` gives everything else: a CLI
            // that settles by saying nothing has settled.
            Ready::Quiet { quiet, .. } => self.quiet(now) >= quiet,
        };
        if satisfied {
            self.opened = true;
            return Readiness::Ready;
        }

        // The deadline is asked second, so a rule satisfied late reads as ready
        // rather than as overdue: the expiry is a diagnosis about a run that has
        // not opened, and this one has.
        let deadline = match self.rule {
            Ready::AltScreen { timeout } => timeout,
            Ready::Quiet { max, .. } => max,
        };
        let unopened_for = now.saturating_duration_since(self.started);
        if unopened_for >= deadline {
            Readiness::Overdue { unopened_for }
        } else {
            Readiness::Waiting
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn alt_screen(timeout: Duration) -> Ready {
        Ready::AltScreen { timeout }
    }

    #[test]
    fn a_run_that_has_printed_nothing_has_been_silent_since_it_was_spawned() {
        let started = Instant::now();
        let pulse = Pulse::opening(alt_screen(Duration::from_secs(10)), started);

        assert_eq!(
            pulse.quiet(started + Duration::from_secs(3)),
            Duration::from_secs(3)
        );
    }

    #[test]
    fn silence_is_measured_from_the_last_byte_the_child_printed() {
        let started = Instant::now();
        let mut pulse = Pulse::opening(alt_screen(Duration::from_secs(10)), started);

        pulse.read(b"working", started + Duration::from_secs(2));

        assert_eq!(
            pulse.quiet(started + Duration::from_secs(5)),
            Duration::from_secs(3)
        );
    }

    #[test]
    fn the_alternate_screen_opens_the_session_even_when_it_straddles_two_reads() {
        for split in 1..ALT_SCREEN.len() {
            let started = Instant::now();
            let mut pulse = Pulse::opening(alt_screen(Duration::from_secs(10)), started);
            let (head, tail) = ALT_SCREEN.split_at(split);

            pulse.read(head, started);
            assert_eq!(
                pulse.readiness(started + Duration::from_millis(1)),
                Readiness::Waiting,
                "split at {split} opened on half a sequence"
            );

            pulse.read(tail, started + Duration::from_millis(2));
            assert_eq!(
                pulse.readiness(started + Duration::from_millis(3)),
                Readiness::Ready,
                "split at {split} was missed"
            );
        }
    }

    #[test]
    fn a_declared_timeout_that_runs_out_without_the_alternate_screen_reads_as_overdue() {
        let started = Instant::now();
        let mut pulse = Pulse::opening(alt_screen(Duration::from_secs(10)), started);

        pulse.read(b"do you trust the files in this folder?", started);

        assert_eq!(
            pulse.readiness(started + Duration::from_secs(9)),
            Readiness::Waiting
        );
        assert_eq!(
            pulse.readiness(started + Duration::from_secs(10)),
            Readiness::Overdue {
                unopened_for: Duration::from_secs(10)
            }
        );

        // Overdue closes nothing: the operator answers the prompt, the agent
        // takes the screen, and the same run reads as ready.
        pulse.read(ALT_SCREEN, started + Duration::from_secs(30));
        assert_eq!(
            pulse.readiness(started + Duration::from_secs(31)),
            Readiness::Ready
        );
    }

    /// The overdue elapsed is the run's own, and it is not the byte silence.
    ///
    /// A CLI that repaints while it waits — a spinner, a first-run install, an
    /// animated banner — has printed a millisecond ago and has still not opened
    /// in twelve seconds. The byte silence is ~0 and says nothing about the
    /// verdict; what the reading claims is the twelve seconds since the spawn,
    /// so that is what it carries.
    #[test]
    fn the_overdue_elapsed_is_measured_from_the_spawn_and_not_from_the_last_byte() {
        let started = Instant::now();
        let mut pulse = Pulse::opening(alt_screen(Duration::from_secs(10)), started);

        pulse.read(b"|", started + Duration::from_secs(12));

        let now = started + Duration::from_millis(12_001);
        assert_eq!(pulse.quiet(now), Duration::from_millis(1));
        assert_eq!(
            pulse.readiness(now),
            Readiness::Overdue {
                unopened_for: Duration::from_millis(12_001)
            }
        );
    }

    #[test]
    fn a_session_that_has_opened_does_not_close_again_when_the_child_prints() {
        let started = Instant::now();
        let mut pulse = Pulse::opening(
            Ready::Quiet {
                quiet: Duration::from_millis(400),
                max: Duration::from_secs(10),
            },
            started,
        );

        pulse.read(b"starting", started);
        assert_eq!(
            pulse.readiness(started + Duration::from_millis(200)),
            Readiness::Waiting
        );
        assert_eq!(
            pulse.readiness(started + Duration::from_millis(500)),
            Readiness::Ready
        );

        pulse.read(b"and now some more", started + Duration::from_secs(1));
        assert_eq!(
            pulse.readiness(started + Duration::from_secs(1)),
            Readiness::Ready
        );
    }

    #[test]
    fn a_run_nothing_has_classified_says_so_rather_than_naming_a_state() {
        let started = Instant::now();
        let mut pulse = Pulse::opening(alt_screen(Duration::from_secs(10)), started);

        assert_eq!(pulse.signal(), None);

        pulse.classified(Signal::Busy);
        pulse.classified(Signal::Idle);

        assert_eq!(pulse.signal(), Some(Signal::Idle));
    }
}

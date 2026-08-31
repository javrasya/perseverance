use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::Path;
use std::time::{Duration, Instant};

use perseverance_agent::{Signal, Watch};

use crate::geometry::{Geometry, Panes};
use crate::pulse::Readiness;
use crate::ring::SCROLLBACK;
use crate::session::{Session, SessionFailure};
use crate::shim::Accepted;
use crate::tap::{Delivery, Tap, SLACK};

/* --------------------------------------------------------- the numbers --- */

/// How long every live run is given to end itself before it is ended.
///
/// One deadline across the whole quit and not one per run: four terminals
/// would otherwise cost four times this, and an app that takes eight seconds
/// to close is an app that looks hung.
///
/// **Two seconds is a guess, and nothing in this repository has measured it.**
/// `docs/research/pty-spawn-agent-clis.md` §8 measured what reaps a tree and
/// never how long a tree asks for; no time-from-end-of-input-to-exit has been
/// taken for `claude`, `codex` or `pi`. The basis is only a bracket, and both
/// ends of it are weak on purpose rather than by accident.
///
/// The lower end is eight times the 5 × 50 ms `portable-pty` spends between its
/// `SIGHUP` and its `SIGKILL` — the grace inside the kill this quit ends with,
/// reachable because [`Session`] keeps the owned child rather than a cloned
/// signaller. It is the only number in the dependency that is about *how long a
/// child gets*, so an agent that merely needs to flush is comfortably inside it.
/// The upper end is a fifth of the ten seconds all three adapters *declare* for
/// readiness — declared and not spent, because `Ready` is not implemented on any
/// of them yet, so this end of the bracket is a shape borrowed from a number
/// nobody has run. It is here to say a quit must not feel like a launch.
///
/// What would settle it is that measurement, on both platforms, for all three
/// CLIs. The revisit trigger is the first report of an agent killed mid-write —
/// that is the failure this number is wrong about, and it is visible.
///
/// [`Session`]: crate::Session
pub const GRACE: Duration = Duration::from_secs(2);

/// How often the deadline is checked. A sampling rate rather than a promise:
/// nothing is owed to a run in the twenty-five milliseconds after it ended.
const POLL: Duration = Duration::from_millis(25);

/// Which run. Opaque, and issued here rather than named by a caller: two runs of
/// the same ticket in the same folder are two runs, and anything derived from
/// what they are would make them one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct RunId(u64);

impl RunId {
    /// For the wire, and for nothing else. The WebView needs to name a run in a
    /// command, and a number is the smallest thing that can.
    pub fn as_u64(self) -> u64 {
        self.0
    }

    /// A number the WebView sent back. It names a run or it names nothing, and
    /// which of the two is [`Runs`]'s to say — every method that takes one
    /// checks, so a stale id is a no-op rather than a run somebody else's.
    pub fn from_u64(run: u64) -> RunId {
        RunId(run)
    }
}

impl std::fmt::Display for RunId {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(out, "run {}", self.0)
    }
}

/// What the chrome is told about one run, several times a second.
///
/// Small, and every field is a count or a flag — no bytes, no lines, no text.
/// That is what makes *telemetry for all runs* affordable at 2–4 Hz while bytes
/// cross for one run only. **It is not a GitHub read**: nothing here has been
/// asked of anybody over a network, so a rate limit cannot make a run's readout
/// go stale and a poller's condition has nothing to say about it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Telemetry {
    pub run: RunId,
    /// Bytes still held for this run.
    pub held: usize,
    /// Bytes this run printed that can no longer be shown. The chrome prints
    /// this; it never goes into the byte stream.
    pub dropped: u64,
    /// How much of the stream this run's terminal has been handed.
    pub through: u64,
    /// How much of the stream there is.
    pub end: u64,
    pub truncated: bool,
    /// This run's terminal is behind, and nothing more will be sent to it until
    /// it catches up and is replayed. A readout, never a byte.
    pub desynced: bool,
    /// The child has exited. Which *kind* of ending that is, is #49's.
    ///
    /// Waited for, never inferred from the PTY going quiet: on Windows the
    /// output pipe stays open for as long as the harness holds the
    /// pseudoconsole, so an end-of-file signal would never arrive at all.
    pub over: bool,
    /// The exit code, if the platform had one and the run is over.
    pub code: Option<u32>,
    pub monitored: bool,
    /// How long this run has printed nothing, measured from its spawn for a
    /// child that has printed nothing at all.
    ///
    /// A length and never a verdict. **Byte silence is not an ending and is not
    /// a fault**: what an hour of it means depends on whether anybody is sitting
    /// at the keyboard and on what the ticket says, and neither of those is
    /// knowable here. The reading crosses and the join happens where the product
    /// vocabulary lives.
    pub quiet: Duration,
    /// The last state a watch classified this run as, and `None` for a run no
    /// signal has ever been observed for.
    ///
    /// **`None` is a fact about this run's history, not a question about its
    /// adapter.** Every run is drained through a `Box<dyn Watch>` on identical
    /// terms, so there is nothing here that could be asked whether an adapter
    /// watches — only whether anything has ever been said about this run.
    pub signal: Option<Signal>,
    /// Whether the session has opened, against the rule its launch declared.
    pub readiness: Readiness,
    /// When this run was opened, as seconds since the epoch.
    ///
    /// A stamp and not an age, because what reads it prints a coarse word —
    /// *4 minutes ago* — and an age recomputed three times a second would make
    /// every readout differ for a word that never moved. The subtraction happens
    /// where the rounding does; see [`Session::opened`].
    ///
    /// [`Session::opened`]: crate::Session::opened
    pub opened: u64,
    /// When this run last printed, as seconds since the epoch — which is when it
    /// opened, for a run that has printed nothing at all.
    ///
    /// Silence is the subtraction from this, and it is a stamp for
    /// [`Telemetry::opened`]'s reason.
    pub spoke: u64,
}

/// One run as the registry holds it: the session that owns the child, and the
/// tap its terminal reads through.
///
/// Public because [`Runs::take`] hands a removed one back, and a caller that
/// owns the value is a caller that decides where the drop happens. Nothing can
/// be done with it from outside — it has no members — which is the point: the
/// only thing worth having is the drop.
pub struct Run {
    session: Session,
    tap: Tap,
}

/// Every live run, the one that bytes cross for, and the one geometry they are
/// all at.
///
/// **The monitored run is a property of this registry and not of a session**,
/// which is what keeps *bytes cross for the monitored run only* structural: a
/// session has no channel, no subscriber and no way to be told about one, so
/// there is nothing for an unmonitored run to accidentally send on. Every run is
/// drained on identical terms — that is not throttling, it is the wire — and the
/// only thing monitoring decides is which tap [`Runs::frame`] reads.
///
/// Switching which run is monitored **resets nothing**. Each run's tap remembers
/// how much of that run's stream its terminal already holds, so coming back to a
/// run that has been running unwatched for an hour continues from there if the
/// ring still reaches, and is a replay of what is held if it does not. That is
/// the same two cases as any other frame, which is why binding is not a special
/// path with a reset in it.
pub struct Runs {
    runs: BTreeMap<RunId, Run>,
    monitored: Option<RunId>,
    panes: Panes,
    issued: u64,
}

impl Runs {
    pub fn new() -> Runs {
        Runs {
            runs: BTreeMap::new(),
            monitored: None,
            panes: Panes::opening(),
            issued: 0,
        }
    }

    /// Start a run, at the geometry every other live run is already at.
    ///
    /// **Nothing is resized here.** The pane's geometry is what the PTY is
    /// *opened* at, so there is no arrival-time reflow to aim at anything — which
    /// is the half of the never-resize-on-bind invariant that this side owns.
    ///
    /// `watching` is the run's classifier, minted by the adapter and handed over
    /// here rather than asked for later: there is exactly one shape of answer, so
    /// nothing in this registry — or above it — has a *does this adapter watch?*
    /// to branch on.
    pub fn open(
        &mut self,
        accepted: Accepted,
        cwd: &Path,
        environment: &[(OsString, OsString)],
        watching: Box<dyn Watch>,
    ) -> Result<RunId, SessionFailure> {
        let session = Session::spawn(
            accepted,
            cwd,
            environment,
            self.panes.geometry(),
            SCROLLBACK,
            watching,
        )?;

        self.issued += 1;
        let run = RunId(self.issued);
        self.runs.insert(
            run,
            Run {
                session,
                tap: Tap::at(0, SLACK),
            },
        );
        Ok(run)
    }

    /// Which run bytes cross for. `None` is nothing on the pane, which is the
    /// state the app opens in.
    ///
    /// A run that is not there is not monitored — a stale id from the WebView
    /// leaves the pane empty rather than pointing the channel at whatever run
    /// happens to hold that number next.
    pub fn monitor(&mut self, run: Option<RunId>) {
        self.monitored = run.filter(|run| self.runs.contains_key(run));
    }

    pub fn monitored(&self) -> Option<RunId> {
        self.monitored
    }

    pub fn live(&self) -> usize {
        self.runs.len()
    }

    /// What crosses to the WebView this frame, for the monitored run and no
    /// other.
    pub fn frame(&mut self) -> Option<(RunId, Delivery)> {
        let monitored = self.monitored?;
        let run = self.runs.get_mut(&monitored)?;
        let delivery = run.tap.take(&run.session.held());
        Some((monitored, delivery))
    }

    /// The WebView confirming it has written this run's bytes up to `through`.
    pub fn took(&mut self, run: RunId, through: u64) {
        if let Some(run) = self.runs.get_mut(&run) {
            run.tap.took(through);
        }
    }

    /// A delivery that was taken from this run but never reached anybody.
    ///
    /// The next frame for it is a reset and a whole replay, which is the only
    /// answer available: the alternative is rewinding a tap, and a rewound tap
    /// is a non-contiguous range the moment the ring's front moves past it.
    pub fn unsent(&mut self, run: RunId) {
        if let Some(run) = self.runs.get_mut(&run) {
            run.tap.unsent();
        }
    }

    /// Keystrokes to a run. Named for what it is rather than for `write`,
    /// because the only thing this crate knows about the bytes is where they go.
    pub fn typed(&self, run: RunId, bytes: &[u8]) -> std::io::Result<()> {
        match self.runs.get(&run) {
            Some(run) => run.session.typed(bytes),
            None => Err(std::io::Error::other(format!("{run} is not a live run"))),
        }
    }

    /// A completed gesture settled on a geometry: **every live run is resized,
    /// once, or none of them is.**
    ///
    /// The whole of the resize surface, and the reason the cost this slice
    /// accepts is nameable — a background research PTY is reflowed by a dial it
    /// has nothing to do with, because there is one geometry and this is the one
    /// method that changes it.
    ///
    /// Returns how many runs were resized, which is zero when the gesture
    /// settled on the size already in force.
    pub fn settled(&mut self, geometry: Geometry) -> usize {
        let Some(geometry) = self.panes.settled(geometry) else {
            return 0;
        };

        self.runs
            .values()
            .filter(|run| run.session.resize(geometry).is_ok())
            .count()
    }

    /// The geometry every live run is at.
    pub fn geometry(&self) -> Geometry {
        self.panes.geometry()
    }

    /// Every run's readout, in the order they were opened.
    pub fn telemetry(&self) -> Vec<Telemetry> {
        self.runs
            .iter()
            .map(|(id, run)| {
                let held = run.session.held();
                Telemetry {
                    run: *id,
                    held: held.held(),
                    dropped: held.dropped(),
                    through: run.tap.handed(),
                    end: held.end(),
                    truncated: held.truncated(),
                    desynced: run.tap.desynced(),
                    over: run.session.over(),
                    code: run.session.ended().and_then(|ending| ending.code),
                    monitored: self.monitored == Some(*id),
                    quiet: run.session.quiet(),
                    signal: run.session.signal(),
                    readiness: run.session.readiness(),
                    opened: run.session.opened(),
                    spoke: run.session.spoke(),
                }
            })
            .collect()
    }

    /// Forget a run and hand it back, so the caller owns the drop.
    ///
    /// The removal is the cheap half of forgetting a run; the drop is the
    /// expensive one, because a session's `Drop` signals its child and waits on
    /// it. Returning the run separates the two: this registry is out of the way
    /// the moment the call returns, and whatever the value costs to drop, it
    /// costs it wherever its new owner is rather than here.
    ///
    /// A run that has merely finished is **not** forgotten by this or anything
    /// else here. Its terminal stays readable until the ending is resolved,
    /// which is #49's, and a registry that reaped on end-of-file would take the
    /// last thing the agent said off the screen.
    pub fn take(&mut self, run: RunId) -> Option<Run> {
        let taken = self.runs.remove(&run);
        if self.monitored == Some(run) {
            self.monitored = None;
        }
        taken
    }

    /// Forget a run, which ends it here: the session drops inside this call, and
    /// with it the guard holding its process tree. [`Runs::take`] is the same
    /// removal for a caller that wants the drop to land somewhere else.
    pub fn close(&mut self, run: RunId) {
        drop(self.take(run));
    }

    /// Every session, ended. The third phase of [`Runs::shut_down`], and still
    /// the primitive that forgets a run; what makes it a promise rather than a
    /// hope is that each session's guard drops with it.
    pub fn close_all(&mut self) {
        self.runs.clear();
        self.monitored = None;
    }

    /// One quit: every run asked to stop, one deadline for all of them, then
    /// every session ended whether it took the hint or not.
    ///
    /// The deadline is shared rather than per run — see [`GRACE`]. Blocking, and
    /// for up to [`GRACE`]: the caller is a process on its way out, and a quit
    /// that returned before the children were gone would be the orphan this
    /// promise is about.
    ///
    /// Three phases, and each of them is a handle rather than a word. **Hanging
    /// up** releases every session's write end — on unix that writes the
    /// terminal's `VEOF` into the pty, and on Windows it closes the
    /// pseudoconsole's input pipe, which the console host answers by breaking
    /// the whole console session (measured: a run ends inside a tenth of a
    /// second with `STATUS_CONTROL_C_EXIT`, so on Windows this phase is an
    /// interrupt rather than an end of file, and the grace below is rarely
    /// spent). **The grace** is one deadline polled every 25 ms, ending early
    /// the moment every run is over. **The kill** is [`Runs::close_all`], which
    /// drops each session: on Windows `TerminateProcess`, then
    /// `ClosePseudoConsole` taking the tree, then the job object closing behind
    /// it; on unix `SIGHUP`, five 50 ms looks at the child, then `SIGKILL` — the
    /// escalation on the owned child rather than the bare `SIGHUP` a cloned
    /// signaller would send — after which the kernel hangs the controlling
    /// terminal up on the foreground group.
    ///
    /// **The deadline is taken before the asking, not after it.** Hanging up
    /// takes each session's writer lock, which the drain thread also takes; a
    /// session that cannot be hung up on is skipped rather than waited for (see
    /// [`Session::hang_up`]), and the clock is already running while that
    /// happens so no phase of a quit can push the kill past the bound.
    ///
    /// No adapter participates in any of it. What ends a run is a handle
    /// lifetime and a clock, which is why the contract stays at four members.
    ///
    /// [`Session::hang_up`]: crate::Session::hang_up
    pub fn shut_down(&mut self) {
        let deadline = Instant::now() + GRACE;

        for run in self.runs.values_mut() {
            run.session.hang_up();
        }

        while Instant::now() < deadline {
            if self.runs.values().all(|run| run.session.over()) {
                break;
            }
            std::thread::sleep(POLL);
        }

        self.close_all();
    }
}

impl Default for Runs {
    fn default() -> Runs {
        Runs::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::time::{Duration, Instant};

    use perseverance_agent::{Launch, NoWatch, Ready};
    use tempfile::TempDir;

    use crate::shim::accept;

    /// A run that stays up until something ends it — and says so first.
    ///
    /// The line it prints is what makes *this run started* observable, and the
    /// only portable evidence of it there is: this crate cannot ask the
    /// operating system whether a pid is alive, so the one thing a test can see
    /// about a child is what it printed. A silent sleeper prints nothing at all
    /// into its pty, so `end > 0` is never true of one on unix and a wait for it
    /// spends its whole timeout and then fails. On Windows the same probe passed
    /// anyway — the console host repaints the screen when the pseudoconsole
    /// opens, so the bytes were the harness's and never the child's, and the
    /// wait was measuring nothing about the run either. One line of output makes
    /// the probe mean the same thing on both platforms: the shell got as far as
    /// running the command, and what follows it is the sleeper.
    fn a_run_that_waits() -> Accepted {
        #[cfg(windows)]
        let line = "echo up&& timeout /t 30 /nobreak >nul";
        #[cfg(not(windows))]
        let line = "printf 'up\\n'; sleep 30";

        a_run_of(line)
    }

    /// A session always runs inside an environment — the folder's harvest, in
    /// the product — and these tests need a real one rather than a token.
    ///
    /// `Session::spawn` clears the child's environment first, so whatever is not
    /// named here does not exist for the child. A run given only `TERM` has no
    /// `PATH`, and on Windows that silently turns every sleeper in this module
    /// into `'timeout' is not recognized as an internal or external command` —
    /// a run that is already over before the quit it was written to exercise.
    /// The deadline test was vacuous for exactly that reason until it was
    /// measured. So the harvest is stood in for by the smallest thing that makes
    /// a shell a shell.
    fn an_environment() -> Vec<(String, String)> {
        #[cfg(windows)]
        let system = {
            let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
            [
                ("PATH".to_string(), format!("{root}\\system32")),
                ("SystemRoot".to_string(), root),
            ]
        };
        #[cfg(not(windows))]
        let system: [(String, String); 0] = [];

        let mut environment = vec![("TERM".to_string(), "xterm-256color".to_string())];
        environment.extend(system);
        environment
    }

    fn a_run_of(line: &str) -> Accepted {
        #[cfg(windows)]
        let argv = vec![
            std::env::var_os("COMSPEC").expect("a command interpreter"),
            OsString::from("/c"),
            OsString::from(line),
        ];
        #[cfg(not(windows))]
        let argv = vec![
            OsString::from("/bin/sh"),
            OsString::from("-c"),
            OsString::from(line),
        ];

        accept(Launch::new(
            argv,
            &[],
            an_environment(),
            Ready::Quiet {
                quiet: Duration::from_millis(400),
                max: Duration::from_secs(10),
            },
        ))
        .expect("a system shell is a native image")
    }

    fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(60);
        while Instant::now() < deadline {
            if done() {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("{what} did not happen inside a minute");
    }

    #[test]
    fn bytes_cross_for_the_monitored_run_only() {
        let directory = TempDir::new().expect("temp dir");
        let mut runs = Runs::new();

        #[cfg(windows)]
        let says = |what: &str| a_run_of(&format!("echo {what}&& timeout /t 30 /nobreak >nul"));
        #[cfg(not(windows))]
        let says = |what: &str| a_run_of(&format!("printf '{what}\\n'; sleep 30"));

        let first = runs
            .open(says("first"), directory.path(), &[], Box::new(NoWatch))
            .expect("a shell starts");
        let second = runs
            .open(says("second"), directory.path(), &[], Box::new(NoWatch))
            .expect("a shell starts");

        // Both are drained regardless — an unread PTY blocks its child — so both
        // have bytes to hand over.
        wait_until("both runs printed", || {
            runs.telemetry().iter().all(|run| run.end > 0)
        });

        // Nothing is monitored, so nothing crosses.
        assert_eq!(runs.frame(), None);

        runs.monitor(Some(first));
        let (which, delivery) = runs.frame().expect("the monitored run has a frame");
        assert_eq!(which, first);
        assert!(matches!(delivery, Delivery::Continues { .. }));

        // And the other run's terminal has been handed nothing at all, however
        // much it has printed.
        let telemetry = runs.telemetry();
        let other = telemetry
            .iter()
            .find(|run| run.run == second)
            .expect("still live");
        assert_eq!(other.through, 0);
        assert!(other.end > 0, "the unmonitored run was not drained");
        assert!(!other.monitored);
    }

    #[test]
    fn coming_back_to_a_run_continues_where_its_terminal_left_off() {
        let directory = TempDir::new().expect("temp dir");
        let mut runs = Runs::new();

        #[cfg(windows)]
        let line = "echo one&& timeout /t 30 /nobreak >nul";
        #[cfg(not(windows))]
        let line = "printf 'one\\n'; sleep 30";

        let first = runs
            .open(a_run_of(line), directory.path(), &[], Box::new(NoWatch))
            .expect("a shell starts");
        let second = runs
            .open(a_run_that_waits(), directory.path(), &[], Box::new(NoWatch))
            .expect("a shell starts");

        runs.monitor(Some(first));
        wait_until("the first run printed", || {
            matches!(runs.frame(), Some((_, Delivery::Continues { .. })))
        });
        let handed = runs
            .telemetry()
            .iter()
            .find(|run| run.run == first)
            .expect("live")
            .through;
        assert!(handed > 0);

        // Away and back. The tap is where it was: switching the pane is not an
        // event a run's stream knows about.
        runs.monitor(Some(second));
        runs.frame();
        runs.monitor(Some(first));

        assert_eq!(
            runs.telemetry()
                .iter()
                .find(|run| run.run == first)
                .expect("live")
                .through,
            handed,
            "binding moved the tap, so a bind is a reset after all"
        );
    }

    #[test]
    fn one_settled_gesture_resizes_every_live_run_and_an_unchanged_one_resizes_none() {
        let directory = TempDir::new().expect("temp dir");
        let mut runs = Runs::new();

        runs.open(a_run_that_waits(), directory.path(), &[], Box::new(NoWatch))
            .expect("a shell starts");
        runs.open(a_run_that_waits(), directory.path(), &[], Box::new(NoWatch))
            .expect("a shell starts");

        assert_eq!(runs.geometry(), Geometry::opening());
        assert_eq!(runs.settled(Geometry::new(50, 200)), 2);
        assert_eq!(runs.geometry(), Geometry::new(50, 200));

        // A gesture that ended where it began reflows nothing at all, including
        // a run that is mid-sentence.
        assert_eq!(runs.settled(Geometry::new(50, 200)), 0);
    }

    #[test]
    fn a_run_opened_after_a_gesture_starts_at_the_geometry_the_others_are_at() {
        let directory = TempDir::new().expect("temp dir");
        let mut runs = Runs::new();

        runs.settled(Geometry::new(50, 200));
        let late = runs
            .open(a_run_that_waits(), directory.path(), &[], Box::new(NoWatch))
            .expect("a shell starts");

        // Opened at it rather than resized to it, which is why arrival is not an
        // occasion for a reflow.
        assert_eq!(runs.geometry(), Geometry::new(50, 200));
        runs.close(late);
    }

    #[test]
    fn monitoring_a_run_that_is_not_there_leaves_the_pane_empty() {
        let mut runs = Runs::new();

        runs.monitor(Some(RunId(9_999)));

        assert_eq!(runs.monitored(), None);
        assert_eq!(runs.frame(), None);
    }

    #[test]
    fn closing_the_monitored_run_stops_the_channel_and_leaves_nothing_monitored() {
        let directory = TempDir::new().expect("temp dir");
        let mut runs = Runs::new();

        let only = runs
            .open(a_run_that_waits(), directory.path(), &[], Box::new(NoWatch))
            .expect("a shell starts");
        runs.monitor(Some(only));

        runs.close(only);

        assert_eq!(runs.monitored(), None);
        assert_eq!(runs.live(), 0);
        assert!(runs.telemetry().is_empty());
    }

    #[test]
    fn taking_the_monitored_run_hands_it_back_and_leaves_nothing_monitored() {
        let directory = TempDir::new().expect("temp dir");
        let mut runs = Runs::new();

        let only = runs
            .open(a_run_that_waits(), directory.path(), &[], Box::new(NoWatch))
            .expect("a shell starts");
        runs.monitor(Some(only));

        let taken = runs.take(only);

        assert!(taken.is_some(), "the removed run comes back to its caller");
        assert!(
            runs.take(only).is_none(),
            "and it is gone from the registry, not shared with it"
        );
        assert_eq!(runs.monitored(), None);
        assert_eq!(runs.live(), 0);
        assert!(runs.telemetry().is_empty());
    }

    #[test]
    fn typing_at_a_run_that_is_not_live_is_refused_rather_than_going_somewhere_else() {
        let runs = Runs::new();

        let refusal = runs
            .typed(RunId(9_999), b"\r")
            .expect_err("there is no such run");

        assert!(refusal.to_string().contains("run 9999"));
    }

    /// The no-orphans criterion, and the reason it is a file rather than a pid.
    ///
    /// This crate forbids `unsafe` and takes no `libc`, and there is no portable
    /// way to enumerate a process tree from safe Rust — so *is it still running*
    /// cannot be asked of the operating system here. What can be asked is
    /// whether anything is still **doing** something: a grandchild that appends
    /// to a file on a timer, and a file that has stopped growing a second and a
    /// half after the quit. That is the strongest portable evidence available,
    /// and it fails in the direction that matters — a survivor keeps writing.
    ///
    /// A grandchild rather than the child, because killing the direct child is
    /// the easy half. What is being exercised is the tree: on Windows the job
    /// object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and the
    /// `ClosePseudoConsole` that comes with the master, neither of which cares
    /// how deep the tree goes; on unix the session leader and the controlling
    /// terminal's hangup, which reach the whole process group.
    ///
    /// The length is recorded *after* [`Runs::shut_down`] returns and after a
    /// further half second, not before and not immediately: the grace is time
    /// the grandchild is legitimately still alive for, so a length taken before
    /// the quit would be measuring the grace rather than the kill — and on unix
    /// `shut_down` returns as soon as the kill has been *sent*, so a length taken
    /// the instant it returns can still catch a tick the kernel had not delivered
    /// the hangup for yet. That race fails in the direction that reads as *a
    /// process survived*, which is the one direction a flake here must not have.
    ///
    /// The tickers are bounded rather than endless. The one test that must not
    /// leave a process behind is not allowed to leave one behind when it fails
    /// either — an unbounded ticker outliving a red run would keep a handle open
    /// inside a `TempDir` whose cleanup then fails silently on Windows.
    #[test]
    fn no_grandchild_survives_a_quit() {
        let directory = TempDir::new().expect("temp dir");
        let marker = directory.path().join("marker.txt");

        #[cfg(windows)]
        let (ticker, body, line) = (
            "ticker.cmd",
            "for /l %%i in (1,1,60) do (\r\n\
             echo tick>>marker.txt\r\n\
             timeout /t 1 /nobreak >nul\r\n\
             )\r\n",
            "start /b cmd /c ticker.cmd& timeout /t 30 /nobreak >nul",
        );
        #[cfg(not(windows))]
        let (ticker, body, line) = (
            "ticker.sh",
            "n=0; while [ $n -lt 300 ]; do echo tick >> marker.txt; sleep 0.2; \
             n=$((n+1)); done\n",
            "sh ticker.sh & sleep 30",
        );
        std::fs::write(directory.path().join(ticker), body).expect("writes");

        let ticked = || {
            std::fs::metadata(&marker)
                .map(|marker| marker.len())
                .unwrap_or(0)
        };

        let mut runs = Runs::new();
        runs.open(a_run_of(line), directory.path(), &[], Box::new(NoWatch))
            .expect("a shell starts");

        wait_until("the grandchild started ticking", || ticked() > 0);
        let started = ticked();
        wait_until("the grandchild ticked twice", || ticked() > started);

        runs.shut_down();

        std::thread::sleep(Duration::from_millis(500));
        let after = ticked();
        std::thread::sleep(Duration::from_millis(1_500));

        assert_eq!(
            ticked(),
            after,
            "something under the quit is still running: the marker grew after the kill"
        );
    }

    /// One grace between three runs, and not one each.
    ///
    /// The upper bound is the claim and it holds on both platforms. The lower
    /// bound is only assertable on unix, and that asymmetry is the mechanism
    /// rather than a gap in the test: hanging up on unix writes `VEOF` into a pty
    /// nobody is reading, so three sleepers are still alive when the deadline
    /// arrives and the whole grace is spent. On Windows, closing the
    /// pseudoconsole's input pipe breaks the console session — measured, the runs
    /// are over inside a tenth of a second with `STATUS_CONTROL_C_EXIT` — so the
    /// grace is *not* spent there and asserting it was would be asserting the
    /// opposite of what the platform does. The Windows half is pinned next door,
    /// by `hanging_up_ends_a_windows_run_by_itself`.
    #[test]
    fn one_quit_is_one_deadline_and_not_one_per_run() {
        let directory = TempDir::new().expect("temp dir");
        let mut runs = Runs::new();

        for _ in 0..3 {
            runs.open(a_run_that_waits(), directory.path(), &[], Box::new(NoWatch))
                .expect("a shell starts");
        }
        wait_until("all three runs started", || {
            runs.telemetry().iter().all(|run| run.end > 0)
        });

        let began = Instant::now();
        runs.shut_down();
        let took = began.elapsed();

        assert!(
            took < GRACE * 2,
            "three runs cost {took:?}, which is a grace each rather than one between them"
        );
        #[cfg(not(windows))]
        assert!(
            took >= GRACE,
            "the quit was over in {took:?}, so the grace was never spent and the bound above \
             proved nothing"
        );
        assert_eq!(runs.live(), 0);
    }

    /// A child that ignores the hangup is killed anyway, which is the whole
    /// reason [`Session`] keeps the owned child.
    ///
    /// `portable-pty`'s cloned killer sends one `SIGHUP` and stops there, and
    /// `/bin/sh` with `trap '' HUP` is a direct child that survives exactly that
    /// — the kernel's own hangup does not fire either, because the drain thread
    /// still holds a `dup` of the master. So this is the difference between the
    /// escalation being documented and the escalation happening: without it the
    /// ticker keeps ticking, and *no process survives the app* is untrue of the
    /// simplest case there is.
    ///
    /// [`Session`]: crate::Session
    #[cfg(unix)]
    #[test]
    fn a_run_that_ignores_the_hangup_does_not_survive_the_quit() {
        let directory = TempDir::new().expect("temp dir");
        let marker = directory.path().join("marker.txt");

        let ticked = || {
            std::fs::metadata(&marker)
                .map(|marker| marker.len())
                .unwrap_or(0)
        };

        let mut runs = Runs::new();
        runs.open(
            a_run_of(
                "trap '' HUP; n=0; while [ $n -lt 300 ]; do echo tick >> marker.txt; \
                 sleep 0.2; n=$((n+1)); done",
            ),
            directory.path(),
            &[],
            Box::new(NoWatch),
        )
        .expect("a shell starts");

        wait_until("the deaf child started ticking", || ticked() > 0);
        let started = ticked();
        wait_until("the deaf child ticked twice", || ticked() > started);

        runs.shut_down();

        std::thread::sleep(Duration::from_millis(500));
        let after = ticked();
        std::thread::sleep(Duration::from_secs(1));

        assert_eq!(
            ticked(),
            after,
            "a child that ignores SIGHUP outlived the quit, so nothing escalated"
        );
    }

    /// The Windows leg of the hang-up, measured rather than assumed.
    ///
    /// Releasing the write end is documented as *asking*, and on unix it is: a
    /// `VEOF` into a pty a sleeper is not reading changes nothing. On Windows it
    /// is not a request at all. Closing the pseudoconsole's input pipe makes the
    /// console host break the session, and the child — here one that never reads
    /// its input, so no end-of-file could reach it — is gone inside a tenth of a
    /// second with `STATUS_CONTROL_C_EXIT`. That is why the grace is a unix
    /// mechanism in practice, and it is asserted here so the claim cannot rot.
    #[cfg(windows)]
    #[test]
    fn hanging_up_ends_a_windows_run_by_itself() {
        let directory = TempDir::new().expect("temp dir");
        let mut runs = Runs::new();

        // `ping` never reads standard input, so nothing about this run could be
        // taking a hint: whatever ends it is the console session going. The
        // `echo` in front of it is the same announcement `a_run_that_waits`
        // makes, and for the same reason — without it the only bytes in the ring
        // are the console host's repaint, and the wait below would pass before
        // the child had started.
        runs.open(
            a_run_of("echo up&& ping -n 31 127.0.0.1 >nul"),
            directory.path(),
            &[],
            Box::new(NoWatch),
        )
        .expect("a shell starts");
        wait_until("the run started", || {
            runs.telemetry().iter().all(|run| run.end > 0)
        });
        assert!(runs.telemetry().iter().all(|run| !run.over));

        let began = Instant::now();
        runs.shut_down();

        assert!(
            began.elapsed() < GRACE,
            "the run outlived the hang-up, so the input pipe closing is an end of file after all"
        );
    }

    #[test]
    fn a_quit_does_not_wait_on_runs_that_have_already_ended() {
        let directory = TempDir::new().expect("temp dir");
        let mut runs = Runs::new();

        #[cfg(windows)]
        let line = "echo over";
        #[cfg(not(windows))]
        let line = "printf 'over\\n'";

        runs.open(a_run_of(line), directory.path(), &[], Box::new(NoWatch))
            .expect("a shell starts");
        wait_until("the run ended by itself", || {
            runs.telemetry().iter().all(|run| run.over)
        });

        // The deadline is a bound and not a wait: there is nothing left to give
        // time to, so the quit is the kill and no more.
        let began = Instant::now();
        runs.shut_down();
        let took = began.elapsed();

        assert!(
            took < GRACE / 2,
            "a quit with nothing live in it still spent {took:?}"
        );
    }
}

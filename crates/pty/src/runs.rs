use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::Path;

use crate::geometry::{Geometry, Panes};
use crate::ring::SCROLLBACK;
use crate::session::{Session, SessionFailure};
use crate::shim::Accepted;
use crate::tap::{Delivery, Tap, SLACK};

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
}

struct Run {
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
    pub fn open(
        &mut self,
        accepted: Accepted,
        cwd: &Path,
        environment: &[(OsString, OsString)],
    ) -> Result<RunId, SessionFailure> {
        let session = Session::spawn(
            accepted,
            cwd,
            environment,
            self.panes.geometry(),
            SCROLLBACK,
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
                }
            })
            .collect()
    }

    /// Forget a run, which ends it: the session drops, and with it the guard
    /// holding its process tree.
    ///
    /// A run that has merely finished is **not** forgotten by this or anything
    /// else here. Its terminal stays readable until the ending is resolved,
    /// which is #49's, and a registry that reaped on end-of-file would take the
    /// last thing the agent said off the screen.
    pub fn close(&mut self, run: RunId) {
        self.runs.remove(&run);
        if self.monitored == Some(run) {
            self.monitored = None;
        }
    }

    /// Every session, ended. #51's clean shutdown is built on this; what makes
    /// it a promise rather than a hope is that each session's guard drops with
    /// it.
    pub fn close_all(&mut self) {
        self.runs.clear();
        self.monitored = None;
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

    use perseverance_agent::{Launch, Ready};
    use tempfile::TempDir;

    use crate::shim::accept;

    #[cfg(windows)]
    fn a_run_that_waits() -> Accepted {
        a_run_of("timeout /t 30 /nobreak >nul")
    }

    #[cfg(not(windows))]
    fn a_run_that_waits() -> Accepted {
        a_run_of("sleep 30")
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
            // A session always runs inside an environment — the folder's
            // harvest, in the product. Windows will not start a child with a
            // completely empty environment block at all, which is a thing worth
            // knowing but not a thing worth building a test around.
            vec![("TERM".to_string(), "xterm-256color".to_string())],
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
            .open(says("first"), directory.path(), &[])
            .expect("a shell starts");
        let second = runs
            .open(says("second"), directory.path(), &[])
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
            .open(a_run_of(line), directory.path(), &[])
            .expect("a shell starts");
        let second = runs
            .open(a_run_that_waits(), directory.path(), &[])
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

        runs.open(a_run_that_waits(), directory.path(), &[])
            .expect("a shell starts");
        runs.open(a_run_that_waits(), directory.path(), &[])
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
            .open(a_run_that_waits(), directory.path(), &[])
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
            .open(a_run_that_waits(), directory.path(), &[])
            .expect("a shell starts");
        runs.monitor(Some(only));

        runs.close(only);

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
}

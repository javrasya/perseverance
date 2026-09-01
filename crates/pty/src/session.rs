use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use perseverance_agent::{Signal, Watch};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};

use crate::geometry::Geometry;
use crate::guard::{Guard, GuardRefusal};
use crate::pulse::{Pulse, Readiness};
use crate::queries::{Queries, ANSWER};
use crate::ring::Ring;
use crate::shim::Accepted;

/// How much of the PTY is taken in one read.
///
/// Comfortably larger than a frame's worth of a fast build and comfortably
/// smaller than the ring, which is what keeps the *one oversized read* branch in
/// [`Ring::push`] unreachable from the one caller that matters.
const READ: usize = 32 * 1024;

/// How often the waiting thread looks at the child.
///
/// A poll rather than a block, and the cost of keeping the child itself rather
/// than a cloned signaller — see the `child` field. It is a sampling rate and
/// not a promise: nothing is owed to a run in the twenty-five milliseconds
/// between it exiting and this noticing, and the one thing that must not be
/// inferred from a clock — *that* it ended — is still the operating system's
/// answer and never this loop's patience.
const TICK: std::time::Duration = std::time::Duration::from_millis(25);

/// Every way the harness fails to open a session, once the launch itself has
/// been accepted.
///
/// None of these is the agent failing, and none of them is a condition on
/// anything: they are all *this app could not start a terminal*, which is a
/// sentence beside the run and never a fact about a map.
#[derive(Debug, thiserror::Error)]
pub enum SessionFailure {
    #[error("a pseudoterminal could not be opened for this run: {detail}")]
    NoPty { detail: String },

    #[error(
        "{program} was accepted as a native image but the operating system still declined to run \
         it: {detail}"
    )]
    NotStarted { program: String, detail: String },

    #[error(
        "the pseudoterminal opened but could not be read, so nothing this run printed would ever \
         reach a screen: {detail}"
    )]
    Unreadable { detail: String },

    #[error(
        "the pseudoterminal opened but could not be written to, so nothing typed would ever reach \
         the agent: {detail}"
    )]
    Unwritable { detail: String },

    /// A run whose tree the app cannot promise to reap is refused rather than
    /// started, because the failure mode is orphaned processes with no window
    /// left to close them from.
    #[error("{0}")]
    Unowned(#[from] GuardRefusal),
}

/// That a run ended, and with what code if the platform had one for it.
///
/// A type rather than an `Option<u32>` because *it has not ended* and *it ended
/// and nobody could say with what* are two different facts, and one option
/// cannot hold both. Which of them is on screen matters: the second is a run to
/// resolve and the first is a run to wait for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ending {
    pub code: Option<u32>,
}

/// One run: a pseudoterminal, the child in it, and the bytes it has produced.
///
/// **The drain never waits for anybody.** It reads the PTY, appends to the ring,
/// answers the terminal queries ConPTY insists on, and goes back to reading —
/// there is no branch in it that consults a WebView, a channel or a subscriber,
/// so a WebView that has stopped taking bytes cannot slow the child down. That
/// is criterion one, and it is the shape of this type rather than a promise
/// about it: throttling lives in [`Tap`], on the channel, and the wire has none.
///
/// A run that nobody is monitoring is drained on exactly the same terms as the
/// monitored one. It has to be: an undrained PTY fills its pipe and blocks the
/// child, and on Windows an unanswered cursor query means the child never starts
/// at all.
///
/// [`Tap`]: crate::Tap
pub struct Session {
    /// Held for the life of the session, and dropped last on purpose. On
    /// Windows dropping it calls `ClosePseudoConsole`, which terminates every
    /// attached process in the tree — measured against an eighteen-process MCP
    /// fleet in `docs/research/pty-spawn-agent-clis.md` §8.1.
    master: Box<dyn MasterPty + Send>,
    /// Shared because two things write to the child: the operator's keystrokes,
    /// and the drain thread answering cursor queries. `take_writer` is
    /// single-use, so sharing the one writer is not a convenience — it is the
    /// only shape available. And it is held for the whole session because
    /// dropping it writes `VEOF` on unix, which would quit the agent.
    ///
    /// The `Option` is there so that exactly one caller can let it go on
    /// purpose: [`Session::hang_up`], which is the first phase of a quit and
    /// wants precisely that `VEOF`. It has to be an `Option` inside the shared
    /// cell rather than an `Option` around the `Arc`, because the drain thread
    /// holds a clone of the `Arc` for as long as it lives — dropping this side's
    /// clone would only decrement a count and would write nothing at all.
    writer: Arc<Mutex<Option<Box<dyn Write + Send>>>>,
    /// The child itself, shared with the thread that waits on it — **not** a
    /// `clone_killer`, and that is the whole of the difference between the
    /// documented kill and a kill that happens.
    ///
    /// `portable-pty`'s cloned killer is a `ProcessSignaller`, and on unix its
    /// `kill` is one `libc::kill(pid, SIGHUP)` with nothing behind it: a child
    /// that traps or ignores `SIGHUP` would survive it, and because the drain
    /// thread holds a `dup` of the master the kernel's own hangup does not fire
    /// either. The escalation — `SIGHUP`, five 50 ms looks at `try_wait`, then
    /// `SIGKILL` — lives on `impl ChildKiller for std::process::Child`, which is
    /// reachable only from the owned child. So the child is kept here instead of
    /// being moved into the wait thread, and the price is that the wait is a
    /// poll rather than a block. On Windows both spellings are the same
    /// `TerminateProcess`, so nothing is traded there.
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    ring: Arc<Mutex<Ring>>,
    /// The child's exit code, once it has one.
    ///
    /// **Asked of the operating system on a thread, and never inferred from the
    /// PTY going quiet or from end of file.** Polled rather than blocked on —
    /// see the `child` field for why — which changes when this is noticed by up
    /// to [`TICK`] and changes nothing about what it means. Measured here: on
    /// Windows the output pipe stays open
    /// for as long as the pseudoconsole does, so a `cmd.exe` that exited zero at
    /// 250 ms produced no end of file at five seconds and would have produced
    /// none ever — the harness holds the master. A run that used EOF as its
    /// ending would therefore never end on one of the two platforms.
    ///
    /// *That* it ended is all this is. What **kind** of ending it was — spent, or
    /// exited-but-unresolved — is #49's, and is deliberately not decided here.
    ended: Arc<Mutex<Option<Ending>>>,
    /// Everything the drain loop learns that is not a byte: when the child last
    /// printed, whether the declared readiness rule has been met, and the last
    /// state a [`Watch`] classified this run as.
    ///
    /// Shared with the drain thread for the reason the ring is: that loop is the
    /// only place bytes are read, so it is the only place any of this can be
    /// known without a second reader inventing a second answer.
    pulse: Arc<Mutex<Pulse>>,
    /// When this session was opened, as seconds since the epoch.
    ///
    /// **Seconds and not a `Duration` since some start**, because the only thing
    /// that ever reads it is a chrome that prints *4 minutes ago* — a coarse
    /// word off a stable stamp. A length recomputed here would change on every
    /// one of the three readouts a second, so every message would differ and the
    /// rack would repaint for a word that did not move.
    ///
    /// Wall clock and not [`Instant`], for the same reason: this crosses to a
    /// WebView that has `Date.now()` and no way to be told what a monotonic
    /// origin on this machine meant. A clock the operator winds backwards is
    /// handled where it is printed, not here.
    ///
    /// [`Instant`]: std::time::Instant
    opened: u64,
    /// When this session last had output appended to its ring, as seconds since
    /// the epoch.
    ///
    /// Shared with the drain thread, which is the one place bytes arrive, and an
    /// atomic rather than a lock so that stamping costs the drain nothing it
    /// could be made to wait for — an unread PTY fills its pipe and stops the
    /// child.
    ///
    /// **Started at [`Session::opened`] rather than at zero**, so a run that has
    /// printed nothing since it opened has been silent for exactly as long as it
    /// has existed. That is the true reading, and it saves every caller from a
    /// *never spoke* case that means the same thing.
    spoke: Arc<AtomicU64>,
    guard: Guard,
}

/// The wall clock, in whole seconds since the epoch.
///
/// A clock before the epoch reads as the epoch rather than failing: nothing here
/// is worth refusing a session over, and the chrome floors an age at *just now*
/// anyway.
fn stamped() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

impl Session {
    /// Open a session for an accepted launch.
    ///
    /// Takes an [`Accepted`] rather than a `Launch`, so *the shim gate ran* is
    /// not something this function has to check or trust — it is the only
    /// argument it can be called with.
    ///
    /// `environment` is the whole environment the child gets. It arrives from
    /// the caller rather than being read here, because what a folder resolves
    /// under is the harvest's answer and this crate may not name the crate that
    /// took it. The child's environment is therefore *cleared first*: a session
    /// running in a GUI bundle's inherited `PATH` is the bug the harvest exists
    /// to fix, and inheriting it as well as the harvest would carry two
    /// environments' worth of history.
    ///
    /// `watching` is the run's own classifier, minted by the adapter and moved
    /// to the drain thread. It arrives as a `Box<dyn Watch>` and never as an
    /// `Option`, so nothing here — and nothing above here — can ask whether the
    /// adapter watches: an adapter that classifies nothing hands over a watch
    /// that says nothing, and the two are read on identical terms.
    pub fn spawn(
        accepted: Accepted,
        cwd: &Path,
        environment: &[(OsString, OsString)],
        geometry: Geometry,
        scrollback: usize,
        watching: Box<dyn Watch>,
    ) -> Result<Session, SessionFailure> {
        // Read before the launch is consumed below, and before the child exists:
        // the readiness clock starts at the spawn, so a rule taken afterwards
        // would be a rule whose deadline began late.
        let rule = accepted.launch().ready();

        let pair = native_pty_system()
            .openpty(sized(geometry))
            .map_err(|error| SessionFailure::NoPty {
                detail: error.to_string(),
            })?;

        let mut command = CommandBuilder::new(accepted.program());
        for argument in accepted.launch().argv().iter().skip(1) {
            command.arg(argument);
        }
        command.cwd(cwd);
        command.env_clear();
        for (name, value) in environment {
            command.env(name, value);
        }
        // The adapter's delta, in the order the two fields mean: what to scrub
        // is applied after the harvest so a name the operator's shell exports
        // cannot survive it, and what to add is applied last because it is the
        // launch's own and the most specific thing anybody said.
        for name in accepted.launch().env_remove() {
            command.env_remove(name);
        }
        for (name, value) in accepted.launch().env_add() {
            command.env(name, value);
        }

        let child =
            pair.slave
                .spawn_command(command)
                .map_err(|error| SessionFailure::NotStarted {
                    program: accepted.program().display().to_string(),
                    detail: error.to_string(),
                })?;
        // The slave handle is of no further use to this side, and holding it
        // would keep the PTY open after the child had gone — which is an end of
        // file that never arrives.
        drop(pair.slave);

        #[cfg(windows)]
        let handle = child.as_raw_handle().map(|handle| handle as isize);
        #[cfg(not(windows))]
        let handle = None;

        // Before the drain thread and before anything is read, so a failure here
        // is a run that never printed a byte rather than one taken away mid
        // sentence. `child` is dropped on the way out of this `?`, which on
        // Windows is `ClosePseudoConsole` and on unix a hangup.
        let guard = Guard::over(handle)?;

        let reader =
            pair.master
                .try_clone_reader()
                .map_err(|error| SessionFailure::Unreadable {
                    detail: error.to_string(),
                })?;
        let writer = Arc::new(Mutex::new(Some(pair.master.take_writer().map_err(
            |error| SessionFailure::Unwritable {
                detail: error.to_string(),
            },
        )?)));

        let ring = Arc::new(Mutex::new(Ring::new(scrollback)));
        let ended = Arc::new(Mutex::new(None));
        let child = Arc::new(Mutex::new(child));
        // The clock starts at the spawn and not at the first byte: a child that
        // printed nothing at all is the case the readiness deadline is most
        // there for.
        let pulse = Arc::new(Mutex::new(Pulse::opening(rule, Instant::now())));
        let opened = stamped();
        let spoke = Arc::new(AtomicU64::new(opened));

        let session = Session {
            master: pair.master,
            writer: Arc::clone(&writer),
            child: Arc::clone(&child),
            ring: Arc::clone(&ring),
            ended: Arc::clone(&ended),
            pulse: Arc::clone(&pulse),
            opened,
            spoke: Arc::clone(&spoke),
            guard,
        };

        // Two threads per run, because there are two things to watch and neither
        // may hold the other up: a pipe that must never fill, and a process that
        // may take an hour. The first blocks in `read`; the second polls, which
        // is what leaves the child reachable for the kill that escalates.
        std::thread::Builder::new()
            .name("perseverance-pty-drain".to_string())
            .spawn(move || drain(reader, &ring, &writer, &pulse, watching, &spoke))
            .map_err(|error| SessionFailure::Unreadable {
                detail: error.to_string(),
            })?;

        std::thread::Builder::new()
            .name("perseverance-pty-wait".to_string())
            .spawn(move || {
                let ending = loop {
                    let looked = child
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .try_wait();
                    match looked {
                        Ok(Some(status)) => {
                            break Ending {
                                code: Some(status.exit_code()),
                            }
                        }
                        // The platform declined to say. That it ended is still
                        // the fact worth recording — with what code is the part
                        // nobody could answer.
                        Err(_) => break Ending { code: None },
                        Ok(None) => std::thread::sleep(TICK),
                    }
                };
                *ended.lock().unwrap_or_else(PoisonError::into_inner) = Some(ending);
            })
            .map_err(|error| SessionFailure::Unreadable {
                detail: error.to_string(),
            })?;

        Ok(session)
    }

    /// Everything this run has printed that is still held.
    pub fn held(&self) -> MutexGuard<'_, Ring> {
        self.ring.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn pulse(&self) -> MutexGuard<'_, Pulse> {
        self.pulse.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// How long this run has printed nothing, measured from its spawn for a
    /// child that has printed nothing at all.
    ///
    /// **Byte silence is never an ending.** A child that has said nothing for an
    /// hour is a child that has said nothing for an hour; whether it is still
    /// running is [`Session::over`]'s answer and comes from the operating
    /// system. What this is for is a reading somebody can act on, and what it
    /// *means* is not this crate's to say.
    pub fn quiet(&self) -> Duration {
        self.pulse().quiet(Instant::now())
    }

    /// The last state a watch classified this run as, and `None` for a run no
    /// signal has ever been observed for.
    ///
    /// The absence is a fact about this run and not about its adapter: `None`
    /// says nothing has ever been classified here, which is the only thing
    /// anybody is entitled to know.
    pub fn signal(&self) -> Option<Signal> {
        self.pulse().signal()
    }

    /// Whether the session has opened, against the rule its launch declared.
    ///
    /// Computed when asked rather than on a timer, which is why it takes the
    /// lock: the *ready* reading latches the first time it is reached, so a
    /// [`Ready::Quiet`](perseverance_agent::Ready::Quiet) rule cannot flap back
    /// to waiting when the child prints again.
    pub fn readiness(&self) -> Readiness {
        self.pulse().readiness(Instant::now())
    }

    /// Keystrokes, or a prompt, or a cursor reply. Whatever the caller has, as
    /// bytes: this crate does not know what any of them mean.
    ///
    /// Refused rather than silently dropped once the session has been hung up.
    /// There is no writer left to take the bytes, and a caller that got `Ok` for
    /// a keystroke that reached nobody would be told the wrong thing about a
    /// child on its way out.
    pub fn typed(&self, bytes: &[u8]) -> std::io::Result<()> {
        let mut writer = self.writer.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(writer) = writer.as_mut() else {
            return Err(std::io::Error::other(
                "this run has been hung up on its way out, so nothing typed at it could reach the \
                 agent",
            ));
        };
        writer.write_all(bytes)?;
        writer.flush()
    }

    /// Let go of the child's input, which is the whole of the asking.
    ///
    /// The master has two ends and they mean different things. This releases the
    /// write end: on unix that is a dup of the master fd whose `Drop` writes `\n`
    /// and the terminal's `VEOF`, which is an end-of-file to a child in canonical
    /// mode and a `Ctrl-D` to one in raw; on Windows it is the pseudoconsole's
    /// input pipe, which closes. The read end — `master` — is deliberately not
    /// released here, because on Windows dropping it is `ClosePseudoConsole` and
    /// that terminates the tree. Releasing it here would make the grace that
    /// follows a wait for processes that were already gone.
    ///
    /// **The `\n` is `portable-pty`'s and it is not free.** `UnixMasterWriter`'s
    /// `Drop` writes `\n` before the `VEOF`, and to a full-screen agent in raw
    /// mode the tty interprets neither — the agent is handed a literal `0x0A`,
    /// which most prompt widgets read as *submit*. So a work run with a
    /// half-typed prompt in it can have that prompt sent as the last thing that
    /// happens before the deadline ends it: a turn on the operator's claim they
    /// did not ask for and will not see. It is accepted because the alternative
    /// is not sending the end-of-file at all — the `\n` is welded to the `VEOF`
    /// inside `portable-pty` and there is no way to write one without the other
    /// from here — and because the quit it belongs to has already been confirmed
    /// against a sentence saying the run is about to end.
    ///
    /// **`try_lock`, and a session that cannot be hung up on is skipped.** The
    /// writer lock is also taken by the drain thread across a blocking
    /// `write_all` into the child's *input*; a child that has stopped reading
    /// and a full line discipline make that write not return, and a quit that
    /// waited on it would never reach its own deadline, let alone the kill. The
    /// asking is the phase that is allowed to fail — what happens to a run that
    /// was never asked is exactly what happens to one that refused.
    ///
    /// Idempotent, and says nothing about whether the child took the hint. What
    /// happens when it does not is the deadline's, in [`Runs::shut_down`].
    ///
    /// [`Runs::shut_down`]: crate::Runs::shut_down
    pub fn hang_up(&mut self) {
        match self.writer.try_lock() {
            Ok(mut writer) => drop(writer.take()),
            Err(std::sync::TryLockError::Poisoned(poisoned)) => drop(poisoned.into_inner().take()),
            Err(std::sync::TryLockError::WouldBlock) => (),
        }
    }

    /// One `ResizePseudoConsole` on Windows, one `TIOCSWINSZ` on unix.
    ///
    /// Called once per settled gesture and from nowhere else. What decides that
    /// is [`Panes`] and the WebView's debounce, not this method — a resize is
    /// cheap to call and expensive to mean, and putting the policy here would put
    /// it behind a call every caller could make.
    ///
    /// [`Panes`]: crate::Panes
    pub fn resize(&self, geometry: Geometry) -> std::io::Result<()> {
        self.master
            .resize(sized(geometry))
            .map_err(|error| std::io::Error::other(error.to_string()))
    }

    /// How this run ended, once it has. `None` is a child still running.
    pub fn ended(&self) -> Option<Ending> {
        *self.ended.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// When this run was opened, as seconds since the epoch.
    pub fn opened(&self) -> u64 {
        self.opened
    }

    /// When this run last printed, as seconds since the epoch — which is when it
    /// opened, for a run that has printed nothing at all.
    pub fn spoke(&self) -> u64 {
        self.spoke.load(Ordering::Relaxed)
    }

    /// Whether this run is over. What *kind* of over is #49's.
    pub fn over(&self) -> bool {
        self.ended().is_some()
    }

    /// Which mechanism is holding this run's process tree, for a readout to
    /// print. There is nothing to configure about it.
    pub fn guard(&self) -> &Guard {
        &self.guard
    }
}

impl Drop for Session {
    /// The child first, then the pseudoterminal.
    ///
    /// In that order because the drain thread is blocked in `read` on a *dup* of
    /// the master on unix, so closing this side alone would leave it blocked
    /// until the child noticed by itself. Killing first makes the end of file
    /// arrive.
    ///
    /// The kill is the **owned child's** and not a cloned signaller's, which on
    /// unix is the difference between a `SIGHUP` a child may ignore and a
    /// `SIGHUP` followed by five 50 ms looks and then a `SIGKILL` it may not.
    /// That escalation is the reason the `child` field is kept here rather than
    /// moved into the wait thread, and it means this can block for up to a
    /// quarter of a second per session on a child that traps the hangup. That
    /// cost is after the grace and only on a run that has already refused to go.
    ///
    /// The thread is not joined. A join here is a quit that can hang, and the
    /// orderly shutdown — every session asked to stop, one deadline for all of
    /// them — is [`Runs::shut_down`] and exists; this is what happens after it,
    /// and what happens instead of it on the paths where nothing gets to run.
    /// What this guarantees is the part that must not depend on anything
    /// running: the guard drops with the session, and on Windows that is the job
    /// object closing.
    ///
    /// [`Runs::shut_down`]: crate::Runs::shut_down
    fn drop(&mut self) {
        let _ = self
            .child
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .kill();
    }
}

fn sized(geometry: Geometry) -> PtySize {
    PtySize {
        rows: geometry.rows,
        cols: geometry.cols,
        // Ignored by ConPTY, which takes a character `COORD` only. Sent as zero
        // rather than guessed, because a pixel size this side invented would be
        // a number only one of the two platforms could act on.
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// Read the PTY into the ring until it ends, answering the queries a terminal
/// is expected to answer.
///
/// Generic over both ends so the whole loop is exercisable without a child: a
/// reader is bytes and a writer is where replies go, and neither of those needs
/// a pseudoterminal to be true.
///
/// **Nothing in here can block on a consumer.** The ring lock is taken for the
/// length of one `push` and let go, and there is no other lock in the loop that
/// anything outside this crate can hold.
///
/// `replies` is an `Option` because [`Session::hang_up`] takes the writer out of
/// it on the way to a quit. An emptied cell stops the answering and nothing
/// else: reading continues to the end of the stream, because what the child said
/// on its way out is the part worth keeping.
///
/// `pulse` is the same bytes read a second way — when they arrived, whether the
/// alternate screen was among them, and what the run's own [`Watch`] made of
/// them. It is written here because this is the only loop that reads the child
/// at all: a second reader would be a second answer about the same silence.
/// `spoke` is stamped here and nowhere else, because this is the only place
/// bytes are appended to the ring. A stamp taken anywhere further out would be
/// *when somebody looked*, and a run nobody was looking at would read as silent
/// while it printed.
pub(crate) fn drain<R: Read, W: Write>(
    mut reader: R,
    ring: &Mutex<Ring>,
    replies: &Mutex<Option<W>>,
    pulse: &Mutex<Pulse>,
    mut watching: Box<dyn Watch>,
    spoke: &AtomicU64,
) {
    let mut buffer = vec![0u8; READ];
    let mut queries = Queries::default();

    loop {
        let read = match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            // A read error on a PTY is the end of the PTY. There is nothing to
            // report to anybody here — an ending is #49's to classify, and this
            // crate may not raise a condition on anything.
            Err(_) => break,
        };
        let bytes = &buffer[..read];

        // Poisoning is recovered from rather than propagated. A panic in a frame
        // pump must not stop a live child's PTY being read: an unread PTY fills
        // its pipe and blocks the agent, which is the one thing this loop exists
        // to prevent.
        ring.lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(bytes);
        // After the push and never before: what the stamp claims is that these
        // bytes are readable, not that a read returned.
        spoke.store(stamped(), Ordering::Relaxed);

        // Classified outside the lock, because a watch is somebody else's code
        // and this loop may not hold a lock the readout tick wants across it.
        let signal = watching.classify(bytes);
        {
            let mut pulse = pulse.lock().unwrap_or_else(PoisonError::into_inner);
            pulse.read(bytes, std::time::Instant::now());
            if let Some(signal) = signal {
                pulse.classified(signal);
            }
        }

        for _ in 0..queries.asked(bytes) {
            let mut replies = replies.lock().unwrap_or_else(PoisonError::into_inner);
            // Best effort, and deliberately so: a reply that cannot be written
            // means the child has gone, which the next read will say properly.
            // An emptied cell is the same fact arriving earlier — the writer was
            // let go on purpose, so there is nobody left to answer.
            if let Some(replies) = replies.as_mut() {
                let _ = replies.write_all(ANSWER);
                let _ = replies.flush();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::io::Cursor;
    use std::time::{Duration, Instant};

    use perseverance_agent::{Launch, NoWatch, Ready};
    use tempfile::TempDir;

    use crate::ring::SCROLLBACK;
    use crate::shim::accept;

    const SCRUB: &[&str] = &["A_MARKER_THIS_HARNESS_MUST_NOT_PASS_ON"];

    fn a_pulse() -> Mutex<Pulse> {
        Mutex::new(Pulse::opening(
            Ready::AltScreen {
                timeout: Duration::from_secs(10),
            },
            Instant::now(),
        ))
    }

    /// A watch that says what it is told to, in order, one answer per read.
    ///
    /// Every shipped adapter takes `NoWatch`, so the only way to exercise the
    /// path a classifier's answers take is to write one — which is what this is,
    /// and what it proves is that the drain feeds the watch it was handed and
    /// keeps the last answer it gave.
    struct AWatch {
        says: Vec<Option<Signal>>,
    }

    impl Watch for AWatch {
        fn classify(&mut self, _bytes: &[u8]) -> Option<Signal> {
            if self.says.is_empty() {
                return None;
            }
            self.says.remove(0)
        }
    }

    /// The platform's own shell, which is the one native image both runners are
    /// guaranteed to have. An agent CLI is not: the whole point of #44's gate is
    /// that CI has none installed.
    #[cfg(windows)]
    fn a_shell() -> std::path::PathBuf {
        std::env::var_os("COMSPEC")
            .map(std::path::PathBuf::from)
            .expect("every Windows names its command interpreter")
    }

    #[cfg(not(windows))]
    fn a_shell() -> std::path::PathBuf {
        std::path::PathBuf::from("/bin/sh")
    }

    /// The smallest environment that makes a shell a shell.
    ///
    /// `Session::spawn` clears the child's environment first, so a run given only
    /// `TERM` has no `PATH` — and on Windows that turns every `timeout` in this
    /// module into *not recognized as an internal or external command*, i.e. a
    /// child that is already over before the test has done anything to it. Every
    /// harness here that needs a live child needs this.
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

    /// A shell told to run one line, as a launch the gate has accepted.
    fn a_run_of(line: &str) -> Accepted {
        let shell = a_shell();
        #[cfg(windows)]
        let argv = vec![
            shell.into_os_string(),
            OsString::from("/c"),
            OsString::from(line),
        ];
        #[cfg(not(windows))]
        let argv = vec![
            shell.into_os_string(),
            OsString::from("-c"),
            OsString::from(line),
        ];

        accept(Launch::new(
            argv,
            SCRUB,
            an_environment(),
            Ready::Quiet {
                quiet: Duration::from_millis(400),
                max: Duration::from_secs(10),
            },
        ))
        .expect("a system shell is a native image")
    }

    /// Roughly `kib` kibibytes of output, then exit. Written per platform
    /// because a loop is the one thing the two shells spell least alike.
    fn says_a_lot(kib: usize) -> String {
        #[cfg(windows)]
        {
            format!("for /L %i in (1,1,{kib}) do @echo {}", "x".repeat(1_000))
        }
        #[cfg(not(windows))]
        {
            format!("n=0; while [ $n -lt {kib} ]; do printf '%01023d\\n' $n; n=$((n+1)); done")
        }
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
    fn the_child_is_never_blocked_by_a_consumer_that_never_reads() {
        let directory = TempDir::new().expect("temp dir");
        // Sixty-four kibibytes of output into a four-kibibyte ring, with nobody
        // taking a single byte of it. The child finishing anyway is the whole
        // claim: an unread PTY fills its pipe and stops the agent dead.
        let session = Session::spawn(
            a_run_of(&says_a_lot(64)),
            directory.path(),
            &[],
            Geometry::new(40, 120),
            4 * 1024,
            Box::new(NoWatch),
        )
        .expect("a shell starts");

        wait_until("the child ended", || session.over());

        let held = session.held();
        assert!(
            held.truncated(),
            "the ring was never overrun, so this proved nothing"
        );
        assert!(held.end() > 60 * 1024, "only {} bytes arrived", held.end());
        // And what is left of it is still a contiguous window of the stream.
        assert_eq!(held.whole().len(), held.held());
        assert_eq!(held.end() - held.first(), held.held() as u64);
    }

    #[test]
    fn what_a_run_prints_is_held_and_readable_while_it_is_still_running() {
        let directory = TempDir::new().expect("temp dir");
        #[cfg(windows)]
        let line = "echo perseverance";
        #[cfg(not(windows))]
        let line = "printf 'perseverance\\n'";

        let session = Session::spawn(
            a_run_of(line),
            directory.path(),
            &[],
            Geometry::new(40, 120),
            SCROLLBACK,
            Box::new(NoWatch),
        )
        .expect("a shell starts");

        wait_until("the run printed", || {
            String::from_utf8_lossy(&session.held().whole()).contains("perseverance")
        });
        wait_until("the child ended", || session.over());

        assert!(!session.held().truncated());
        assert_eq!(session.ended(), Some(Ending { code: Some(0) }));
    }

    /// The last thing every test program below prints.
    ///
    /// Waited for instead of the child's exit, because **the two are not the
    /// same event**: the waiter learns the child is gone the moment it is, and
    /// the drain thread is a separate thread that may not have read what it
    /// wrote yet. A test that read the ring on the exit was a flake, and it
    /// found one.
    const LAST_WORD: &str = "wf47-done";

    fn said_by(session: &Session) -> String {
        String::from_utf8_lossy(&session.held().whole()).to_string()
    }

    fn wait_for_the_last_word(session: &Session) -> String {
        wait_until("the run said everything it had to", || {
            said_by(session).contains(LAST_WORD)
        });
        said_by(session)
    }

    #[test]
    fn a_session_starts_in_the_directory_it_was_given() {
        let directory = TempDir::new().expect("temp dir");
        // A file the shell can only find if it started where it was told to.
        // Asserted this way round rather than by printing the working directory,
        // because macOS resolves a temporary path through `/private` and a
        // string comparison would be a test about symlinks.
        std::fs::write(directory.path().join("wf47-marker"), b"here").expect("writes");

        #[cfg(windows)]
        let line = format!("if exist wf47-marker echo started-here&& echo {LAST_WORD}");
        #[cfg(not(windows))]
        let line =
            format!("[ -f wf47-marker ] && printf 'started-here\\n'; printf '{LAST_WORD}\\n'");

        let session = Session::spawn(
            a_run_of(&line),
            directory.path(),
            &[(OsString::from("TERM"), OsString::from("xterm-256color"))],
            Geometry::new(40, 120),
            SCROLLBACK,
            Box::new(NoWatch),
        )
        .expect("a shell starts");

        let said = wait_for_the_last_word(&session);
        assert!(
            said.contains("started-here"),
            "the child did not start in the directory it was given: {said:?}"
        );
    }

    #[test]
    fn a_session_runs_in_the_environment_it_was_given() {
        let directory = TempDir::new().expect("temp dir");
        #[cfg(windows)]
        let line = format!("echo [%WF47_MARKER%]&& echo {LAST_WORD}");
        #[cfg(not(windows))]
        let line = format!("printf '[%s]\\n' \"$WF47_MARKER\"; printf '{LAST_WORD}\\n'");

        let session = Session::spawn(
            a_run_of(&line),
            directory.path(),
            &[(
                OsString::from("WF47_MARKER"),
                OsString::from("from-the-harvest"),
            )],
            Geometry::new(40, 120),
            SCROLLBACK,
            Box::new(NoWatch),
        )
        .expect("a shell starts");

        let said = wait_for_the_last_word(&session);
        assert!(
            said.contains("[from-the-harvest]"),
            "the child did not see the environment it was given: {said:?}"
        );
    }

    #[test]
    fn the_environment_is_cleared_first_so_no_run_inherits_this_process() {
        let directory = TempDir::new().expect("temp dir");
        #[cfg(windows)]
        let line = format!("echo [%CARGO_PKG_NAME%]&& echo {LAST_WORD}");
        #[cfg(not(windows))]
        let line = format!("printf '[%s]\\n' \"$CARGO_PKG_NAME\"; printf '{LAST_WORD}\\n'");

        let session = Session::spawn(
            a_run_of(&line),
            directory.path(),
            &[(OsString::from("TERM"), OsString::from("xterm-256color"))],
            Geometry::new(40, 120),
            SCROLLBACK,
            Box::new(NoWatch),
        )
        .expect("a shell starts");

        // Cargo sets this on the test process. A session that inherited it would
        // be a session running in the app's environment rather than the
        // folder's, which is #45's bug re-entered through the back door.
        let said = wait_for_the_last_word(&session);
        assert!(
            !said.contains("[perseverance-pty]"),
            "the run inherited this process's environment: {said:?}"
        );
    }

    #[test]
    fn a_geometry_can_be_put_to_a_live_run_without_disturbing_what_it_printed() {
        let directory = TempDir::new().expect("temp dir");
        #[cfg(windows)]
        let line = "echo settled&& timeout /t 3 /nobreak >nul";
        #[cfg(not(windows))]
        let line = "printf 'settled\\n'; sleep 3";

        let session = Session::spawn(
            a_run_of(line),
            directory.path(),
            &[],
            Geometry::new(40, 120),
            SCROLLBACK,
            Box::new(NoWatch),
        )
        .expect("a shell starts");

        wait_until("the run printed", || {
            String::from_utf8_lossy(&session.held().whole()).contains("settled")
        });
        let before = session.held().end();

        session
            .resize(Geometry::new(50, 200))
            .expect("a live pty resizes");

        // A resize is a window-size change and not a write, so the stream the
        // terminal is replaying does not move because of one. Whether the agent
        // reflows in response is the agent's business.
        assert!(session.held().end() >= before);
        assert!(!session.held().truncated());
    }

    #[test]
    fn the_drain_answers_the_cursor_query_conpty_will_not_start_without() {
        // The loop, without a child: the measured ConPTY opening, then output.
        // Answering is what a terminal does, and this is where it is done — so a
        // run nobody is monitoring gets it too.
        let ring = Mutex::new(Ring::new(SCROLLBACK));
        let replies = Mutex::new(Some(Vec::new()));
        let wire = b"\x1b[6n\x1b[?9001h2.1.220 (Claude Code)\r\n".to_vec();

        drain(
            Cursor::new(wire.clone()),
            &ring,
            &replies,
            &a_pulse(),
            Box::new(NoWatch),
            &AtomicU64::new(0),
        );

        assert_eq!(
            replies
                .into_inner()
                .expect("not poisoned")
                .expect("never hung up"),
            ANSWER
        );
        // And the query is in the ring exactly as it arrived. Stripping it would
        // be a splice, which is the one thing the ring may not hold.
        assert_eq!(
            ring.into_inner().expect("not poisoned").whole(),
            wire,
            "the drain rewrote the stream instead of only reading it"
        );
    }

    #[test]
    fn a_drain_over_a_reader_that_ends_records_everything_that_came_out_of_it() {
        let ring = Mutex::new(Ring::new(SCROLLBACK));
        let replies = Mutex::new(Some(Vec::new()));
        let wire: Vec<u8> = (0..200_000u32).map(|byte| byte as u8).collect();

        drain(
            Cursor::new(wire.clone()),
            &ring,
            &replies,
            &a_pulse(),
            Box::new(NoWatch),
            &AtomicU64::new(0),
        );

        let ring = ring.into_inner().expect("not poisoned");
        assert_eq!(ring.end(), wire.len() as u64);
        assert_eq!(ring.whole(), wire);
        assert!(!ring.truncated());
    }

    /// A hung-up session is one on its way out, and what it prints on the way
    /// out is the part worth keeping. So losing the writer must not stop the
    /// reading — the query simply goes unanswered, which is the same best-effort
    /// branch a dead child already took.
    #[test]
    fn a_drain_whose_replies_have_been_hung_up_keeps_reading_rather_than_stopping() {
        let ring = Mutex::new(Ring::new(SCROLLBACK));
        let replies: Mutex<Option<Vec<u8>>> = Mutex::new(None);
        let wire = b"before\x1b[6nafter\r\n".to_vec();

        drain(
            Cursor::new(wire.clone()),
            &ring,
            &replies,
            &a_pulse(),
            Box::new(NoWatch),
            &AtomicU64::new(0),
        );

        assert!(replies.into_inner().expect("not poisoned").is_none());
        assert_eq!(
            ring.into_inner().expect("not poisoned").whole(),
            wire,
            "the drain stopped at the query it could not answer"
        );
    }

    /// The same read is the ring's and the reading's, which is what makes the
    /// two impossible to disagree: a run that has printed cannot look silent
    /// since its spawn.
    #[test]
    fn the_bytes_the_ring_takes_are_the_bytes_the_silence_is_measured_from() {
        let ring = Mutex::new(Ring::new(SCROLLBACK));
        let replies = Mutex::new(Some(Vec::new()));
        let pulse = a_pulse();
        let started = Instant::now();

        drain(
            Cursor::new(b"working on it\r\n".to_vec()),
            &ring,
            &replies,
            &pulse,
            Box::new(NoWatch),
            &AtomicU64::new(0),
        );

        let printed = pulse
            .lock()
            .expect("not poisoned")
            .quiet(started + Duration::from_secs(30));
        assert!(
            printed < Duration::from_secs(30),
            "the silence was still being measured from the spawn after the child printed"
        );
    }

    /// A run is classified by the watch it was opened with, and the last thing
    /// that watch said is what is kept. Exercised with a fake because every v1
    /// adapter takes `NoWatch` — the path is the thing under test, not any
    /// shipped classifier.
    #[test]
    fn a_run_is_classified_by_the_watch_it_was_opened_with_and_keeps_the_last_answer() {
        let ring = Mutex::new(Ring::new(SCROLLBACK));
        let replies = Mutex::new(Some(Vec::new()));
        let pulse = a_pulse();

        drain(
            // One answer per read, and the reader hands the whole thing over in
            // one, so only the first is ever asked for here.
            Cursor::new(b"busy then idle".to_vec()),
            &ring,
            &replies,
            &pulse,
            Box::new(AWatch {
                says: vec![Some(Signal::Idle)],
            }),
            &AtomicU64::new(0),
        );

        assert_eq!(
            pulse.lock().expect("not poisoned").signal(),
            Some(Signal::Idle)
        );
    }

    /// A watch that says nothing leaves the run unclassified, and *unclassified*
    /// is a fact about the run rather than an answer about its adapter.
    #[test]
    fn a_run_no_signal_has_ever_been_observed_for_says_so_rather_than_naming_a_state() {
        let ring = Mutex::new(Ring::new(SCROLLBACK));
        let replies = Mutex::new(Some(Vec::new()));
        let pulse = a_pulse();

        drain(
            Cursor::new(b"plenty of output and not one signal".to_vec()),
            &ring,
            &replies,
            &pulse,
            Box::new(NoWatch),
            &AtomicU64::new(0),
        );

        assert_eq!(pulse.lock().expect("not poisoned").signal(), None);
    }

    #[test]
    fn typing_at_a_session_that_has_been_hung_up_is_refused_rather_than_going_nowhere() {
        let directory = TempDir::new().expect("temp dir");
        let mut session = Session::spawn(
            a_run_of(A_WAIT),
            directory.path(),
            &[],
            Geometry::new(40, 120),
            SCROLLBACK,
            Box::new(NoWatch),
        )
        .expect("a shell starts");

        session.hang_up();
        // Twice, because the first phase of a quit runs over every session and a
        // second ask must not be a panic.
        session.hang_up();

        let refusal = session
            .typed(b"\r")
            .expect_err("there is no writer left to take it");

        let sentence = refusal.to_string();
        assert!(
            sentence.len() > 40,
            "{sentence:?} is a label rather than a sentence"
        );
        assert!(
            !sentence.ends_with('.'),
            "{sentence:?} ends in a full stop; house style does not"
        );
        assert!(
            sentence
                .chars()
                .next()
                .is_some_and(|opening| !opening.is_uppercase()),
            "{sentence:?} opens upper case; house style does not"
        );
    }

    /// A line that outlives the test that starts it, so there is a live child to
    /// hang up on.
    /// The stamp is *when bytes were appended*, and the only way to tell that
    /// from *when a reader returned* is to plant an impossible one and watch it
    /// move. Zero is before the epoch's first second, so nothing but this
    /// drain's own store can produce the reading asserted here.
    #[test]
    fn a_drain_stamps_the_moment_it_appends_and_not_the_moment_it_was_asked() {
        let ring = Mutex::new(Ring::new(SCROLLBACK));
        let replies = Mutex::new(Some(Vec::new()));
        let spoke = AtomicU64::new(0);
        let before = stamped();

        drain(
            Cursor::new(b"said something\r\n".to_vec()),
            &ring,
            &replies,
            &a_pulse(),
            Box::new(NoWatch),
            &spoke,
        );

        let spoke = spoke.load(Ordering::Relaxed);
        assert!(spoke >= before, "output did not reset the silence at all");
        assert!(
            spoke <= stamped(),
            "the stamp is in the future, so it was not read off this clock"
        );
    }

    /// A run that has printed nothing has been silent for exactly as long as it
    /// has existed — so its silence grows with its age rather than starting over
    /// at a *never spoke* the chrome would have to spell a second way.
    #[test]
    fn a_run_that_has_printed_nothing_has_been_silent_for_as_long_as_it_has_lived() {
        let directory = TempDir::new().expect("temp dir");
        let session = Session::spawn(
            a_run_of(A_WAIT),
            directory.path(),
            &[],
            Geometry::new(40, 120),
            SCROLLBACK,
            Box::new(NoWatch),
        )
        .expect("a shell starts");

        // Long enough that a drain with anything to append would have appended
        // it, and this shell has nothing.
        std::thread::sleep(Duration::from_millis(300));

        let whole = session.held().whole();
        assert_eq!(
            session.held().end(),
            0,
            "the shell printed after all: {:?}",
            String::from_utf8_lossy(&whole)
        );
        assert_eq!(session.spoke(), session.opened());
    }

    /// A wait that is genuinely silent, which `timeout` is not.
    ///
    /// `timeout /t N /nobreak` writes its countdown to the *console*, so `>nul`
    /// — which only redirects standard output — does not stop it reaching the
    /// ring. Every other use of `timeout` in this crate is prefixed by an `echo`
    /// and is reading output on purpose, so the banner is invisible there; the
    /// one test that asserts a shell printed *nothing* is the one place it is
    /// not, and it went red on Windows with the banner's sixty-one bytes.
    ///
    /// `ping` writes to standard output like an ordinary program, so `>nul`
    /// really does swallow it. `hanging_up_ends_a_windows_run_by_itself` in
    /// `runs.rs` already waits this way, and for the neighbouring reason.
    #[cfg(windows)]
    const A_WAIT: &str = "ping -n 31 127.0.0.1 >nul";
    #[cfg(not(windows))]
    const A_WAIT: &str = "sleep 30";
}

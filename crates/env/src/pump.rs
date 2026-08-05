use std::ffi::OsStr;
use std::io::Read;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use crate::parse::find_from;

/// A GUI bundle must not flash a console window on Windows for a measurement
/// the operator never asked to watch.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// How often the child is asked whether it has exited, once the answer is in
/// hand. Small enough that a fast exit is not rounded up into the readout's
/// `elapsedMs`, large enough not to spin.
const POLL: Duration = Duration::from_millis(10);

/// Everything a spawn needs, as a value.
///
/// This module is the only impure one in the crate and it is kept deliberately
/// small: it knows about pipes, threads and clocks, and nothing at all about
/// environments, frames, tokens or GitHub. What the bytes mean is somebody
/// else's question.
pub(crate) struct Plan<'a> {
    pub program: &'a OsStr,
    pub args: &'a [&'a OsStr],
    pub cwd: &'a Path,
    /// Applied to the command after the stdio is set and before the spawn, so
    /// the caller decides whether the child inherits this process's environment
    /// or replaces it wholesale.
    pub environment: &'a dyn Fn(&mut Command),
    /// The bytes that end the caller's interest in stdout. `None` means EOF.
    ///
    /// Seeing them ends [`Plan::deadline`] and starts [`Plan::exit_grace`], and
    /// **that** is what keeps a harvest off EOF: a login shell may leave a
    /// daemon holding the write handle, measured here at 4219 ms past a clean
    /// exit on a payload that backgrounded a four-second sleeper, and at
    /// 4013 ms on Windows in #26. Neither is a bound anybody chose.
    ///
    /// Reading does not *cease* at the mark, because the mark cannot be
    /// trusted to be ours: a start-up file that prints a whole forged frame
    /// closes one before the real answer has been written, and a reader that
    /// stopped dead there would hand back the forgery — which is the exact
    /// substitution last-mark-wins exists to defeat. So the mark converts an
    /// unbounded read into a bounded one, and the parser decides which frame
    /// was the answer.
    pub stop_at: Option<&'a [u8]>,
    /// Spawn to the stop mark. Expiring it means the caller gets nothing.
    pub deadline: Duration,
    /// Stop mark to the child's exit. Expiring it is not a failure — the answer
    /// is already in hand — and the child we spawned is stopped so that it is
    /// not left behind.
    pub exit_grace: Duration,
    /// Past this with no stop mark, the harvest is lost, so the read ends here
    /// too and the caller is handed [`PumpOutcome::Overflowed`].
    pub stdout_cap: usize,
    /// A bound on what this process keeps, and on nothing else. The read runs to
    /// EOF past it — see [`drain`] for the SIGPIPE that closing it early costs.
    pub stderr_cap: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PumpOutcome {
    /// The stop mark arrived, or — with no stop mark — stdout reached EOF.
    Finished,
    /// The deadline expired with the stop mark still unseen.
    Expired,
    /// stdout passed its cap without the stop mark arriving.
    Overflowed,
}

pub(crate) struct Pumped {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub outcome: PumpOutcome,
    /// `None` when the platform reports no code — a signal, on unix — and when
    /// the child had to be stopped.
    pub status: Option<i32>,
    pub elapsed: Duration,
}

/// Spawns, drains both pipes concurrently with the wait, and abandons whatever
/// will not end.
///
/// Both pipes get their own thread and both threads run *while* the child is
/// still being waited on. Reading one stream to the end before waiting is the
/// deadlock #26 measured on a chatty profile: the child blocks writing into a
/// full pipe nobody is draining, we block waiting for a child that cannot make
/// progress, and the result is indistinguishable from a profile that is
/// genuinely still working. That indistinguishability is why the drain order is
/// not a detail — a harness that got it wrong would blame the operator's
/// start-up files for its own bug.
///
/// stdin is [`Stdio::null`] rather than inherited: a start-up file that reads
/// gets EOF and carries on. Measured here — a blocking `read -r ANSWER` in a
/// `.zshrc` exits 0 at 220 ms with the line after it having run.
///
/// Only the child we spawned is killed, never its tree. A grandchild belongs to
/// the operator's own start-up files — a background updater, or a daemon the rc
/// started on purpose — and reaching outside our own child to undo something
/// the operator asked for is not ours to do. The price is that a reader thread
/// can park on a pipe that grandchild is holding; it is abandoned rather than
/// waited for, and [`Plan::exit_grace`] is what bounds the cost.
pub(crate) fn pump(plan: &Plan<'_>) -> std::io::Result<Pumped> {
    let mut command = Command::new(plan.program);
    command
        .args(plan.args)
        .current_dir(plan.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    (plan.environment)(&mut command);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let started = Instant::now();
    let mut child = command.spawn()?;

    let stdout_sink = Arc::new(Mutex::new(Vec::new()));
    let stderr_sink = Arc::new(Mutex::new(Vec::new()));
    let (sender, receiver) = mpsc::channel();

    let out = child.stdout.take().expect("stdout was piped");
    let err = child.stderr.take().expect("stderr was piped");
    spawn_drain(
        "perseverance-env-stdout",
        out,
        Arc::clone(&stdout_sink),
        plan.stop_at.map(<[u8]>::to_vec),
        plan.stdout_cap,
        Stream::Stdout,
        sender.clone(),
    )?;
    spawn_drain(
        "perseverance-env-stderr",
        err,
        Arc::clone(&stderr_sink),
        None,
        plan.stderr_cap,
        Stream::Stderr,
        sender.clone(),
    )?;
    // Held only by the two readers from here, so a `Disconnected` means both
    // have finished rather than that anything went wrong.
    drop(sender);

    let mut reached: Option<Reached> = None;
    let mut stdout_finished = false;
    let mut stderr_finished = false;
    while reached.is_none() {
        let Some(left) = plan.deadline.checked_sub(started.elapsed()) else {
            break;
        };
        match receiver.recv_timeout(left) {
            Ok((Stream::Stdout, at)) => {
                stdout_finished = at != Reached::Mark;
                reached = Some(at);
            }
            Ok((Stream::Stderr, _)) => stderr_finished = true,
            Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => break,
        }
    }

    let outcome = match reached {
        Some(Reached::Mark | Reached::Eof) => PumpOutcome::Finished,
        Some(Reached::Cap) => PumpOutcome::Overflowed,
        None => PumpOutcome::Expired,
    };
    let status = settle(
        &mut child,
        &receiver,
        &mut stdout_finished,
        &mut stderr_finished,
        outcome,
        plan.exit_grace,
    );
    let elapsed = started.elapsed();

    Ok(Pumped {
        stdout: taken(&stdout_sink, plan.stdout_cap),
        stderr: taken(&stderr_sink, plan.stderr_cap),
        outcome,
        status,
        elapsed,
    })
}

/// How far a drain got. `Mark` is the only one that is not the end of a stream,
/// and the only one this crate ever reports twice.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Reached {
    Mark,
    Eof,
    /// stdout only. stderr's cap fills its sink without ending its read, so a
    /// stderr drain reports `Eof` however much the shell wrote.
    Cap,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stream {
    Stdout,
    Stderr,
}

fn spawn_drain(
    name: &str,
    source: impl Read + Send + 'static,
    sink: Arc<Mutex<Vec<u8>>>,
    stop_at: Option<Vec<u8>>,
    cap: usize,
    stream: Stream,
    sender: Sender<(Stream, Reached)>,
) -> std::io::Result<()> {
    std::thread::Builder::new()
        .name(name.to_string())
        .spawn(move || {
            drain(source, &sink, stop_at.as_deref(), cap, stream, &sender);
        })?;
    Ok(())
}

/// Reads into a shared buffer rather than returning one, so a reader that never
/// ends still leaves behind everything it managed to read — which is how a
/// discarded harvest can still show the operator what their shell wrote to
/// stderr.
///
/// The stop mark is announced the first time it appears and the read carries
/// on. Announcing is what ends the deadline; carrying on is what lets a real
/// answer arrive after a start-up file has printed a forged frame.
///
/// Shared by both streams, and the cap is the one place they part: it bounds
/// the sink on both, and ends the read on stdout only.
fn drain(
    mut source: impl Read,
    sink: &Mutex<Vec<u8>>,
    stop_at: Option<&[u8]>,
    cap: usize,
    stream: Stream,
    sender: &Sender<(Stream, Reached)>,
) {
    let mut chunk = [0_u8; 8192];
    let mut searched: usize = 0;
    let mut announced = false;

    let ended = loop {
        let read = match source.read(&mut chunk) {
            Ok(0) => break Reached::Eof,
            Ok(read) => read,
            // A pipe that errors has nothing further to give, and there is no
            // partial read to recover.
            Err(_) => break Reached::Eof,
        };

        let mut held = sink.lock().unwrap_or_else(PoisonError::into_inner);
        // The cap bounds what is *kept*, so a full sink stops the appending and
        // not the read. `taken` truncates to `cap` regardless, so overshooting
        // by at most one chunk changes nothing about what a caller gets back.
        if held.len() < cap {
            held.extend_from_slice(&chunk[..read]);
        }

        if let Some(mark) = stop_at.filter(|_| !announced) {
            // Only the tail is re-searched: a mark cannot straddle further back
            // than its own length, and rescanning a 1.6 MB flood on every
            // 8 KiB read would make a chatty profile quadratic.
            let from = searched.saturating_sub(mark.len().saturating_sub(1));
            if find_from(&held, mark, from).is_some() {
                announced = true;
                let _ = sender.send((stream, Reached::Mark));
            }
            searched = held.len();
        }

        if held.len() >= cap {
            match stream {
                // stdout past its cap with no mark is a lost harvest already,
                // and ending the read is what makes it sayable as
                // `OutputTooLarge` rather than left to expire the deadline.
                Stream::Stdout => break Reached::Cap,
                // stderr's cap may not end the read, because ending it drops
                // `ChildStderr` and closes the read end while the shell is
                // still running — and a shell writing through a builtin dies of
                // SIGPIPE for it, losing an answer it had not written yet.
                // Measured here: floods `/bin/sh`, `/bin/zsh` and `/bin/bash`
                // with their own `printf`, close the read end at 64 KiB, and all
                // three exit rc -13 with an empty stdout; an external `cat`
                // doing the writing survives, which is why the flood stub built
                // on `cat` could not catch this. So the sink stops filling and
                // the pipe stays open to EOF: the cap bounds this process's
                // memory, not how much the operator's shell is allowed to say.
                Stream::Stderr => {}
            }
        }
    };

    // The receiver may already have given up on this stream, which is the whole
    // point of abandoning a reader parked on a pipe a grandchild is holding.
    let _ = sender.send((stream, ended));
}

/// Waits for the child, briefly, and stops it if it will not go.
///
/// Two bounds, not one, because a clean exit and a closed frame diverge by
/// seconds. Expiring the deadline has already discarded the answer, so there is
/// nothing left to wait for and the child is stopped at once. Expiring the
/// grace has not: the answer is in hand, and a profile that left a background
/// updater holding a handle has not failed. Its only trace is `elapsedMs`, and
/// that is said out loud in the crate's honest limits rather than implied.
fn settle(
    child: &mut Child,
    receiver: &Receiver<(Stream, Reached)>,
    stdout_finished: &mut bool,
    stderr_finished: &mut bool,
    outcome: PumpOutcome,
    grace: Duration,
) -> Option<i32> {
    if outcome == PumpOutcome::Expired {
        let _ = child.kill();
        return child.wait().ok().and_then(|status| status.code());
    }

    let since = Instant::now();
    let mut exited = None;
    loop {
        if exited.is_none() {
            exited = child.try_wait().ok().flatten();
        }
        if exited.is_some() && *stdout_finished && *stderr_finished {
            break;
        }
        let Some(left) = grace.checked_sub(since.elapsed()) else {
            break;
        };
        match receiver.recv_timeout(left.min(POLL)) {
            Ok((Stream::Stdout, at)) => *stdout_finished = at != Reached::Mark,
            Ok((Stream::Stderr, _)) => *stderr_finished = true,
            Err(RecvTimeoutError::Timeout) => {}
            // Both readers are done and the child still has not exited, so
            // there is nothing to wake for; poll rather than spin.
            Err(RecvTimeoutError::Disconnected) => std::thread::sleep(left.min(POLL)),
        }
    }

    match exited {
        Some(status) => status.code(),
        None => {
            let _ = child.kill();
            child.wait().ok().and_then(|status| status.code())
        }
    }
}

/// A snapshot of whatever a reader has put down so far, capped. Cloned rather
/// than moved because the reader may still be running and may never stop.
fn taken(sink: &Mutex<Vec<u8>>, cap: usize) -> Vec<u8> {
    let held = sink.lock().unwrap_or_else(PoisonError::into_inner);
    let mut bytes = held.clone();
    bytes.truncate(cap);
    bytes
}

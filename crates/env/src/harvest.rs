use std::ffi::OsStr;
use std::time::Duration;

use crate::environment::Environment;
use crate::nonce::Nonce;
use crate::parse::{read_frame, Tally};
use crate::payload::closing_mark;
use crate::pump::{pump, Plan, PumpOutcome};
use crate::shell::{harvest_command, HarvestCommand, Shell};

/// Two bounds and two caps, because a clean exit and a closed frame diverge by
/// seconds.
///
/// `frame` runs from spawn to the closing mark; expiring it discards the whole
/// harvest, which is sound because a killed shell emits no mark pair.
/// `exit_grace` runs from the closing mark to the child's exit, and expiring it
/// is **not** a failure — the environment is already in hand, and a profile that
/// left a background updater holding the write handle has not failed. #26
/// measured a grandchild that returned the process at 1063 ms and the read at
/// 4013 ms; measured again here on macOS, a payload leaving `(sleep 4 &)` behind
/// framed its answer in milliseconds and did not reach EOF until 4219 ms. That
/// gap is why there are two numbers here and not one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Bounds {
    pub frame: Duration,
    pub exit_grace: Duration,
    pub stdout_cap: usize,
    pub stderr_cap: usize,
}

impl Bounds {
    /// unix: 8 s / 2 s. Windows: 20 s / 5 s. Caps: 8 MiB stdout, 4 MiB stderr.
    ///
    /// Sized on the slowest run that legitimately **completed**, never on the
    /// median. The binding data are not the cost table: a chatty profile drained
    /// 1.64 MB of stderr and finished at 4234 ms; `Get-Credential` took 1873 ms;
    /// PowerShell's own startup floor is 591 ms before a profile has done
    /// anything, and a real profile costs 1.9 s on top. #26's own harness used
    /// 12–15 s process guards and 5–8 s read guards. On unix the median is
    /// 187 ms — 186–252 ms re-measured here — and #21's 2 s watchdog was only
    /// eightfold, too little headroom for a p10k or conda rc. Nothing waits on
    /// either number, so slack costs nothing and tightness costs an operator
    /// their environment.
    pub fn for_this_machine() -> Bounds {
        let (frame, exit_grace) = if cfg!(windows) {
            (Duration::from_secs(20), Duration::from_secs(5))
        } else {
            (Duration::from_secs(8), Duration::from_secs(2))
        };
        Bounds {
            frame,
            exit_grace,
            stdout_cap: 8 * 1024 * 1024,
            stderr_cap: 4 * 1024 * 1024,
        }
    }
}

/// What the shell wrote to stderr: the bytes, capped and read lossily, plus a
/// classification by **content** rather than by platform — the `#< CLIXML`
/// prefix is the whole test, so this runs the same on both runners.
///
/// Never a boolean error signal. On Windows the stream carries a **616-byte
/// non-empty baseline with no profile at all**, and native-executable output
/// passes through raw and interleaved with the XML.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stderr {
    /// Verbatim, capped at [`Bounds::stderr_cap`], decoded lossily.
    ///
    /// Kept rather than reduced to a byte count. Under `AllSigned` the profile
    /// does not run, stdout is clean, both marks arrive and the refusal appears
    /// **only** here — throwing the text away would delete the sole artifact of
    /// the one degradation this crate admits it cannot detect. On Windows it is
    /// hard-wrapped mid-word before serialisation (`cannot _x000D__x000A_be
    /// loaded`), so shown verbatim it looks broken; the panel says so above it
    /// rather than tidying it into something that is no longer evidence.
    pub text: String,
    pub bytes: usize,
    pub kind: StderrKind,
}

impl Stderr {
    fn of(bytes: &[u8]) -> Stderr {
        Stderr {
            text: String::from_utf8_lossy(bytes).into_owned(),
            bytes: bytes.len(),
            kind: classify_stderr(bytes),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StderrKind {
    Empty,
    /// Plain text, worth reading: this is where #21's `command not found: fnm`
    /// appeared under `-ic`.
    Text,
    /// PowerShell's own serialisation. Present is not the same as wrong.
    Clixml,
}

/// By content, so a macOS runner can assert the Windows classification and the
/// other way round. The prefix is the whole test.
pub fn classify_stderr(bytes: &[u8]) -> StderrKind {
    if bytes.is_empty() {
        StderrKind::Empty
    } else if bytes.starts_with(b"#< CLIXML") {
        StderrKind::Clixml
    } else {
        StderrKind::Text
    }
}

/// What a harvest came back with: the environment and the parser's count of
/// what it saw on the way to it, and nothing else.
///
/// The shell, the stream and the clock are [`HarvestAttempt`]'s, because they
/// are true of the *attempt* whether or not it produced one of these. One home
/// per fact, so there is no second copy to drift.
#[derive(Debug, Clone)]
pub struct Harvest {
    pub environment: Environment,
    pub tally: Tally,
}

/// One run of one shell, whatever became of it.
///
/// [`HarvestAttempt::stderr`] sits **outside** [`HarvestAttempt::outcome`] on
/// purpose, and that placement is the whole shape of this type. stderr is where
/// the evidence lives, and a discarded harvest is when it matters most: #21
/// found the `-ic` failure — an rc whose `fnm` line died, leaving a `PATH` that
/// still looked plausible — only on this stream, and #26 found that under
/// `AllSigned` the refusal to run a profile at all appears only here, on a
/// stream whose Windows baseline is never empty. A type that threw the bytes
/// away with the [`HarvestCondition`] would leave a diagnostics panel blind in
/// exactly the case an operator opened it for, and would report *empty* — the
/// same reading as a shell that wrote nothing — for *thrown away*.
///
/// [`HarvestAttempt::shell`] is the shell that actually ran, so a caller
/// reporting a discarded harvest names what was asked rather than asking the
/// machine again and naming a second guess.
#[derive(Debug, Clone)]
pub struct HarvestAttempt {
    pub outcome: Result<Harvest, HarvestCondition>,
    /// `None` only when no shell could be chosen at all — which is exactly the
    /// readout's `WireShell::None`.
    pub shell: Option<Shell>,
    /// Whatever the shell wrote, drained concurrently and kept even when the
    /// answer was discarded. Empty where nothing ever ran to write it:
    /// [`HarvestCondition::NoShellNamed`], [`HarvestCondition::NoShellInstalled`]
    /// and [`HarvestCondition::ShellDidNotStart`] all precede a process, so
    /// their emptiness is a fact rather than a loss.
    pub stderr: Stderr,
    /// Spawn to the closing mark, measured by the run itself rather than by a
    /// caller's clock, and zero on the conditions that precede a spawn.
    pub elapsed: Duration,
}

impl HarvestAttempt {
    /// The conditions [`Shell::for_this_machine`] decides before anything is
    /// run. No shell was chosen, so none is named; nothing was spawned, so
    /// there is no stream and no duration to report.
    fn before_a_shell_was_chosen(condition: HarvestCondition) -> HarvestAttempt {
        HarvestAttempt {
            outcome: Err(condition),
            shell: None,
            stderr: Stderr::of(b""),
            elapsed: Duration::ZERO,
        }
    }
}

/// Every way a harvest declines to produce an environment.
///
/// None of these is thrown at the app: the caller records the condition, falls
/// back to inheritance, and the window is already open. None may read like a
/// failed request either — nothing here makes one — and the frame sentence names
/// **both** possibilities rather than the likelier one, because #26 showed that
/// a drain in the wrong order deadlocks indistinguishably from a profile that is
/// genuinely still working. `RepoBindingError::NotAGitRepo`'s doc comment
/// records that rule; this is its second instance.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum HarvestCondition {
    /// Refused rather than fallen back to `/bin/zsh`. #21 confirmed a GUI
    /// bundle's launchd record does carry `SHELL`, so this fires only in a case
    /// never observed — and guessing would run start-up files that are not the
    /// operator's, silently, which is the one harm #15 named.
    #[error(
        "the environment this app was launched with names no shell, and guessing at one would \
         run start-up files nobody asked this app to run"
    )]
    NoShellNamed,

    #[error(
        "no PowerShell where Windows keeps it ({looked_in}); it is not looked for anywhere else, \
         because where to look is what has not been established yet"
    )]
    NoShellInstalled { looked_in: String },

    #[error("{program} did not start: {detail}")]
    ShellDidNotStart { program: String, detail: String },

    #[error(
        "the shell finished without ever writing this run's opening mark, so there is nothing \
         here that it meant as an answer"
    )]
    NoOpeningMark,

    #[error(
        "the harvest opened but was still not closed after {after_ms} ms: either the shell is \
         still working through its start-up files, or nothing here read what it wrote"
    )]
    FrameNeverClosed { after_ms: u64 },

    #[error("the shell wrote more than {cap_bytes} bytes without closing the harvest")]
    OutputTooLarge { cap_bytes: usize },

    #[error("the harvest closed with nothing inside it that was shaped like a variable")]
    NoVariablesSurvived,

    #[error("the harvest closed with no PATH in it, which is the one thing it exists to carry")]
    NoPathInHarvest,
}

/// The real one: pick the shell from this process's environment, mint a nonce,
/// run it at the root under the shipped bounds, read the frame.
pub fn harvest() -> HarvestAttempt {
    let shell = match Shell::for_this_machine(&|name| std::env::var(name).ok()) {
        Ok(shell) => shell,
        Err(condition) => return HarvestAttempt::before_a_shell_was_chosen(condition),
    };
    let nonce = Nonce::fresh();
    let command = harvest_command(shell, &nonce);
    harvest_with(&command, &nonce, &Bounds::for_this_machine())
}

/// The seam the tests drive, and the seam #45 extends.
///
/// Everything about a harvest except *which program* is a parameter, so a fake
/// shell exercises the framing, the two bounds, both drains, the kill and the
/// parser on a runner that has no login shell and no profile — and so #45's
/// per-folder harvest is this function plus a map keyed on the absolute spawn
/// cwd, rather than a second implementation.
///
/// It hands back a [`HarvestAttempt`] rather than a bare `Result` so that what
/// the shell said survives being discarded — see that type for why the stream
/// is the half a caller needs most when there is no environment.
pub fn harvest_with(command: &HarvestCommand, nonce: &Nonce, bounds: &Bounds) -> HarvestAttempt {
    let closing = closing_mark(nonce);
    let args: Vec<&OsStr> = command.args.iter().map(OsStr::new).collect();
    let overlay = &command.env_overlay;

    let spawned = pump(&Plan {
        program: OsStr::new(&command.program),
        args: &args,
        cwd: &command.cwd,
        // Laid over what this process was launched with, never over a previous
        // harvest: a second harvest carrying the first's `PATH` would compound.
        environment: &|child: &mut std::process::Command| {
            for (name, value) in overlay {
                child.env(name, value);
            }
        },
        stop_at: Some(&closing),
        deadline: bounds.frame,
        exit_grace: bounds.exit_grace,
        stdout_cap: bounds.stdout_cap,
        stderr_cap: bounds.stderr_cap,
    });

    let pumped = match spawned {
        Ok(pumped) => pumped,
        // The one condition where the shell is named and nothing of it ran:
        // there is no process, so there are no bytes and no duration, and the
        // empty stream below is that fact rather than a discarded one.
        Err(refused) => {
            return HarvestAttempt {
                outcome: Err(HarvestCondition::ShellDidNotStart {
                    program: command.program.clone(),
                    detail: refused.to_string(),
                }),
                shell: Some(command.shell.clone()),
                stderr: Stderr::of(b""),
                elapsed: Duration::ZERO,
            }
        }
    };

    let elapsed = pumped.elapsed;
    let after_ms = elapsed.as_millis().min(u128::from(u64::MAX)) as u64;

    let outcome = match pumped.outcome {
        PumpOutcome::Overflowed => Err(HarvestCondition::OutputTooLarge {
            cap_bytes: bounds.stdout_cap,
        }),
        PumpOutcome::Expired => Err(HarvestCondition::FrameNeverClosed { after_ms }),
        // `read_frame` has no clock, so the one condition it cannot fill in
        // honestly is filled in here.
        PumpOutcome::Finished => read_frame(&pumped.stdout, nonce, command.shell.record_tag())
            .map(|reading| Harvest {
                tally: reading.tally,
                environment: Environment::from_reading(reading),
            })
            .map_err(|condition| match condition {
                HarvestCondition::FrameNeverClosed { .. } => {
                    HarvestCondition::FrameNeverClosed { after_ms }
                }
                other => other,
            }),
    };

    HarvestAttempt {
        outcome,
        shell: Some(command.shell.clone()),
        // Taken on every path, discarded or not. What a start-up file said
        // while the frame never closed is the only account of it there is.
        stderr: Stderr::of(&pumped.stderr),
        elapsed,
    }
}

/// The vocabulary of a failed request. No condition this crate produces may
/// contain any of it, because nothing this crate does involves a request. The
/// list is `crates/store/src/repo.rs`'s, copied rather than shared because a
/// dependency on the registry to acquire an environment would be absurd.
#[cfg(test)]
pub(crate) const NETWORK_VOCABULARY: &[&str] = &[
    "reach", "connect", "network", "timeout", "offline", "retry", "server", "http",
];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse::{framed, opened_only, RecordTag};
    use crate::run::RunFailure;
    use std::path::{Path, PathBuf};
    use tempfile::TempDir;

    /* ----------------------------------------------- stderr classification --- */

    #[test]
    fn the_windows_baseline_is_serialised_output_and_not_an_error() {
        // 616 bytes of this arrive with no profile at all, so "stderr is
        // non-empty" is not a verdict anyone may draw.
        let baseline = b"#< CLIXML\r\n<Objs Version=\"1.1.0.1\" xmlns=\"http://schemas.microsoft.com/powershell/2004/04\"><Obj S=\"progress\" RefId=\"0\"/></Objs>";

        let classified = Stderr::of(baseline);

        assert_eq!(classified.kind, StderrKind::Clixml);
        assert_eq!(classified.bytes, baseline.len());
        assert!(classified.text.starts_with("#< CLIXML"));
    }

    #[test]
    fn a_wrapped_clixml_error_is_shown_as_it_arrived_rather_than_repaired() {
        let wrapped = b"#< CLIXML\r\n<S S=\"Error\">cannot _x000D__x000A_be loaded</S>";

        let classified = Stderr::of(wrapped);

        // Hard-wrapped mid-word before serialisation. Shown verbatim it looks
        // broken; that is correct, and it is the only artifact an `AllSigned`
        // refusal ever leaves.
        assert!(classified.text.contains("cannot _x000D__x000A_be loaded"));
        assert_eq!(classified.kind, StderrKind::Clixml);
    }

    #[test]
    fn a_broken_rc_line_is_plain_text_worth_reading() {
        let said = b"command not found: fnm\n";

        let classified = Stderr::of(said);

        assert_eq!(classified.kind, StderrKind::Text);
        assert_eq!(classified.text, "command not found: fnm\n");
        assert_eq!(classified.bytes, 23);
    }

    #[test]
    fn a_shell_that_wrote_nothing_to_stderr_is_the_only_empty_one() {
        assert_eq!(classify_stderr(b""), StderrKind::Empty);
        assert_eq!(classify_stderr(b"\n"), StderrKind::Text);
        assert_eq!(classify_stderr(b"#< CLIXML"), StderrKind::Clixml);
        // The prefix is the whole test, and it has to be at the front: a
        // profile that printed the words later did not serialise anything.
        assert_eq!(classify_stderr(b"oops\n#< CLIXML"), StderrKind::Text);
    }

    #[test]
    fn no_harvest_condition_reads_like_a_network_failure() {
        let conditions = [
            HarvestCondition::NoShellNamed.to_string(),
            HarvestCondition::NoShellInstalled {
                looked_in: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
                    .to_string(),
            }
            .to_string(),
            HarvestCondition::ShellDidNotStart {
                program: "/bin/zsh".to_string(),
                detail: "No such file or directory (os error 2)".to_string(),
            }
            .to_string(),
            HarvestCondition::NoOpeningMark.to_string(),
            HarvestCondition::FrameNeverClosed { after_ms: 8000 }.to_string(),
            HarvestCondition::OutputTooLarge { cap_bytes: 8388608 }.to_string(),
            HarvestCondition::NoVariablesSurvived.to_string(),
            HarvestCondition::NoPathInHarvest.to_string(),
            RunFailure::NotOnThisPath {
                program: "gh".to_string(),
            }
            .to_string(),
            RunFailure::DidNotStart {
                program: "gh".to_string(),
                detail: "Permission denied (os error 13)".to_string(),
            }
            .to_string(),
            RunFailure::RanTooLong {
                program: "gh".to_string(),
                after_ms: 8000,
            }
            .to_string(),
        ];

        for condition in conditions {
            let lowered = condition.to_lowercase();
            for word in NETWORK_VOCABULARY {
                assert!(
                    !lowered.contains(word),
                    "{condition:?} reads like a network failure because of {word:?}"
                );
            }
        }
    }

    #[test]
    fn the_frame_sentence_names_both_possibilities_and_blames_neither() {
        let said = HarvestCondition::FrameNeverClosed { after_ms: 8000 }.to_string();

        // A drain in the wrong order deadlocks indistinguishably from a
        // profile that is genuinely still working, so a sentence naming only
        // the first is asserting the likelier of two things when one of them
        // is this harness's own bug.
        assert!(said.contains("still working"), "{said}");
        assert!(said.contains("nothing here read"), "{said}");
        for blame in ["broken", "misconfigured", "invalid", "failed"] {
            assert!(!said.contains(blame), "{said}");
        }
    }

    #[test]
    fn the_bounds_leave_room_for_the_slowest_run_that_legitimately_completed() {
        let bounds = Bounds::for_this_machine();

        // #26's chatty-stderr harvest completed at 4234 ms having drained
        // 1.64 MB; the grandchild read finished 2950 ms after a clean exit.
        assert!(bounds.frame >= Duration::from_secs(8));
        assert!(bounds.exit_grace >= Duration::from_secs(2));
        assert!(bounds.stdout_cap >= 8 * 1024 * 1024);
        assert!(bounds.stderr_cap >= 4 * 1024 * 1024);
    }

    /* ------------------------------------------------------- the stub shell --- */

    fn nonce() -> Nonce {
        Nonce::from_literal("deadbeefdeadbeef")
    }

    /// Short enough that the expiry tests cost half a second each rather than
    /// the twenty-eight seconds the shipped numbers would. Only for the tests
    /// whose subject *is* a bound firing.
    fn quick() -> Bounds {
        Bounds {
            frame: Duration::from_millis(500),
            exit_grace: Duration::from_millis(200),
            stdout_cap: 8 * 1024 * 1024,
            stderr_cap: 4 * 1024 * 1024,
        }
    }

    /// For every test whose subject is *not* a bound. A deadline that starts
    /// before the spawn is a deadline on the runner's scheduler as much as on
    /// the child, and a suite that spawns a dozen shells at once on a loaded
    /// machine will lose a 500 ms race that means nothing. The grace stays
    /// short so the stubs that sleep for thirty seconds still cost a fifth of
    /// one.
    ///
    /// Twenty rather than ten, and it costs nothing: no test using these bounds
    /// expects the frame to expire — the expiry tests take [`quick`] — so every
    /// one of them ends at its mark or at EOF and the figure is only ever a
    /// ceiling. It was raised after `windows-latest` was seen taking 9.05 s to
    /// reach a mark with a dozen PowerShells spawning at once: at ten the next
    /// slow spawn would not have made this suite flaky, it would have made it
    /// wrong, discarding a harvest that had lost a race against a busy runner
    /// and reporting the operator's shell as silent.
    fn roomy() -> Bounds {
        Bounds {
            frame: Duration::from_secs(20),
            exit_grace: Duration::from_millis(200),
            ..quick()
        }
    }

    /// How long a stub that sleeps, or a grandchild that holds the write handle,
    /// keeps hold of it. Spelled once and read by both scripts and by the two
    /// wall-clock assertions, so the number the stubs sleep for and the number
    /// those assertions are measured against cannot drift apart.
    const STUB_HOLDS: Duration = Duration::from_secs(30);

    /// The pathology a stub exists to inflict. The bytes it emits are always
    /// the ones [`framed`] built, so the two languages differ only in "sleep,
    /// background, flood" — which cannot drift in a way the parser cares about.
    #[derive(Debug, Clone, Copy)]
    enum Pathology {
        /// Emit the transcript and exit.
        Plain,
        /// Emit the transcript, then stay alive far past every bound.
        ThenSleep,
        /// Leave a background sleeper holding the write end of stdout, emit the
        /// transcript, and exit at once.
        Grandchild,
        /// Flood stderr, then emit the transcript.
        FloodStderr,
        /// Flood stderr **from the shell's own process**, then emit the
        /// transcript.
        ///
        /// The distinction from [`Pathology::FloodStderr`] is the whole point
        /// and it is not cosmetic: that one floods with `cat "$WF31_FLOOD" >&2`,
        /// a *child* of the stub, so a read end closed under it kills the `cat`
        /// and the stub carries on to write its frame. Here the writer is the
        /// shell itself — its own `printf` builtin, in a loop — so a closed read
        /// end lands on the process that still owes us an answer. Measured on
        /// this machine: `/bin/sh`, `/bin/zsh` and `/bin/bash` all exit with
        /// rc `-13` (SIGPIPE) and an empty stdout when the read end is closed
        /// after 64 KiB and the writing is done by a builtin; they survive it
        /// when an external `cat` does the writing.
        FloodStderrItself,
        /// Flood stdout, then emit the transcript.
        FloodStdout,
        /// Read stdin to EOF, then emit the transcript.
        ReadsStdin,
        /// Say one line on stderr, then emit the transcript and exit. Paired
        /// with a half-frame it is a harvest that is discarded with the only
        /// account of itself on the stream nobody parses.
        TalksFirst,
        /// Write nothing at all and exit 127.
        Exits127,
    }

    /// #21's line, verbatim, because it is the one that was actually measured:
    /// under `-ic` the rc's `fnm` line died here while stdout still carried a
    /// plausible `PATH`. No `%` and no quote, so it goes through `printf` and
    /// through a single-quoted PowerShell literal unchanged.
    const SAID_ON_STDERR: &str = "command not found: fnm";

    #[cfg(unix)]
    fn script(pathology: Pathology) -> String {
        let emit = "cat \"$WF31_TRANSCRIPT\"\n";
        match pathology {
            Pathology::Plain => format!("#!/bin/sh\n{emit}"),
            Pathology::ThenSleep => {
                format!("#!/bin/sh\n{emit}sleep {}\n", STUB_HOLDS.as_secs())
            }
            Pathology::Grandchild => {
                format!("#!/bin/sh\nsleep {} &\n{emit}", STUB_HOLDS.as_secs())
            }
            Pathology::FloodStderr => {
                format!("#!/bin/sh\ncat \"$WF31_FLOOD\" >&2\n{emit}")
            }
            // The `cat` here only *reads*, into a variable; the one write is the
            // stub's own `printf` builtin, and that is the whole difference from
            // [`Pathology::FloodStderr`] above. Piping the file straight to
            // stderr instead would put a child on the write end and this stub
            // would survive the very signal it exists to take. `printf` is a
            // builtin in every `/bin/sh` this runs under, so the process holding
            // the write end is the stub itself.
            //
            // One write of the whole flood rather than a line-at-a-time loop:
            // measured on this machine, both shapes kill all three shells with
            // rc -13, and this one costs 0.03 s against 0.11-0.15 s — load a
            // suite with timing assertions in it should not have to absorb.
            Pathology::FloodStderrItself => format!(
                "#!/bin/sh\nwf31=$(cat \"$WF31_FLOOD\")\nprintf '%s\\n' \"$wf31\" >&2\n{emit}"
            ),
            Pathology::FloodStdout => format!("#!/bin/sh\ncat \"$WF31_FLOOD\"\n{emit}"),
            Pathology::ReadsStdin => format!("#!/bin/sh\ncat >/dev/null\n{emit}"),
            Pathology::TalksFirst => {
                format!("#!/bin/sh\nprintf '{SAID_ON_STDERR}' >&2\n{emit}")
            }
            Pathology::Exits127 => "#!/bin/sh\nexit 127\n".to_string(),
        }
    }

    /// Unrun. No Windows machine was available while this was written, so every
    /// assertion below is CI's `windows-latest` job to make for the first time.
    #[cfg(windows)]
    fn script(pathology: Pathology) -> String {
        let emit = "$o=[Console]::OpenStandardOutput()\n\
                    $b=[IO.File]::ReadAllBytes($env:WF31_TRANSCRIPT)\n\
                    $o.Write($b,0,$b.Length)\n\
                    $o.Flush()\n";
        match pathology {
            Pathology::Plain => emit.to_string(),
            Pathology::ThenSleep => {
                format!("{emit}Start-Sleep -Seconds {}\n", STUB_HOLDS.as_secs())
            }
            // `ping` sends its first packet at once and waits a second between
            // the rest, so one more than the seconds wanted is the count that
            // holds the handle for them.
            Pathology::Grandchild => format!(
                "Start-Process -FilePath cmd.exe -ArgumentList \
                 '/c','ping','-n','{}','127.0.0.1' -NoNewWindow\n{emit}",
                STUB_HOLDS.as_secs() + 1
            ),
            Pathology::FloodStderr => format!(
                "$e=[Console]::OpenStandardError()\n\
                 $f=[IO.File]::ReadAllBytes($env:WF31_FLOOD)\n\
                 $e.Write($f,0,$f.Length)\n\
                 $e.Flush()\n{emit}"
            ),
            // Chunked and flushed rather than written in one go, so the write
            // that meets a closed read end happens with the transcript still
            // unwritten — the unix stub's shape, expressed in the language that
            // has no SIGPIPE.
            Pathology::FloodStderrItself => format!(
                "$e=[Console]::OpenStandardError()\n\
                 $f=[IO.File]::ReadAllBytes($env:WF31_FLOOD)\n\
                 $at=0\n\
                 while($at -lt $f.Length){{\n\
                 $n=[Math]::Min(4096,$f.Length-$at)\n\
                 $e.Write($f,$at,$n)\n\
                 $e.Flush()\n\
                 $at+=$n\n\
                 }}\n{emit}"
            ),
            Pathology::FloodStdout => format!(
                "$o=[Console]::OpenStandardOutput()\n\
                 $f=[IO.File]::ReadAllBytes($env:WF31_FLOOD)\n\
                 $o.Write($f,0,$f.Length)\n{emit}"
            ),
            Pathology::ReadsStdin => format!("[void][Console]::In.ReadToEnd()\n{emit}"),
            // Written to the handle rather than through PowerShell's error
            // stream, exactly as the flood above is, so what arrives is the
            // bytes and not a CLIXML rendering of them.
            Pathology::TalksFirst => format!(
                "$e=[Console]::OpenStandardError()\n\
                 $m=[Text.Encoding]::UTF8.GetBytes('{SAID_ON_STDERR}')\n\
                 $e.Write($m,0,$m.Length)\n\
                 $e.Flush()\n{emit}"
            ),
            Pathology::Exits127 => "exit 127\n".to_string(),
        }
    }

    /// A stub is a program, not a shell, so it is built by hand rather than by
    /// [`harvest_command`]: the whole point is to drive the framing, the two
    /// bounds, both drains, the kill and the parser on a runner that has no
    /// login shell and no profile.
    fn stub(
        directory: &Path,
        pathology: Pathology,
        transcript: &[u8],
        flood: usize,
    ) -> HarvestCommand {
        let transcript_path = directory.join("transcript");
        std::fs::write(&transcript_path, transcript).expect("writes the transcript");

        let mut overlay = vec![(
            "WF31_TRANSCRIPT".to_string(),
            transcript_path.to_string_lossy().into_owned(),
        )];
        if flood > 0 {
            let flood_path = directory.join("flood");
            std::fs::write(
                &flood_path,
                "chatter chatter chatter\n".repeat(flood / 24 + 1),
            )
            .expect("writes the flood");
            overlay.push((
                "WF31_FLOOD".to_string(),
                flood_path.to_string_lossy().into_owned(),
            ));
        }

        let (program, args) = program_for(directory, pathology);
        HarvestCommand {
            shell: Shell::LoginShell {
                program: program.clone(),
            },
            program,
            args,
            cwd: directory.to_path_buf(),
            env_overlay: overlay,
        }
    }

    #[cfg(unix)]
    fn program_for(directory: &Path, pathology: Pathology) -> (String, Vec<String>) {
        use std::os::unix::fs::PermissionsExt;

        let path = directory.join("stub.sh");
        std::fs::write(&path, script(pathology)).expect("writes the stub");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
            .expect("makes the stub a program");
        (path.to_string_lossy().into_owned(), Vec::new())
    }

    /// `-EncodedCommand` rather than a `.ps1` file, so no execution policy is
    /// involved in running the test harness's own stub and nothing has to be
    /// overridden to make the suite green.
    #[cfg(windows)]
    fn program_for(_directory: &Path, pathology: Pathology) -> (String, Vec<String>) {
        let program = crate::shell::powershell_location(&|name| std::env::var(name).ok());
        (
            program,
            vec![
                "-NoProfile".to_string(),
                "-NoLogo".to_string(),
                "-EncodedCommand".to_string(),
                crate::payload::encode_command(&script(pathology)),
            ],
        )
    }

    /// The environment an attempt produced, or the assertion that it should
    /// have. Every test below reaches through the attempt rather than around
    /// it, because the shell, the stream and the clock are the attempt's.
    fn harvested(attempt: &HarvestAttempt) -> &Harvest {
        attempt.outcome.as_ref().expect("harvests")
    }

    fn discarded(attempt: &HarvestAttempt) -> HarvestCondition {
        attempt.outcome.as_ref().expect_err("discards").clone()
    }

    fn value(attempt: &HarvestAttempt, name: &str) -> String {
        String::from_utf8_lossy(
            harvested(attempt)
                .environment
                .get(name)
                .unwrap_or_else(|| panic!("{name} survived")),
        )
        .into_owned()
    }

    #[test]
    fn a_chatty_shell_that_closes_the_frame_hands_back_its_environment() {
        let directory = TempDir::new().expect("a temporary directory");
        let banner: &[u8] = b"welcome to your shell\nlast login: never\n";
        let transcript = framed(
            &nonce(),
            banner,
            &[b"PATH=/opt/homebrew/bin:/usr/bin", b"HOME=/Users/you"],
            b"",
        );
        let command = stub(directory.path(), Pathology::Plain, &transcript, 0);

        let attempt = harvest_with(&command, &nonce(), &roomy());

        assert_eq!(value(&attempt, "PATH"), "/opt/homebrew/bin:/usr/bin");
        assert_eq!(value(&attempt, "HOME"), "/Users/you");
        assert_eq!(harvested(&attempt).tally.records_seen, 2);
        assert_eq!(harvested(&attempt).tally.records_dropped, 0);
        assert_eq!(harvested(&attempt).tally.bytes_before_frame, banner.len());
    }

    #[test]
    fn a_shell_that_never_opened_the_frame_leaves_nothing_to_salvage() {
        let directory = TempDir::new().expect("a temporary directory");
        let command = stub(
            directory.path(),
            Pathology::Plain,
            b"welcome to your shell\nPATH=/opt/homebrew/bin\n",
            0,
        );

        let condition = discarded(&harvest_with(&command, &nonce(), &roomy()));

        assert_eq!(condition, HarvestCondition::NoOpeningMark);
    }

    #[test]
    fn a_frame_that_opened_and_never_closed_is_discarded_whole() {
        let directory = TempDir::new().expect("a temporary directory");
        let transcript = opened_only(&nonce(), b"", &[b"PATH=/opt/homebrew/bin"]);
        let command = stub(directory.path(), Pathology::ThenSleep, &transcript, 0);

        let condition = discarded(&harvest_with(&command, &nonce(), &quick()));

        // A killed shell emits no mark pair, so a half-frame is structurally
        // detectable and there is nothing in it worth keeping.
        match condition {
            HarvestCondition::FrameNeverClosed { after_ms } => {
                assert!(after_ms >= 500, "{after_ms} ms is under the bound");
            }
            other => panic!("{other:?}"),
        }
    }

    /// The stub says its line and *exits* on a half-frame rather than hanging
    /// on one, so nothing here is racing a bound: the subject is the stream
    /// surviving the discard, and a test whose subject is not a bound may not
    /// be lost to a loaded runner's scheduler. Expiring is the same discard by
    /// a different route, and
    /// [`a_frame_that_opened_and_never_closed_is_discarded_whole`] drives it.
    #[test]
    fn a_discarded_harvest_still_hands_back_what_the_shell_wrote_to_stderr() {
        let directory = TempDir::new().expect("a temporary directory");
        let transcript = opened_only(&nonce(), b"", &[b"PATH=/opt/homebrew/bin"]);
        let command = stub(directory.path(), Pathology::TalksFirst, &transcript, 0);

        let attempt = harvest_with(&command, &nonce(), &roomy());

        // There is no environment, and this is precisely when the stream is
        // worth reading: #21 found the `-ic` failure only here, and #26 found
        // that under `AllSigned` the refusal to run a profile appears nowhere
        // else. Reporting an empty stream for a discarded one would say the
        // same thing as a shell that never opened its mouth.
        assert!(
            matches!(
                attempt.outcome,
                Err(HarvestCondition::FrameNeverClosed { .. })
            ),
            "{:?}",
            attempt.outcome
        );
        assert_eq!(attempt.stderr.text, SAID_ON_STDERR);
        assert_eq!(attempt.stderr.bytes, SAID_ON_STDERR.len());
        assert_eq!(attempt.stderr.kind, StderrKind::Text);
        // And the shell that ran is named, so nobody downstream has to guess
        // at it a second time.
        assert_eq!(
            attempt.shell.as_ref().map(|shell| shell.program()),
            Some(command.program.as_str())
        );
    }

    #[test]
    fn the_harvest_is_over_when_the_frame_closes_and_not_when_the_child_exits() {
        let directory = TempDir::new().expect("a temporary directory");
        let transcript = framed(&nonce(), b"", &[b"PATH=/opt/homebrew/bin"], b"");
        let command = stub(directory.path(), Pathology::ThenSleep, &transcript, 0);

        let attempt = harvest_with(&command, &nonce(), &roomy());

        assert_eq!(value(&attempt, "PATH"), "/opt/homebrew/bin");
        // The stub sleeps [`STUB_HOLDS`] after writing. Waiting for the exit
        // would have cost all of it, so anything comfortably under it proves
        // the claim; the expected figure is the 200 ms grace.
        //
        // Half of what is being denied, rather than a number of its own. A
        // fixed five seconds was observed failing at 9.05 s on a four-core
        // `windows-latest` with PowerShell stubs spawning beside it, and a
        // fixed two before that at 2.60 s: every absolute figure picked so far
        // has eventually measured the runner rather than the harvest. Tying it
        // to the sleep keeps the only thing this can distinguish — a harvest
        // that waited for EOF from one that stopped at the mark — while a
        // margin that wide cannot be crossed by load alone. A red build that
        // means "the runner was busy" is worse than no assertion, because it
        // teaches everyone to re-run rather than read.
        assert!(attempt.elapsed < STUB_HOLDS / 2, "{:?}", attempt.elapsed);
    }

    #[test]
    fn a_background_grandchild_holding_the_pipe_does_not_hold_the_harvest() {
        let directory = TempDir::new().expect("a temporary directory");
        let transcript = framed(&nonce(), b"", &[b"PATH=/opt/homebrew/bin"], b"");
        let command = stub(directory.path(), Pathology::Grandchild, &transcript, 0);

        let attempt = harvest_with(&command, &nonce(), &roomy());

        // Measured here: a payload leaving `(sleep 4 &)` behind framed its
        // answer in milliseconds and did not reach EOF until 4219 ms. Reading
        // to EOF would have parked on that handle; stopping at the mark does
        // not, and the grace expiring is not a failure.
        assert_eq!(value(&attempt, "PATH"), "/opt/homebrew/bin");
        // Half of what the grandchild holds the handle for, for the reason
        // given on the test above: the margin is there to survive a busy
        // runner, not to measure one. This is the assertion that was seen
        // failing at 9.05 s on `windows-latest` with a fixed five in place.
        assert!(attempt.elapsed < STUB_HOLDS / 2, "{:?}", attempt.elapsed);
    }

    #[test]
    fn a_shell_that_floods_stderr_before_it_answers_is_drained_rather_than_deadlocked() {
        let directory = TempDir::new().expect("a temporary directory");
        let transcript = framed(&nonce(), b"", &[b"PATH=/opt/homebrew/bin"], b"");
        let command = stub(
            directory.path(),
            Pathology::FloodStderr,
            &transcript,
            1_600_000,
        );

        let attempt = harvest_with(&command, &nonce(), &roomy());

        // Reading one stream to the end before waiting is #26's deadlock: the
        // child blocks writing into a full pipe nobody is draining. Under this
        // bound it does not hang the suite, it *discards* — which is why this
        // fails on an assertion rather than timing out.
        assert_eq!(value(&attempt, "PATH"), "/opt/homebrew/bin");
        assert!(
            attempt.stderr.bytes >= 1_600_000,
            "{}",
            attempt.stderr.bytes
        );
        assert_eq!(attempt.stderr.kind, StderrKind::Text);
    }

    #[test]
    fn the_stderr_cap_bounds_this_process_rather_than_killing_the_shell_that_is_still_answering() {
        let directory = TempDir::new().expect("a temporary directory");
        let bounds = Bounds {
            stderr_cap: 64 * 1024,
            ..roomy()
        };
        let transcript = framed(&nonce(), b"", &[b"PATH=/opt/homebrew/bin"], b"");
        let command = stub(
            directory.path(),
            Pathology::FloodStderrItself,
            &transcript,
            256 * 1024,
        );

        let attempt = harvest_with(&command, &nonce(), &bounds);

        // The cap must bound what this process keeps, never what the operator's
        // shell is allowed to say. Ending the *read* at the cap drops the pipe
        // while the shell is still running: measured here, closing the read end
        // after 64 KiB kills `/bin/sh`, `/bin/zsh` and `/bin/bash` with rc `-13`
        // and an empty stdout whenever the writing is done by a builtin. The
        // harvest then came back `NoOpeningMark` — this harness telling the
        // operator their shell never meant to answer, in the one case this
        // harness caused the silence, which is exactly what
        // `the_frame_sentence_names_both_possibilities_and_blames_neither`
        // exists to forbid. `Pathology::FloodStderr` cannot catch it: its flood
        // is a `cat` child that absorbs the signal on the stub's behalf.
        assert_eq!(value(&attempt, "PATH"), "/opt/homebrew/bin");
        // And the bound still holds — the retained bytes are the cap exactly,
        // not the 256 KiB the shell wrote.
        assert_eq!(attempt.stderr.bytes, 64 * 1024);
    }

    #[test]
    fn a_shell_that_floods_stdout_before_it_answers_is_drained_rather_than_deadlocked() {
        let directory = TempDir::new().expect("a temporary directory");
        let transcript = framed(&nonce(), b"", &[b"PATH=/opt/homebrew/bin"], b"");
        let command = stub(
            directory.path(),
            Pathology::FloodStdout,
            &transcript,
            1_600_000,
        );

        let attempt = harvest_with(&command, &nonce(), &roomy());

        assert_eq!(value(&attempt, "PATH"), "/opt/homebrew/bin");
        assert!(
            harvested(&attempt).tally.bytes_before_frame >= 1_600_000,
            "{}",
            harvested(&attempt).tally.bytes_before_frame
        );
    }

    #[test]
    fn a_shell_that_reads_its_own_stdin_gets_the_end_of_it_rather_than_a_wedge() {
        let directory = TempDir::new().expect("a temporary directory");
        let transcript = framed(&nonce(), b"", &[b"PATH=/opt/homebrew/bin"], b"");
        let command = stub(directory.path(), Pathology::ReadsStdin, &transcript, 0);

        let attempt = harvest_with(&command, &nonce(), &roomy());

        // stdin is set to null rather than inherited. Inheriting the bundle's
        // would leave a reading start-up file waiting on something nobody is
        // going to type.
        assert_eq!(value(&attempt, "PATH"), "/opt/homebrew/bin");
    }

    #[test]
    fn a_shell_that_printed_its_own_frame_first_cannot_substitute_the_harvest_end_to_end() {
        let directory = TempDir::new().expect("a temporary directory");
        let mut transcript = framed(&nonce(), b"", &[b"INJECTED=evil", b"PATH=/nowhere"], b"");
        transcript.extend_from_slice(&framed(
            &nonce(),
            b"",
            &[b"PATH=/opt/homebrew/bin", b"HOME=/Users/you"],
            b"",
        ));
        let command = stub(directory.path(), Pathology::Plain, &transcript, 0);

        let attempt = harvest_with(&command, &nonce(), &roomy());

        assert_eq!(value(&attempt, "PATH"), "/opt/homebrew/bin");
        assert_eq!(harvested(&attempt).environment.get("INJECTED"), None);
        assert_eq!(harvested(&attempt).tally.extra_opening_marks, 1);
    }

    #[test]
    fn a_shell_that_writes_without_ever_closing_the_frame_is_stopped_at_the_cap() {
        let directory = TempDir::new().expect("a temporary directory");
        let bounds = Bounds {
            stdout_cap: 64 * 1024,
            ..roomy()
        };
        let transcript = framed(&nonce(), b"", &[b"PATH=/opt/homebrew/bin"], b"");
        let command = stub(
            directory.path(),
            Pathology::FloodStdout,
            &transcript,
            256 * 1024,
        );

        let condition = discarded(&harvest_with(&command, &nonce(), &bounds));

        assert_eq!(
            condition,
            HarvestCondition::OutputTooLarge {
                cap_bytes: 64 * 1024
            }
        );
    }

    #[test]
    fn a_program_that_does_not_understand_the_flags_fails_structurally() {
        let directory = TempDir::new().expect("a temporary directory");
        let command = stub(directory.path(), Pathology::Exits127, b"", 0);

        let condition = discarded(&harvest_with(&command, &nonce(), &roomy()));

        // No mark pair, a recorded condition, and an app that is already open.
        assert_eq!(condition, HarvestCondition::NoOpeningMark);
    }

    #[test]
    fn a_shell_that_is_not_there_is_a_condition_rather_than_a_panic() {
        let directory = TempDir::new().expect("a temporary directory");
        let missing = directory.path().join("no-such-shell");
        let command = HarvestCommand {
            shell: Shell::LoginShell {
                program: missing.to_string_lossy().into_owned(),
            },
            program: missing.to_string_lossy().into_owned(),
            args: Vec::new(),
            cwd: directory.path().to_path_buf(),
            env_overlay: Vec::new(),
        };

        let attempt = harvest_with(&command, &nonce(), &roomy());

        let condition = discarded(&attempt);
        assert!(
            matches!(condition, HarvestCondition::ShellDidNotStart { .. }),
            "{condition:?}"
        );
        // Nothing ever ran, so the empty stream here is the fact and not a
        // discarded one — the distinction the type exists to keep.
        assert_eq!(attempt.stderr.kind, StderrKind::Empty);
        assert_eq!(attempt.elapsed, Duration::ZERO);
    }

    #[test]
    fn the_child_is_given_the_folder_it_starts_in_rather_than_cd_ing_into_it() {
        // #24 calls this the load-bearing correction: a `cd` inside the command
        // would run before the framing and put its own output where the opening
        // mark belongs. Nothing else in this file would catch it.
        let directory = TempDir::new().expect("a temporary directory");
        let started_in = std::fs::canonicalize(directory.path()).expect("canonicalises");
        let transcript = framed(
            &nonce(),
            b"",
            &[
                b"PATH=/opt/homebrew/bin",
                format!("STARTED_IN={}", started_in.display()).as_bytes(),
            ],
            b"",
        );
        let mut command = stub(directory.path(), Pathology::Plain, &transcript, 0);
        command.cwd = started_in.clone();

        let attempt = harvest_with(&command, &nonce(), &roomy());

        assert_eq!(
            PathBuf::from(value(&attempt, "STARTED_IN")),
            started_in,
            "the child was spawned somewhere other than the folder it was given"
        );
    }

    #[test]
    fn a_windows_shaped_transcript_reads_back_under_the_tag_it_was_written_with() {
        let directory = TempDir::new().expect("a temporary directory");
        let transcript = framed(
            &nonce(),
            b"",
            &[
                b"deadbeefdeadbeef:V:Path=C:\\Windows;C:\\Windows\\System32",
                b"deadbeefdeadbeef:V:USERPROFILE=C:\\Users\\you",
                b"ASYNC-JUNK timer 1",
            ],
            b"",
        );
        let mut command = stub(directory.path(), Pathology::Plain, &transcript, 0);
        // Only the tag differs between the two platforms' grammars, so the
        // Windows half of the parser is drivable from a macOS runner.
        command.shell = Shell::PowerShell {
            program: command.program.clone(),
        };

        let attempt = harvest_with(&command, &nonce(), &roomy());

        assert_eq!(
            attempt
                .shell
                .as_ref()
                .map(|shell| shell.record_tag())
                .expect("a shell ran"),
            RecordTag::Required
        );
        assert_eq!(harvested(&attempt).tally.records_dropped, 1);
        assert_eq!(harvested(&attempt).environment.len(), 2);
    }

    /* --------------------------------------------------------- real shells --- */

    /// A start-up file in a directory of its own, reached by autoload rather
    /// than by a dot-source: `ZDOTDIR` is how zsh is told where to look, and it
    /// travels in [`HarvestCommand::env_overlay`] so no test ever calls
    /// `std::env::set_var` in a binary whose tests run on several threads.
    #[cfg(target_os = "macos")]
    fn zsh_harvest(home: &TempDir, rc: &str, nonce: &Nonce) -> HarvestCommand {
        std::fs::write(home.path().join(".zshrc"), rc).expect("writes the rc");
        let mut command = harvest_command(
            Shell::LoginShell {
                program: "/bin/zsh".to_string(),
            },
            nonce,
        );
        command.env_overlay = vec![(
            "ZDOTDIR".to_string(),
            home.path().to_string_lossy().into_owned(),
        )];
        command
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_operators_start_up_files_actually_run() {
        let home = TempDir::new().expect("a temporary directory");
        let command = zsh_harvest(&home, "export WF31_MARK=ran\n", &nonce());

        let attempt = harvest_with(&command, &nonce(), &Bounds::for_this_machine());
        let harvest = attempt.outcome.as_ref().expect("a real zsh harvests");

        // The substance of acceptance criterion 1, and the only place any
        // runner can green it: `-lic` ran a file this test wrote.
        assert_eq!(value(&attempt, "WF31_MARK"), "ran");
        assert!(harvest.environment.path().is_some());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_start_up_file_that_prompts_for_input_does_not_wedge_the_harvest() {
        let home = TempDir::new().expect("a temporary directory");
        let command = zsh_harvest(
            &home,
            "read -r WF31_ANSWER\nexport WF31_MARK=post\n",
            &nonce(),
        );

        let attempt = harvest_with(&command, &nonce(), &Bounds::for_this_machine());
        attempt
            .outcome
            .as_ref()
            .expect("a blocking rc still harvests");

        // Measured: exit 0 at 220 ms, with the rc carrying on past the
        // blocking call. The line after it having run is the assertion —
        // completing is not enough.
        assert_eq!(value(&attempt, "WF31_MARK"), "post");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_start_up_file_that_prints_a_banner_does_not_become_a_variable() {
        let home = TempDir::new().expect("a temporary directory");
        let command = zsh_harvest(
            &home,
            "print -r -- 'welcome to your shell'\nexport WF31_MARK=ran\n",
            &nonce(),
        );

        let attempt = harvest_with(&command, &nonce(), &Bounds::for_this_machine());
        let harvest = attempt.outcome.as_ref().expect("a chatty rc harvests");

        // This closes the loop between the shipped payload and the parser that
        // a hand-authored transcript cannot: the banner really did land before
        // the opening mark.
        assert!(harvest.tally.bytes_before_frame >= "welcome to your shell\n".len());
        assert_eq!(harvest.tally.records_dropped, 0);
        assert_eq!(value(&attempt, "WF31_MARK"), "ran");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_start_up_file_that_prints_our_own_marks_cannot_substitute_the_harvest() {
        let home = TempDir::new().expect("a temporary directory");
        let forged = home.path().join("forged");
        std::fs::write(
            &forged,
            framed(&nonce(), b"", &[b"INJECTED=evil", b"PATH=/nowhere"], b""),
        )
        .expect("writes the forged frame");
        let command = zsh_harvest(
            &home,
            &format!("cat '{}'\nexport WF31_MARK=ran\n", forged.display()),
            &nonce(),
        );

        let attempt = harvest_with(&command, &nonce(), &Bounds::for_this_machine());
        let harvest = attempt.outcome.as_ref().expect("harvests past the forgery");

        assert_eq!(harvest.environment.get("INJECTED"), None);
        assert_ne!(value(&attempt, "PATH"), "/nowhere");
        assert_eq!(harvest.tally.extra_opening_marks, 1);
        assert_eq!(value(&attempt, "WF31_MARK"), "ran");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_shell_runs_again_every_time_it_is_asked() {
        let home = TempDir::new().expect("a temporary directory");
        let ledger = home.path().join("ledger");
        let command = zsh_harvest(
            &home,
            &format!("printf x >> '{}'\nexport WF31_MARK=ran\n", ledger.display()),
            &nonce(),
        );

        harvest_with(&command, &nonce(), &Bounds::for_this_machine())
            .outcome
            .expect("harvests");
        harvest_with(&command, &nonce(), &Bounds::for_this_machine())
            .outcome
            .expect("harvests again");

        // AC4's re-harvest, asserted rather than asserted about: nothing here
        // caches, so the rc ran twice.
        assert_eq!(std::fs::read(&ledger).expect("reads the ledger"), b"xx");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_real_program_that_is_not_a_shell_at_all_fails_structurally() {
        let mut command = harvest_command(
            Shell::LoginShell {
                program: "/usr/bin/false".to_string(),
            },
            &nonce(),
        );
        command.cwd = PathBuf::from("/");

        let condition = discarded(&harvest_with(&command, &nonce(), &roomy()));

        assert_eq!(condition, HarvestCondition::NoOpeningMark);
    }

    /// Unrun. PowerShell 5.1 derives `$PROFILE` from these four variables
    /// rather than from the registry, which is #26's own relocation mechanism
    /// and so genuine autoload rather than a dot-source. No Windows machine was
    /// available while this was written.
    #[cfg(windows)]
    #[test]
    fn the_four_variables_that_locate_a_profile_cross_untouched() {
        let home = TempDir::new().expect("a temporary directory");
        let profile = home.path().join("Documents").join("WindowsPowerShell");
        std::fs::create_dir_all(&profile).expect("creates the profile directory");
        std::fs::write(
            profile.join("Microsoft.PowerShell_profile.ps1"),
            "$env:WF31_MARK='ran'\n",
        )
        .expect("writes the profile");

        let home_text = home.path().to_string_lossy().into_owned();
        let mut command = harvest_command(
            Shell::for_this_machine(&|name| std::env::var(name).ok()).expect("finds powershell"),
            &nonce(),
        );
        command.env_overlay = vec![
            ("USERPROFILE".to_string(), home_text.clone()),
            ("HOME".to_string(), home_text.clone()),
            ("HOMEDRIVE".to_string(), String::new()),
            ("HOMEPATH".to_string(), home_text.clone()),
        ];

        let attempt = harvest_with(&command, &nonce(), &Bounds::for_this_machine());
        attempt
            .outcome
            .as_ref()
            .expect("a real powershell harvests");

        assert_eq!(value(&attempt, "WF31_MARK"), "ran");
        assert_eq!(value(&attempt, "USERPROFILE"), home_text);
        assert_eq!(value(&attempt, "HOME"), home_text);
        assert_eq!(value(&attempt, "HOMEPATH"), home_text);
    }

    /// The Windows counterpart of [`zsh_harvest`]: a profile in a relocated
    /// `$PROFILE` directory, reached by PowerShell's own autoload rather than by
    /// a dot-source, with the four locating variables travelling in
    /// [`HarvestCommand::env_overlay`] so no test sets a process-wide variable.
    #[cfg(windows)]
    fn powershell_harvest(home: &TempDir, profile_body: &str, nonce: &Nonce) -> HarvestCommand {
        let profile = home.path().join("Documents").join("WindowsPowerShell");
        std::fs::create_dir_all(&profile).expect("creates the profile directory");
        std::fs::write(
            profile.join("Microsoft.PowerShell_profile.ps1"),
            profile_body,
        )
        .expect("writes the profile");

        let home_text = home.path().to_string_lossy().into_owned();
        let mut command = harvest_command(
            Shell::for_this_machine(&|name| std::env::var(name).ok()).expect("finds powershell"),
            nonce,
        );
        command.env_overlay = vec![
            ("USERPROFILE".to_string(), home_text.clone()),
            ("HOME".to_string(), home_text.clone()),
            ("HOMEDRIVE".to_string(), String::new()),
            ("HOMEPATH".to_string(), home_text),
        ];
        command
    }

    #[cfg(windows)]
    #[test]
    fn a_start_up_file_that_prints_a_banner_does_not_become_a_variable() {
        let home = TempDir::new().expect("a temporary directory");
        let command = powershell_harvest(
            &home,
            "Write-Output 'welcome to your shell'\n$env:WF31_MARK='ran'\n",
            &nonce(),
        );

        let attempt = harvest_with(&command, &nonce(), &Bounds::for_this_machine());
        let harvest = attempt.outcome.as_ref().expect("a chatty profile harvests");

        assert!(harvest.tally.bytes_before_frame >= "welcome to your shell".len());
        assert_eq!(harvest.tally.records_dropped, 0);
        assert_eq!(value(&attempt, "WF31_MARK"), "ran");
    }

    #[cfg(windows)]
    #[test]
    fn a_start_up_file_that_prints_our_own_marks_cannot_substitute_the_harvest() {
        let home = TempDir::new().expect("a temporary directory");
        let forged_path = home.path().join("forged");
        // Tagged with this run's own nonce, which is the worst case rather than
        // a fanciful one: the encoded command carries the nonce and is visible
        // in the process list, so a forger on this machine can read it. The tag
        // therefore has to be assumed forgeable and last-mark-wins is what
        // actually refuses the substitution.
        let prefix = crate::payload::record_prefix(&nonce());
        let mut injected = prefix.clone();
        injected.extend_from_slice(b"INJECTED=evil");
        let mut forged_path_var = prefix;
        forged_path_var.extend_from_slice(b"PATH=C:\\nowhere");
        std::fs::write(
            &forged_path,
            framed(&nonce(), b"", &[&injected, &forged_path_var], b""),
        )
        .expect("writes the forged frame");

        let command = powershell_harvest(
            &home,
            &format!(
                "$o=[Console]::OpenStandardOutput()\n\
                 $b=[IO.File]::ReadAllBytes('{}')\n\
                 $o.Write($b,0,$b.Length)\n\
                 $o.Flush()\n\
                 $env:WF31_MARK='ran'\n",
                forged_path.display()
            ),
            &nonce(),
        );

        let attempt = harvest_with(&command, &nonce(), &Bounds::for_this_machine());
        let harvest = attempt.outcome.as_ref().expect("harvests past the forgery");

        assert_eq!(harvest.environment.get("INJECTED"), None);
        assert_ne!(value(&attempt, "PATH"), "C:\\nowhere");
        assert_eq!(harvest.tally.extra_opening_marks, 1);
        assert_eq!(value(&attempt, "WF31_MARK"), "ran");
    }

    #[cfg(windows)]
    #[test]
    fn a_start_up_file_that_prompts_for_input_does_not_wedge_the_harvest() {
        let home = TempDir::new().expect("a temporary directory");
        let command = powershell_harvest(
            &home,
            "$null=[Console]::In.ReadLine()\n$env:WF31_MARK='post'\n",
            &nonce(),
        );

        let attempt = harvest_with(&command, &nonce(), &Bounds::for_this_machine());
        attempt
            .outcome
            .as_ref()
            .expect("a blocking profile still harvests");

        // Completing is not enough: the line *after* the blocking read having
        // run is what says the profile carried on rather than being killed.
        assert_eq!(value(&attempt, "WF31_MARK"), "post");
    }

    #[cfg(windows)]
    #[test]
    fn the_shell_runs_again_every_time_it_is_asked() {
        let home = TempDir::new().expect("a temporary directory");
        let ledger = home.path().join("ledger");
        let command = powershell_harvest(
            &home,
            &format!(
                "[IO.File]::AppendAllText('{}','x')\n$env:WF31_MARK='ran'\n",
                ledger.display()
            ),
            &nonce(),
        );

        harvest_with(&command, &nonce(), &Bounds::for_this_machine())
            .outcome
            .expect("harvests");
        harvest_with(&command, &nonce(), &Bounds::for_this_machine())
            .outcome
            .expect("harvests again");

        assert_eq!(std::fs::read(&ledger).expect("reads the ledger"), b"xx");
    }

    /// Unrun on any runner, and deliberately so: it asks the machine it is on
    /// for its own operator's environment, which is not a fact a CI image has.
    /// `cargo test --package perseverance-env -- --ignored` on an operator's
    /// own machine is where the `-lic` measurement is reproducible.
    #[test]
    #[ignore = "asks this machine for its own operator's environment; CI has none"]
    fn this_operators_login_shell_carries_more_than_the_launchd_stub() {
        let harvest = harvest()
            .outcome
            .expect("this machine's own shell harvests");

        let path = harvest.environment.path().expect("a PATH").into_owned();
        assert!(path.len() > "/usr/bin:/bin:/usr/sbin:/sbin".len(), "{path}");
        assert!(
            harvest.environment.len() > 12,
            "{}",
            harvest.environment.len()
        );
    }
}

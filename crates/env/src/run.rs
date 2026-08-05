use std::ffi::OsStr;
use std::path::Path;

use crate::environment::Environment;
use crate::harvest::Bounds;
use crate::pump::{pump, Plan, PumpOutcome};

#[derive(Debug, Clone)]
pub struct Capture {
    /// `None` when the platform reports no code — a signal, on unix.
    pub status: Option<i32>,
    /// The program's own bytes. When a caller is running something whose stdout
    /// *is* a secret — `gh auth token` is exactly that — this must not reach a
    /// message, a log or the wire.
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

impl Capture {
    pub fn succeeded(&self) -> bool {
        self.status == Some(0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RunFailure {
    #[error("nothing named {program} is on the PATH this harvest acquired")]
    NotOnThisPath { program: String },
    #[error("{program} did not start: {detail}")]
    DidNotStart { program: String, detail: String },
    #[error("{program} was still running after {after_ms} ms and was stopped")]
    RanTooLong { program: String, after_ms: u64 },
}

/// Runs one program with **only** the harvested environment — `env_clear`, then
/// the harvest — with stdin at EOF and both streams drained concurrently with
/// the wait.
///
/// The program is resolved against the harvested `PATH` by
/// [`Environment::resolve`] and spawned by absolute path, because the
/// alternative is resolving it against the launchd stub.
///
/// This one **does** wait for EOF, and the difference from the harvest is the
/// point: a harvest is decided at a mark, and its reader gets only
/// `bounds.exit_grace` afterwards, because a login shell may leave a daemon
/// holding the pipe for seconds past a clean exit. A program we chose to run is
/// expected to end, so waiting for the end of its output is waiting for
/// something that will happen. The concurrent drain is the same, because the
/// deadlock does not care which program it happens to. `bounds.frame` is the
/// outer wait.
///
/// A program that writes past `bounds.stdout_cap` is captured up to it rather
/// than refused: there is no condition here for it, and truncating output this
/// crate did not ask for is a smaller harm than discarding a run that
/// succeeded.
pub fn run_in(
    environment: &Environment,
    program: &str,
    args: &[&str],
    cwd: &Path,
    bounds: &Bounds,
) -> Result<Capture, RunFailure> {
    let resolved = environment
        .resolve(program)
        .ok_or_else(|| RunFailure::NotOnThisPath {
            program: program.to_string(),
        })?;
    let args: Vec<&OsStr> = args.iter().map(OsStr::new).collect();

    let pumped = pump(&Plan {
        program: resolved.as_os_str(),
        args: &args,
        cwd,
        environment: &|child: &mut std::process::Command| environment.apply(child),
        stop_at: None,
        deadline: bounds.frame,
        exit_grace: bounds.exit_grace,
        stdout_cap: bounds.stdout_cap,
        stderr_cap: bounds.stderr_cap,
    })
    .map_err(|refused| RunFailure::DidNotStart {
        program: program.to_string(),
        detail: refused.to_string(),
    })?;

    if pumped.outcome == PumpOutcome::Expired {
        return Err(RunFailure::RanTooLong {
            program: program.to_string(),
            after_ms: pumped.elapsed.as_millis().min(u128::from(u64::MAX)) as u64,
        });
    }

    Ok(Capture {
        status: pumped.status,
        stdout: pumped.stdout,
        stderr: pumped.stderr,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::Duration;
    use tempfile::TempDir;

    /// For the one test whose subject is the outer wait firing.
    fn quick() -> Bounds {
        Bounds {
            frame: Duration::from_millis(500),
            exit_grace: Duration::from_millis(200),
            stdout_cap: 8 * 1024 * 1024,
            stderr_cap: 8 * 1024 * 1024,
        }
    }

    /// For every other test. A deadline that starts before the spawn is a
    /// deadline on the runner's scheduler as much as on the child.
    fn roomy() -> Bounds {
        Bounds {
            frame: Duration::from_secs(10),
            ..quick()
        }
    }

    /// An environment whose `PATH` names one temporary directory and nothing
    /// else, so every resolution in this file is a resolution against the
    /// harvest rather than against whatever the runner happens to have.
    fn harvested(directory: &Path) -> Environment {
        let nonce = crate::Nonce::from_literal("deadbeefdeadbeef");
        let bytes = crate::parse::framed(
            &nonce,
            b"",
            &[
                format!("PATH={}", directory.to_string_lossy()).as_bytes(),
                b"WF31_FROM_HARVEST=yes",
                b"PATHEXT=.COM;.EXE;.BAT;.CMD",
            ],
            b"",
        );
        Environment::from_reading(
            crate::parse::read_frame(&bytes, &nonce, crate::parse::RecordTag::Absent)
                .expect("reads"),
        )
    }

    #[cfg(unix)]
    fn program(directory: &Path, name: &str, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;

        let path = directory.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}")).expect("writes the program");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
            .expect("makes it a program");
        path
    }

    #[cfg(windows)]
    fn program(directory: &Path, name: &str, body: &str) -> PathBuf {
        let path = directory.join(format!("{name}.cmd"));
        std::fs::write(&path, format!("@echo off\r\n{body}\r\n")).expect("writes the program");
        path
    }

    #[cfg(unix)]
    const SAYS_HELLO: &str = "printf 'hello\\n'\nexit 0\n";
    #[cfg(windows)]
    const SAYS_HELLO: &str = "echo hello\r\nexit /b 0";

    #[test]
    fn a_program_is_run_inside_the_environment_the_harvest_acquired() {
        let directory = TempDir::new().expect("a temporary directory");
        program(directory.path(), "wf31say", SAYS_HELLO);
        let environment = harvested(directory.path());

        let captured =
            run_in(&environment, "wf31say", &[], directory.path(), &roomy()).expect("runs");

        assert!(captured.succeeded());
        assert_eq!(String::from_utf8_lossy(&captured.stdout).trim(), "hello");
    }

    #[cfg(unix)]
    #[test]
    fn the_program_sees_the_harvested_environment_and_nothing_this_process_added() {
        let directory = TempDir::new().expect("a temporary directory");
        program(
            directory.path(),
            "wf31echo",
            "printf '%s|%s\\n' \"$WF31_FROM_HARVEST\" \"$CARGO_PKG_NAME\"\nexit 0\n",
        );
        let environment = harvested(directory.path());

        let captured =
            run_in(&environment, "wf31echo", &[], directory.path(), &roomy()).expect("runs");

        // `env_clear` first: cargo sets `CARGO_PKG_NAME` on this process, and a
        // child that inherited it as well as the harvest would be carrying two
        // environments' worth of history.
        assert_eq!(String::from_utf8_lossy(&captured.stdout).trim(), "yes|");
    }

    #[test]
    fn a_program_that_is_not_on_the_harvested_path_is_never_looked_for_elsewhere() {
        let directory = TempDir::new().expect("a temporary directory");
        let environment = harvested(directory.path());

        // `sh` is on this process's own PATH on every runner this repo builds
        // on. Resolving against the parent's PATH is #21's bug re-entered
        // through the back door, and this is where it would show.
        let refusal =
            run_in(&environment, "sh", &[], directory.path(), &roomy()).expect_err("refuses");

        assert_eq!(
            refusal,
            RunFailure::NotOnThisPath {
                program: "sh".to_string()
            }
        );
    }

    #[test]
    fn a_program_that_answers_with_a_code_hands_it_back_rather_than_refusing() {
        let directory = TempDir::new().expect("a temporary directory");
        #[cfg(unix)]
        program(
            directory.path(),
            "wf31fail",
            "printf 'nope\\n' >&2\nexit 1\n",
        );
        #[cfg(windows)]
        program(directory.path(), "wf31fail", "echo nope 1>&2\r\nexit /b 1");
        let environment = harvested(directory.path());

        let captured =
            run_in(&environment, "wf31fail", &[], directory.path(), &roomy()).expect("runs");

        assert!(!captured.succeeded());
        assert_eq!(captured.status, Some(1));
        assert_eq!(String::from_utf8_lossy(&captured.stderr).trim(), "nope");
    }

    #[cfg(unix)]
    #[test]
    fn a_program_that_never_ends_is_stopped_and_named() {
        let directory = TempDir::new().expect("a temporary directory");
        program(directory.path(), "wf31forever", "/bin/sleep 30\n");
        let environment = harvested(directory.path());

        let refusal = run_in(&environment, "wf31forever", &[], directory.path(), &quick())
            .expect_err("refuses");

        match refusal {
            RunFailure::RanTooLong { program, after_ms } => {
                assert_eq!(program, "wf31forever");
                assert!(after_ms >= 500, "{after_ms}");
            }
            other => panic!("{other:?}"),
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_program_that_floods_one_stream_before_it_writes_the_other_is_drained_rather_than_deadlocked(
    ) {
        let directory = TempDir::new().expect("a temporary directory");
        let flood = directory.path().join("flood");
        std::fs::write(&flood, "chatter chatter chatter\n".repeat(70_000))
            .expect("writes the flood");
        program(
            directory.path(),
            "wf31flood",
            &format!(
                "/bin/cat '{}' >&2\nprintf 'hello\\n'\nexit 0\n",
                flood.display()
            ),
        );
        let environment = harvested(directory.path());

        let captured =
            run_in(&environment, "wf31flood", &[], directory.path(), &roomy()).expect("runs");

        assert!(captured.succeeded());
        assert_eq!(String::from_utf8_lossy(&captured.stdout).trim(), "hello");
        assert!(
            captured.stderr.len() >= 1_600_000,
            "{}",
            captured.stderr.len()
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_program_that_reads_its_own_stdin_gets_the_end_of_it_rather_than_a_wedge() {
        let directory = TempDir::new().expect("a temporary directory");
        program(
            directory.path(),
            "wf31stdin",
            "/bin/cat >/dev/null\nprintf 'hello\\n'\nexit 0\n",
        );
        let environment = harvested(directory.path());

        let captured =
            run_in(&environment, "wf31stdin", &[], directory.path(), &roomy()).expect("runs");

        assert_eq!(String::from_utf8_lossy(&captured.stdout).trim(), "hello");
    }

    #[cfg(unix)]
    #[test]
    fn the_arguments_a_caller_names_are_the_arguments_the_program_is_given() {
        let directory = TempDir::new().expect("a temporary directory");
        program(
            directory.path(),
            "wf31args",
            "printf '%s\\n' \"$@\"\nexit 0\n",
        );
        let environment = harvested(directory.path());

        let captured = run_in(
            &environment,
            "wf31args",
            &["auth", "token"],
            directory.path(),
            &roomy(),
        )
        .expect("runs");

        assert_eq!(
            String::from_utf8_lossy(&captured.stdout),
            "auth\ntoken\n".to_string()
        );
    }
}

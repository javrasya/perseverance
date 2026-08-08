use std::path::{Path, PathBuf};

use crate::environment::Environment;
use crate::harvest::Bounds;
use crate::run::{run_in, RunFailure};

/// Which name resolved, or everything an operator needs in order to disbelieve
/// *claude: not found*.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Located {
    Found(Found),
    NotFound(NotFound),
}

/// The name that answered, and the absolute path it answered with.
///
/// The path is the headline fact in a per-folder readout, because it is what
/// says *which* installation this folder resolves to — a bare name that follows
/// a version pin resolves to a different absolute path in two folders, and that
/// difference is the only visible form the pin has.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    pub name: String,
    pub program: PathBuf,
}

/// The names that were tried, in the order they were tried.
///
/// The shell used, the harvest's outcome and the verbatim `PATH` are the
/// [`FolderEnvironment`]'s and are deliberately not copied here — one home per
/// fact, so an error surface assembles the four from two values and there is no
/// second copy to drift.
///
/// [`FolderEnvironment`]: crate::FolderEnvironment
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotFound {
    pub names: Vec<String>,
}

/// First name that resolves wins.
///
/// Resolution is [`Environment::resolve`] against the folder's own harvested
/// `PATH` and nothing else. Nowhere in this function, this module or this crate
/// is a directory named that a `PATH` did not name: there is no `~/.local/bin`,
/// no `/opt/homebrew`, no `%APPDATA%\npm` and no shelling out to `where.exe`,
/// `Get-Command` or `command -v`. The failure mode of install-location probing
/// is not incompleteness, it is **divergence** from what the operator's own
/// shell resolves — and a silent wrong binary is worse than a loud not-found,
/// which is what [`NotFound`] is for.
pub fn locate_in(environment: &Environment, names: &[&str]) -> Located {
    for name in names {
        if let Some(program) = environment.resolve(name) {
            return Located::Found(Found {
                name: (*name).to_string(),
                program,
            });
        }
    }

    Located::NotFound(NotFound {
        names: names.iter().map(|name| (*name).to_string()).collect(),
    })
}

/// One declared probe, run — never read for a verdict.
///
/// The program and arguments are echoed back beside the outcome so a readout can
/// show what was asked as well as what came of it. Nothing here parses a
/// version, compares one, or decides anything: wrong-interpreter is made
/// *inspectable* rather than detected, because a check that guessed would be
/// this harness disagreeing silently with the operator's own terminal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbeReading {
    pub program: String,
    pub args: Vec<String>,
    pub outcome: ProbeOutcome,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProbeOutcome {
    /// The first non-empty line only, capped. A probe's whole stdout is not
    /// evidence and could be a megabyte; one line is what a person reads.
    Answered {
        status: Option<i32>,
        line: String,
    },
    /// The probe's own program is not on this folder's `PATH`, which is a
    /// reading rather than a failure: an adapter that declared a `node` probe
    /// has just been told this folder has no `node`.
    NotOnThisPath,
    DidNotRun {
        detail: String,
    },
}

/// How much of a line is kept. Long enough for `v22.11.0 (/opt/homebrew/bin)`
/// and short enough that a probe which printed a banner cannot fill a panel.
const LINE_CAP: usize = 200;

/// Run one declared probe inside a folder's environment, at that folder.
///
/// A thin wrapper over [`run_in`]: the environment is the folder's harvest, the
/// working directory is the folder, and the bounds are the caller's. It parses
/// nothing, compares nothing and decides nothing.
pub fn probe_in(
    environment: &Environment,
    directory: &Path,
    program: &str,
    args: &[&str],
    bounds: &Bounds,
) -> ProbeReading {
    let outcome = match run_in(environment, program, args, directory, bounds) {
        Ok(capture) => ProbeOutcome::Answered {
            status: capture.status,
            // stdout first, then stderr: a probe that answered on the wrong
            // stream still answered, and a blank line would report the same
            // thing as a probe that said nothing at all.
            line: first_line(&capture.stdout)
                .or_else(|| first_line(&capture.stderr))
                .unwrap_or_default(),
        },
        Err(RunFailure::NotOnThisPath { .. }) => ProbeOutcome::NotOnThisPath,
        Err(refusal) => ProbeOutcome::DidNotRun {
            detail: refusal.to_string(),
        },
    };

    ProbeReading {
        program: program.to_string(),
        args: args.iter().map(|arg| (*arg).to_string()).collect(),
        outcome,
    }
}

/// The first line with anything on it, decoded lossily and capped by
/// **characters** rather than by bytes, so a cap never lands inside one.
fn first_line(bytes: &[u8]) -> Option<String> {
    String::from_utf8_lossy(bytes)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.chars().take(LINE_CAP).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::time::Duration;
    use tempfile::TempDir;

    /// An environment whose `PATH` names exactly the directories given and
    /// nothing else, built through the frame parser so it is the same shape a
    /// harvest produces.
    fn harvested(directories: &[&Path]) -> Environment {
        let nonce = crate::Nonce::from_literal("deadbeefdeadbeef");
        let separator = if cfg!(windows) { ";" } else { ":" };
        let path = directories
            .iter()
            .map(|directory| directory.to_string_lossy().into_owned())
            .collect::<Vec<String>>()
            .join(separator);
        let bytes = crate::parse::framed(
            &nonce,
            b"",
            &[
                format!("PATH={path}").as_bytes(),
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
    const SAYS_A_VERSION: &str = "printf '\\nv22.11.0\\nand more\\n'\nexit 0\n";
    #[cfg(windows)]
    const SAYS_A_VERSION: &str = "echo.\r\necho v22.11.0\r\necho and more\r\nexit /b 0";

    fn roomy() -> Bounds {
        Bounds {
            frame: Duration::from_secs(10),
            exit_grace: Duration::from_millis(200),
            stdout_cap: 8 * 1024 * 1024,
            stderr_cap: 4 * 1024 * 1024,
        }
    }

    #[test]
    fn nothing_here_looks_anywhere_a_path_did_not_name() {
        let installed = TempDir::new().expect("somewhere a program really is");
        let on_the_path = TempDir::new().expect("the one directory the PATH names");
        program(installed.path(), "wf45claude", "exit 0\n");
        let environment = harvested(&[on_the_path.path()]);

        let located = locate_in(&environment, &["wf45claude"]);

        // The program is there, it is executable, and it is in a directory no
        // list here knows about — which is the whole of "no install-location
        // probing". A candidate list that named the operator's usual install
        // directories would find it and diverge from what their own shell
        // resolves, silently.
        assert_eq!(
            located,
            Located::NotFound(NotFound {
                names: vec!["wf45claude".to_string()]
            })
        );
    }

    #[test]
    fn the_first_name_that_resolves_is_the_one_that_is_used() {
        let directory = TempDir::new().expect("a temporary directory");
        let second = program(directory.path(), "wf45second", "exit 0\n");
        let third = program(directory.path(), "wf45third", "exit 0\n");
        let environment = harvested(&[directory.path()]);

        let located = locate_in(&environment, &["wf45absent", "wf45second", "wf45third"]);

        match located {
            Located::Found(found) => {
                assert_eq!(found.name, "wf45second");
                assert!(found.program.is_absolute());
                assert!(found.program.exists());
                assert_ne!(found.program, third);
                assert_eq!(found.program.parent(), second.parent());
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_probe_that_answers_is_kept_as_one_line() {
        let directory = TempDir::new().expect("a temporary directory");
        program(directory.path(), "wf45node", SAYS_A_VERSION);
        let environment = harvested(&[directory.path()]);

        let reading = probe_in(
            &environment,
            directory.path(),
            "wf45node",
            &["--version"],
            &roomy(),
        );

        assert_eq!(reading.program, "wf45node");
        assert_eq!(reading.args, vec!["--version".to_string()]);
        match reading.outcome {
            ProbeOutcome::Answered { status, line } => {
                assert_eq!(status, Some(0));
                // The first line with anything on it, and only that line: a
                // probe's whole stdout is not evidence.
                assert_eq!(line, "v22.11.0");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_probe_whose_program_is_not_on_this_path_says_so_rather_than_failing() {
        let directory = TempDir::new().expect("a temporary directory");
        let environment = harvested(&[directory.path()]);

        let reading = probe_in(
            &environment,
            directory.path(),
            "wf45node",
            &["--version"],
            &roomy(),
        );

        // A reading and not a refusal. An adapter that declared a `node` probe
        // has just been told this folder has no `node`, which is a fact about
        // the folder worth showing rather than an error worth raising.
        assert_eq!(reading.outcome, ProbeOutcome::NotOnThisPath);
    }

    #[test]
    fn a_line_longer_than_a_person_reads_is_cut_rather_than_carried() {
        assert_eq!(
            first_line("x".repeat(500).as_bytes()).map(|line| line.len()),
            Some(LINE_CAP)
        );
        assert_eq!(
            first_line(b"\n\n  \nfirst\nsecond\n").as_deref(),
            Some("first")
        );
        assert_eq!(first_line(b"   \n"), None);
        assert_eq!(first_line(b""), None);
    }
}

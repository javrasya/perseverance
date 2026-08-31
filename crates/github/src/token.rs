use perseverance_env::{harvest_cwd, run_in, Bounds, Capture, Environment, RunFailure};

/// A GitHub token, for the life of this process.
///
/// No `Serialize`, no `Display`, and a `Debug` that prints `Token(…)` — because
/// the way a token reaches a log is a struct three types up that derived
/// `Debug`. It is not zeroised: `String` reallocates, so a promise to scrub it
/// would be one this crate cannot keep, and the honest version is that it is
/// written down nowhere.
#[derive(Clone, PartialEq, Eq)]
pub struct Token(String);

impl Token {
    /// The only way to read it, named so a call site reads as a decision.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Token {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Token(…)")
    }
}

/// What asking `gh` for a token came to.
///
/// None of these is an error the app is having, so none rejects a call: an
/// operator who has never signed in has a working app with no poller, and that
/// is a sentence rather than a stack.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TokenOutcome {
    Acquired(Token),
    /// The harvest was discarded, so `gh` was never looked for. Not looking is a
    /// different fact from looking and not finding.
    NotAttempted,
    Refused(TokenRefusal),
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TokenRefusal {
    #[error(
        "nothing named gh is on the PATH this run acquired, across its {entries} directories, so \
         there is no token to ask for"
    )]
    NotOnPath { entries: usize },

    #[error("gh answered with no token")]
    NoToken,

    /// The first line of gh's **stderr**, never its stdout — stdout is the
    /// token, and a refusal that repeated it would print a secret into whatever
    /// reads refusals. `gh`'s own sentence may say whatever it says, including
    /// about a network, because it is `gh`'s account of `gh`'s own failure and
    /// rewriting it here would mean this crate asserting a reason it did not
    /// establish. When `gh` said nothing at all, the code it returned is the
    /// only other thing anyone here observed, and stdout may not stand in for it.
    #[error("gh declined to give a token: {said}")]
    Declined { said: String },

    #[error("{0}")]
    CouldNotRun(#[from] RunFailure),
}

/// `gh auth token`, run inside the harvested environment. Nothing stores what
/// comes back.
///
/// The launch order this fixes — harvest, then token, then the first poll — is a
/// data dependency and not a schedule: `gh` is not on the launchd stub, so the
/// first step has to have happened before the second can. Measured again on this
/// machine for this slice: from `env -i` under that stub, `zsh -ic` returns a
/// plausible 14-variable environment with no `gh` in it at all, because
/// homebrew's directory is added only by the login `path_helper`.
///
/// It is asked at the root, where the harvest was taken, because whether this
/// operator has signed in is a fact about the machine rather than about a folder.
pub fn acquire_token(environment: &Environment) -> TokenOutcome {
    let asked = run_in(
        environment,
        "gh",
        &["auth", "token"],
        &harvest_cwd(),
        &Bounds::for_this_machine(),
    );

    match interpret(asked) {
        // [`interpret`] is pure and cannot count what it was never handed. How
        // many directories were searched is the environment's to report, and it
        // is what turns "not on the PATH" into something an operator can act on:
        // three directories means the harvest degraded, and eighty means `gh` is
        // genuinely not installed.
        TokenOutcome::Refused(TokenRefusal::CouldNotRun(RunFailure::NotOnThisPath { .. })) => {
            TokenOutcome::Refused(TokenRefusal::NotOnPath {
                entries: directories_on(environment),
            })
        }
        settled => settled,
    }
}

/// What a finished `gh auth token` run means. Pure, so every branch is tested
/// with no `gh` on either runner — which matters, because a GitHub CI image has
/// `gh` installed and has never signed in, so exactly one of four branches is
/// the only one a live call could ever reach.
pub fn interpret(run: Result<Capture, RunFailure>) -> TokenOutcome {
    let captured = match run {
        Ok(captured) => captured,
        Err(refused) => return TokenOutcome::Refused(TokenRefusal::CouldNotRun(refused)),
    };

    if !captured.succeeded() {
        return TokenOutcome::Refused(TokenRefusal::Declined {
            said: what_gh_said(&captured),
        });
    }

    // Lossily and trimmed: a token is ASCII and arrives with the newline `gh`
    // printed after it. What is *not* done here is as load-bearing — nothing
    // measures, splits, prefixes or logs it on the way past.
    let token = String::from_utf8_lossy(&captured.stdout).trim().to_string();
    if token.is_empty() {
        TokenOutcome::Refused(TokenRefusal::NoToken)
    } else {
        TokenOutcome::Acquired(Token(token))
    }
}

/// `gh`'s first line of stderr, and never its stdout under any circumstance —
/// stdout is the token. A run that failed while saying nothing leaves only the
/// code it returned, which is a fact rather than a reason, so it is reported as
/// one.
fn what_gh_said(captured: &Capture) -> String {
    let stderr = String::from_utf8_lossy(&captured.stderr);
    let first = stderr
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string);

    first.unwrap_or_else(|| match captured.status {
        Some(code) => format!("it said nothing and exited with status {code}"),
        None => "it said nothing and was stopped before it exited".to_string(),
    })
}

/// A count for a sentence, never for a decision. Splitting a `PATH` is a guess
/// about the separator — the verbatim string is the evidence, which is why
/// [`Environment::path`] never splits — and a guess is good enough to say how
/// many places were looked in.
fn directories_on(environment: &Environment) -> usize {
    let separator = if cfg!(windows) { ';' } else { ':' };

    environment
        .path()
        .map(|path| {
            path.split(separator)
                .filter(|entry| !entry.is_empty())
                .count()
        })
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use perseverance_env::{Reading, Tally};
    use std::collections::BTreeMap;
    use std::path::{Path, PathBuf};
    use tempfile::TempDir;

    /// The token this workspace uses to prove a token never travels. It is not a
    /// GitHub token and never was; `ghp_` is the prefix a leak scanner greps for,
    /// which is the point of choosing it.
    const NOT_A_TOKEN: &str = "ghp_notarealtoken";

    fn captured(status: i32, stdout: &str, stderr: &str) -> Result<Capture, RunFailure> {
        Ok(Capture {
            status: Some(status),
            stdout: stdout.as_bytes().to_vec(),
            stderr: stderr.as_bytes().to_vec(),
        })
    }

    /// An environment whose `PATH` names one temporary directory and nothing
    /// else, so a `gh` found through it was found through the harvest and not
    /// through whatever the runner happens to have installed.
    fn harvested(directory: &Path) -> Environment {
        let mut variables = BTreeMap::new();
        variables.insert(
            "PATH".to_string(),
            directory.to_string_lossy().as_bytes().to_vec(),
        );
        // The Windows half of resolution, carried in the harvest rather than
        // assumed, so `gh.cmd` is found by the same walk a real one would be.
        variables.insert("PATHEXT".to_string(), b".COM;.EXE;.BAT;.CMD".to_vec());
        variables.insert("WF31_FROM_HARVEST".to_string(), b"yes".to_vec());

        Environment::from_reading(Reading {
            variables,
            tally: Tally::default(),
        })
    }

    /// A `gh` that is ours. Every branch below is reachable with it and none is
    /// reachable with a real one: a GitHub runner has `gh` installed and has
    /// never signed in.
    #[cfg(unix)]
    fn fake_gh(directory: &Path, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;

        let path = directory.join("gh");
        std::fs::write(&path, format!("#!/bin/sh\n{body}")).expect("writes the fake gh");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
            .expect("makes it a program");
        path
    }

    #[cfg(windows)]
    fn fake_gh(directory: &Path, body: &str) -> PathBuf {
        let path = directory.join("gh.cmd");
        std::fs::write(&path, format!("@echo off\r\n{body}\r\n")).expect("writes the fake gh");
        path
    }

    #[cfg(unix)]
    fn declines() -> String {
        format!("printf '{NOT_A_TOKEN}\\n'\nprintf 'not logged in to any hosts\\n' >&2\nexit 1\n")
    }
    #[cfg(windows)]
    fn declines() -> String {
        format!("echo {NOT_A_TOKEN}\r\necho not logged in to any hosts 1>&2\r\nexit /b 1")
    }

    #[cfg(unix)]
    fn answers() -> String {
        format!("printf '{NOT_A_TOKEN}\\n'\nexit 0\n")
    }
    #[cfg(windows)]
    fn answers() -> String {
        format!("echo {NOT_A_TOKEN}\r\nexit /b 0")
    }

    #[test]
    fn a_token_on_stdout_is_the_token() {
        let outcome = interpret(captured(0, "ghp_something\n", ""));

        match outcome {
            TokenOutcome::Acquired(token) => assert_eq!(token.expose(), "ghp_something"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_gh_that_is_there_and_has_not_signed_in_is_a_refusal_in_ghs_own_words() {
        let outcome = interpret(captured(
            1,
            "",
            "not logged in to any hosts\nTry: gh auth login\n",
        ));

        assert_eq!(
            outcome,
            TokenOutcome::Refused(TokenRefusal::Declined {
                // The first line only. `gh` writes a hint under it, and a
                // refusal is a sentence rather than a transcript.
                said: "not logged in to any hosts".to_string()
            })
        );
    }

    #[test]
    fn a_gh_that_answered_with_nothing_is_told_apart_from_one_that_refused() {
        assert_eq!(
            interpret(captured(0, "\n", "")),
            TokenOutcome::Refused(TokenRefusal::NoToken)
        );
    }

    #[test]
    fn a_gh_that_was_never_found_is_carried_rather_than_rephrased() {
        let refusal = RunFailure::NotOnThisPath {
            program: "gh".to_string(),
        };

        assert_eq!(
            interpret(Err(refusal.clone())),
            TokenOutcome::Refused(TokenRefusal::CouldNotRun(refusal))
        );
    }

    #[test]
    fn a_gh_that_failed_without_saying_anything_is_not_quoted_from_its_stdout() {
        // The one shape where a refusal has nothing to say. stdout is the token,
        // so the code it returned is all that may stand in.
        let outcome = interpret(captured(1, NOT_A_TOKEN, ""));

        match outcome {
            TokenOutcome::Refused(TokenRefusal::Declined { said }) => {
                assert!(!said.contains(NOT_A_TOKEN), "{said}");
                assert!(said.contains('1'), "{said}");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_failed_token_acquisition_never_repeats_what_gh_printed_to_stdout() {
        let directory = TempDir::new().expect("a temporary directory");
        fake_gh(directory.path(), &declines());

        let outcome = acquire_token(&harvested(directory.path()));

        // Everything a refusal could possibly be read through: its own fields,
        // its sentence, and the `{:?}` of the outcome it is wrapped in — which is
        // how a secret reaches a log without anyone choosing to print it.
        let refusal = match &outcome {
            TokenOutcome::Refused(refusal) => refusal.clone(),
            other => panic!("{other:?}"),
        };
        assert!(!refusal.to_string().contains(NOT_A_TOKEN));
        assert!(!format!("{refusal:?}").contains(NOT_A_TOKEN));
        assert!(!format!("{outcome:?}").contains(NOT_A_TOKEN));
        assert_eq!(
            refusal,
            TokenRefusal::Declined {
                said: "not logged in to any hosts".to_string()
            }
        );
    }

    #[test]
    fn a_token_is_read_from_the_environment_the_harvest_acquired_and_written_down_nowhere() {
        let directory = TempDir::new().expect("a temporary directory");
        fake_gh(directory.path(), &answers());

        let outcome = acquire_token(&harvested(directory.path()));

        match &outcome {
            TokenOutcome::Acquired(token) => assert_eq!(token.expose(), NOT_A_TOKEN),
            other => panic!("{other:?}"),
        }
        // The acquired outcome is the one place the token exists, and it does not
        // print itself even from three types up.
        assert!(!format!("{outcome:?}").contains(NOT_A_TOKEN));
        // Nothing was written beside the fake `gh`, which is the whole of what
        // this crate could have written.
        let written: Vec<_> = std::fs::read_dir(directory.path())
            .expect("reads the directory")
            .map(|entry| entry.expect("an entry").file_name())
            .collect();
        assert_eq!(written.len(), 1, "{written:?}");
    }

    #[test]
    fn a_gh_that_is_not_on_the_harvested_path_is_reported_with_how_far_we_looked() {
        let directory = TempDir::new().expect("a temporary directory");

        // `gh` is on a GitHub runner's own PATH. Resolving against the parent's
        // PATH is #21's bug re-entered through the back door, and this is where
        // it would show: the answer must be that it is not on *this* one.
        let outcome = acquire_token(&harvested(directory.path()));

        assert_eq!(
            outcome,
            TokenOutcome::Refused(TokenRefusal::NotOnPath { entries: 1 })
        );
    }

    #[test]
    fn a_token_does_not_print_itself() {
        let token = Token(NOT_A_TOKEN.to_string());

        assert_eq!(format!("{token:?}"), "Token(…)");
        assert!(!format!("{token:?}").contains("ghp_"));
    }

    /// Unrun here, and unrunnable on either runner: a GitHub image has `gh`
    /// installed and has never signed in, so the only branch a live call could
    /// reach there is the one every test above already reaches with a fake.
    /// `cargo test --package perseverance-github -- --ignored` on a machine
    /// whose operator has signed in is the one place the shipped argv is
    /// exercised — a typo in `["auth", "token"]` is invisible to everything
    /// else in this file, and the README says so.
    ///
    /// It asserts the outcome and never the value. Nothing here prints, stores
    /// or compares the token, which is why an operator can run it.
    #[test]
    #[ignore = "asks this machine's own gh for a real token; no CI runner has signed in"]
    fn a_signed_in_gh_answers_the_argv_this_crate_actually_ships() {
        let harvested = perseverance_env::harvest()
            .outcome
            .expect("this machine's own shell harvests");

        match acquire_token(&harvested.environment) {
            TokenOutcome::Acquired(_) => {}
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn no_token_refusal_reads_like_a_network_failure() {
        // Shared with `perseverance-store`'s own sweep. A refusal that reads like
        // a failed request sends an operator to their network rather than to
        // `gh auth login`.
        const NETWORK_VOCABULARY: &[&str] = &[
            "reach", "connect", "network", "timeout", "offline", "retry", "server", "http",
        ];

        // `Declined` is exempt and only `Declined`: its content is `gh`'s own
        // account of `gh`'s own failure, and rewriting it would mean asserting a
        // reason this crate did not establish.
        let refusals = [
            TokenRefusal::NotOnPath { entries: 12 },
            TokenRefusal::NoToken,
            TokenRefusal::CouldNotRun(RunFailure::NotOnThisPath {
                program: "gh".to_string(),
            }),
            TokenRefusal::CouldNotRun(RunFailure::DidNotStart {
                program: "gh".to_string(),
                detail: "permission denied".to_string(),
            }),
            TokenRefusal::CouldNotRun(RunFailure::RanTooLong {
                program: "gh".to_string(),
                after_ms: 8000,
            }),
        ];

        for refusal in refusals {
            let lowered = refusal.to_string().to_lowercase();
            for word in NETWORK_VOCABULARY {
                assert!(
                    !lowered.contains(word),
                    "{refusal:?} reads like a network failure because of {word:?}"
                );
            }
        }
    }
}

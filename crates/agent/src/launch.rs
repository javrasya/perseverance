use std::ffi::{OsStr, OsString};
use std::fmt;
use std::time::Duration;

use crate::platform::Platform;
use crate::registry::AgentId;

/// The program the harness resolved, handed over as a *name* and never as a
/// path.
///
/// A newtype around `&OsStr` rather than a `&Path`, and the difference is the
/// whole reason it exists. A path carries *inherent* filesystem methods that
/// need no import at all — `exists`, `metadata`, `read_dir`, `canonicalize`,
/// `read_link` — so an adapter handed one could make syscalls inside `plan`
/// while naming nothing a scan could see. An `OsStr` has no such method, and
/// this wrapper adds none and derefs to nothing: it can be read as a name, put
/// into argv, and printed. That is the entire surface.
///
/// Whether the program is really there, and whether it is a native image rather
/// than a shim, is [`perseverance_pty`]'s to say — at the boundary, after
/// planning, once, rather than remembered per adapter.
///
/// [`perseverance_pty`]: https://github.com/javrasya/perseverance
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Program<'a>(&'a OsStr);

impl<'a> Program<'a> {
    /// The name, for putting into argv. There is nothing else to do with it.
    pub fn as_os_str(self) -> &'a OsStr {
        self.0
    }
}

impl fmt::Display for Program<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0.to_string_lossy())
    }
}

/// The directory the harness will start the child in, on the same terms as
/// [`Program`]: a name an adapter may read and print, and not a handle it may
/// walk.
///
/// It is here so a plan *can* mention where the run happens — an adapter that
/// needed the folder in argv has it — and not so an adapter can go and look at
/// what is in it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cwd<'a>(&'a OsStr);

impl<'a> Cwd<'a> {
    pub fn as_os_str(self) -> &'a OsStr {
        self.0
    }
}

impl fmt::Display for Cwd<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0.to_string_lossy())
    }
}

/// Everything an adapter is allowed to plan from.
///
/// **`Copy` is load-bearing and not a convenience.** `File`, `TcpStream`,
/// `Sender`, `Command` and `Box<dyn Fn>` are none of them `Copy`, so the derive
/// below fails to compile the day someone adds a field a `plan` could write
/// through.
///
/// `Copy` alone would only stop the *writes*. Every field is also a type with
/// no way to reach the world: [`Platform`] is an enum, the prompt is a `&str`,
/// the environment is a borrowed slice of pairs rather than a closure — a
/// closure can close over a socket, a slice cannot close over anything — and
/// the two directory-shaped fields are [`Program`] and [`Cwd`] rather than
/// `&Path`, because a path would have brought a dozen inherent filesystem
/// methods in with it. Nothing handed to `plan` can read, and nothing handed to
/// `plan` can write.
///
/// The third leg is that this crate has no dependencies and may name only
/// `ffi`, `fmt`, `time` and `error` out of `std` — an allowlist a test in
/// `crates/app` enforces over these source files — so there is no second way to
/// reach a path type either.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LaunchContext<'a> {
    platform: Platform,
    program: Program<'a>,
    cwd: Cwd<'a>,
    prompt: &'a str,
    environment: &'a [(&'a str, &'a [u8])],
}

impl<'a> LaunchContext<'a> {
    /// `program` is already resolved — by `perseverance_env::Environment::resolve`,
    /// against the environment that harvest acquired, and never by an adapter.
    /// `prompt` is already rendered. Nothing here is a request to go and find
    /// something out.
    ///
    /// The two directories arrive as `&OsStr` (a caller holding a path passes
    /// `as_os_str()`) and are wrapped on the way in. The conversion happens
    /// here, on the harness's side of the boundary, so that the adapter side
    /// never holds a value with a filesystem method on it.
    pub fn new(
        platform: Platform,
        program: &'a OsStr,
        cwd: &'a OsStr,
        prompt: &'a str,
        environment: &'a [(&'a str, &'a [u8])],
    ) -> LaunchContext<'a> {
        LaunchContext {
            platform,
            program: Program(program),
            cwd: Cwd(cwd),
            prompt,
            environment,
        }
    }

    pub fn platform(&self) -> Platform {
        self.platform
    }

    /// The absolute path the harness resolved, as a name. It becomes `argv[0]`,
    /// and whether it is spawnable is [`perseverance_pty`]'s to say, not an
    /// adapter's.
    ///
    /// [`perseverance_pty`]: https://github.com/javrasya/perseverance
    pub fn program(&self) -> Program<'a> {
        self.program
    }

    /// Set on the child at spawn by the harness. It is here so an adapter can
    /// *read* it, never so an adapter can act on it.
    pub fn cwd(&self) -> Cwd<'a> {
        self.cwd
    }

    pub fn prompt(&self) -> &'a str {
        self.prompt
    }

    /// One variable, matched the way the platform being planned for matches it:
    /// without regard to case on Windows, exactly elsewhere.
    ///
    /// The same rule as `perseverance_env::Environment::get`, restated here
    /// because this crate may not name that one — and keyed off
    /// [`LaunchContext::platform`] rather than off `cfg!`, so a Windows plan is
    /// checkable from a macOS runner.
    pub fn var(&self, name: &str) -> Option<&'a [u8]> {
        self.environment
            .iter()
            .find(|(held, _)| {
                if self.platform.folds_variable_case() {
                    held.eq_ignore_ascii_case(name)
                } else {
                    *held == name
                }
            })
            .map(|(_, value)| *value)
    }
}

/// How the harness decides a session has opened.
///
/// **Declared, not implemented.** An adapter says which rule applies to it and
/// the harness runs the clock; an adapter that timed its own readiness would be
/// a driver, and the adapter is not a driver.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ready {
    /// The agent has switched the terminal to the alternate screen. Measured at
    /// ~223 ms for Claude Code, so a timeout an order of magnitude above that
    /// is a *diagnosis* — something is waiting for the operator, most likely a
    /// trust prompt — and not a slow machine.
    AltScreen { timeout: Duration },
    /// The agent has written nothing for `quiet`, giving up at `max`. For CLIs
    /// that never take the alternate screen and simply settle.
    Quiet { quiet: Duration, max: Duration },
}

/// The whole of what an adapter produces.
///
/// An argument vector, an environment delta, and a readiness rule. There is no
/// path field, no bytes field, no list of files to write and no callback — so
/// anything an adapter wanted done would have to be sayable as argv or as
/// environment, and per-run configuration therefore *is* argv and environment.
/// That is criterion 7, restated as the shape of one type.
///
/// Fields are private and there is no setter. A plan the harness could edit
/// after `plan` returned would make a golden-argv assertion a statement about
/// something other than what gets spawned.
///
/// `PartialEq` is why the golden test can compare the whole value rather than
/// the fields someone thought to check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    argv: Vec<OsString>,
    env_remove: &'static [&'static str],
    env_add: Vec<(String, String)>,
    ready: Ready,
}

impl Launch {
    /// The asymmetry between the two environment fields is deliberate. What to
    /// scrub is a property of the adapter — the same names every time, known at
    /// compile time, hence `&'static` — while what to inject can depend on the
    /// launch.
    pub fn new(
        argv: Vec<OsString>,
        env_remove: &'static [&'static str],
        env_add: Vec<(String, String)>,
        ready: Ready,
    ) -> Launch {
        Launch {
            argv,
            env_remove,
            env_add,
            ready,
        }
    }

    /// `argv[0]` is the program. The harness checks it is a native image before
    /// anything is spawned; see `perseverance_pty::accept`.
    pub fn argv(&self) -> &[OsString] {
        &self.argv
    }

    pub fn env_remove(&self) -> &'static [&'static str] {
        self.env_remove
    }

    pub fn env_add(&self) -> &[(String, String)] {
        &self.env_add
    }

    pub fn ready(&self) -> Ready {
        self.ready
    }
}

/// Every way planning declines to produce a launch.
///
/// All three are decidable from the context alone, which is what makes them
/// plan-time rather than spawn-time. Each names the adapter, because a message
/// that said only "the prompt is empty" would leave the operator to work out
/// which of several adapters said it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlanError {
    /// The adapter has nothing to run on the platform being planned for. No
    /// shipped adapter says this yet; it exists so that one which is genuinely
    /// unix-only refuses at plan time rather than producing argv nobody can
    /// spawn.
    NotOnThisPlatform { id: AgentId, platform: Platform },
    /// A session opened with nothing to do is a session the operator has to
    /// notice and close.
    PromptIsEmpty { id: AgentId },
    /// Not invented: `CommandBuilder::append_quoted` rejects embedded NULs
    /// outright (`docs/research/pty-spawn-agent-clis.md` §6.1), so a NUL that
    /// reached spawn would be a surprise at the far end of the harness. It is
    /// refused here, where the thing that produced it is still in view.
    PromptHasNul { id: AgentId },
}

impl fmt::Display for PlanError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PlanError::NotOnThisPlatform { id, platform } => write!(
                f,
                "{id} has nothing to run on {}, so there is no launch to plan",
                match platform {
                    Platform::Windows => "windows",
                    Platform::Unix => "unix",
                }
            ),
            PlanError::PromptIsEmpty { id } => write!(
                f,
                "{id} was asked to open a session with an empty prompt, which would leave the \
                 operator a window with nothing in it to close"
            ),
            PlanError::PromptHasNul { id } => write!(
                f,
                "{id} was given a prompt with a NUL byte in it, which no command line on either \
                 platform can carry"
            ),
        }
    }
}

impl std::error::Error for PlanError {}

#[cfg(test)]
mod tests {
    use super::*;

    const ENVIRONMENT: &[(&str, &[u8])] = &[("PATH", b"/usr/bin"), ("Term", b"dumb")];

    fn context(platform: Platform) -> LaunchContext<'static> {
        LaunchContext::new(
            platform,
            OsStr::new("/usr/local/bin/claude"),
            OsStr::new("/work/perseverance"),
            "open the map",
            ENVIRONMENT,
        )
    }

    #[test]
    fn the_program_and_the_working_directory_arrive_as_names_and_not_as_handles() {
        let cx = context(Platform::Unix);

        // The only two things either wrapper can do. `as_os_str` is what argv
        // is built from and `Display` is what an error message is written with;
        // there is no third, and in particular no `exists`, `metadata`,
        // `read_dir` or `canonicalize` — which is the point of the wrappers
        // rather than a `&Path`, since those four need no import and would
        // therefore be invisible to any scan of this crate's source.
        assert_eq!(
            cx.program().as_os_str(),
            OsStr::new("/usr/local/bin/claude")
        );
        assert_eq!(cx.cwd().as_os_str(), OsStr::new("/work/perseverance"));
        assert_eq!(cx.program().to_string(), "/usr/local/bin/claude");
        assert_eq!(cx.cwd().to_string(), "/work/perseverance");

        // Both are `Copy`, so the context stays `Copy` and no adapter can be
        // handed a value it could write through.
        let carried: LaunchContext<'_> = cx;
        assert_eq!(carried, cx);
    }

    #[test]
    fn a_context_reads_a_variable_by_the_rule_of_the_platform_it_plans_for() {
        // One slice, two rules, both asserted from whichever runner is here.
        // A `cfg!` inside `var` would make one of these two blocks dead on
        // every machine that ever runs it.
        let windows = context(Platform::Windows);
        assert_eq!(windows.var("TERM"), Some(&b"dumb"[..]));
        assert_eq!(windows.var("term"), Some(&b"dumb"[..]));
        assert_eq!(windows.var("path"), Some(&b"/usr/bin"[..]));

        let unix = context(Platform::Unix);
        assert_eq!(unix.var("Term"), Some(&b"dumb"[..]));
        assert_eq!(unix.var("TERM"), None);
        assert_eq!(unix.var("path"), None);
    }

    #[test]
    fn a_variable_that_is_not_there_reads_as_nothing_rather_than_as_empty() {
        // The distinction matters to an adapter deciding whether to inject:
        // `Some(b"")` is a variable the operator set to nothing on purpose.
        for platform in [Platform::Windows, Platform::Unix] {
            assert_eq!(context(platform).var("CLAUDE_CODE_CHILD_SESSION"), None);
        }
    }

    #[test]
    fn every_reason_a_plan_can_fail_says_so_in_a_sentence_naming_the_adapter() {
        let id = AgentId::ClaudeCode;
        let reasons = [
            PlanError::NotOnThisPlatform {
                id,
                platform: Platform::Windows,
            },
            PlanError::PromptIsEmpty { id },
            PlanError::PromptHasNul { id },
        ];

        for reason in reasons {
            let sentence = reason.to_string();

            assert!(
                sentence.contains(id.as_str()),
                "{sentence:?} does not name the adapter that refused"
            );
            assert!(
                sentence.len() > 40,
                "{sentence:?} is a label rather than a sentence"
            );
            assert!(
                !sentence.ends_with('.'),
                "{sentence:?} ends in a full stop; house style does not"
            );
            // It is an error in the `std` sense, so a caller may put it behind
            // `Box<dyn Error>` without this crate owning a dependency.
            let _: &dyn std::error::Error = &reason;
        }
    }

    #[test]
    fn a_finished_plan_compares_equal_only_to_the_same_argv_scrub_set_and_readiness_rule() {
        const SCRUB: &[&str] = &["A_MARKER"];
        const OTHER: &[&str] = &["ANOTHER_MARKER"];
        let ready = Ready::AltScreen {
            timeout: Duration::from_secs(10),
        };

        let plan = || {
            Launch::new(
                vec![
                    OsString::from("/usr/local/bin/claude"),
                    OsString::from("go"),
                ],
                SCRUB,
                vec![("TERM".to_string(), "xterm-256color".to_string())],
                ready,
            )
        };

        assert_eq!(plan(), plan());

        // Each field on its own is enough to make two plans different, which is
        // what lets a golden test compare the whole value rather than the
        // fields whoever wrote it happened to think of.
        assert_ne!(
            plan(),
            Launch::new(
                vec![OsString::from("/usr/local/bin/claude")],
                SCRUB,
                vec![],
                ready
            )
        );
        assert_ne!(
            plan(),
            Launch::new(
                vec![
                    OsString::from("/usr/local/bin/claude"),
                    OsString::from("go")
                ],
                OTHER,
                vec![("TERM".to_string(), "xterm-256color".to_string())],
                ready,
            )
        );
        assert_ne!(
            plan(),
            Launch::new(
                vec![
                    OsString::from("/usr/local/bin/claude"),
                    OsString::from("go")
                ],
                SCRUB,
                vec![],
                ready,
            )
        );
        assert_ne!(
            plan(),
            Launch::new(
                vec![
                    OsString::from("/usr/local/bin/claude"),
                    OsString::from("go")
                ],
                SCRUB,
                vec![("TERM".to_string(), "xterm-256color".to_string())],
                Ready::Quiet {
                    quiet: Duration::from_millis(400),
                    max: Duration::from_secs(10),
                },
            )
        );

        assert_eq!(plan().argv().len(), 2);
        assert_eq!(plan().env_remove(), SCRUB);
        assert_eq!(plan().env_add()[0].0, "TERM");
        assert_eq!(plan().ready(), ready);
    }
}

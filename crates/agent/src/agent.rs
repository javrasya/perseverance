use crate::launch::{Launch, LaunchContext, PlanError};
use crate::platform::Platform;
use crate::registry::AgentId;
use crate::watch::{NoWatch, Watch};

/// How the harness finds this agent's program.
///
/// Every field is `&'static`, so a `Discovery` is a `static` and
/// [`Agent::discovery`] hands back a reference to it. That is not a
/// micro-optimisation: it means discovery is a *declaration*, fixed when the
/// binary was built, and there is no place in the signature for an adapter to
/// have gone and looked something up first.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Discovery {
    /// Ordered. The first name that resolves wins.
    ///
    /// Resolving is `perseverance_env::Environment::resolve`'s work and never
    /// this crate's — an adapter says what to look for and never where, because
    /// where is a `PATH` this crate has not acquired and must not guess at.
    pub candidates: &'static [&'static str],
    /// Interpreter probes, per platform. What to run, and with what, to find out
    /// which interpreter the thing this agent needs is really sitting under.
    /// Declared here and run by the harness, because running one is spawning a
    /// child — `perseverance_env::probe_in` is what runs them, inside the
    /// folder's own harvested environment.
    ///
    /// Read for *inspection* and never for a verdict. Nothing in this workspace
    /// parses a version out of a probe or compares one: wrong-interpreter is
    /// made inspectable rather than detected, because a check that guessed would
    /// be this harness disagreeing silently with the operator's own terminal.
    pub probes: Probes,
}

/// Declared per platform, because an interpreter is a platform's.
///
/// Not one list with a tag on each entry. A list like that is per-platform only
/// for as long as every caller remembers to filter it, and a probe run on the
/// wrong platform is a reading of nothing presented as a reading of something —
/// `node --version` on a machine with no `node` reads exactly like a folder that
/// has none. Here the wrong platform's probes are not reachable without naming
/// the wrong platform, and [`Probes::on`] takes the platform as a parameter so
/// both arms are checkable from either runner.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Probes {
    pub windows: &'static [Probe],
    pub unix: &'static [Probe],
}

impl Probes {
    /// An adapter with nothing behind it to ask about. The shipped one is this.
    pub const NONE: Probes = Probes {
        windows: &[],
        unix: &[],
    };

    pub const fn on(&self, platform: Platform) -> &'static [Probe] {
        match platform {
            Platform::Windows => self.windows,
            Platform::Unix => self.unix,
        }
    }
}

/// One declared probe. A program and its arguments, and never a result.
///
/// Nothing here can hold an answer, which is the point: a `Probe` that carried
/// its own outcome would be an adapter that had already run it. The platform is
/// no longer a field either — which list it is in *is* the platform, so there is
/// no way to declare a probe for one platform and read it on the other.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Probe {
    pub program: &'static str,
    pub args: &'static [&'static str],
}

/// The whole contract between the harness and an agent CLI.
///
/// **Four members, and no fifth.** An adapter names itself, says how it is
/// found, plans a launch, and optionally classifies bytes. It does not spawn,
/// does not wait, does not inject a prompt — the opening prompt is a launch
/// parameter that lands in argv — and does not decide when it is ready. The
/// adapter is not a driver.
///
/// `plan` is pure, and by signature rather than by promise: `&self`, no
/// `async`, no future in the return type, and a [`LaunchContext`] that is
/// `Copy` and therefore cannot carry a handle to write through. `Copy` on its
/// own would only rule out the writes — a `&Path` field is `Copy` and carries
/// `exists`, `metadata` and `read_dir` as *inherent* methods needing no import
/// — so the two directory-shaped fields are [`Program`] and [`Cwd`], newtypes
/// over `&OsStr` with `as_os_str` and `Display` and nothing else. The crate has
/// no dependencies, so `std` is the only tool left, and `crates/app` reads
/// these source files and fails the build unless every `std` path they name is
/// one of `ffi`, `fmt`, `time` and `error` — an allowlist rather than a list of
/// forbidden names, because a brace-grouped import pulls in the file and I/O
/// modules while spelling neither of them the way a forbidden-name scan looks
/// for. `path` is not on the allowlist, so
/// no path type is nameable here and no inherent filesystem method is
/// reachable. An adapter plans from what it was handed and from nothing it
/// could go and read.
///
/// [`Program`]: crate::Program
/// [`Cwd`]: crate::Cwd
///
/// `Sync + 'static` because the registry hands out `&'static dyn Agent` and any
/// number of runs may plan at once. Not `Send`: nothing ever moves one, because
/// nothing ever owns one.
pub trait Agent: Sync + 'static {
    fn id(&self) -> AgentId;

    fn discovery(&self) -> &Discovery;

    /// Pure. Same context in, same launch out, every time.
    fn plan(&self, cx: &LaunchContext<'_>) -> Result<Launch, PlanError>;

    /// A fresh classifier for one run. The default watches nothing, which is
    /// what every v1 adapter does: live signals mean only *poll GitHub sooner*,
    /// and polling never stopped, so there is nothing to degrade from.
    ///
    /// Because the default exists, no call site can branch on whether an
    /// adapter produces signals — there is always a `Box<dyn Watch>`.
    fn watch(&self) -> Box<dyn Watch> {
        Box::new(NoWatch)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::ffi::{OsStr, OsString};
    use std::time::Duration;

    use crate::launch::Ready;

    static UNIX_PROBES: &[Probe] = &[Probe {
        program: "node",
        args: &["--version"],
    }];

    static WINDOWS_PROBES: &[Probe] = &[Probe {
        program: "node.exe",
        args: &["--version"],
    }];

    static DISCOVERY: Discovery = Discovery {
        candidates: &["stand-in", "stand-in.exe"],
        probes: Probes {
            windows: WINDOWS_PROBES,
            unix: UNIX_PROBES,
        },
    };

    const SCRUB: &[&str] = &["A_MARKER_THIS_HARNESS_MUST_NOT_PASS_ON"];

    /// An adapter written the way the contract intends: three answers, and the
    /// fourth inherited.
    ///
    /// This double is what enforces "no fifth *required* member". It implements
    /// `id`, `discovery` and `plan` and nothing else, so a fifth member without
    /// a default body would stop this file compiling. A fifth member *with* one
    /// would not: nothing here counts the members, and an optional one is
    /// caught by review rather than by the compiler.
    struct StandIn;

    impl Agent for StandIn {
        fn id(&self) -> AgentId {
            AgentId::ClaudeCode
        }

        fn discovery(&self) -> &Discovery {
            &DISCOVERY
        }

        fn plan(&self, cx: &LaunchContext<'_>) -> Result<Launch, PlanError> {
            if cx.prompt().is_empty() {
                return Err(PlanError::PromptIsEmpty { id: self.id() });
            }

            Ok(Launch::new(
                vec![
                    cx.program().as_os_str().to_os_string(),
                    OsString::from(cx.prompt()),
                ],
                SCRUB,
                vec![("TERM".to_string(), "xterm-256color".to_string())],
                Ready::AltScreen {
                    timeout: Duration::from_secs(10),
                },
            ))
        }
    }

    fn context() -> LaunchContext<'static> {
        const ENVIRONMENT: &[(&str, &[u8])] = &[("PATH", b"/usr/bin")];

        LaunchContext::new(
            Platform::Unix,
            OsStr::new("/usr/local/bin/stand-in"),
            OsStr::new("/work/perseverance"),
            "open the map",
            ENVIRONMENT,
        )
    }

    #[test]
    fn an_adapter_is_written_by_answering_three_questions_and_inheriting_the_fourth() {
        let adapter: &dyn Agent = &StandIn;

        assert_eq!(adapter.id(), AgentId::ClaudeCode);
        assert_eq!(adapter.discovery().candidates.len(), 2);
        assert!(adapter.plan(&context()).is_ok());

        // Inherited, and it is a `Box<dyn Watch>` rather than an `Option`, so
        // this call site cannot ask whether the adapter watches.
        assert_eq!(adapter.watch().classify(b"anything at all"), None);
    }

    #[test]
    fn planning_the_same_launch_twice_gives_the_same_answer_both_times() {
        let adapter: &dyn Agent = &StandIn;
        let cx = context();

        // Purity in its only observable form. It holds because `plan` takes
        // `&self` and the context is `Copy` — there is no state on either side
        // for a first call to have changed.
        assert_eq!(adapter.plan(&cx), adapter.plan(&cx));

        // And a refusal is as reproducible as a launch.
        let empty = LaunchContext::new(
            Platform::Unix,
            OsStr::new("/usr/local/bin/stand-in"),
            OsStr::new("/work/perseverance"),
            "",
            &[],
        );
        assert_eq!(adapter.plan(&empty), adapter.plan(&empty));
        assert_eq!(
            adapter.plan(&empty),
            Err(PlanError::PromptIsEmpty {
                id: AgentId::ClaudeCode
            })
        );
    }

    #[test]
    fn a_declared_probe_is_a_program_and_its_arguments_and_never_a_result() {
        let adapter: &dyn Agent = &StandIn;

        for platform in [Platform::Windows, Platform::Unix] {
            for probe in adapter.discovery().probes.on(platform) {
                assert!(!probe.program.is_empty());
                // `Copy` and `'static` throughout, so a probe cannot have been
                // filled in from something that ran: there is no owned field for
                // an outcome to live in, and the whole value is fixed at build
                // time.
                let carried_home: Probe = *probe;
                assert_eq!(carried_home, *probe);
            }
        }

        assert_eq!(
            adapter.discovery().probes.on(Platform::Unix)[0],
            Probe {
                program: "node",
                args: &["--version"],
            }
        );
    }

    #[test]
    fn a_probe_declared_for_one_platform_cannot_be_reached_from_the_other() {
        let probes = StandIn.discovery().probes;

        // Selected by parameter, so both readings are checkable from whichever
        // runner is here — and the wrong platform's list is not reachable
        // without naming the wrong platform, which is the difference from a flat
        // list every caller had to remember to filter.
        assert_eq!(probes.on(Platform::Unix)[0].program, "node");
        assert_eq!(probes.on(Platform::Windows)[0].program, "node.exe");
        assert_ne!(probes.on(Platform::Unix), probes.on(Platform::Windows));

        // And an adapter with nothing behind it says so once, for both.
        assert!(Probes::NONE.on(Platform::Unix).is_empty());
        assert!(Probes::NONE.on(Platform::Windows).is_empty());
    }
}

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
    /// Interpreter probes: what to run, and with what, to find out whether the
    /// thing this agent needs is really there. Declared here and run by the
    /// harness at #45, because running one is spawning a child.
    pub probes: &'static [Probe],
}

/// One declared probe. A program and its arguments, and the platform it applies
/// to — never a result.
///
/// Nothing here can hold an answer, which is the point: a `Probe` that carried
/// its own outcome would be an adapter that had already run it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Probe {
    pub program: &'static str,
    pub args: &'static [&'static str],
    pub platform: Platform,
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

    static PROBES: &[Probe] = &[Probe {
        program: "node",
        args: &["--version"],
        platform: Platform::Unix,
    }];

    static DISCOVERY: Discovery = Discovery {
        candidates: &["stand-in", "stand-in.exe"],
        probes: PROBES,
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

        for probe in adapter.discovery().probes {
            assert!(!probe.program.is_empty());
            // `Copy` and `'static` throughout, so a probe cannot have been
            // filled in from something that ran: there is no owned field for an
            // outcome to live in, and the whole value is fixed at build time.
            let carried_home: Probe = *probe;
            assert_eq!(carried_home, *probe);
        }

        assert_eq!(
            adapter.discovery().probes[0],
            Probe {
                program: "node",
                args: &["--version"],
                platform: Platform::Unix,
            }
        );
    }
}

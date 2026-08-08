use std::ffi::OsString;
use std::time::Duration;

use crate::agent::{Agent, Discovery};
use crate::launch::{Launch, LaunchContext, PlanError, Ready};
use crate::registry::AgentId;

/// The one name every installer agrees on.
///
/// npm, the native installer and Homebrew all put the entry point on `PATH`
/// under `claude`, and resolving that name to a path is
/// `perseverance_env::Environment::resolve`'s work: it is the thing holding the
/// harvested `PATH`, and this crate has not acquired one and must not guess.
/// `claude.exe` is deliberately not a second candidate — on Windows the
/// resolver appends `PATHEXT` itself, and a candidate spelled with an extension
/// would be this crate re-implementing that badly.
///
/// No probes. Claude Code's supported installs ship a native image; the npm
/// install ships a shim, and a shim is refused at the harness boundary by
/// `perseverance_pty::accept` rather than sniffed for here. A probe declared to
/// cover it would be an interpreter check whose only honest outcome is the
/// refusal that already happens.
static DISCOVERY: Discovery = Discovery {
    candidates: &["claude"],
    probes: &[],
};

/// The marker a session started from inside another session inherits.
///
/// Observed live: a `claude` spawned from a dev terminal that was itself a
/// Claude Code session prints *transcript saving is off — inherited
/// `CLAUDE_CODE_CHILD_SESSION` marker* and silently stops persisting its
/// transcript (`docs/research/pty-spawn-agent-clis.md` §5.3). The harness
/// forwards whatever launched it, so a run started from a developer's own
/// session would keep no transcript at all — and the failure is a line in a
/// status bar nobody is looking at.
///
/// `&'static` because the scrub set is a property of the adapter and not of the
/// launch: it is the same name every time, known when the binary was built.
const CHILD_SESSION: &[&str] = &["CLAUDE_CODE_CHILD_SESSION"];

/// The terminal type, stated rather than forwarded.
///
/// `xterm-256color` is what the measured spawn set. Forwarding whatever the
/// harness itself was started under would forward whatever launched *it* — on
/// macOS a launchd stub with no `TERM` at all — so a run's terminal is a
/// declaration and not an inheritance.
const TERM_NAME: &str = "TERM";
const TERM_VALUE: &str = "xterm-256color";

/// Readiness, declared and not implemented.
///
/// `ESC[?1049h` was observed at ~223 ms, emitted by the app rather than by
/// ConPTY, immediately before the TUI paints — a semantic signal, because the
/// app takes the screen only when it is about to run its main loop
/// (`docs/research/pty-spawn-agent-clis.md` §6.2).
///
/// Ten seconds is ~45× the measurement, which makes an expiry a *diagnosis*
/// rather than a slow machine: what stops the alternate screen arriving is
/// something waiting on the operator, and for this CLI that is the trust modal
/// (#50). A timeout tight enough to be tripped by a loaded laptop would turn
/// that diagnosis into noise.
const READY: Ready = Ready::AltScreen {
    timeout: Duration::from_secs(10),
};

/// The Claude Code adapter.
///
/// A zero-sized type, and that is the shape the contract wants: an adapter has
/// no state, because everything it plans from arrives in the
/// [`LaunchContext`]. The registry holds one `static` of it for the life of the
/// process.
///
/// It takes the default [`Agent::watch`]. That is not an omission — v1 cuts the
/// whole out-of-band tier, live signals mean only *poll GitHub sooner*, and
/// polling never stopped, so there is nothing to degrade from. The shipped
/// adapter watching nothing is what makes criterion 6 real rather than
/// hypothetical: no call site can have grown a branch on whether an adapter
/// produces signals, because the only adapter in the tree produces none and
/// every call site works anyway.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ClaudeCode;

impl Agent for ClaudeCode {
    fn id(&self) -> AgentId {
        AgentId::ClaudeCode
    }

    fn discovery(&self) -> &Discovery {
        &DISCOVERY
    }

    /// Two elements, and the second is the opening prompt.
    ///
    /// `claude [options] [command] [prompt]` — the prompt is a positional, an
    /// interactive session is the default, and slash commands work through it
    /// in that mode (`claude "/help"` painted the help panel under a real
    /// ConPTY with no keystrokes injected; `claude -p "/help"` did not).
    /// *Injecting a prompt* is therefore not an operation this harness has: the
    /// opening prompt is a launch parameter that lands in argv.
    ///
    /// No trust or permission flag. Claude's trust modal is exactly what
    /// [`Ready`]'s expiry is for, and `--dangerously-skip-permissions` is a
    /// policy this ticket did not decide.
    ///
    /// No platform branch. The honest finding is that this plan is identical on
    /// both, modulo the program the harness resolved — and the test below
    /// asserts that as a property, so the day an adapter needs a real branch
    /// the claim fails on whichever runner is already there.
    fn plan(&self, cx: &LaunchContext<'_>) -> Result<Launch, PlanError> {
        if cx.prompt().is_empty() {
            return Err(PlanError::PromptIsEmpty { id: self.id() });
        }
        if cx.prompt().as_bytes().contains(&0) {
            return Err(PlanError::PromptHasNul { id: self.id() });
        }

        Ok(Launch::new(
            vec![
                cx.program().as_os_str().to_os_string(),
                OsString::from(cx.prompt()),
            ],
            CHILD_SESSION,
            vec![(TERM_NAME.to_string(), TERM_VALUE.to_string())],
            READY,
        ))
    }

    // `watch` is inherited. See the type's doc comment.
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::ffi::OsStr;

    use crate::platform::Platform;
    use crate::watch::Signal;

    const ENVIRONMENT: &[(&str, &[u8])] = &[
        ("PATH", b"/usr/local/bin:/usr/bin"),
        // Present in the harvest, and present for a reason: a run started from
        // a developer's own Claude Code session inherits it.
        ("CLAUDE_CODE_CHILD_SESSION", b"1"),
        ("TERM", b"dumb"),
    ];

    const PROMPT: &str = "/perseverance work the frontier";

    const WINDOWS_PROGRAM: &str = r"C:\Users\ahmet\.local\bin\claude.exe";
    const UNIX_PROGRAM: &str = "/Users/ahmet/.local/bin/claude";

    fn program_for(platform: Platform) -> &'static OsStr {
        match platform {
            Platform::Windows => OsStr::new(WINDOWS_PROGRAM),
            Platform::Unix => OsStr::new(UNIX_PROGRAM),
        }
    }

    fn context_for(platform: Platform, prompt: &'static str) -> LaunchContext<'static> {
        LaunchContext::new(
            platform,
            program_for(platform),
            OsStr::new("/work/perseverance"),
            prompt,
            ENVIRONMENT,
        )
    }

    /// The golden, written out by hand rather than derived from the code under
    /// test, so the assertion is against a value somebody chose and not against
    /// whatever `plan` currently returns.
    fn golden_for(platform: Platform) -> Launch {
        Launch::new(
            vec![
                OsString::from(program_for(platform)),
                OsString::from(PROMPT),
            ],
            &["CLAUDE_CODE_CHILD_SESSION"],
            vec![("TERM".to_string(), "xterm-256color".to_string())],
            Ready::AltScreen {
                timeout: Duration::from_secs(10),
            },
        )
    }

    #[test]
    fn the_opening_prompt_is_a_positional_argument_and_not_a_flag() {
        // `claude [options] [command] [prompt]`, and an interactive session is
        // the default. There is no `--prompt`, no here-doc, and no writing to
        // the child's stdin after the fact — which is why this contract has no
        // inject-prompt operation to leave unimplemented.
        for platform in [Platform::Windows, Platform::Unix] {
            let launch = ClaudeCode.plan(&context_for(platform, PROMPT)).unwrap();
            let argv = launch.argv();

            assert_eq!(argv.len(), 2, "{platform:?} planned {argv:?}");
            assert_eq!(argv[0], OsString::from(program_for(platform)));
            assert_eq!(argv[1], OsString::from(PROMPT));

            // A slash command is a prompt like any other. Nothing quotes it,
            // escapes it or reads it — it is one argv element, verbatim.
            let slashed = ClaudeCode.plan(&context_for(platform, "/help")).unwrap();
            assert_eq!(slashed.argv()[1], OsString::from("/help"));
        }
    }

    #[test]
    fn the_plan_for_windows_and_the_plan_for_unix_differ_in_nothing_but_the_program() {
        // Both goldens, asserted whole, from one host. That is what handing the
        // platform in buys: a `cfg!` inside `plan` would leave one of these two
        // arms dead on every machine that ever ran it.
        for platform in [Platform::Windows, Platform::Unix] {
            assert_eq!(
                ClaudeCode.plan(&context_for(platform, PROMPT)),
                Ok(golden_for(platform)),
                "the plan for {platform:?} is not the one written down"
            );
        }

        // And the property itself: the two plans are the same value once the
        // program is set aside. The day #46 or a later Claude needs a genuine
        // platform branch, this line is what fails and says so.
        let windows = ClaudeCode
            .plan(&context_for(Platform::Windows, PROMPT))
            .unwrap();
        let unix = ClaudeCode
            .plan(&context_for(Platform::Unix, PROMPT))
            .unwrap();

        assert_ne!(windows.argv()[0], unix.argv()[0]);
        assert_eq!(windows.argv()[1..], unix.argv()[1..]);
        assert_eq!(windows.env_remove(), unix.env_remove());
        assert_eq!(windows.env_add(), unix.env_add());
        assert_eq!(windows.ready(), unix.ready());
    }

    #[test]
    fn a_session_this_harness_starts_never_inherits_the_marker_that_turns_transcripts_off() {
        // The marker is in the context — this is the developer's own session
        // launching the harness — and the plan scrubs it rather than reading
        // it. Observed: an inherited marker leaves the run persisting no
        // transcript, and says so only in a status bar.
        for platform in [Platform::Windows, Platform::Unix] {
            let cx = context_for(platform, PROMPT);
            assert_eq!(cx.var("CLAUDE_CODE_CHILD_SESSION"), Some(&b"1"[..]));

            let launch = ClaudeCode.plan(&cx).unwrap();
            assert_eq!(launch.env_remove(), ["CLAUDE_CODE_CHILD_SESSION"]);

            // `TERM` is stated rather than forwarded: the harvest here says
            // `dumb`, and a macOS launchd stub says nothing at all.
            assert_eq!(cx.var("TERM"), Some(&b"dumb"[..]));
            assert_eq!(
                launch.env_add(),
                [("TERM".to_string(), "xterm-256color".to_string())]
            );
        }
    }

    #[test]
    fn readiness_is_declared_as_the_alternate_screen_and_its_expiry_is_a_diagnosis() {
        let launch = ClaudeCode
            .plan(&context_for(Platform::Unix, PROMPT))
            .unwrap();

        let Ready::AltScreen { timeout } = launch.ready() else {
            panic!("claude settles into a TUI; it does not merely go quiet");
        };
        // ~223 ms measured. An order of magnitude above it means an expiry is
        // something waiting on the operator — the trust modal — rather than a
        // loaded machine.
        assert!(timeout >= Duration::from_secs(5) && timeout <= Duration::from_secs(30));
        assert_eq!(timeout, Duration::from_secs(10));

        // Declared, and not implemented: the adapter neither runs the clock nor
        // watches for the sequence. It takes the default watch, which is what
        // stops any call site asking whether it watches.
        assert_eq!(
            ClaudeCode.watch().classify(b"\x1b[?1049h"),
            None::<Signal>,
            "the shipped adapter classifies nothing, so nothing downstream may \
             branch on whether an adapter does"
        );
    }

    #[test]
    fn a_prompt_with_a_nul_in_it_is_refused_while_planning_and_not_while_spawning() {
        // `CommandBuilder::append_quoted` rejects embedded NULs outright, so a
        // NUL that reached spawn would surface at the far end of the harness,
        // with whatever produced it long out of view.
        for platform in [Platform::Windows, Platform::Unix] {
            assert_eq!(
                ClaudeCode.plan(&context_for(platform, "open the\0map")),
                Err(PlanError::PromptHasNul {
                    id: AgentId::ClaudeCode
                })
            );
        }
    }

    #[test]
    fn an_empty_prompt_is_refused_rather_than_opening_a_session_with_nothing_to_do() {
        for platform in [Platform::Windows, Platform::Unix] {
            assert_eq!(
                ClaudeCode.plan(&context_for(platform, "")),
                Err(PlanError::PromptIsEmpty {
                    id: AgentId::ClaudeCode
                })
            );
        }
    }

    #[test]
    fn the_only_name_claude_is_looked_for_under_is_the_one_every_installer_agrees_on() {
        let discovery = ClaudeCode.discovery();

        assert_eq!(discovery.candidates, ["claude"]);
        // No `claude.exe`: appending `PATHEXT` is the resolver's job, and a
        // candidate spelled with an extension would be this crate doing it
        // again and worse.
        assert!(!discovery
            .candidates
            .iter()
            .any(|candidate| candidate.contains('.')));
        // No probes. There is no interpreter behind a supported install, and
        // the npm shim is refused at the boundary rather than detected here.
        assert!(discovery.probes.is_empty());
        assert_eq!(ClaudeCode.id(), AgentId::ClaudeCode);
    }

    #[test]
    fn the_platform_this_build_runs_on_is_one_a_plan_can_be_made_for() {
        // The drift guard. Every golden above is written against a `Platform`
        // parameter, so this one line is what keeps that parameter attached to
        // the machine the harness will really spawn on.
        #[cfg(windows)]
        assert_eq!(Platform::host(), Platform::Windows);
        #[cfg(unix)]
        assert_eq!(Platform::host(), Platform::Unix);

        assert!(ClaudeCode
            .plan(&context_for(Platform::host(), PROMPT))
            .is_ok());
    }
}

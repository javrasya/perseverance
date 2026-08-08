use std::ffi::OsString;
use std::time::Duration;

use crate::agent::{Agent, Discovery, Probe, Probes};
use crate::launch::{Launch, LaunchContext, PlanError, Ready};
use crate::registry::AgentId;

/// The interpreter behind the entry point, asked for on both platforms.
///
/// Bare `node`, never `node.exe`: the resolver tries the bare name first and
/// then each `PATHEXT` spelling, and a probe spelled with an extension would be
/// this crate re-implementing that badly — the same argument the candidate list
/// makes.
static NODE: &[Probe] = &[Probe {
    program: "node",
    args: &["--version"],
}];

/// The same probe on both platforms, and that is a measurement rather than a
/// convenience.
///
/// Issue #21 read the macOS entry point and found `#!/usr/bin/env node` script
/// text that switches on `process.platform` and spawns a vendored native image
/// as a child: the nested platform package is not a Windows artifact, it is the
/// universal shape. So there is no platform on which an npm-installed `codex` is
/// not sitting on a `node`, and no platform where the reading is worth less.
const NODE_ON_BOTH: Probes = Probes {
    windows: NODE,
    unix: NODE,
};

/// The one name every installer agrees on.
///
/// Homebrew, the standalone release and npm all put the entry point on `PATH`
/// under `codex`. No `codex.exe`, for the resolver's reason above, and no search
/// paths of any kind: an adapter says *what* to look for and the folder's own
/// harvested `PATH` says where. `docs/adr/0011` records why guessing at install
/// directories is refused — the failure mode is not incompleteness but silent
/// divergence from what the operator's own shell resolves.
///
/// The probe is read for **inspection and never for a verdict**. A Homebrew or
/// standalone-release install is a native image with no `node` behind it at all,
/// and its probe will read *nothing of that name* on a perfectly good machine —
/// which is why nothing parses or compares it, and why the absolute path the
/// candidate resolved to sits beside it as the fact that says which install this
/// is.
///
/// What the probe buys is #21's other measurement: `zsh -lc` resolves `codex` to
/// `/usr/local/bin/codex`, which then dies `env: node: No such file or
/// directory`, exit 127. This turns that post-spawn 127 into a line in the
/// per-folder readout, before anything is spawned.
static DISCOVERY: Discovery = Discovery {
    candidates: &["codex"],
    probes: NODE_ON_BOTH,
};

/// Nothing is scrubbed, and the empty set is a reading of the evidence rather
/// than a gap in it.
///
/// The scrub set exists to stop a child believing it is nested and silently
/// writing no session record — harm to the operator's own history. For Codex
/// that harm has no environment-shaped route: transcripts land at
/// `$CODEX_HOME/sessions/**/rollout-*.jsonl` (observed), suppression is
/// `codex exec --ephemeral`, which is a flag and `exec`-only, and
/// `history.persistence`, which is a config key. No *I am inside codex* marker
/// of the `CLAUDE_CODE_CHILD_SESSION` kind is recorded anywhere in this repo's
/// research.
///
/// `CODEX_HOME` is named here precisely because it is the variable a harness
/// would reach for, and it is deliberately **not** scrubbed: it relocates the
/// whole Codex state directory *including `auth.json`*, so touching it would
/// start the child unauthenticated and misfile its history in one move.
///
/// The honest caveat, so the next reader inherits it rather than rediscovering
/// it: nobody has ever diffed the environment inside a codex child. *No nesting
/// marker* is an absence of evidence, and one measurement would close it. An
/// invented `CODEX_*` name would be the first adapter fact in this tree that is
/// not traceable to `docs/research`.
const NOTHING_TO_SCRUB: &[&str] = &[];

/// The terminal type, stated rather than forwarded, and identical to the other
/// adapters' on purpose.
///
/// The terminal type is a fact about the PTY the *harness* presents, not about
/// the vendor — which is exactly why it must not vary by adapter. Forwarding
/// whatever the harness itself was started under would forward whatever launched
/// *it*, and on macOS that is a launchd stub with no `TERM` at all.
const TERM_NAME: &str = "TERM";
const TERM_VALUE: &str = "xterm-256color";

/// Readiness, declared and not implemented.
///
/// The alternate screen is Codex's default and that part is observed:
/// `--no-alt-screen` exists for inline mode. We do not pass it — it would trade
/// a semantic readiness signal for scrollback the harness renders itself.
///
/// **The ten seconds is Claude's constant reused, not a measurement.** No
/// time-to-alt-screen has been taken for codex. It is declared here as this
/// adapter's own value rather than hoisted into a shared default, so the day
/// somebody measures it, it simply differs and no call site learns a default.
const READY: Ready = Ready::AltScreen {
    timeout: Duration::from_secs(10),
};

/// The Codex adapter.
///
/// A zero-sized type, like every other: an adapter has no state, because
/// everything it plans from arrives in the [`LaunchContext`].
///
/// It takes the default [`Agent::watch`], as all three shipped adapters do. That
/// is what keeps criterion 5 real rather than stated — no call site can have
/// grown a branch on whether an adapter produces signals, because none of them
/// does and every call site works anyway.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Codex;

impl Agent for Codex {
    fn id(&self) -> AgentId {
        AgentId::Codex
    }

    fn discovery(&self) -> &Discovery {
        &DISCOVERY
    }

    /// Two elements, and the second is the opening prompt. The same shape as
    /// the other two adapters, which is the whole point of this ticket.
    ///
    /// `codex [OPTIONS] [PROMPT]`, *optional user prompt to start the session*
    /// — a positional, and an interactive session is the default.
    ///
    /// **No `-C/--cd`**, though Codex is the only surveyed CLI that has one. The
    /// child's working directory is a spawn parameter and any `--cd`-style flag
    /// is an adapter-internal detail; using it would give one adapter a cwd that
    /// could differ from its own process cwd.
    ///
    /// No `-a never`, no `--no-alt-screen`, no `-c key=value`. Declining the
    /// same class of flag for every adapter is what makes the behaviour
    /// identical; picking them per vendor is what would shape the product like
    /// three vendors' CLIs. `--dangerously-skip-permissions` was declined for
    /// Claude on the same grounds — a policy this ticket did not decide.
    ///
    /// No platform branch, and the test below asserts that as a property rather
    /// than restating it.
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
            NOTHING_TO_SCRUB,
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
        // In the harvest, and left exactly where it is: an operator who
        // relocated their Codex state keeps it, and this run's history goes
        // where they put it.
        ("CODEX_HOME", b"/Users/ahmet/.codex-work"),
        ("TERM", b"dumb"),
    ];

    const PROMPT: &str = "/perseverance work the frontier";

    /// The Windows program is deliberately an npm shim, because that is what a
    /// `PATH` walk actually finds on a machine that installed it that way — and
    /// `perseverance_pty::accept` refuses a `.cmd` as `SpawnRefusal::BatchShim`.
    /// The plan is still the plan: the refusal belongs to the boundary, and
    /// #45's argv override is the operator's answer to it.
    const WINDOWS_PROGRAM: &str = r"C:\Users\ahmet\npm-global\codex.cmd";
    /// And the unix one is the interpreter-pinned entry point, which on the
    /// machine #21 measured was `#!/usr/bin/env node` script text.
    const UNIX_PROGRAM: &str = "/Users/ahmet/.fnm/node-versions/v24.15.0/installation/bin/codex";

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
    /// test, so the assertion is against a value somebody chose.
    fn golden_for(platform: Platform) -> Launch {
        Launch::new(
            vec![
                OsString::from(program_for(platform)),
                OsString::from(PROMPT),
            ],
            &[],
            vec![("TERM".to_string(), "xterm-256color".to_string())],
            Ready::AltScreen {
                timeout: Duration::from_secs(10),
            },
        )
    }

    #[test]
    fn the_opening_prompt_is_a_positional_argument_and_not_a_flag() {
        // `codex [OPTIONS] [PROMPT]` — *optional user prompt to start the
        // session*. There is no `--prompt` and nothing is written to the child's
        // stdin after the fact, which is why this contract has no inject-prompt
        // operation to leave unimplemented.
        for platform in [Platform::Windows, Platform::Unix] {
            let launch = Codex.plan(&context_for(platform, PROMPT)).unwrap();
            let argv = launch.argv();

            assert_eq!(argv.len(), 2, "{platform:?} planned {argv:?}");
            assert_eq!(argv[0], OsString::from(program_for(platform)));
            assert_eq!(argv[1], OsString::from(PROMPT));

            // And no `-C`, though Codex is the only surveyed CLI that has one:
            // the child's directory is a spawn parameter, and an adapter that
            // set it in argv could disagree with the process it is set on.
            assert!(!argv.iter().any(|element| element == OsStr::new("-C")
                || element == OsStr::new("--cd")
                || element == OsStr::new("/work/perseverance")));
        }
    }

    #[test]
    fn the_plan_for_windows_and_the_plan_for_unix_differ_in_nothing_but_the_program() {
        // Both goldens, asserted whole, from one host. That is what handing the
        // platform in buys: a `cfg!` inside `plan` would leave one of these two
        // arms dead on every machine that ever ran it.
        for platform in [Platform::Windows, Platform::Unix] {
            assert_eq!(
                Codex.plan(&context_for(platform, PROMPT)),
                Ok(golden_for(platform)),
                "the plan for {platform:?} is not the one written down"
            );
        }

        let windows = Codex.plan(&context_for(Platform::Windows, PROMPT)).unwrap();
        let unix = Codex.plan(&context_for(Platform::Unix, PROMPT)).unwrap();

        assert_ne!(windows.argv()[0], unix.argv()[0]);
        assert_eq!(windows.argv()[1..], unix.argv()[1..]);
        assert_eq!(windows.env_remove(), unix.env_remove());
        assert_eq!(windows.env_add(), unix.env_add());
        assert_eq!(windows.ready(), unix.ready());
    }

    #[test]
    fn a_session_this_harness_starts_still_writes_the_session_record_codex_would_have_written() {
        // The empty scrub set, asserted as a value rather than left to be read
        // as an omission: nothing this adapter does can stop a Codex session
        // record being written, because there is no variable in the evidence
        // that suppresses one.
        for platform in [Platform::Windows, Platform::Unix] {
            let cx = context_for(platform, PROMPT);
            let launch = Codex.plan(&cx).unwrap();

            assert_eq!(launch.env_remove(), [] as [&str; 0]);

            // `CODEX_HOME` is in the harvest, and it is the one a harness would
            // reach for. It relocates `auth.json` and the sessions directory
            // together, so it is left exactly as the operator set it — both
            // directions, scrub and inject.
            assert_eq!(cx.var("CODEX_HOME"), Some(&b"/Users/ahmet/.codex-work"[..]));
            assert!(!launch.env_remove().contains(&"CODEX_HOME"));
            assert!(!launch
                .env_add()
                .iter()
                .any(|(name, _)| name == "CODEX_HOME"));

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
        let launch = Codex.plan(&context_for(Platform::Unix, PROMPT)).unwrap();

        let Ready::AltScreen { timeout } = launch.ready() else {
            panic!("the alternate screen is codex's default; it does not merely go quiet");
        };
        // Claude's number, reused and unmeasured. What an expiry diagnoses for
        // this adapter is a trust decision that went the quiet way: Codex's
        // untrusted-folder failure is *silent* — project-local config ignored —
        // where Pi's is a blocking modal. #50 owns the diagnosis.
        assert_eq!(timeout, Duration::from_secs(10));

        // Declared, and not implemented: the adapter neither runs the clock nor
        // watches for the sequence.
        assert_eq!(
            Codex.watch().classify(b"\x1b[?1049h"),
            None::<Signal>,
            "every shipped adapter classifies nothing, so nothing downstream may \
             branch on whether an adapter does"
        );
    }

    #[test]
    fn a_prompt_with_a_nul_in_it_is_refused_while_planning_and_not_while_spawning() {
        for platform in [Platform::Windows, Platform::Unix] {
            assert_eq!(
                Codex.plan(&context_for(platform, "open the\0map")),
                Err(PlanError::PromptHasNul { id: AgentId::Codex })
            );
        }
    }

    #[test]
    fn an_empty_prompt_is_refused_rather_than_opening_a_session_with_nothing_to_do() {
        for platform in [Platform::Windows, Platform::Unix] {
            assert_eq!(
                Codex.plan(&context_for(platform, "")),
                Err(PlanError::PromptIsEmpty { id: AgentId::Codex })
            );
        }
    }

    #[test]
    fn the_only_name_codex_is_looked_for_under_is_the_one_every_installer_agrees_on() {
        let discovery = Codex.discovery();

        assert_eq!(discovery.candidates, ["codex"]);
        // The interpreter is asked about on both platforms, because the
        // `#!/usr/bin/env node` entry point is the universal shape and not a
        // Windows artifact — and it is one probe, the same one, on each.
        assert_eq!(
            discovery.probes.on(Platform::Unix),
            [Probe {
                program: "node",
                args: &["--version"],
            }]
        );
        assert_eq!(
            discovery.probes.on(Platform::Windows),
            discovery.probes.on(Platform::Unix)
        );
        assert_eq!(Codex.id(), AgentId::Codex);
    }

    #[test]
    fn the_platform_this_build_runs_on_is_one_a_plan_can_be_made_for() {
        // The drift guard. Every golden above is written against a `Platform`
        // parameter, so this one line is what keeps that parameter attached to
        // the machine the harness will really spawn on.
        assert!(Codex.plan(&context_for(Platform::host(), PROMPT)).is_ok());
    }
}

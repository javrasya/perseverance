use std::ffi::OsString;
use std::time::Duration;

use crate::agent::{Agent, Discovery, Probe, Probes};
use crate::launch::{Launch, LaunchContext, PlanError, Ready};
use crate::registry::AgentId;

/// The interpreter, on both platforms. Issue #21 read `pi` on macOS as a symlink
/// to `.../pi-coding-agent/dist/cli.js` behind `#!/usr/bin/env node`, which is
/// the whole of *pi is `node cli.js`*.
static NODE: &[Probe] = &[Probe {
    program: "node",
    args: &["--version"],
}];

/// The interpreter, **and the shell one of pi's own tools needs**, on Windows.
///
/// Pi requires a bash shell on Windows; without one its `bash` tool fails at
/// *runtime* rather than at startup, which is the dangerous half. Declared as
/// the bare name resolved against the folder's own harvested `PATH`, and never
/// as the install directory the vendor's docs list — a hardcoded install
/// directory is what `docs/adr/0011` and
/// `scripts/check-no-install-probing.mjs` refuse.
static NODE_AND_BASH: &[Probe] = &[
    Probe {
        program: "node",
        args: &["--version"],
    },
    Probe {
        program: "bash",
        args: &["--version"],
    },
];

/// The first adapter in this tree whose probes genuinely differ by platform,
/// which is what [`Probes`]'s two fields were built for and had no producer for
/// until now.
///
/// The Windows extra is a *probe* and not a [`PlanError::NotOnThisPlatform`]:
/// pi does run on Windows, it merely needs bash for one tool. So the requirement
/// is made inspectable in the per-folder readout — ADR 0011's posture throughout
/// — rather than turned into a plan-time refusal that would also make a Windows
/// golden unwritable.
const NODE_AND_ON_WINDOWS_BASH: Probes = Probes {
    windows: NODE_AND_BASH,
    unix: NODE,
};

/// The one name, observed twice: `npm ls -g` names
/// `@earendil-works/pi-coding-agent` v0.83.0 on Windows, and #21 read the same
/// package on macOS as a symlink into its own `dist/`.
///
/// No `pi.exe`, for the resolver's reason, and no search paths of any kind.
///
/// `pi` is a short name and collides with unrelated binaries more readily than
/// `claude` or `codex` do, and a candidate list cannot disambiguate. The only
/// place an operator sees *which* `pi` resolved is the absolute path in #45's
/// per-folder readout — which is an argument for keeping that row prominent
/// rather than for inventing a second candidate.
static DISCOVERY: Discovery = Discovery {
    candidates: &["pi"],
    probes: NODE_AND_ON_WINDOWS_BASH,
};

/// Three names, and every one of them is a statement about a session that is
/// **not this one**.
///
/// `PI_CODING_AGENT` is set on every child process and is documented as the
/// clean way for a harness-invoked script to detect it is inside pi —
/// structurally the same object as `CLAUDE_CODE_CHILD_SESSION`, and reachable in
/// exactly the way that matters here, because a harness launched from inside
/// pi's own bash tool carries it. `PI_SESSION_ID` and `PI_SESSION_FILE` are
/// worse than a flag: they are a pointer at the *parent's* transcript, and a
/// child inheriting one is the misfiling this ticket calls harm to the
/// operator's own history.
///
/// Whether pi *reads* any of the three at startup is undocumented — the shipped
/// docs say only that pi *sets* them for children. So this scrub set is
/// inference where Claude's is measurement, and the direction is chosen because
/// it cannot be wrong: none of the three is operator configuration, and no
/// operator sets `PI_SESSION_FILE` by hand.
///
/// **The not-scrubbed half is the more important one**, and it is deliberately
/// one underscore away. `PI_CODING_AGENT_SESSION_DIR` is the operator's chosen
/// session directory, so scrubbing it would send their transcripts back to the
/// default and misfile this run — the exact harm the scrub set exists to
/// prevent, committed by the mechanism meant to prevent it.
/// `PI_CODING_AGENT_DIR` relocates the whole config directory *including
/// `auth.json`*, so scrubbing it would start the child unauthenticated and paint
/// a login flow into the PTY. `PI_PROVIDER`, `PI_MODEL` and `PI_REASONING_LEVEL`
/// are left alone too, despite being parent-session facts: unlike a session-file
/// pointer they are plausibly things an operator exports as their own defaults,
/// and scrubbing something an operator may have set is the failure this ticket
/// exists to prevent. The line is: scrub a pointer at another session, leave
/// anything that could be a preference.
const A_SESSION_THAT_IS_NOT_THIS_ONE: &[&str] =
    &["PI_CODING_AGENT", "PI_SESSION_ID", "PI_SESSION_FILE"];

/// The terminal type, stated rather than forwarded, and the same value every
/// other adapter states. It is a fact about the PTY the harness presents, not
/// about the vendor, which is why it must not vary by adapter.
const TERM_NAME: &str = "TERM";
const TERM_VALUE: &str = "xterm-256color";

/// Readiness, declared and not implemented — and on weaker evidence than the
/// other two.
///
/// Pi is recorded as a full TUI, and the alternate screen is **inferred from
/// that rather than observed**; no sequence was ever measured for it. The ten
/// seconds is Claude's constant reused, as it is for Codex.
///
/// The expiry does double duty here, because Pi's documented hazard is exactly
/// the one an expiry diagnoses: on interactive startup pi asks before trusting a
/// project folder, and the harness spawns into a fresh worktree per ticket, so
/// that modal fires on a real first run rather than hypothetically. We still do
/// not pass `--approve` or `--no-approve` — the equivalent was declined for
/// Claude as a policy this ticket did not decide, and turning the stall into a
/// diagnosis is #50's.
const READY: Ready = Ready::AltScreen {
    timeout: Duration::from_secs(10),
};

/// The Pi adapter.
///
/// A zero-sized type, like every other, and it takes the default
/// [`Agent::watch`]. Pi was the obvious candidate for a real `Watch` producer
/// and deliberately is not one: v1 cuts the whole out-of-band tier, and a live
/// signal can only ever mean *poll GitHub sooner*.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Pi;

impl Agent for Pi {
    fn id(&self) -> AgentId {
        AgentId::Pi
    }

    fn discovery(&self) -> &Discovery {
        &DISCOVERY
    }

    /// Two elements, and the second is the opening prompt — the same shape as
    /// the other two adapters.
    ///
    /// `pi [options] [@files...] [messages...]`, and the help's own example is
    /// labelled *interactive mode with initial prompt*.
    ///
    /// **One positional and not several.** `pi "a" "b"` is accepted and labelled
    /// *multiple messages*, but whether those arrive as successive turns or as
    /// one concatenated message is unknown and flagged in the research as
    /// needing an empirical test. An adapter is not the place to bet on it.
    ///
    /// **No `@file`.** Semantics travel inline, never by pointer: the `@ticket.md`
    /// splice is the pointer form, an absolute application-data path is exactly
    /// what a sandboxed agent refuses, and the refusal arrives as a mid-run
    /// permission prompt rather than as a clean error. The prose is already one
    /// rendered `&str` in the [`LaunchContext`] and it goes in as one argv
    /// element.
    ///
    /// No `--cd`, because pi has none and the harness sets the child's directory
    /// at spawn anyway — load-bearing for pi beyond tool access, since its
    /// session storage is keyed off cwd. No `--approve`, no `--offline`, no
    /// `--session-dir`.
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
            A_SESSION_THAT_IS_NOT_THIS_ONE,
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
        // The three a harness launched from inside pi's own bash tool carries,
        // and this project's whole workflow is agents running commands.
        ("PI_CODING_AGENT", b"true"),
        ("PI_SESSION_ID", b"01JQ7"),
        ("PI_SESSION_FILE", b"/Users/ahmet/.pi/sessions/01JQ7.jsonl"),
        // One underscore away from two of them, and the operator's own choice.
        ("PI_CODING_AGENT_SESSION_DIR", b"/Users/ahmet/work/.pi"),
        ("PI_CODING_AGENT_DIR", b"/Users/ahmet/.pi-work"),
        ("PI_MODEL", b"a-model-the-operator-picked"),
        ("TERM", b"dumb"),
    ];

    const PROMPT: &str = "/perseverance work the frontier";

    /// An npm shim on Windows and the interpreter-pinned entry point on unix,
    /// because that is what a `PATH` walk finds for the way this was installed
    /// on both measured machines. `perseverance_pty::accept` refuses the first
    /// as `SpawnRefusal::BatchShim` and the second — `#!/usr/bin/env node`
    /// script text — as `SpawnRefusal::ScriptShim`. The plan is still the plan:
    /// the refusal belongs to the boundary, and #45's argv override is the
    /// operator's answer.
    const WINDOWS_PROGRAM: &str = r"C:\Users\ahmet\npm-global\pi.cmd";
    const UNIX_PROGRAM: &str = "/Users/ahmet/.fnm/node-versions/v24.15.0/installation/bin/pi";

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
    /// test.
    fn golden_for(platform: Platform) -> Launch {
        Launch::new(
            vec![
                OsString::from(program_for(platform)),
                OsString::from(PROMPT),
            ],
            &["PI_CODING_AGENT", "PI_SESSION_ID", "PI_SESSION_FILE"],
            vec![("TERM".to_string(), "xterm-256color".to_string())],
            Ready::AltScreen {
                timeout: Duration::from_secs(10),
            },
        )
    }

    #[test]
    fn the_opening_prompt_is_one_positional_argument_and_never_a_file_to_point_at() {
        // `pi [options] [@files...] [messages...]`, and one message rather than
        // several: multi-message delivery semantics are unknown and an adapter
        // is not the place to bet on them.
        for platform in [Platform::Windows, Platform::Unix] {
            let launch = Pi.plan(&context_for(platform, PROMPT)).unwrap();
            let argv = launch.argv();

            assert_eq!(argv.len(), 2, "{platform:?} planned {argv:?}");
            assert_eq!(argv[0], OsString::from(program_for(platform)));
            assert_eq!(argv[1], OsString::from(PROMPT));

            // Semantics travel inline, never by pointer. Nothing in argv is an
            // `@file` splice, so nothing the agent has to go and read stands
            // between the prose and the session.
            assert!(
                !argv[1..]
                    .iter()
                    .any(|element| element.to_string_lossy().starts_with('@')),
                "{platform:?} planned a pointer where the prose should have been"
            );
        }
    }

    #[test]
    fn the_plan_for_windows_and_the_plan_for_unix_differ_in_nothing_but_the_program() {
        for platform in [Platform::Windows, Platform::Unix] {
            assert_eq!(
                Pi.plan(&context_for(platform, PROMPT)),
                Ok(golden_for(platform)),
                "the plan for {platform:?} is not the one written down"
            );
        }

        // The probes differ by platform for this adapter and the *plan* still
        // does not, which is the distinction worth pinning: what is inspected
        // about a folder is a platform's business, and what is run is not.
        let windows = Pi.plan(&context_for(Platform::Windows, PROMPT)).unwrap();
        let unix = Pi.plan(&context_for(Platform::Unix, PROMPT)).unwrap();

        assert_ne!(windows.argv()[0], unix.argv()[0]);
        assert_eq!(windows.argv()[1..], unix.argv()[1..]);
        assert_eq!(windows.env_remove(), unix.env_remove());
        assert_eq!(windows.env_add(), unix.env_add());
        assert_eq!(windows.ready(), unix.ready());
    }

    #[test]
    fn a_session_this_harness_starts_inherits_no_pointer_at_another_sessions_transcript() {
        for platform in [Platform::Windows, Platform::Unix] {
            let cx = context_for(platform, PROMPT);
            // All three are in the context — this is a harness launched from
            // inside pi's own bash tool — and the plan scrubs them rather than
            // reading them.
            assert_eq!(cx.var("PI_CODING_AGENT"), Some(&b"true"[..]));
            assert_eq!(
                cx.var("PI_SESSION_FILE"),
                Some(&b"/Users/ahmet/.pi/sessions/01JQ7.jsonl"[..])
            );

            let launch = Pi.plan(&cx).unwrap();
            assert_eq!(
                launch.env_remove(),
                ["PI_CODING_AGENT", "PI_SESSION_ID", "PI_SESSION_FILE"]
            );

            // And the sharp contrast, one underscore away: where this run's own
            // history is kept is the operator's, and scrubbing it would misfile
            // exactly what the three names above protect. `..._DIR` also holds
            // `auth.json`, so scrubbing it would start the child unauthenticated
            // as well.
            for theirs in [
                "PI_CODING_AGENT_SESSION_DIR",
                "PI_CODING_AGENT_DIR",
                "PI_MODEL",
            ] {
                assert!(
                    !launch.env_remove().contains(&theirs),
                    "{theirs} is the operator's own setting and the harness took it away"
                );
                assert!(!launch.env_add().iter().any(|(name, _)| name == theirs));
            }

            assert_eq!(cx.var("TERM"), Some(&b"dumb"[..]));
            assert_eq!(
                launch.env_add(),
                [("TERM".to_string(), "xterm-256color".to_string())]
            );
        }
    }

    #[test]
    fn readiness_is_declared_as_the_alternate_screen_and_its_expiry_is_a_diagnosis() {
        let launch = Pi.plan(&context_for(Platform::Unix, PROMPT)).unwrap();

        let Ready::AltScreen { timeout } = launch.ready() else {
            panic!("pi settles into a full TUI; it does not merely go quiet");
        };
        // Inferred from *full TUI* rather than observed, and the ten seconds is
        // Claude's number reused. Pi is nonetheless the adapter most likely to
        // trip it: its untrusted-folder failure is a blocking modal where
        // Codex's is silent, and the harness opens a fresh worktree per ticket.
        assert_eq!(timeout, Duration::from_secs(10));

        assert_eq!(
            Pi.watch().classify(b"\x1b[?1049h"),
            None::<Signal>,
            "every shipped adapter classifies nothing, so nothing downstream may \
             branch on whether an adapter does"
        );
    }

    #[test]
    fn a_prompt_with_a_nul_in_it_is_refused_while_planning_and_not_while_spawning() {
        for platform in [Platform::Windows, Platform::Unix] {
            assert_eq!(
                Pi.plan(&context_for(platform, "open the\0map")),
                Err(PlanError::PromptHasNul { id: AgentId::Pi })
            );
        }
    }

    #[test]
    fn an_empty_prompt_is_refused_rather_than_opening_a_session_with_nothing_to_do() {
        for platform in [Platform::Windows, Platform::Unix] {
            assert_eq!(
                Pi.plan(&context_for(platform, "")),
                Err(PlanError::PromptIsEmpty { id: AgentId::Pi })
            );
        }
    }

    #[test]
    fn windows_is_asked_about_the_shell_one_of_pis_own_tools_needs_and_unix_is_not() {
        let discovery = Pi.discovery();

        assert_eq!(discovery.candidates, ["pi"]);
        assert_eq!(
            discovery.probes.on(Platform::Unix),
            [Probe {
                program: "node",
                args: &["--version"],
            }]
        );
        // The first genuinely per-platform declaration in the tree. Windows is
        // asked about `bash` because pi's `bash` tool fails at runtime without
        // one — not at startup, which is what makes it worth a readout line
        // rather than a plan-time refusal.
        assert_eq!(
            discovery.probes.on(Platform::Windows),
            [
                Probe {
                    program: "node",
                    args: &["--version"],
                },
                Probe {
                    program: "bash",
                    args: &["--version"],
                }
            ]
        );
        assert_ne!(
            discovery.probes.on(Platform::Windows),
            discovery.probes.on(Platform::Unix)
        );
        // The bare name, resolved against the folder's own `PATH` — never the
        // install directory the vendor's docs list.
        assert!(discovery
            .probes
            .on(Platform::Windows)
            .iter()
            .all(|probe| !probe.program.contains('\\') && !probe.program.contains('/')));
        assert_eq!(Pi.id(), AgentId::Pi);
    }

    #[test]
    fn the_platform_this_build_runs_on_is_one_a_plan_can_be_made_for() {
        assert!(Pi.plan(&context_for(Platform::host(), PROMPT)).is_ok());
    }
}

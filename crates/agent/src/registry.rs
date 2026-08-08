use std::fmt;

use crate::agent::Agent;
use crate::claude::ClaudeCode;
use crate::codex::Codex;
use crate::pi::Pi;

/// Every adapter this build has.
///
/// A closed enum rather than a registration call, because the set of adapters
/// is a fact about the binary and not about the order modules happened to
/// initialise in. Adding one is a variant here, an entry in [`ALL`], a match
/// arm in [`as_str`], a match arm in [`agent`], and a golden-argv test. The
/// match arms stop compiling by themselves; [`ALL`] is a list and would not, so
/// a test below matches over it without a wildcard and pins its length. That is
/// not a proof that the list covers the enum — stable Rust with no dependencies
/// has none to offer — but it does mean no variant is added, and no entry of
/// the list changed, without the build stopping in that test.
///
/// **What an adapter actually costs**, measured by adding two of them at #46 and
/// written down here so nobody has to measure it again. **Two files besides the
/// new one:** one new file in this directory, one `mod` and one `pub use` in
/// `lib.rs`, and here a variant, an [`ALL`] entry, an [`as_str`] arm, an
/// [`agent`] arm and a `static`. Every one of those but the `pub use` and the
/// [`ALL`] entry is a compile error **naming the thing that is missing**; the
/// [`ALL`] entry is caught by the wildcard-free match in this file's tests,
/// which the compiler names on the day a variant appears.
///
/// `crates/app`'s purity scan used to be a third file, and #46 removed it: it
/// held a hand-written list of this directory's files, and it now reads the
/// directory. A list of the haystack was never registration — it was a second
/// place to forget the same file.
///
/// **#46's criterion 1 said *one file, one variant, one match arm*, and that is
/// not what this costs.** It was already untrue of #44 as shipped, which had two
/// wildcard-free matches, a hand-written [`ALL`] and a `static` per adapter. The
/// measured cost above is the amendment `docs/adr/0012` proposes and it is
/// **not ratified**; the criterion should be closed as amended or the shape
/// changed deliberately, not recorded as met. `docs/adr/0012` also records why
/// the `macro_rules!` table that would collapse this to one line was rejected:
/// it would buy prose fidelity at the cost of the property `docs/adr/0010` paid
/// for, that forgetting an arm is a compile error naming one function.
///
/// Config-defined adapters are deferred, not refused: a later ticket can hang
/// an `AgentId::Configured(..)` off this enum without any of the shipped
/// adapters noticing. What is refused is a *registry* whose contents are not
/// knowable at compile time.
///
/// [`agent`]: crate::agent()
/// [`ALL`]: AgentId::ALL
/// [`as_str`]: AgentId::as_str
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AgentId {
    ClaudeCode,
    Codex,
    Pi,
}

impl AgentId {
    /// Every variant, so a cross-adapter guard is a loop rather than a list
    /// someone has to remember to extend.
    ///
    /// Hand-written, so unlike the matches beside it nothing here stops
    /// compiling when a variant appears: one absent from this list is skipped
    /// by every guard that loops over it, and makes [`from_wire`] answer `None`
    /// for an adapter this build does have. Checking a list against an enum
    /// needs reflection or a derive and this crate has neither, so the test
    /// below settles for the next thing — a wildcard-free match the compiler
    /// names the day a variant appears, and a pinned length — and neither this
    /// list nor that match can move without the build stopping there.
    ///
    /// [`from_wire`]: AgentId::from_wire
    pub const ALL: &'static [AgentId] = &[AgentId::ClaudeCode, AgentId::Codex, AgentId::Pi];

    /// The spelling that is already on disk.
    ///
    /// Fixed by data rather than taste: `folders.adapter` holds `'claude'`
    /// (`crates/store/src/schema.rs`, `crates/store/src/folders.rs`), the
    /// `default_adapter` app key holds `"claude"`
    /// (`crates/store/src/store.rs`), and the same string already crosses to
    /// the WebView in `src/launcher/launcher.ts`. A registry that spelled it
    /// differently would be a migration, and #44 is not one.
    ///
    /// The two spellings #46 added are the names the programs are invoked
    /// under, for the same reason: nothing else is on disk for them yet, so the
    /// name an operator would type is the one that gets written down.
    pub const fn as_str(self) -> &'static str {
        match self {
            AgentId::ClaudeCode => "claude",
            AgentId::Codex => "codex",
            AgentId::Pi => "pi",
        }
    }

    /// The inverse, for a string that came off the registry or off the wire.
    ///
    /// `None` rather than a default. A folder row naming an adapter this build
    /// does not have is a thing the caller must decide about; quietly starting
    /// a different agent than the one that was written down is the one answer
    /// that must not be available here.
    pub fn from_wire(name: &str) -> Option<AgentId> {
        AgentId::ALL.iter().copied().find(|id| id.as_str() == name)
    }
}

impl fmt::Display for AgentId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// One `static` per adapter, for the life of the process.
///
/// An adapter is a zero-sized type with no state — everything it plans from
/// arrives in a `LaunchContext` — so a `static` costs nothing and is why
/// [`agent`] can hand back `&'static dyn Agent` rather than allocating a box
/// per lookup.
static CLAUDE_CODE: ClaudeCode = ClaudeCode;
static CODEX: Codex = Codex;
static PI: Pi = Pi;

/// The lookup: one match arm per variant, and no wildcard.
///
/// That is the whole of the registration mechanism. Adding an adapter is a
/// variant above, an arm here, and a golden-argv test — and forgetting the arm
/// is a compile error naming this function, rather than an adapter that exists
/// and is unreachable.
pub fn agent(id: AgentId) -> &'static dyn Agent {
    match id {
        AgentId::ClaudeCode => &CLAUDE_CODE,
        AgentId::Codex => &CODEX,
        AgentId::Pi => &PI,
    }
}

/// The same lookup for a name that came off the registry or off the wire.
///
/// `None` rather than a default, for [`AgentId::from_wire`]'s reason: a folder
/// row naming an adapter this build does not have is the caller's to decide
/// about, and quietly starting a different agent than the one written down is
/// the one answer that must not be available.
pub fn agent_named(name: &str) -> Option<&'static dyn Agent> {
    AgentId::from_wire(name).map(agent)
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::ffi::OsStr;

    use crate::launch::LaunchContext;
    use crate::platform::Platform;

    /// Everything any adapter in the tree scrubs is in here, so a guard that
    /// checks *what was taken away* is checking against a context that had it.
    const ENVIRONMENT: &[(&str, &[u8])] = &[
        ("PATH", b"/usr/local/bin:/usr/bin"),
        ("CLAUDE_CODE_CHILD_SESSION", b"1"),
        ("PI_CODING_AGENT", b"true"),
        ("PI_SESSION_ID", b"01JQ7"),
        (
            "PI_SESSION_FILE",
            b"/Users/operator/.pi/sessions/01JQ7.jsonl",
        ),
        // The four places the three adapters keep what they wrote down, all
        // relocated by the operator, and none of them touched by anyone.
        ("CLAUDE_CONFIG_DIR", b"/Users/operator/work/.claude"),
        ("CODEX_HOME", b"/Users/operator/work/.codex"),
        ("PI_CODING_AGENT_DIR", b"/Users/operator/work/.pi"),
        ("PI_CODING_AGENT_SESSION_DIR", b"/Users/operator/work/.pi/s"),
    ];

    /// The one prompt every adapter is asked to plan from, so the guard that
    /// compares argv across adapters has something to compare.
    const PROMPT: &str = "work the frontier";

    /// Every plan every adapter in the build would make for one platform, from
    /// **one context**.
    ///
    /// A loop over [`AgentId::ALL`] rather than a list, so an adapter added
    /// later inherits the guards below by reaching that one list — and
    /// [`a_variant_the_compiler_accepts_is_still_a_variant_the_guards_have_to_loop_over`]
    /// is what stops the build in this file on the day there is a variant to
    /// add to it.
    ///
    /// The program is deliberately one name for all three rather than each
    /// adapter's own. Resolution is the harness's, an adapter is handed whatever
    /// it resolved to, and
    /// [`the_prompt_that_reaches_the_agent_is_the_same_text_for_every_adapter`]
    /// depends on the three plans being comparable element by element.
    fn every_plan(platform: Platform) -> Vec<(AgentId, crate::launch::Launch)> {
        let program = match platform {
            Platform::Windows => OsStr::new(r"C:\Users\operator\bin\the-agent.exe"),
            Platform::Unix => OsStr::new("/Users/operator/bin/the-agent"),
        };
        let cx = LaunchContext::new(
            platform,
            program,
            OsStr::new("/work/perseverance"),
            PROMPT,
            ENVIRONMENT,
        );

        AgentId::ALL
            .iter()
            .copied()
            .filter_map(|id| agent(id).plan(&cx).ok().map(|launch| (id, launch)))
            .collect()
    }

    /// **The list every guard loops over is checked against the enum itself.**
    ///
    /// Adding a variant stops [`AgentId::as_str`] and [`agent`] compiling by
    /// themselves, because both are wildcard-free matches. #46 added two and
    /// that is exactly what happened.
    /// [`AgentId::ALL`] is a list and would have said nothing: a variant
    /// missing from it is skipped by every guard below that loops over it,
    /// while [`AgentId::from_wire`] answers `None` for an adapter the build
    /// has — the failure mode `ALL`'s own doc comment says cannot happen.
    ///
    /// So there are two halves here, and what they buy is a forced stop rather
    /// than a proof. The wildcard-free match is the same idiom `watch.rs` uses
    /// on `Signal`, and it is a third thing the compiler names the day a
    /// variant appears — in this file, next to the list. The pinned length is
    /// what fails the day `ALL` itself changes size, so the list cannot be
    /// edited without this count being read either.
    ///
    /// Neither half can check that the list covers the enum. That needs
    /// reflection or a derive; `crates/agent` has no dependencies and stable
    /// Rust cannot count an enum's variants, so this is deliberately the
    /// weaker claim: nobody adds a variant, and nobody edits `ALL`, without
    /// arriving here.
    #[test]
    fn a_variant_the_compiler_accepts_is_still_a_variant_the_guards_have_to_loop_over() {
        // One arm per variant, no wildcard — and the arm you are made to write
        // is the reminder that the same variant belongs in `AgentId::ALL`.
        for id in AgentId::ALL.iter().copied() {
            match id {
                AgentId::ClaudeCode => {}
                AgentId::Codex => {}
                AgentId::Pi => {}
            }
        }

        assert_eq!(
            AgentId::ALL.len(),
            3,
            "AgentId::ALL changed size: every cross-adapter guard here loops over it, so what \
             is in it is what is guarded and what is missing is what from_wire refuses"
        );
    }

    #[test]
    fn the_wire_spelling_of_an_adapter_is_the_one_already_written_into_the_folder_row() {
        // `crates/store/src/schema.rs` inserts `'claude'` into `folders.adapter`
        // and `crates/store/src/store.rs` writes `"claude"` under
        // `default_adapter`. This crate does not get to pick a nicer name for
        // something already sitting in the operator's registry.
        assert_eq!(AgentId::ClaudeCode.as_str(), "claude");
        assert_eq!(AgentId::ClaudeCode.to_string(), "claude");
        // Nothing is on disk for these two yet, so the spelling is the name the
        // program is invoked under — the one an operator would type.
        assert_eq!(AgentId::Codex.as_str(), "codex");
        assert_eq!(AgentId::Pi.as_str(), "pi");
    }

    #[test]
    fn every_adapter_id_round_trips_through_the_string_the_store_keeps() {
        for id in AgentId::ALL.iter().copied() {
            assert_eq!(AgentId::from_wire(id.as_str()), Some(id));
        }
    }

    #[test]
    fn a_name_the_registry_does_not_know_resolves_to_nothing_rather_than_to_a_default() {
        // `codex` and `pi` came out of this table at #46, because the build now
        // has them. What replaced them keeps the same two claims tested: the
        // lookup is case-sensitive, and it does not trim.
        for unknown in [
            "",
            "Claude",
            "claude-code",
            "Codex",
            "codex-cli",
            "pi-coding-agent",
            " pi",
            " claude",
        ] {
            assert_eq!(
                AgentId::from_wire(unknown),
                None,
                "{unknown} resolved to an adapter, so a folder row naming an \
                 agent this build does not have would silently start another"
            );
            assert!(agent_named(unknown).is_none());
        }
    }

    #[test]
    fn the_lookup_hands_back_an_adapter_that_answers_with_the_id_it_was_asked_for() {
        for id in AgentId::ALL.iter().copied() {
            // The one thing a match arm can get wrong is pointing at the wrong
            // adapter, and it is the one thing the compiler cannot catch.
            assert_eq!(agent(id).id(), id);
            assert_eq!(agent_named(id.as_str()).map(Agent::id), Some(id));

            // Discovery is a declaration, so an adapter with no name to look
            // for could never be found at all.
            assert!(!agent(id).discovery().candidates.is_empty());
        }
    }

    #[test]
    fn no_adapter_spells_a_candidate_with_an_extension_the_resolver_appends_itself() {
        // Hoisted out of `claude.rs` at #46, because it was never a fact about
        // one adapter: on Windows `Environment::spellings` tries the bare name
        // and then each `PATHEXT` suffix, so a candidate spelled `codex.exe`
        // would be this crate re-implementing that badly — and would miss the
        // `.cmd` an npm install actually leaves.
        for id in AgentId::ALL.iter().copied() {
            for candidate in agent(id).discovery().candidates {
                assert!(
                    !candidate.contains('.'),
                    "{id} looks for {candidate}, and appending PATHEXT is the resolver's job"
                );
            }
        }
    }

    #[test]
    fn nothing_any_adapter_does_can_change_which_powershell_profile_loads() {
        // A launch that reset `USERPROFILE` or `HOME` would move the profile
        // PowerShell sources, the config an agent reads, and the credentials
        // `gh` finds — all three at once, and none of them visibly. Per-run
        // configuration being argv and environment is only safe while the
        // environment delta is additive in the shallow sense: it may say what
        // this run is, never where the operator lives.
        //
        // **Both halves, and the second one is #46's.** `crates/env/src/shell.rs`
        // is explicit that PowerShell 5.1 derives `$PROFILE` from these four
        // rather than from the registry, so *scrubbing* one of them loads a
        // different profile, or none — exactly as overriding it does. This guard
        // used to read `env_add` alone, and a scrub set containing `HOME` would
        // have passed every test in the tree.
        const HOMES: [&str; 4] = ["USERPROFILE", "HOME", "HOMEDRIVE", "HOMEPATH"];

        for platform in [Platform::Windows, Platform::Unix] {
            for (id, launch) in every_plan(platform) {
                for (name, value) in launch.env_add() {
                    assert!(
                        !HOMES.iter().any(|home| name.eq_ignore_ascii_case(home)),
                        "{id} sets {name}={value} on {platform:?}, which moves where the \
                         operator's profile, config and credentials are read from"
                    );
                }
                for name in launch.env_remove() {
                    assert!(
                        !HOMES.iter().any(|home| name.eq_ignore_ascii_case(home)),
                        "{id} scrubs {name} on {platform:?}, and an absent one of these four \
                         loads a different profile, or none — the same harm as setting it"
                    );
                }
            }
        }
    }

    #[test]
    fn no_adapter_scrubs_the_place_its_own_history_is_kept() {
        // Criterion 3, as a loop, and it names *variables* rather than adapters
        // so that no call site and no test here branches on adapter identity.
        //
        // Each of these relocates one agent's whole state directory — and in
        // three of the four cases `auth.json` moves with it, so a scrub would
        // both misfile the transcript and start the child unauthenticated. An
        // operator who set one of them chose where their history goes; running
        // an agent under this harness must not silently send it somewhere else,
        // which is the same harm the scrub sets exist to prevent, committed by
        // the mechanism meant to prevent it.
        const WHERE_THE_OPERATOR_KEEPS_THEIR_HISTORY: [&str; 4] = [
            "CLAUDE_CONFIG_DIR",
            "CODEX_HOME",
            "PI_CODING_AGENT_DIR",
            "PI_CODING_AGENT_SESSION_DIR",
        ];

        for platform in [Platform::Windows, Platform::Unix] {
            for (id, launch) in every_plan(platform) {
                for kept in WHERE_THE_OPERATOR_KEEPS_THEIR_HISTORY {
                    assert!(
                        !launch.env_remove().contains(&kept),
                        "{id} scrubs {kept} on {platform:?}, so a run under this harness would \
                         write its session record somewhere the operator did not choose"
                    );
                    assert!(
                        !launch.env_add().iter().any(|(name, _)| name == kept),
                        "{id} sets {kept} on {platform:?}, which relocates the operator's own \
                         state directory for the duration of a run"
                    );
                }
            }
        }
    }

    #[test]
    fn the_prompt_that_reaches_the_agent_is_the_same_text_for_every_adapter() {
        // Criterion 6, mechanically. One context, three plans, and the prose
        // arrives verbatim as exactly one argv element in each — not quoted, not
        // wrapped, not prefixed, and not written to a file and pointed at.
        // Semantics travel inline, never by pointer: an absolute
        // application-data path is what a sandboxed agent refuses, and it
        // refuses it as a mid-run permission prompt rather than as a clean
        // error.
        for platform in [Platform::Windows, Platform::Unix] {
            let planned = every_plan(platform);
            assert_eq!(
                planned.len(),
                AgentId::ALL.len(),
                "an adapter refused a plan every other adapter made on {platform:?}"
            );

            for (id, launch) in &planned {
                let carrying: Vec<&OsStr> = launch
                    .argv()
                    .iter()
                    .filter(|element| element.as_os_str() == OsStr::new(PROMPT))
                    .map(|element| element.as_os_str())
                    .collect();
                assert_eq!(
                    carrying.len(),
                    1,
                    "{id} does not carry the prompt exactly once on {platform:?}: {:?}",
                    launch.argv()
                );
            }

            // And what is *around* it is the same for all three, once the
            // program the harness resolved is set aside. Today that is nothing
            // at all; the day one adapter grows a flag the others do not have,
            // this is what says the product has taken a vendor's shape.
            let around: Vec<(AgentId, Vec<&OsStr>)> = planned
                .iter()
                .map(|(id, launch)| {
                    (
                        *id,
                        launch.argv()[1..]
                            .iter()
                            .filter(|element| element.as_os_str() != OsStr::new(PROMPT))
                            .map(|element| element.as_os_str())
                            .collect(),
                    )
                })
                .collect();
            for (id, arguments) in &around {
                assert_eq!(
                    arguments, &around[0].1,
                    "{id} plans arguments on {platform:?} that {} does not",
                    around[0].0
                );
            }
        }
    }

    #[test]
    fn the_terminal_every_adapter_asks_for_is_the_harness_s_and_not_the_vendor_s() {
        // `TERM` is stated rather than forwarded, and the same value everywhere:
        // the terminal type is a fact about the PTY *this harness* presents, and
        // a per-adapter one would be the product taking three vendors' shapes.
        // Forwarding instead would forward whatever launched the harness, which
        // on macOS is a launchd stub with no `TERM` at all.
        for platform in [Platform::Windows, Platform::Unix] {
            let stated: Vec<(AgentId, Option<String>)> = every_plan(platform)
                .iter()
                .map(|(id, launch)| {
                    (
                        *id,
                        launch
                            .env_add()
                            .iter()
                            .find(|(name, _)| name == "TERM")
                            .map(|(_, value)| value.clone()),
                    )
                })
                .collect();

            for (id, value) in &stated {
                assert_eq!(
                    value, &stated[0].1,
                    "{id} asks for a different terminal on {platform:?} than {} does",
                    stated[0].0
                );
            }
            assert_eq!(stated[0].1.as_deref(), Some("xterm-256color"));
        }
    }

    #[test]
    fn no_adapter_puts_a_shell_between_itself_and_the_program_it_planned() {
        // argv is an argument vector and not a command line. A shell in
        // `argv[0]` orphans the process tree on Windows exactly as the npm
        // batch shim does — `perseverance_pty::accept` refuses that at the
        // boundary — and a `&&` or a `;` anywhere in argv is an adapter having
        // decided to drive rather than to plan.
        const NOT_A_PROGRAM: [&str; 5] = ["&&", "|", ";", "cmd.exe", "powershell"];

        for platform in [Platform::Windows, Platform::Unix] {
            for (id, launch) in every_plan(platform) {
                assert!(
                    !launch.argv().is_empty(),
                    "{id} planned no program at all on {platform:?}"
                );

                for element in launch.argv() {
                    let lowered = element.to_string_lossy().to_ascii_lowercase();
                    for shell in NOT_A_PROGRAM {
                        assert!(
                            !lowered.contains(shell),
                            "{id} put {shell:?} into argv on {platform:?}, so the harness \
                             would be spawning a shell rather than the agent"
                        );
                    }
                }
            }
        }
    }
}

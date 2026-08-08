use std::fmt;

use crate::agent::Agent;
use crate::claude::ClaudeCode;

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
    pub const ALL: &'static [AgentId] = &[AgentId::ClaudeCode];

    /// The spelling that is already on disk.
    ///
    /// Fixed by data rather than taste: `folders.adapter` holds `'claude'`
    /// (`crates/store/src/schema.rs`, `crates/store/src/folders.rs`), the
    /// `default_adapter` app key holds `"claude"`
    /// (`crates/store/src/store.rs`), and the same string already crosses to
    /// the WebView in `src/launcher/launcher.ts`. A registry that spelled it
    /// differently would be a migration, and #44 is not one.
    pub const fn as_str(self) -> &'static str {
        match self {
            AgentId::ClaudeCode => "claude",
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

/// The lookup: one match arm per variant, and no wildcard.
///
/// That is the whole of the registration mechanism. Adding an adapter is a
/// variant above, an arm here, and a golden-argv test — and forgetting the arm
/// is a compile error naming this function, rather than an adapter that exists
/// and is unreachable.
pub fn agent(id: AgentId) -> &'static dyn Agent {
    match id {
        AgentId::ClaudeCode => &CLAUDE_CODE,
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

    const ENVIRONMENT: &[(&str, &[u8])] = &[("PATH", b"/usr/local/bin:/usr/bin")];

    /// Every plan every adapter in the build would make for one platform.
    ///
    /// A loop over [`AgentId::ALL`] rather than a list, so #46's two adapters
    /// inherit the guards below by reaching that one list — and
    /// [`a_variant_the_compiler_accepts_is_still_a_variant_the_guards_have_to_loop_over`]
    /// is what stops the build in this file on the day there is a variant to
    /// add to it.
    fn every_plan(platform: Platform) -> Vec<(AgentId, crate::launch::Launch)> {
        let program = match platform {
            Platform::Windows => OsStr::new(r"C:\Users\operator\.local\bin\claude.exe"),
            Platform::Unix => OsStr::new("/Users/operator/.local/bin/claude"),
        };
        let cx = LaunchContext::new(
            platform,
            program,
            OsStr::new("/work/perseverance"),
            "work the frontier",
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
    /// Adding `AgentId::Codex` stops [`AgentId::as_str`] and [`agent`]
    /// compiling by themselves, because both are wildcard-free matches.
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
            }
        }

        assert_eq!(
            AgentId::ALL.len(),
            1,
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
    }

    #[test]
    fn every_adapter_id_round_trips_through_the_string_the_store_keeps() {
        for id in AgentId::ALL.iter().copied() {
            assert_eq!(AgentId::from_wire(id.as_str()), Some(id));
        }
    }

    #[test]
    fn a_name_the_registry_does_not_know_resolves_to_nothing_rather_than_to_a_default() {
        for unknown in ["", "Claude", "claude-code", "codex", "pi", " claude"] {
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
    fn nothing_any_adapter_injects_can_change_which_powershell_profile_loads() {
        // A launch that reset `USERPROFILE` or `HOME` would move the profile
        // PowerShell sources, the config an agent reads, and the credentials
        // `gh` finds — all three at once, and none of them visibly. Per-run
        // configuration being argv and environment is only safe while the
        // environment delta is additive in the shallow sense: it may say what
        // this run is, never where the operator lives.
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
            }
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

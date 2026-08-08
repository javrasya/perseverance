/// Which platform a plan is being made *for*.
///
/// A parameter rather than a `cfg!`, and that is the whole of its reason for
/// existing. An adapter whose `plan` branched on `cfg!(windows)` would have
/// exactly one of its two argv vectors checkable on any given runner, and #44
/// asks for a golden argv *per platform* — so the platform is handed in, both
/// goldens are asserted from one host, and the day an adapter needs a real
/// branch the test that says it has none fails on the machine that is already
/// running.
///
/// Two variants, not three. macOS and Linux differ nowhere in argv
/// construction, and unix-versus-Windows is the axis every measurement in
/// `docs/research/` was actually taken against. A third variant would be a
/// distinction this crate cannot yet point at a difference for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Platform {
    Windows,
    Unix,
}

impl Platform {
    /// The platform this build will really spawn on.
    ///
    /// The only place a `cfg!` is spoken in this crate. An adapter is handed
    /// the answer and never asks the question, which is what keeps `plan`
    /// exercisable for the platform the test is not running on.
    pub const fn host() -> Platform {
        if cfg!(windows) {
            Platform::Windows
        } else {
            Platform::Unix
        }
    }

    /// Whether a variable name is matched without regard to case.
    ///
    /// True on Windows, where `Path` and `PATH` are one variable, and false
    /// elsewhere, where they are two. The same rule
    /// `perseverance_env::Environment::get` applies, restated because this
    /// crate may not name that one.
    pub const fn folds_variable_case(self) -> bool {
        matches!(self, Platform::Windows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_platform_a_plan_is_made_for_is_a_parameter_and_not_the_one_this_build_runs_on() {
        // Both are named here, on whichever runner is reading this. If the
        // platform were a `cfg!` inside `plan`, one of these two lines would be
        // unwritable and half of every adapter would go unchecked.
        let both = [Platform::Windows, Platform::Unix];

        assert_eq!(both.len(), 2);
        assert_ne!(Platform::Windows, Platform::Unix);
        assert!(both.contains(&Platform::host()));
    }

    #[test]
    fn only_windows_folds_the_case_of_a_variable_name() {
        assert!(Platform::Windows.folds_variable_case());
        assert!(!Platform::Unix.folds_variable_case());
    }
}

use std::borrow::Cow;
use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use crate::parse::Reading;

/// The operator's environment, held in memory for the life of this process.
///
/// It derives no `Serialize`, and cannot: this crate has no serde in its tree.
/// That is the whole of AC4's *never touches disk*, and it is a compile error
/// rather than a convention. `Debug` prints how many variables it holds and
/// never which, because an environment that spills into a panic message has
/// been written down.
#[derive(Clone, PartialEq, Eq)]
pub struct Environment {
    variables: BTreeMap<String, Vec<u8>>,
}

impl Environment {
    /// What this process was launched with — on a macOS GUI bundle, the launchd
    /// stub this crate exists to leave behind. It is the fallback when a harvest
    /// is discarded, and it is why a discarded harvest is survivable rather than
    /// fatal.
    pub fn inherited() -> Environment {
        Environment {
            variables: std::env::vars_os()
                .map(|(name, value)| (name.to_string_lossy().into_owned(), raw_bytes(&value)))
                .collect(),
        }
    }

    pub fn from_reading(reading: Reading) -> Environment {
        Environment {
            variables: reading.variables,
        }
    }

    /// Matched the way the platform matches it: without regard to case on
    /// Windows, where `Path` and `PATH` are one variable, and exactly elsewhere,
    /// where they are two. The stored spelling is always the shell's own.
    pub fn get(&self, name: &str) -> Option<&[u8]> {
        if cfg!(windows) {
            self.variables
                .iter()
                .find(|(held, _)| held.eq_ignore_ascii_case(name))
                .map(|(_, value)| value.as_slice())
        } else {
            self.variables.get(name).map(Vec::as_slice)
        }
    }

    /// The verbatim `PATH`, lossily as text, for the readout and nothing else.
    /// Never split: the separator is a guess, and a `PATH` entry containing the
    /// separator is precisely where the guess misleads.
    pub fn path(&self) -> Option<Cow<'_, str>> {
        self.get("PATH").map(String::from_utf8_lossy)
    }

    pub fn len(&self) -> usize {
        self.variables.len()
    }

    pub fn is_empty(&self) -> bool {
        self.variables.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &[u8])> {
        self.variables
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_slice()))
    }

    /// Replaces a command's environment wholesale — `env_clear` first, then
    /// every pair. Not layered on top of inheritance: a child that inherits the
    /// launchd stub *and* the harvest carries two `PATH`s worth of history, and
    /// which one wins is the platform's business rather than a decision anyone
    /// here made.
    pub fn apply(&self, command: &mut std::process::Command) {
        command.env_clear();
        for (name, value) in &self.variables {
            command.env(name, os_value(value));
        }
    }

    /// Every pair, in the spelling a process spawner takes.
    ///
    /// The sibling of [`Environment::apply`], for the one child this workspace
    /// starts that is not a `std::process::Command`: a PTY session is built
    /// through `portable_pty`'s own command builder, which knows nothing about
    /// this type. The conversion is the same one `apply` makes, so what a
    /// terminal run inherits and what a captured run inherits cannot differ.
    pub fn os_pairs(&self) -> Vec<(OsString, OsString)> {
        self.variables
            .iter()
            .map(|(name, value)| (OsString::from(name), os_value(value).into_owned()))
            .collect()
    }

    /// An absolute path to `program`, resolved against **this** `PATH`.
    ///
    /// `std::process::Command` resolves a bare program name against the
    /// *parent's* `PATH`, so `Command::new("gh")` with `envs()` set would look
    /// `gh` up on the launchd stub and fail — #21's problem, re-entered through
    /// the back door, and the precise bug the harvest exists to fix. It may not
    /// be left to a default. On Windows this walks `PATHEXT` from the harvested
    /// environment; on unix it checks the executable bit.
    ///
    /// A program that already names a directory is taken at its word and only
    /// checked, because a `PATH` walk would be looking for something the caller
    /// has already located.
    ///
    /// Resolvable is not spawnable. This says a file is there and executable and
    /// nothing about whether its interpreter resolves at exec time: #21 measured
    /// `codex` resolving and then dying at 127 inside its own `env node` shebang.
    pub fn resolve(&self, program: &str) -> Option<PathBuf> {
        if program.is_empty() {
            return None;
        }

        let named = Path::new(program);
        if named
            .parent()
            .is_some_and(|parent| !parent.as_os_str().is_empty())
        {
            return runnable(named).then(|| named.to_path_buf());
        }

        let path = self.path()?;
        let separator = if cfg!(windows) { ';' } else { ':' };
        for directory in path.split(separator).filter(|entry| !entry.is_empty()) {
            for candidate in self.spellings(Path::new(directory), program) {
                if runnable(&candidate) {
                    return Some(candidate);
                }
            }
        }
        None
    }

    /// Every filename a directory could hold for this program. One on unix.
    /// On Windows, the bare name first and then each `PATHEXT` suffix — read
    /// from the *harvested* environment, because an operator who added `.PY`
    /// to it did so in the shell this harvest just asked.
    fn spellings(&self, directory: &Path, program: &str) -> Vec<PathBuf> {
        let mut spellings = vec![directory.join(program)];
        if !cfg!(windows) {
            return spellings;
        }

        let extensions = self
            .get("PATHEXT")
            .map(|raw| String::from_utf8_lossy(raw).into_owned())
            .filter(|declared| !declared.trim().is_empty())
            .unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".to_string());
        for extension in extensions.split(';').filter(|entry| !entry.is_empty()) {
            spellings.push(directory.join(format!("{program}{extension}")));
        }
        spellings
    }
}

impl std::fmt::Debug for Environment {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Environment")
            .field("variables", &self.variables.len())
            .finish_non_exhaustive()
    }
}

/// A file that exists and that this platform would agree to execute. On unix
/// that is the executable bit; on Windows it is being a file at all, because
/// the extension is the whole of the decision and [`Environment::spellings`]
/// has already made it.
#[cfg(unix)]
fn runnable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;

    std::fs::metadata(path)
        .map(|about| about.is_file() && about.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn runnable(path: &Path) -> bool {
    path.is_file()
}

/// The bytes behind an inherited value. On unix they are the value; on Windows
/// the platform's own storage is UTF-16 and a lossy decode is the closest thing
/// to verbatim that exists.
#[cfg(unix)]
fn raw_bytes(value: &OsStr) -> Vec<u8> {
    use std::os::unix::ffi::OsStrExt;

    value.as_bytes().to_vec()
}

#[cfg(not(unix))]
fn raw_bytes(value: &OsStr) -> Vec<u8> {
    value.to_string_lossy().into_owned().into_bytes()
}

#[cfg(unix)]
fn os_value(value: &[u8]) -> Cow<'_, OsStr> {
    use std::os::unix::ffi::OsStrExt;

    Cow::Borrowed(OsStr::from_bytes(value))
}

#[cfg(not(unix))]
fn os_value(value: &[u8]) -> Cow<'_, OsStr> {
    Cow::Owned(std::ffi::OsString::from(
        String::from_utf8_lossy(value).into_owned(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse::{read_frame, RecordTag};
    use crate::Nonce;
    use tempfile::TempDir;

    fn environment_of(pairs: &[(&str, &[u8])]) -> Environment {
        Environment {
            variables: pairs
                .iter()
                .map(|(name, value)| (name.to_string(), value.to_vec()))
                .collect(),
        }
    }

    /// The same file on disk, which on Windows is not the same string.
    ///
    /// [`Environment::spellings`] appends the operator's `PATHEXT` entry
    /// verbatim, and Windows spells that entry `.CMD` while a test writes
    /// `wf31stub.cmd` — so `resolve` hands back `wf31stub.CMD` for a file named
    /// `wf31stub.cmd`. Keeping the declared spelling is the deliberate
    /// behaviour: an operator who added `.PY` to `PATHEXT` in the shell this
    /// harvest just asked should get `.PY` back, and re-deriving the on-disk
    /// casing would cost a directory scan per candidate to change nothing but
    /// how the path looks. Windows opens either, which is what the existence
    /// check below actually proves — and proving the path opens is a stronger
    /// claim than the string equality this replaced.
    fn assert_same_file(found: &Path, expected: &Path) {
        assert!(found.exists(), "{found:?} does not open");
        assert_eq!(found.parent(), expected.parent());

        let (found_name, expected_name) = (
            found.file_name().expect("a file name").to_string_lossy(),
            expected.file_name().expect("a file name").to_string_lossy(),
        );
        if cfg!(windows) {
            assert!(
                found_name.eq_ignore_ascii_case(&expected_name),
                "{found_name} is not {expected_name} in any casing"
            );
        } else {
            assert_eq!(found_name, expected_name);
        }
    }

    /// Writes a file and, on unix, gives it the bit that makes it a program.
    fn program_file(directory: &Path, name: &str, executable: bool) -> PathBuf {
        let path = directory.join(name);
        std::fs::write(&path, "#!/bin/sh\nexit 0\n").expect("writes the program");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = if executable { 0o755 } else { 0o644 };
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode))
                .expect("sets the mode");
        }
        let _ = executable;
        path
    }

    #[test]
    fn an_environment_never_prints_what_it_holds() {
        let environment = environment_of(&[
            ("PATH", b"/opt/homebrew/bin:/usr/bin"),
            ("GITHUB_TOKEN", b"ghp_notarealtoken"),
        ]);

        let printed = format!("{environment:?}");

        assert!(!printed.contains("GITHUB_TOKEN"), "{printed}");
        assert!(!printed.contains("ghp_notarealtoken"), "{printed}");
        assert!(!printed.contains("homebrew"), "{printed}");
        assert!(printed.contains('2'), "{printed}");
    }

    #[test]
    fn applying_an_environment_clears_before_it_sets() {
        let environment = environment_of(&[("PATH", b"/usr/bin:/bin"), ("WF31_ONLY", b"yes")]);

        let mut command = std::process::Command::new("/usr/bin/env");
        environment.apply(&mut command);

        // `env_clear` first is the assertion: a child that inherited the
        // launchd stub *and* the harvest would carry two PATHs worth of
        // history. `get_envs` reports the whole plan, and a cleared plan holds
        // exactly what was put there here — nothing removed, nothing over.
        let planned: Vec<(String, Option<String>)> = command
            .get_envs()
            .map(|(name, value)| {
                (
                    name.to_string_lossy().into_owned(),
                    value.map(|value| value.to_string_lossy().into_owned()),
                )
            })
            .collect();

        assert_eq!(planned.len(), 2);
        assert!(planned.contains(&("WF31_ONLY".to_string(), Some("yes".to_string()))));
        assert!(planned.contains(&("PATH".to_string(), Some("/usr/bin:/bin".to_string()))));
    }

    #[test]
    fn a_program_is_looked_for_on_the_harvested_path_and_not_on_this_processs_own() {
        let directory = TempDir::new().expect("a temporary directory");
        let name = if cfg!(windows) {
            "wf31stub.cmd"
        } else {
            "wf31stub"
        };
        program_file(directory.path(), name, true);
        let environment =
            environment_of(&[("PATH", directory.path().to_string_lossy().as_bytes())]);

        let found = environment
            .resolve("wf31stub")
            .expect("resolves against the harvested PATH");

        assert_same_file(&found, &directory.path().join(name));
        // `sh` is on this process's own PATH on every runner this repo builds
        // on. It is not on the one above, and that difference is the bug the
        // harvest exists to fix, re-entered through the back door.
        assert_eq!(environment.resolve("sh"), None);
        assert_eq!(environment.resolve("cmd"), None);
    }

    #[test]
    fn a_program_named_by_its_own_path_is_checked_rather_than_looked_for() {
        let directory = TempDir::new().expect("a temporary directory");
        let name = if cfg!(windows) {
            "wf31stub.cmd"
        } else {
            "wf31stub"
        };
        let program = program_file(directory.path(), name, true);
        let environment = environment_of(&[("PATH", b"/nowhere-at-all")]);

        let found = environment.resolve(&program.to_string_lossy());

        assert_eq!(found, Some(program));
        assert_eq!(
            environment.resolve(&directory.path().join("absent").to_string_lossy()),
            None
        );
    }

    #[test]
    fn an_environment_with_no_path_resolves_nothing() {
        let environment = environment_of(&[("HOME", b"/Users/you")]);

        assert_eq!(environment.resolve("sh"), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_file_without_the_executable_bit_is_not_a_program() {
        let directory = TempDir::new().expect("a temporary directory");
        program_file(directory.path(), "wf31readable", false);
        program_file(directory.path(), "wf31runnable", true);
        let environment =
            environment_of(&[("PATH", directory.path().to_string_lossy().as_bytes())]);

        assert_eq!(
            environment.resolve("wf31runnable"),
            Some(directory.path().join("wf31runnable"))
        );
        assert_eq!(environment.resolve("wf31readable"), None);
    }

    #[cfg(unix)]
    #[test]
    fn path_matches_the_way_the_platform_matches_it() {
        let environment = environment_of(&[("PATH", b"/usr/bin"), ("Path", b"/nowhere")]);

        // Two variables here, and the shell's own spelling is the one that
        // answers.
        assert_eq!(environment.get("PATH"), Some(&b"/usr/bin"[..]));
        assert_eq!(environment.get("Path"), Some(&b"/nowhere"[..]));
        assert_eq!(environment.path().as_deref(), Some("/usr/bin"));
    }

    #[cfg(windows)]
    #[test]
    fn path_matches_the_way_the_platform_matches_it() {
        let environment = environment_of(&[("Path", b"C:\\Windows")]);

        // One variable here, whatever it is spelled as.
        assert_eq!(environment.get("PATH"), Some(&b"C:\\Windows"[..]));
        assert_eq!(environment.get("Path"), Some(&b"C:\\Windows"[..]));
        assert_eq!(environment.path().as_deref(), Some("C:\\Windows"));
    }

    #[cfg(windows)]
    #[test]
    fn a_windows_program_is_found_by_walking_the_harvested_pathext() {
        let directory = TempDir::new().expect("a temporary directory");
        program_file(directory.path(), "wf31stub.cmd", true);
        let with = environment_of(&[
            ("Path", directory.path().to_string_lossy().as_bytes()),
            ("PATHEXT", b".COM;.EXE;.CMD"),
        ]);
        let without = environment_of(&[
            ("Path", directory.path().to_string_lossy().as_bytes()),
            ("PATHEXT", b".COM;.EXE"),
        ]);

        let found = with.resolve("wf31stub").expect("walks PATHEXT");
        assert_same_file(&found, &directory.path().join("wf31stub.cmd"));
        // The harvested PATHEXT decides, not a constant in here.
        assert_eq!(without.resolve("wf31stub"), None);
    }

    #[test]
    fn the_verbatim_path_is_never_split_on_a_separator_that_might_be_in_it() {
        let odd = "/opt/one:/opt/a b:c/two";
        let environment = environment_of(&[("PATH", odd.as_bytes())]);

        assert_eq!(environment.path().as_deref(), Some(odd));
    }

    #[test]
    fn an_environment_read_from_a_frame_holds_what_the_frame_held() {
        let nonce = Nonce::from_literal("deadbeefdeadbeef");
        let bytes = crate::parse::framed(&nonce, b"", &[b"PATH=/bin", b"HOME=/Users/you"], b"");
        let reading = read_frame(&bytes, &nonce, RecordTag::Absent).expect("reads");

        let environment = Environment::from_reading(reading);

        assert_eq!(environment.len(), 2);
        assert!(!environment.is_empty());
        assert_eq!(environment.path().as_deref(), Some("/bin"));
        let held: Vec<&str> = environment.iter().map(|(name, _)| name).collect();
        assert_eq!(held, vec!["HOME", "PATH"]);
    }

    #[test]
    fn the_inherited_environment_is_what_this_process_was_launched_with() {
        let inherited = Environment::inherited();

        // Cargo runs its test binaries with a PATH, on every runner. This is
        // the fallback a discarded harvest lands on, so it has to be a real
        // environment rather than an empty one.
        assert!(!inherited.is_empty());
        assert!(inherited.path().is_some());
    }
}

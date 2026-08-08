use std::path::{Path, PathBuf};

use crate::harvest::HarvestCondition;
use crate::nonce::Nonce;
use crate::parse::RecordTag;
use crate::payload::{encode_command, powershell_payload, unix_payload};

/// Which interpreter, and where it is.
///
/// Both variants are constructible on both platforms. The argv this crate sends
/// on Windows has to be reviewable from a macOS runner and the other way round,
/// and a `#[cfg]` body would make each one checkable on exactly one machine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Shell {
    /// `$SHELL -lic '<payload>'`. **Both** flags, never one.
    ///
    /// Measured under the launchd stub against a real 159-line oh-my-zsh rc:
    /// `-c` reads `.zshenv` only and resolves nothing; `-lc` resolves `codex`
    /// and then dies at exec with `env: node: No such file or directory`, exit
    /// 127 — a green picker measuring nothing; `-ic` misses the login
    /// `path_helper`, so the rc's own `fnm` line dies, the rc carries on, and it
    /// **still returns a plausible-looking PATH**. Dropping either flag fails in
    /// a way that looks like success.
    ///
    /// Re-measured on this machine for this slice, from `env -i` under the
    /// launchd stub, and it sharpens rather than repeats: no flags gives 9
    /// variables and neither `gh` nor `node`; `-lc` gives 10 and `gh` but not
    /// `node`; `-ic` gives 14 and `node` but **not `gh`**, because homebrew's
    /// `/opt/homebrew/bin` is added only by the login `path_helper` — so `-ic`
    /// alone fails acceptance criterion 5 outright, there being no `gh` to ask
    /// for a token. `-lic` gives 23, both, at 186–252 ms.
    ///
    /// `$SHELL` rather than a hardcoded `/bin/zsh`: #21 confirmed from launchd
    /// job records that a GUI bundle's dozen variables do carry `SHELL`, and
    /// hardcoding would diverge from an operator on bash or fish.
    LoginShell { program: String },

    /// `powershell.exe -NoLogo -EncodedCommand <base64 utf-16le>`, at
    /// `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` — absolute,
    /// not found on `PATH`, because `PATH` is the thing this run has not
    /// acquired yet and an earlier match would be an arbitrary program.
    ///
    /// No `-NoProfile`: it was the *control* in every #26 measurement, and the
    /// operator's profile running is the entire point. No `-NonInteractive`
    /// either — measured not to change which profiles load; its only effect is
    /// to make a `Read-Host` at EOF error rather than return junk, and neither
    /// wedged. No `-ExecutionPolicy` either: overriding the operator's own
    /// policy would be this harness deciding to run something their machine
    /// declined, and it is unmeasured. Under `AllSigned` the profile does not
    /// run and the harvest degrades to plain inheritance with exit 0, both
    /// marks and clean stdout. That is still not *detected* — but where the
    /// interpreter says so in its own words on stderr,
    /// [`crate::degradation_in`] names it, and where it says nothing the
    /// degradation is still invisible. The remedy stays a readout rather than a
    /// flag.
    PowerShell { program: String },
}

impl Shell {
    /// Takes a lookup rather than reading the environment, so the whole of this
    /// decision is exercisable from a map on either runner.
    pub fn for_this_machine(
        lookup: &dyn Fn(&str) -> Option<String>,
    ) -> Result<Shell, HarvestCondition> {
        // `cfg!` rather than `#[cfg]`: both arms compile on both runners, so
        // neither half of this can rot behind a platform nobody built on today.
        if cfg!(windows) {
            let looked_in = powershell_location(lookup);
            if std::path::Path::new(&looked_in).is_file() {
                Ok(Shell::PowerShell { program: looked_in })
            } else {
                Err(HarvestCondition::NoShellInstalled { looked_in })
            }
        } else {
            match lookup("SHELL") {
                Some(program) if !program.trim().is_empty() => Ok(Shell::LoginShell { program }),
                _ => Err(HarvestCondition::NoShellNamed),
            }
        }
    }

    pub fn program(&self) -> &str {
        match self {
            Shell::LoginShell { program } | Shell::PowerShell { program } => program,
        }
    }

    /// `["-lic"]` or `["-NoLogo", "-EncodedCommand"]` — the flags without the
    /// payload, which is also exactly what the readout shows. `-lic` is one
    /// argument because that is the argument every measurement was taken with.
    pub fn flags(&self) -> Vec<String> {
        match self {
            Shell::LoginShell { .. } => vec!["-lic".to_string()],
            Shell::PowerShell { .. } => {
                vec!["-NoLogo".to_string(), "-EncodedCommand".to_string()]
            }
        }
    }

    /// Whether a record inside the frame must carry the nonce.
    pub fn record_tag(&self) -> RecordTag {
        match self {
            Shell::LoginShell { .. } => RecordTag::Absent,
            Shell::PowerShell { .. } => RecordTag::Required,
        }
    }
}

/// Program, argv, working directory and the environment the child is given —
/// fully determined, as a value, so a test can point the whole pipeline at
/// something that is not a shell.
#[derive(Debug, Clone)]
pub struct HarvestCommand {
    pub shell: Shell,
    pub program: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    /// Pairs laid over **this process's** inherited environment.
    ///
    /// Empty in every shipped call, and [`harvest_command`] is the only thing
    /// that builds a shipped one. It exists so a test can point
    /// `ZDOTDIR`, or `USERPROFILE`/`HOME`/`HOMEDRIVE`/`HOMEPATH`, at a
    /// temporary directory holding a start-up file — which is genuine autoload
    /// rather than a dot-source — without any test ever calling
    /// `std::env::set_var` in a binary whose tests run on several threads.
    ///
    /// The child inherits this process's environment and **never** a previously
    /// harvested one: a second harvest carrying the first's `PATH` would
    /// compound, which is the Windows sibling of #14's
    /// `CLAUDE_CODE_CHILD_SESSION` trap with the harness as its own author. On
    /// Windows that inheritance is load-bearing twice over — PowerShell 5.1
    /// derives `$PROFILE` from `USERPROFILE`, `HOME`, `HOMEDRIVE` and
    /// `HOMEPATH` rather than from the registry, so scrubbing or overriding any
    /// of the four loads a different profile, or none.
    pub env_overlay: Vec<(String, String)>,
}

/// `/` on unix and `%SystemDrive%\` on Windows. A GUI bundle runs at the root —
/// confirmed in launchd job records for three applications — and #24 fixes the
/// app-global harvest there. A directory with no version pin in it is also the
/// one place a version manager cannot quietly answer a question nobody asked.
pub fn harvest_cwd() -> PathBuf {
    if cfg!(windows) {
        let drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".to_string());
        PathBuf::from(format!("{drive}\\"))
    } else {
        PathBuf::from("/")
    }
}

/// The absolute directory a child is actually given, and the key a folder's
/// harvest is kept on.
///
/// Canonicalised, because `/var` and `/private/var` are one directory on macOS
/// and an 8.3 short name and its long spelling are one directory on Windows —
/// two keys for one directory would be two harvests that could disagree, and
/// disagreeing about which interpreter a folder resolves under is the whole of
/// what #45 exists to stop.
///
/// A directory that cannot be canonicalised — it is gone, or the operator
/// cannot read it — is absolutised and used as it is: a folder that is not there
/// is a condition, not a reason to refuse a key.
pub fn spawn_directory(folder: &Path) -> PathBuf {
    if let Ok(settled) = std::fs::canonicalize(folder) {
        return settled;
    }
    if folder.is_absolute() {
        return folder.to_path_buf();
    }
    match std::env::current_dir() {
        Ok(here) => here.join(folder),
        Err(_) => folder.to_path_buf(),
    }
}

/// The same directory in a form a child can be given.
///
/// `std::fs::canonicalize` returns `\\?\C:\...` on Windows. The prefix is right
/// for a key — it is the spelling two short names collapse onto — and unproven
/// for `Command::current_dir`, so it is stripped here and the key keeps it. A
/// `\\?\UNC\` prefix is left alone: stripping it would leave a share path with
/// its leading slashes gone, which is a different directory rather than the same
/// one spelled shorter.
pub fn spawnable_form(directory: &Path) -> PathBuf {
    let named = directory.to_string_lossy();
    match named.strip_prefix(VERBATIM) {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => directory.to_path_buf(),
    }
}

/// Windows' verbatim-path prefix, spelled once.
const VERBATIM: &str = r"\\?\";

/// [`harvest_command`] with the working directory named rather than assumed.
///
/// The payload is still generated here, and still says nothing about moving:
/// setting the child's directory is the whole mechanism. A version manager
/// resolves its pin inside its own process at rc-evaluation time, so the pin is
/// answered by *where the shell started*; and on Windows only the aliased `cd`
/// fires the hook at all, so scripted navigation would be both unnecessary and
/// wrong. #24 calls the same thing the load-bearing correction from the other
/// side: a `cd` inside the command would run before the framing and put its own
/// output where the opening mark belongs.
pub fn harvest_command_in(shell: Shell, nonce: &Nonce, directory: PathBuf) -> HarvestCommand {
    let mut args = shell.flags();
    match &shell {
        Shell::LoginShell { .. } => args.push(unix_payload(nonce)),
        Shell::PowerShell { .. } => args.push(encode_command(&powershell_payload(nonce))),
    }

    HarvestCommand {
        program: shell.program().to_string(),
        args,
        cwd: directory,
        env_overlay: Vec::new(),
        shell,
    }
}

/// The shipped command for a shell and a nonce, at the root. The payload is
/// generated by [`harvest_command_in`] rather than passed in, so no caller — and
/// no test — can frame a harvest the shipped code would not have framed.
///
/// One builder, two working directories: the app-global harvest is exactly the
/// per-folder one asked at [`harvest_cwd`], which is what makes "the only
/// difference is where the child started" a fact about the code rather than a
/// claim about it.
pub fn harvest_command(shell: Shell, nonce: &Nonce) -> HarvestCommand {
    harvest_command_in(shell, nonce, harvest_cwd())
}

/// Where Windows keeps PowerShell 5.1, derived from `SystemRoot` and nothing
/// else. Split out of [`Shell::for_this_machine`] so the location policy is
/// assertable from a macOS runner: the machine that must review this argv is
/// not the machine that can run it.
pub(crate) fn powershell_location(lookup: &dyn Fn(&str) -> Option<String>) -> String {
    let root = lookup("SystemRoot")
        .filter(|named| !named.trim().is_empty())
        .unwrap_or_else(|| "C:\\Windows".to_string());
    format!("{root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::payload::{decode_command, NAVIGATION};
    use tempfile::TempDir;

    fn nonce() -> Nonce {
        Nonce::from_literal("deadbeefdeadbeef")
    }

    /// Everything the child is actually told, as readable text.
    ///
    /// The unix argv already is that. The PowerShell one is not: its last
    /// argument is base64 of UTF-16LE, so it is decoded here — otherwise any
    /// assertion about what the payload says is an assertion about an alphabet
    /// the words cannot occur in.
    fn spoken(command: &HarvestCommand) -> String {
        let mut said = command.args.clone();
        if matches!(command.shell, Shell::PowerShell { .. }) {
            let encoded = said.pop().expect("the payload is the last argument");
            said.push(decode_command(&encoded));
        }
        said.join(" ")
    }

    fn from<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |wanted: &str| {
            pairs
                .iter()
                .find(|(name, _)| *name == wanted)
                .map(|(_, value)| value.to_string())
        }
    }

    #[test]
    fn the_login_shell_is_asked_for_a_login_and_an_interactive_one_together() {
        let shell = Shell::LoginShell {
            program: "/bin/zsh".to_string(),
        };

        let command = harvest_command(shell, &nonce());

        // One argument, because `-lic` is the argument every measurement was
        // taken with. `-lc` resolves `gh` and not `node`; `-ic` resolves `node`
        // and not `gh`. Each single flag returns a plausible environment
        // missing exactly what the other carries.
        assert_eq!(command.args[0], "-lic");
        assert_eq!(command.args.len(), 2);
        assert_eq!(command.program, "/bin/zsh");
        assert!(command.args[1].contains("env -0"));
    }

    #[test]
    fn the_windows_harvest_never_asks_for_a_shell_without_the_operators_profile() {
        let shell = Shell::PowerShell {
            program: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe".to_string(),
        };

        let command = harvest_command(shell, &nonce());

        // `-NoProfile` was the control in every #26 measurement. Shipping it
        // would leave a green readout measuring nothing, so its absence is the
        // single most load-bearing negative assertion in this slice.
        assert!(!command.args.iter().any(|arg| arg == "-NoProfile"));
        assert!(!command.args.iter().any(|arg| arg == "-NonInteractive"));
        assert!(!command.args.iter().any(|arg| arg == "-ExecutionPolicy"));
        assert_eq!(command.args[0], "-NoLogo");
        assert_eq!(command.args[1], "-EncodedCommand");
        assert_eq!(command.args.len(), 3);
    }

    #[test]
    fn the_flags_the_readout_shows_are_the_flags_the_child_was_given() {
        for shell in [
            Shell::LoginShell {
                program: "/bin/zsh".to_string(),
            },
            Shell::PowerShell {
                program: "powershell.exe".to_string(),
            },
        ] {
            let flags = shell.flags();
            let command = harvest_command(shell, &nonce());

            assert_eq!(command.args[..flags.len()], flags[..]);
            // The payload is the one thing the readout does not show, because
            // it is the same every run and it is long.
            assert_eq!(command.args.len(), flags.len() + 1);
        }
    }

    #[test]
    fn powershell_is_named_where_windows_keeps_it_rather_than_found_on_a_path_we_have_not_acquired()
    {
        let located = powershell_location(&from(&[("SystemRoot", "D:\\WinNT")]));

        assert_eq!(
            located,
            "D:\\WinNT\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
        );
        // `PATH` is the thing this run has not acquired yet, so an earlier
        // match on it would be an arbitrary program.
        assert!(located.starts_with("D:\\"));
        assert_eq!(
            powershell_location(&from(&[])),
            "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_bundle_that_names_no_shell_is_refused_rather_than_guessed_at() {
        let condition = Shell::for_this_machine(&from(&[])).expect_err("refuses");

        assert_eq!(condition, HarvestCondition::NoShellNamed);
        // Guessing `/bin/zsh` would run start-up files that may not be the
        // operator's, silently — the one harm #15 named.
        assert!(!condition.to_string().contains("zsh"));
    }

    #[cfg(unix)]
    #[test]
    fn a_bundle_naming_a_blank_shell_is_refused_the_same_way() {
        let condition = Shell::for_this_machine(&from(&[("SHELL", "   ")])).expect_err("refuses");

        assert_eq!(condition, HarvestCondition::NoShellNamed);
    }

    #[cfg(unix)]
    #[test]
    fn the_shell_the_bundle_names_is_the_shell_that_is_asked() {
        let shell = Shell::for_this_machine(&from(&[("SHELL", "/opt/homebrew/bin/fish")]))
            .expect("names a shell");

        assert_eq!(
            shell,
            Shell::LoginShell {
                program: "/opt/homebrew/bin/fish".to_string()
            }
        );
        assert_eq!(shell.record_tag(), RecordTag::Absent);
    }

    #[test]
    fn a_windows_record_carries_the_tag_and_a_unix_one_cannot() {
        // `env -0` cannot prefix, and a `while read -d ''` loop is bash/zsh
        // syntax a fish `$SHELL` would refuse. The tag is adopted where it
        // costs nothing rather than made a universal rule.
        assert_eq!(
            Shell::PowerShell {
                program: "powershell.exe".to_string()
            }
            .record_tag(),
            RecordTag::Required
        );
        assert_eq!(
            Shell::LoginShell {
                program: "/bin/zsh".to_string()
            }
            .record_tag(),
            RecordTag::Absent
        );
    }

    #[test]
    fn the_harvest_runs_at_the_root_where_no_version_pin_can_answer_for_a_folder() {
        let cwd = harvest_cwd();

        assert!(cwd.is_absolute());
        assert_eq!(cwd.parent(), None);
        if cfg!(windows) {
            assert!(cwd.to_string_lossy().ends_with('\\'));
        } else {
            assert_eq!(cwd, PathBuf::from("/"));
        }
    }

    #[test]
    fn a_shipped_harvest_lays_nothing_over_the_environment_it_inherits() {
        let command = harvest_command(
            Shell::LoginShell {
                program: "/bin/zsh".to_string(),
            },
            &nonce(),
        );

        assert!(command.env_overlay.is_empty());
    }

    #[test]
    fn a_folders_harvest_is_asked_inside_the_folder_and_still_says_nothing_about_moving() {
        let directory = TempDir::new().expect("a temporary directory");
        let folder = directory.path().to_path_buf();

        for shell in [
            Shell::LoginShell {
                program: "/bin/zsh".to_string(),
            },
            Shell::PowerShell {
                program: "powershell.exe".to_string(),
            },
        ] {
            let at_the_root = harvest_command(shell.clone(), &nonce());
            let in_the_folder = harvest_command_in(shell, &nonce(), folder.clone());

            // The whole of the per-folder harvest, as a difference of one field.
            assert_eq!(in_the_folder.cwd, folder);
            assert_ne!(in_the_folder.cwd, at_the_root.cwd);
            assert_eq!(in_the_folder.args, at_the_root.args);
            assert_eq!(in_the_folder.program, at_the_root.program);
            assert!(in_the_folder.env_overlay.is_empty());

            // A version manager resolves its pin inside its own process at
            // rc-evaluation time, and on Windows only the aliased `cd` fires the
            // hook. Navigation would therefore buy nothing and would run before
            // the framing — so there is none, on either platform's argv.
            //
            // Read through `spoken`, because the PowerShell payload reaches the
            // child as base64 of UTF-16LE: searching the encoded argument for
            // the word is searching an alphabet the word cannot appear in, and
            // would pass no matter what the payload said.
            let lowered = spoken(&in_the_folder).to_lowercase();
            for spelling in NAVIGATION {
                assert!(!lowered.contains(spelling), "{spelling} in {lowered}");
            }
        }
    }

    #[test]
    fn two_spellings_of_one_folder_are_one_key() {
        let directory = TempDir::new().expect("a temporary directory");
        let plain = spawn_directory(directory.path());
        let dotted = spawn_directory(&directory.path().join("."));

        // Two harvests of one directory could disagree about which interpreter
        // it resolves under, which is the failure this key exists to delete.
        assert_eq!(plain, dotted);
        assert!(plain.is_absolute());

        #[cfg(unix)]
        {
            let elsewhere = TempDir::new().expect("a second temporary directory");
            let link = elsewhere.path().join("pointing-at-the-first");
            std::os::unix::fs::symlink(directory.path(), &link).expect("links");
            assert_eq!(spawn_directory(&link), plain);
        }
    }

    #[test]
    fn the_directory_a_child_is_given_is_one_a_child_can_be_given() {
        // Assertable from either runner, because it is a rule about a string.
        assert_eq!(
            spawnable_form(Path::new(r"\\?\C:\work\perseverance")),
            PathBuf::from(r"C:\work\perseverance")
        );
        // Everything else is left exactly as it arrived — including a share,
        // whose leading slashes are not a prefix to strip.
        assert_eq!(
            spawnable_form(Path::new(r"\\?\UNC\build\share\work")),
            PathBuf::from(r"\\?\UNC\build\share\work")
        );
        assert_eq!(
            spawnable_form(Path::new("/private/var/folders/work")),
            PathBuf::from("/private/var/folders/work")
        );
        assert_eq!(
            spawnable_form(Path::new(r"C:\work\?\odd")),
            PathBuf::from(r"C:\work\?\odd")
        );
    }

    #[test]
    fn a_folder_that_is_not_there_still_has_a_key() {
        let directory = TempDir::new().expect("a temporary directory");
        let gone = directory.path().join("no-such-folder");

        let key = spawn_directory(&gone);

        // A folder that has been moved or unmounted is a condition the readout
        // reports, and a harvest that panicked on the way to reporting it would
        // be the app refusing to open a folder because the folder is missing.
        assert!(key.is_absolute());
        assert!(key.ends_with("no-such-folder"));
    }

    #[test]
    fn two_harvests_are_framed_with_marks_neither_could_mistake_for_the_others() {
        let first = harvest_command(
            Shell::LoginShell {
                program: "/bin/zsh".to_string(),
            },
            &Nonce::fresh(),
        );
        let second = harvest_command(
            Shell::LoginShell {
                program: "/bin/zsh".to_string(),
            },
            &Nonce::fresh(),
        );

        assert_ne!(first.args[1], second.args[1]);
    }
}

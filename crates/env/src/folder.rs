use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::Duration;

use crate::environment::Environment;
use crate::harvest::{
    degradation_in, harvest_with, Bounds, Degradation, HarvestAttempt, HarvestCondition, Stderr,
};
use crate::nonce::Nonce;
use crate::parse::Tally;
use crate::shell::{harvest_command_in, spawn_directory, spawnable_form, Shell};

/// The environment a folder resolves in: one harvest run with the child's
/// working directory set to that folder, and the facts of the attempt beside it.
///
/// The facts sit here rather than behind a `Result` for the same reason
/// [`HarvestAttempt::stderr`] sits outside its outcome: a *discarded* harvest is
/// exactly when a caller needs to say which shell ran, what it wrote and how
/// long it took. There is always an [`Environment`] — the harvested one, or this
/// process's own — so a folder can always be opened and a program can always be
/// looked for.
#[derive(Debug, Clone)]
pub struct FolderEnvironment {
    /// The absolute, canonicalised directory the child was given, which is also
    /// the key this was kept on.
    pub spawn_directory: PathBuf,
    pub environment: Environment,
    /// `false` when the harvest was discarded and [`FolderEnvironment::environment`]
    /// is [`Environment::inherited`].
    pub from_harvest: bool,
    pub condition: Option<HarvestCondition>,
    /// `None` only when no shell could be chosen at all.
    pub shell: Option<Shell>,
    pub stderr: Stderr,
    pub elapsed: Duration,
    /// Empty where the harvest was discarded: there is no frame to have counted.
    pub tally: Tally,
    /// Named from what the interpreter wrote about itself, never detected. See
    /// [`Degradation`].
    pub degradation: Option<Degradation>,
}

impl FolderEnvironment {
    /// One attempt, settled into a value. The fallback to inheritance happens
    /// here and only here, so there is one place where "the harvest was
    /// discarded" becomes "and the folder opened anyway".
    fn settled_from(spawn_directory: PathBuf, attempt: HarvestAttempt) -> FolderEnvironment {
        let degradation = degradation_in(&attempt.stderr);
        let (environment, from_harvest, condition, tally) = match attempt.outcome {
            Ok(harvest) => (harvest.environment, true, None, harvest.tally),
            Err(condition) => (
                Environment::inherited(),
                false,
                Some(condition),
                Tally::default(),
            ),
        };

        FolderEnvironment {
            spawn_directory,
            environment,
            from_harvest,
            condition,
            shell: attempt.shell,
            stderr: attempt.stderr,
            elapsed: attempt.elapsed,
            tally,
            degradation,
        }
    }
}

/// One cell per directory, so the map lock is never held across a harvest.
type Cell = Arc<OnceLock<Arc<FolderEnvironment>>>;

/// One harvest per folder, keyed on the **absolute spawn working directory** —
/// not on a folder id, not on a path as it was typed.
///
/// Keying on the directory the child was actually given deletes the worktree
/// question rather than answering it: two rows that resolve to one directory
/// share one harvest because they *are* one harvest, and a row that has been
/// relocated gets a new one because the child would start somewhere else. The
/// key is canonicalised by [`spawn_directory`], so `/var` and `/private/var`,
/// and an 8.3 short name and its long spelling, are one key rather than two that
/// could disagree.
///
/// **Invalidation is the operator's explicit retry and nothing else.** There is
/// no duration parameter anywhere on this type and no watcher, and neither is an
/// omission. The dangerous case is *pin unchanged, installed set changed* — a
/// version pin that still reads the same while the thing it pins to has been
/// added or removed — which no filesystem watcher over the folder can see, and
/// which a clock would only re-take at random. So the answer stands until
/// somebody who has just changed something says so:
/// [`Harvests::again_in_folder`].
///
/// The map lock is taken only to get-or-insert the cell and is released
/// **before** the harvest runs; the harvest happens inside
/// [`OnceLock::get_or_init`]. A Windows harvest is bounded at 20 s, and holding
/// the map lock across one would serialise every folder in the app behind
/// whichever folder was asked first. Two concurrent asks for the same directory
/// still produce one harvest, because they are waiting on the same cell.
#[derive(Debug, Default)]
pub struct Harvests {
    taken: Mutex<HashMap<PathBuf, Cell>>,
}

impl Harvests {
    pub fn new() -> Harvests {
        Harvests {
            taken: Mutex::new(HashMap::new()),
        }
    }

    /// This folder's environment, harvested the first time and handed back
    /// every time after.
    pub fn in_folder(&self, folder: &Path) -> Arc<FolderEnvironment> {
        self.in_folder_with(folder, &harvest_in)
    }

    /// The retry. Forgets this directory, then harvests it again.
    ///
    /// Forgetting first is the whole of it: an operator who has just installed
    /// something is saying the answer this map is holding is stale, and
    /// re-reading the cell would hand back the same stale answer faster.
    pub fn again_in_folder(&self, folder: &Path) -> Arc<FolderEnvironment> {
        self.again_in_folder_with(folder, &harvest_in)
    }

    /// The seam the tests drive, exactly as [`harvest_with`] is for one run.
    ///
    /// The taker is handed the *spawn directory* rather than the folder as it
    /// was typed, so a test asserting where a child started is asserting about
    /// the same value the key was made from.
    pub fn in_folder_with(
        &self,
        folder: &Path,
        take: &dyn Fn(&Path) -> HarvestAttempt,
    ) -> Arc<FolderEnvironment> {
        let directory = spawn_directory(folder);
        let cell = self.cell_for(&directory);
        cell.get_or_init(|| {
            Arc::new(FolderEnvironment::settled_from(
                directory.clone(),
                take(&directory),
            ))
        })
        .clone()
    }

    pub fn again_in_folder_with(
        &self,
        folder: &Path,
        take: &dyn Fn(&Path) -> HarvestAttempt,
    ) -> Arc<FolderEnvironment> {
        let directory = spawn_directory(folder);
        self.held().remove(&directory);
        self.in_folder_with(folder, take)
    }

    /// What is keyed, for the panel and for the test that reads it. Sorted, so
    /// two runs of the same asks read the same way.
    pub fn directories(&self) -> Vec<PathBuf> {
        let mut directories: Vec<PathBuf> = self.held().keys().cloned().collect();
        directories.sort();
        directories
    }

    /// Get-or-insert the cell, and give the lock straight back. Nothing that
    /// waits happens while this is held.
    fn cell_for(&self, directory: &Path) -> Cell {
        self.held()
            .entry(directory.to_path_buf())
            .or_default()
            .clone()
    }

    /// A harvest runs outside this lock, so a panic in one cannot be carried
    /// into it — and a poisoned map would still be a map worth reading, so the
    /// answer to one is to carry on rather than to take the app down with it.
    fn held(&self) -> MutexGuard<'_, HashMap<PathBuf, Cell>> {
        self.taken.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// One folder's harvest: choose the shell, mint a nonce, run it **in** the
/// folder under the shipped bounds.
///
/// This is [`harvest_with`] with a working directory named rather than assumed,
/// and not a second implementation — the seam that function's own doc reserves.
/// The overlay stays empty, so the child inherits *this process's* environment
/// and never a previous harvest's: a second harvest carrying the first's `PATH`
/// would compound, and a per-folder cache is a great many second harvests.
pub fn harvest_in(directory: &Path) -> HarvestAttempt {
    let shell = match Shell::for_this_machine(&|name| std::env::var(name).ok()) {
        Ok(shell) => shell,
        Err(condition) => return HarvestAttempt::before_a_shell_was_chosen(condition),
    };
    let nonce = Nonce::fresh();
    let command = harvest_command_in(shell, &nonce, spawnable_form(&spawn_directory(directory)));
    harvest_with(&command, &nonce, &Bounds::for_this_machine())
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::atomic::{AtomicUsize, Ordering};

    use crate::harvest::Harvest;
    use crate::parse::{framed, read_frame, RecordTag};
    use crate::payload::{closing_mark, opening_mark};
    use crate::shell::HarvestCommand;
    use tempfile::TempDir;

    fn nonce() -> Nonce {
        Nonce::from_literal("deadbeefdeadbeef")
    }

    /// The bounds every test here that is not about a bound uses. A deadline
    /// that starts before the spawn is a deadline on the runner's scheduler as
    /// much as on the child.
    fn roomy() -> Bounds {
        Bounds {
            frame: Duration::from_secs(20),
            exit_grace: Duration::from_millis(200),
            stdout_cap: 8 * 1024 * 1024,
            stderr_cap: 4 * 1024 * 1024,
        }
    }

    /// An attempt that harvested, without a child: the subject of most of these
    /// tests is the map, not the pump.
    fn settled(path: &str) -> HarvestAttempt {
        let bytes = framed(
            &nonce(),
            b"",
            &[format!("PATH={path}").as_bytes(), b"WF45_MARK=ran"],
            b"",
        );
        let reading = read_frame(&bytes, &nonce(), RecordTag::Absent).expect("reads");
        HarvestAttempt {
            outcome: Ok(Harvest {
                tally: reading.tally,
                environment: Environment::from_reading(reading),
            }),
            shell: Some(Shell::LoginShell {
                program: "/bin/zsh".to_string(),
            }),
            stderr: Stderr::of(b""),
            elapsed: Duration::from_millis(187),
        }
    }

    fn discarded() -> HarvestAttempt {
        HarvestAttempt {
            outcome: Err(HarvestCondition::NoOpeningMark),
            shell: Some(Shell::LoginShell {
                program: "/bin/zsh".to_string(),
            }),
            stderr: Stderr::of(b"command not found: fnm\n"),
            elapsed: Duration::from_millis(212),
        }
    }

    fn value(folder: &FolderEnvironment, name: &str) -> String {
        String::from_utf8_lossy(
            folder
                .environment
                .get(name)
                .unwrap_or_else(|| panic!("{name} survived")),
        )
        .into_owned()
    }

    #[test]
    fn a_folder_is_asked_once_and_the_second_ask_is_the_first_answer() {
        let directory = TempDir::new().expect("a temporary directory");
        let asked = AtomicUsize::new(0);
        let take = |_: &Path| {
            asked.fetch_add(1, Ordering::SeqCst);
            settled("/opt/homebrew/bin")
        };
        let harvests = Harvests::new();

        let first = harvests.in_folder_with(directory.path(), &take);
        let second = harvests.in_folder_with(directory.path(), &take);

        // A harvest is a login shell running the operator's start-up files.
        // Once per folder is the whole reason this type exists.
        assert_eq!(asked.load(Ordering::SeqCst), 1);
        assert_eq!(value(&first, "PATH"), "/opt/homebrew/bin");
        assert!(Arc::ptr_eq(&first, &second));
    }

    #[test]
    fn the_operators_retry_is_the_only_thing_that_forgets() {
        let directory = TempDir::new().expect("a temporary directory");
        let asked = AtomicUsize::new(0);
        let take = |_: &Path| {
            asked.fetch_add(1, Ordering::SeqCst);
            settled("/opt/homebrew/bin")
        };
        let harvests = Harvests::new();

        harvests.in_folder_with(directory.path(), &take);
        harvests.in_folder_with(directory.path(), &take);
        harvests.again_in_folder_with(directory.path(), &take);
        harvests.in_folder_with(directory.path(), &take);

        // Two harvests for four asks, and the second one happened where the
        // operator said so. No clock ran and nothing was watched: the dangerous
        // case is a pin that has not changed while the installed set has, which
        // a watcher over the folder cannot see and a duration would only
        // re-take at random. There is accordingly no duration to pass to any
        // function on this type, and this crate's whole dependency list is
        // `thiserror` — there is nothing here that could watch.
        assert_eq!(asked.load(Ordering::SeqCst), 2);
        assert_eq!(harvests.directories().len(), 1);
    }

    #[test]
    fn two_spellings_of_one_folder_share_one_harvest() {
        let directory = TempDir::new().expect("a temporary directory");
        let asked = AtomicUsize::new(0);
        let take = |_: &Path| {
            asked.fetch_add(1, Ordering::SeqCst);
            settled("/opt/homebrew/bin")
        };
        let harvests = Harvests::new();

        harvests.in_folder_with(directory.path(), &take);
        harvests.in_folder_with(&directory.path().join("."), &take);

        // One directory, however it was spelled. Two keys would be two harvests
        // that could disagree about which interpreter the folder resolves under.
        assert_eq!(asked.load(Ordering::SeqCst), 1);
        assert_eq!(
            harvests.directories(),
            vec![spawn_directory(directory.path())]
        );
    }

    #[test]
    fn a_folder_whose_harvest_was_discarded_still_hands_back_an_environment() {
        let directory = TempDir::new().expect("a temporary directory");
        let harvests = Harvests::new();

        let folder = harvests.in_folder_with(directory.path(), &|_| discarded());

        // The value layer of "a missing CLI never blocks the folder from
        // opening": there is no way to reach a state where a caller has nothing
        // to resolve against, so nothing downstream needs a branch for one.
        assert!(!folder.from_harvest);
        assert_eq!(folder.condition, Some(HarvestCondition::NoOpeningMark));
        assert!(!folder.environment.is_empty());
        assert!(folder.environment.path().is_some());
        // And what the shell said survives the discard, on the same terms as it
        // does for the app-global harvest.
        assert_eq!(folder.stderr.text, "command not found: fnm\n");
        assert!(folder.shell.is_some());
        assert_eq!(folder.tally, Tally::default());
    }

    #[test]
    fn a_folder_whose_interpreter_declined_its_profile_says_so_beside_the_environment() {
        let directory = TempDir::new().expect("a temporary directory");
        let mut attempt = settled("C:\\Windows\\system32");
        attempt.stderr = Stderr::of(
            b"#< CLIXML\r\n<S S=\"Error\">File p.ps1 cannot _x000D__x000A_be loaded. \
              The file is not digitally signed._x000D__x000A_</S>",
        );
        let harvests = Harvests::new();

        let folder = harvests.in_folder_with(directory.path(), &|_| attempt.clone());

        // Exit 0, both marks, a clean environment — and the one artifact read
        // out of the stream rather than thrown away with it.
        assert!(folder.from_harvest);
        assert_eq!(folder.condition, None);
        assert_eq!(folder.degradation, Some(Degradation::ProfileRefused));
    }

    #[test]
    fn no_folder_harvest_is_laid_over_another() {
        let directory = TempDir::new().expect("a temporary directory");

        for shell in [
            Shell::LoginShell {
                program: "/bin/zsh".to_string(),
            },
            Shell::PowerShell {
                program: "powershell.exe".to_string(),
            },
        ] {
            let command = harvest_command_in(shell, &nonce(), directory.path().to_path_buf());

            // The child inherits this process's environment and never a
            // previous harvest's. A per-folder cache is a great many second
            // harvests, and one carrying the last one's `PATH` would compound
            // folder by folder.
            assert!(command.env_overlay.is_empty());
        }
    }

    /* ------------------------------------------ a real child, per folder --- */

    /// A stub that answers with the directory it was actually started in, so
    /// the assertion is about where the child ran rather than about what a
    /// hand-written transcript said. The frame is this crate's own grammar,
    /// spelled by [`opening_mark`] and [`closing_mark`] so the two cannot drift.
    #[cfg(unix)]
    fn says_where_it_started(directory: &Path) -> HarvestCommand {
        use std::os::unix::fs::PermissionsExt;

        let opening = String::from_utf8(opening_mark(&nonce())).expect("utf-8");
        let closing = String::from_utf8(closing_mark(&nonce())).expect("utf-8");
        let path = directory.join("wf45stub.sh");
        std::fs::write(
            &path,
            format!(
                "#!/bin/sh\nprintf '{opening}'\nprintf 'STARTED_IN=%s\\0' \"$(pwd -P)\"\n\
                 printf 'PATH=/wf45\\0'\nprintf '{closing}'\n"
            ),
        )
        .expect("writes the stub");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
            .expect("makes the stub a program");

        HarvestCommand {
            shell: Shell::LoginShell {
                program: path.to_string_lossy().into_owned(),
            },
            program: path.to_string_lossy().into_owned(),
            args: Vec::new(),
            cwd: PathBuf::new(),
            env_overlay: Vec::new(),
        }
    }

    /// `-EncodedCommand` rather than a `.ps1` file, so no execution policy is
    /// involved in running this suite's own stub. The marks go into a
    /// double-quoted string, which PowerShell lets span lines, and `` `0 `` is
    /// the NUL that ends the one record.
    #[cfg(windows)]
    fn says_where_it_started(_directory: &Path) -> HarvestCommand {
        let opening = String::from_utf8(opening_mark(&nonce())).expect("utf-8");
        let closing = String::from_utf8(closing_mark(&nonce())).expect("utf-8");
        let program = crate::shell::powershell_location(&|name| std::env::var(name).ok());
        let script = format!(
            "$o=[Console]::OpenStandardOutput()\n\
             $t=\"{opening}STARTED_IN=\" + (Get-Location).Path + \"`0PATH=C:\\wf45`0{closing}\"\n\
             $b=[Text.Encoding]::UTF8.GetBytes($t)\n\
             $o.Write($b,0,$b.Length)\n\
             $o.Flush()\n"
        );

        HarvestCommand {
            // `LoginShell` rather than `PowerShell`, because the tag is the only
            // thing the two grammars differ in and this stub writes untagged
            // records. The program really is powershell.
            shell: Shell::LoginShell {
                program: program.clone(),
            },
            program,
            args: vec![
                "-NoProfile".to_string(),
                "-NoLogo".to_string(),
                "-EncodedCommand".to_string(),
                crate::payload::encode_command(&script),
            ],
            cwd: PathBuf::new(),
            env_overlay: Vec::new(),
        }
    }

    #[test]
    fn the_harvest_a_folder_gets_is_the_one_it_started_in() {
        let elsewhere = TempDir::new().expect("a directory for the stub");
        let folder = TempDir::new().expect("the folder being opened");
        let harvests = Harvests::new();

        let opened = harvests.in_folder_with(folder.path(), &|directory| {
            let mut command = says_where_it_started(elsewhere.path());
            // Where the *child* is told to start, which is the whole mechanism:
            // no `cd`, no navigation, one field.
            command.cwd = spawnable_form(directory);
            harvest_with(&command, &nonce(), &roomy())
        });

        assert!(opened.from_harvest, "{:?}", opened.condition);
        assert_eq!(
            PathBuf::from(value(&opened, "STARTED_IN")),
            spawnable_form(&spawn_directory(folder.path())),
            "the child was spawned somewhere other than the folder it was given"
        );
        assert_eq!(opened.spawn_directory, spawn_directory(folder.path()));
    }
}

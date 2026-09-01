//! The working copy a research run is started in.
//!
//! Boundary: given the folder the operator picked and the ticket about to be
//! researched, this crate produces one git worktree at
//! `<folder>/.perseverance/worktrees/<ticket>` on branch
//! `research/<ticket>-<slug>`, and hides it from the repository's status by
//! appending one line to `.git/info/exclude`. That is the whole surface, and it
//! is the whole of what the harness writes inside somebody else's repository.
//!
//! Three rules the rest of the app leans on and this crate may not soften:
//!
//! - **Nothing here is written down anywhere else.** A worktree is a fact about
//!   git, discovered from git, and the registry's schema has no row for one.
//!   Nothing this app stored can therefore disagree with the disk: a worktree
//!   the operator deleted is missing, a worktree they kept is found again by a
//!   process that never made it, and neither is a row to reconcile.
//! - **Nothing is ever moved, forced, or removed without a slip.** A path
//!   holding something else refuses; a branch checked out elsewhere refuses;
//!   `git worktree add` exiting non-zero refuses; and `--force` appears in this
//!   crate exactly nowhere. Removal is a second verb, added by #60 and confined
//!   to the inventory: `git worktree remove` on a directory this app made, that
//!   has nothing uncommitted in it, and whose commits are already on a remote —
//!   and it deletes no branch, so the run's work outlives its working copy. What
//!   is still not run is `git worktree prune`: it is repository-wide and would
//!   drop registrations this app never made, and the narrow command turns out to
//!   clear a hand-deleted directory's registration by itself.
//! - **The operator's own files are appended to, never rewritten.** The exclude
//!   line goes on the end of `.git/info/exclude` if it is not already in it, and
//!   the tracked `.gitignore` is never touched — hiding the harness's scratch
//!   space is this machine's business, not a commit in the operator's history.
//!
//! Filled in by:
//! - #58 the worktree before the spawn
//! - #60 the inventory, its classification and its removal

mod inventory;

pub use inventory::{
    canonical, classify, inventory, parse, remove, InventoryError, Listed, Origin, Probed,
    Publication, Record, Removal, Working,
};

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// The line appended to `.git/info/exclude`.
///
/// Anchored with a leading slash so it hides the harness's directory at the root
/// of the repository and nothing that happens to be named the same deeper in the
/// tree, and it names the whole of `.perseverance/` rather than one ticket, so
/// the file is appended to once per repository however many research runs it
/// eventually holds.
const EXCLUDE_LINE: &str = "/.perseverance/";

/// How much of a ticket title survives into a branch name.
///
/// Long enough that two tickets are told apart by eye in `git branch`, short
/// enough that the branch fits in a terminal beside a prompt. The number is
/// arbitrary; that it is applied in one place is not.
const SLUG_LIMIT: usize = 40;

/// The working copy a research session runs in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Worktree {
    /// Absolute, and the directory the child is actually started in — which is
    /// also the key its environment is harvested under, so it has to be the
    /// path itself and never the folder it hangs off.
    pub path: PathBuf,
    pub branch: String,
}

/// The four ways a research run can fail to get a working copy.
///
/// Every one of them names something the operator can do next, because none of
/// them is the harness asking to be retried: a folder that is not a repository,
/// a path with somebody else's files in it, a machine with no `git`, and git
/// itself saying no are four different fixes.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum WorktreeError {
    /// No usable `.git` above the picked folder.
    ///
    /// The same fact [`perseverance_store::bind_repo`] refuses on, met again
    /// here because this crate is entitled to its own answer rather than to an
    /// assumption about what ran before it.
    #[error("this folder holds no usable .git, so there is no repository to make a worktree in")]
    NotAGitRepo,

    /// The path is taken by something that is not this ticket's worktree.
    ///
    /// Refused rather than cleared: whatever is there was put there by somebody,
    /// and this app has never been the one to decide it was rubbish. No branch
    /// is named in the sentence, because a branch is not what disqualified it:
    /// anything of this repository's on a `research/<ticket>` branch is ours
    /// whatever its slug says, so what is there is either not a worktree of this
    /// repository or not this ticket's work at all.
    #[error(
        "{} already holds something that is not #{ticket}'s worktree; move it aside \
         yourself — this app removes nothing it did not create",
        .path.display()
    )]
    Occupied { path: PathBuf, ticket: u64 },

    /// `git` could not be run at all.
    #[error(
        "no git could be run for #{ticket}'s worktree, and a research run needs one ({detail})"
    )]
    NoGit { ticket: u64, detail: String },

    /// `git worktree add` ran and said no — a branch already checked out in
    /// another worktree is the common one, and git's own last line says which.
    #[error("git would not make #{ticket}'s worktree on {branch}: {detail}")]
    GitRefused {
        ticket: u64,
        branch: String,
        detail: String,
    },

    /// The worktree exists but could not be hidden.
    ///
    /// A refusal rather than a shrug: a worktree the operator's `git status`
    /// reports as untracked noise in their own checkout is exactly the intrusion
    /// the exclude line exists to prevent, so a run that cannot promise it does
    /// not start.
    #[error("#{ticket}'s worktree cannot be hidden: {} could not be appended to ({detail})", .path.display())]
    NotHidden {
        ticket: u64,
        path: PathBuf,
        detail: String,
    },
}

/// The branch a research run on this ticket uses, derived and never stored.
///
/// The slug rule, in full: the title is folded to lowercase ASCII, every run of
/// anything that is not an ASCII letter or digit becomes a single `-`, leading
/// and trailing dashes are trimmed, and what is left is cut to [`SLUG_LIMIT`]
/// characters and trimmed again. Non-ASCII is dropped rather than transliterated
/// — a branch name is typed by hand on two operating systems, and a title in
/// another script is better as `research/58` than as something no one can spell
/// at a shell. A title that slugs to nothing yields exactly that: `research/58`
/// is a legal branch name, and the number is the part that identifies the work
/// anyway.
pub fn branch_for(ticket: u64, title: &str) -> String {
    let mut slug = String::new();
    for character in title.chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character.to_ascii_lowercase());
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }

    let slug = slug.trim_matches('-');
    let slug = match slug.char_indices().nth(SLUG_LIMIT) {
        Some((cut, _)) => slug[..cut].trim_matches('-'),
        None => slug,
    };

    match slug.is_empty() {
        true => format!("research/{ticket}"),
        false => format!("research/{ticket}-{slug}"),
    }
}

/// Where this ticket's worktree lives, whether or not it is there yet.
///
/// Derived rather than remembered, which is what lets a worktree be found again
/// by a process that never created it.
pub fn worktree_path(folder: &Path, ticket: u64) -> PathBuf {
    worktrees_root(folder).join(ticket.to_string())
}

/// The directory every worktree this app makes lives directly under.
///
/// Exported because it is what *ours* means: the inventory classifies an entry
/// by whether git's path for it is under this one, and a second spelling of the
/// same three components is how that question quietly starts answering *foreign*
/// about our own directories.
pub fn worktrees_root(folder: &Path) -> PathBuf {
    folder.join(".perseverance").join("worktrees")
}

/// The worktree this research run gets: reused if it is already there, created
/// if it is not.
///
/// Reuse is silent and is the ordinary case — a second press on the same ticket
/// after the first run ended finds the same branch with the same commits on it,
/// and starting a run is not a reason to lose them. *Already there* means a
/// worktree of **this** repository on **some** `research/<ticket>` branch, and
/// the branch it is actually on is the one returned. The title is not part of
/// the question: it is a mutable field on somebody else's issue tracker, and a
/// rename between two presses would otherwise make the second one refuse a
/// directory that is plainly the first one's — with the run's commits stranded
/// on a branch nothing points at. The ticket number is the half that cannot
/// change, so it is the half identity is keyed on. Anything else at that path is
/// somebody else's and refuses.
///
/// The title is still what *names* a branch that does not exist yet, and only
/// then: a first press slugs it, and every press after that inherits whatever
/// the first one wrote.
///
/// The exclude line is appended on every call, including a reuse, because it is
/// idempotent and because the operator may have tidied it away between two
/// presses. It is the last step: a worktree that exists but is not hidden yet is
/// a state worth failing out of, and one that is hidden but does not exist is
/// not a state at all.
pub fn worktree_for(folder: &Path, ticket: u64, title: &str) -> Result<Worktree, WorktreeError> {
    let common = perseverance_store::common_git_dir(folder).ok_or(WorktreeError::NotAGitRepo)?;
    let path = worktree_path(folder, ticket);

    let branch = match path.exists() {
        true => match ours_at(&path, &common, ticket) {
            Some(branch) => branch,
            None => return Err(WorktreeError::Occupied { path, ticket }),
        },
        false => {
            let branch = branch_for(ticket, title);
            add(folder, &path, &branch, ticket, &common)?;
            branch
        }
    };

    hide(&common, ticket)?;

    Ok(Worktree {
        // Canonicalised last, so the answer is the spelling the filesystem
        // itself uses: this path becomes a harvest key and a child's working
        // directory, and two spellings of one directory would be two harvests.
        //
        // Through `inventory::canonical` and not `std::fs::canonicalize`, for
        // exactly that reason. On Windows the bare call answers an
        // extended-length path (`\\?\C:\…`) while `git worktree list
        // --porcelain` prints `C:/…`, so the worktree this function just made
        // and the entry the listing reports for it would be two spellings of
        // one directory — which is the second harvest this comment forbids.
        path: inventory::canonical(&path),
        branch,
    })
}

/// The branch this ticket's worktree is on, if what is at the path is ours.
///
/// Two questions, and both have to answer yes. *Ours* is asked of the shared git
/// directory rather than of the path — a worktree of a different clone, or a
/// clone of its own, is not this repository's working copy however it is spelled
/// — and the branch is read out of the worktree's own `HEAD`.
///
/// The second question is asked of the branch's stem only: `research/<ticket>`
/// exactly, or `research/<ticket>-` and then anything. The slug is derived from
/// a title that anyone can edit on GitHub between two presses, so an equality
/// against a freshly derived name would answer *not ours* about the worktree
/// this very ticket is standing in. The `-` is required rather than assumed:
/// without it `research/580-…` would answer for #58.
///
/// The branch that comes back is the one on disk, never the one the caller would
/// have derived — a reused worktree keeps the name it was made under, so the
/// commits of every earlier run on this ticket stay on one branch.
fn ours_at(path: &Path, common: &Path, ticket: u64) -> Option<String> {
    let same_repository = perseverance_store::common_git_dir(path)
        .map(|theirs| same_directory(&theirs, common))
        .unwrap_or(false);
    if !same_repository {
        return None;
    }

    let branch = checked_out_branch(path)?;
    let stem = format!("research/{ticket}");
    match branch == stem || branch.starts_with(&format!("{stem}-")) {
        true => Some(branch),
        false => None,
    }
}

/// The branch checked out in a worktree, read as text.
///
/// A worktree's `.git` is a file pointing at a directory under the clone's
/// `worktrees/`, and that directory's `HEAD` is the one fact wanted here. Read
/// rather than asked of `git`, so *is this already ours?* is answerable on a
/// machine where the answer is no because there is no git at all.
fn checked_out_branch(path: &Path) -> Option<String> {
    let pointer = std::fs::read_to_string(path.join(".git")).ok()?;
    let target = pointer
        .lines()
        .find_map(|line| line.trim().strip_prefix("gitdir:"))?
        .trim();
    let target = PathBuf::from(target);
    let target = match target.is_absolute() {
        true => target,
        false => path.join(target),
    };

    let head = std::fs::read_to_string(target.join("HEAD")).ok()?;
    Some(
        head.trim()
            .strip_prefix("ref: refs/heads/")?
            .trim()
            .to_string(),
    )
}

/// Two paths naming one directory, canonicalised where the filesystem will say
/// so and compared as written where it will not.
pub(crate) fn same_directory(left: &Path, right: &Path) -> bool {
    let canonical =
        |path: &Path| std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    canonical(left) == canonical(right)
}

/// The one `git` this crate runs.
///
/// `-b` only when the branch is not there yet. A branch that already exists —
/// the shape left behind by an operator who deleted the directory and kept the
/// history — is checked out into the new worktree instead, because the
/// alternative spellings are `-B`, which resets somebody's commits, and a
/// refusal that leaves them with no way back to their own work.
fn add(
    folder: &Path,
    path: &Path,
    branch: &str,
    ticket: u64,
    common: &Path,
) -> Result<(), WorktreeError> {
    // git creates the leading directories itself; this is here so that a
    // failure to make `.perseverance/worktrees` is reported as the filesystem
    // error it is rather than as a line of git's stderr.
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|failure| WorktreeError::GitRefused {
            ticket,
            branch: branch.to_string(),
            detail: failure.to_string(),
        })?;
    }

    let mut command = Command::new("git");
    command.arg("-C").arg(folder).arg("worktree").arg("add");
    if branch_exists(common, branch) {
        command.arg(path).arg(branch);
    } else {
        command.arg("-b").arg(branch).arg(path);
    }
    // A prompt for a credential or a hook's input would hang a press with no
    // terminal to answer it in. There is nothing to type at this child.
    command.stdin(Stdio::null());

    let finished = command.output().map_err(|failure| WorktreeError::NoGit {
        ticket,
        detail: failure.to_string(),
    })?;

    if finished.status.success() {
        return Ok(());
    }

    Err(WorktreeError::GitRefused {
        ticket,
        branch: branch.to_string(),
        detail: refusal_from(&finished.stderr),
    })
}

/// Whether a branch of that name is already in the repository, loose or packed.
///
/// Read off disk rather than asked of `git rev-parse`, for the reason every
/// other read here is: one process is started per press, and it is the one that
/// changes something.
pub(crate) fn branch_exists(common: &Path, branch: &str) -> bool {
    let loose = branch
        .split('/')
        .fold(common.join("refs").join("heads"), |path, part| {
            path.join(part)
        });
    if loose.exists() {
        return true;
    }

    let reference = format!("refs/heads/{branch}");
    std::fs::read_to_string(common.join("packed-refs"))
        .map(|packed| {
            packed
                .lines()
                .filter_map(|line| line.split_once(' '))
                .any(|(_, name)| name.trim() == reference)
        })
        .unwrap_or(false)
}

/// Appends the exclude line if it is not already there, and nothing otherwise.
///
/// The append is the whole write: the file is opened in append mode, never read
/// back and rewritten, so an operator's own excludes cannot be reordered, folded
/// or truncated by a press of ours. A file that does not end in a newline gets
/// one first, because gluing our line onto the end of theirs would silently
/// change what they excluded.
fn hide(common: &Path, ticket: u64) -> Result<(), WorktreeError> {
    let info = common.join("info");
    let exclude = info.join("exclude");
    let refuse = |failure: std::io::Error| WorktreeError::NotHidden {
        ticket,
        path: exclude.clone(),
        detail: failure.to_string(),
    };

    let existing = std::fs::read_to_string(&exclude).unwrap_or_default();
    if existing.lines().any(|line| line.trim() == EXCLUDE_LINE) {
        return Ok(());
    }

    std::fs::create_dir_all(&info).map_err(refuse)?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&exclude)
        .map_err(refuse)?;

    let opening = match existing.is_empty() || existing.ends_with('\n') {
        true => "",
        false => "\n",
    };
    file.write_all(format!("{opening}{EXCLUDE_LINE}\n").as_bytes())
        .map_err(refuse)
}

/// What git said, minus the progress line it says on the way in.
///
/// Its `hint:` lines are kept rather than trimmed to the `fatal:`, because they
/// are the half that names the command the operator would run next — *use
/// `prune`*, for a worktree whose directory they deleted by hand — and this
/// crate is deliberately not the thing that runs it for them.
pub(crate) fn refusal_from(stderr: &[u8]) -> String {
    let said = String::from_utf8_lossy(stderr);
    let said: Vec<&str> = said
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with("Preparing worktree"))
        .collect();

    match said.is_empty() {
        true => "git said nothing".to_string(),
        false => said.join("; "),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use tempfile::TempDir;

    /// A repository with one commit, or `None` where this machine has no git.
    ///
    /// CI is a Windows and macOS matrix and both have git, but a contributor's
    /// container may not, and a test that cannot run is not a test that failed.
    pub(crate) fn a_repository() -> Option<TempDir> {
        let folder = TempDir::new().expect("a temporary directory");
        let run = |arguments: &[&str]| -> Option<bool> {
            Command::new("git")
                .arg("-C")
                .arg(folder.path())
                .args(arguments)
                .stdin(Stdio::null())
                .output()
                .ok()
                .map(|finished| finished.status.success())
        };

        run(&["init", "--initial-branch=main"])?.then_some(())?;
        run(&["config", "user.email", "harness@example.invalid"])?;
        run(&["config", "user.name", "Harness"])?;
        std::fs::write(folder.path().join("README.md"), "a repository\n").expect("writes a file");
        run(&["add", "README.md"])?;
        run(&["commit", "-m", "first"])?;

        Some(folder)
    }

    /// Where a branch points, asked of git rather than of this crate's own
    /// reading, so a test about a branch surviving is not checked by the code it
    /// is checking.
    pub(crate) fn tip_of(folder: &Path, branch: &str) -> Option<String> {
        let finished = Command::new("git")
            .arg("-C")
            .arg(folder)
            .args(["rev-parse", &format!("refs/heads/{branch}")])
            .output()
            .ok()?;
        finished
            .status
            .success()
            .then(|| String::from_utf8_lossy(&finished.stdout).trim().to_string())
    }

    fn excludes(folder: &Path) -> String {
        let common = perseverance_store::common_git_dir(folder).expect("a git directory");
        std::fs::read_to_string(common.join("info").join("exclude")).unwrap_or_default()
    }

    #[test]
    fn a_title_becomes_one_lowercase_dashed_run() {
        assert_eq!(
            branch_for(58, "The worktree before the spawn"),
            "research/58-the-worktree-before-the-spawn"
        );
        assert_eq!(
            branch_for(7, "  Spaces, punctuation -- and CAPS!  "),
            "research/7-spaces-punctuation-and-caps"
        );
    }

    /// The two titles a naive rule produces an illegal ref from: one that has
    /// nothing to slug, and one that would end on a dash after the cut.
    #[test]
    fn a_title_that_slugs_to_nothing_is_still_a_branch() {
        assert_eq!(branch_for(58, "—— ??? ——"), "research/58");
        assert_eq!(branch_for(58, ""), "research/58");

        let long = branch_for(
            58,
            "a ridiculously long title about nothing i in particular",
        );
        assert!(!long.ends_with('-'), "{long}");
        assert!(long.len() <= "research/58-".len() + SLUG_LIMIT, "{long}");
    }

    #[test]
    fn a_folder_that_is_no_repository_refuses() {
        let folder = TempDir::new().expect("a temporary directory");
        assert_eq!(
            worktree_for(folder.path(), 58, "anything"),
            Err(WorktreeError::NotAGitRepo)
        );
    }

    #[test]
    fn the_worktree_lands_where_it_says_on_the_branch_it_says() {
        let Some(folder) = a_repository() else {
            return;
        };

        let made = worktree_for(folder.path(), 58, "The worktree before the spawn")
            .expect("makes a worktree");

        assert_eq!(made.branch, "research/58-the-worktree-before-the-spawn");
        assert!(made.path.is_absolute(), "{}", made.path.display());
        assert!(
            same_directory(&made.path, &worktree_path(folder.path(), 58)),
            "{}",
            made.path.display()
        );
        assert_eq!(
            checked_out_branch(&made.path).as_deref(),
            Some(&*made.branch)
        );
    }

    /// The exclude line lands in git's local file and the tracked one is never
    /// created, because hiding this app's scratch space is this machine's
    /// business and not a change to somebody's repository.
    #[test]
    fn the_worktree_is_hidden_in_the_local_exclude_and_nowhere_tracked() {
        let Some(folder) = a_repository() else {
            return;
        };

        worktree_for(folder.path(), 58, "a title").expect("makes a worktree");

        assert!(excludes(folder.path()).contains(EXCLUDE_LINE));
        assert!(
            !folder.path().join(".gitignore").exists(),
            "a tracked ignore file was written"
        );

        let status = Command::new("git")
            .arg("-C")
            .arg(folder.path())
            .args(["status", "--porcelain"])
            .output()
            .expect("runs git status");
        let reported = String::from_utf8_lossy(&status.stdout);
        assert!(
            !reported.contains(".perseverance"),
            "the worktree shows up in the operator's status: {reported}"
        );
    }

    #[test]
    fn an_operators_own_excludes_survive_and_the_line_is_written_once() {
        let Some(folder) = a_repository() else {
            return;
        };
        let common = perseverance_store::common_git_dir(folder.path()).expect("a git directory");
        std::fs::create_dir_all(common.join("info")).expect("makes info");
        // No trailing newline on purpose: the operator's last line may not be
        // absorbed into ours.
        std::fs::write(common.join("info").join("exclude"), "*.log\nscratch/").expect("writes");

        worktree_for(folder.path(), 58, "a title").expect("makes a worktree");
        worktree_for(folder.path(), 58, "a title").expect("reuses the worktree");

        let after = excludes(folder.path());
        assert!(after.starts_with("*.log\nscratch/\n"), "{after}");
        assert_eq!(
            after.lines().filter(|line| *line == EXCLUDE_LINE).count(),
            1,
            "{after}"
        );
    }

    /// A second press on the same ticket is the ordinary case, and it is the
    /// same directory on the same branch with whatever was committed still in
    /// it — not a second worktree and not a refusal.
    #[test]
    fn a_second_press_reuses_the_same_worktree() {
        let Some(folder) = a_repository() else {
            return;
        };

        let first = worktree_for(folder.path(), 58, "a title").expect("makes a worktree");
        std::fs::write(first.path.join("notes.md"), "kept\n").expect("writes in the worktree");

        let again = worktree_for(folder.path(), 58, "a title").expect("reuses the worktree");

        assert_eq!(again, first);
        assert_eq!(
            std::fs::read_to_string(first.path.join("notes.md")).expect("still there"),
            "kept\n"
        );

        let listed = Command::new("git")
            .arg("-C")
            .arg(folder.path())
            .args(["worktree", "list", "--porcelain"])
            .output()
            .expect("runs git worktree list");
        let listed = String::from_utf8_lossy(&listed.stdout);
        assert_eq!(
            listed.matches("branch refs/heads/research/58").count(),
            1,
            "{listed}"
        );
    }

    /// A title is somebody else's mutable field. Renaming the ticket on GitHub
    /// between two presses changes the slug it would derive, and it may not
    /// change the answer to *is this ticket's worktree already there?* — the run
    /// resumes on the branch the first press made, with its commits on it.
    #[test]
    fn a_retitled_ticket_reuses_the_worktree_the_first_press_made() {
        let Some(folder) = a_repository() else {
            return;
        };

        let first = worktree_for(folder.path(), 58, "a title").expect("makes a worktree");
        std::fs::write(first.path.join("notes.md"), "kept\n").expect("writes in the worktree");

        let again = worktree_for(folder.path(), 58, "a wholly different title")
            .expect("reuses the worktree");

        assert_eq!(again, first);
        assert_eq!(again.branch, "research/58-a-title");
        assert_eq!(
            std::fs::read_to_string(again.path.join("notes.md")).expect("still there"),
            "kept\n"
        );
    }

    /// A directory the operator deleted by hand leaves git holding a record of
    /// it, and clearing that record is `git worktree prune` — a repository-wide
    /// delete of registrations this app did not all make. So the press refuses
    /// and says the word, rather than reconciling on the operator's behalf.
    #[test]
    fn a_worktree_deleted_by_hand_refuses_and_names_the_way_out() {
        let Some(folder) = a_repository() else {
            return;
        };

        let first = worktree_for(folder.path(), 58, "a title").expect("makes a worktree");
        std::fs::remove_dir_all(&first.path).expect("the operator deletes it");

        let refusal = worktree_for(folder.path(), 58, "a title").expect_err("refuses");

        assert!(refusal.to_string().contains("prune"), "{refusal}");
        assert!(branch_exists(
            &perseverance_store::common_git_dir(folder.path()).expect("a git directory"),
            &first.branch
        ));
    }

    /// Somebody else's files at that path are somebody else's. The refusal is a
    /// sentence, and everything that was there is still there afterwards.
    #[test]
    fn a_path_holding_something_else_refuses_and_touches_nothing() {
        let Some(folder) = a_repository() else {
            return;
        };
        let occupied = worktree_path(folder.path(), 58);
        std::fs::create_dir_all(&occupied).expect("makes the directory");
        std::fs::write(occupied.join("theirs.txt"), "mine\n").expect("writes their file");

        let refusal = worktree_for(folder.path(), 58, "a title").expect_err("refuses");

        assert!(
            refusal
                .to_string()
                .contains("removes nothing it did not create"),
            "{refusal}"
        );
        assert_eq!(
            std::fs::read_to_string(occupied.join("theirs.txt")).expect("still there"),
            "mine\n"
        );
        assert!(
            !excludes(folder.path()).contains(EXCLUDE_LINE),
            "a refused press still wrote to the operator's repository"
        );
    }
}

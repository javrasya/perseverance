//! Every worktree of the bound repository, read out of git on every call.
//!
//! The listing is the other half of [`crate::worktree_for`]: that one makes a
//! working copy, this one says what is there and which of it this app is
//! entitled to take away. Both answers come from git and neither is written
//! down, so nothing this app remembers can disagree with the disk — a worktree
//! the operator deleted by hand is a state in this list rather than a row to
//! reconcile.
//!
//! Four rules hold the whole module up, and each of them is a thing the operator
//! would not forgive being wrong:
//!
//! - **A worktree that is not ours is never touched.** Not removed, not locked,
//!   not even asked what is dirty in it. *Ours* is a path under
//!   `<folder>/.perseverance/worktrees/` that names a ticket; everything else,
//!   the operator's own main worktree included, is [`Origin::Foreign`] and gets
//!   no probes and no offer. The immunity is structural: [`remove`] takes a
//!   [`Removal`], whose fields are private and which is minted in exactly one
//!   place — [`offer`], on an ours entry that passed every rule below.
//! - **Removal is offered on pushed, never on merged.** A branch counts as
//!   pushed when every commit on it is already reachable from a remote-tracking
//!   ref this clone has. Waiting for a merge instead would pin every worktree
//!   open behind an unreviewed pull request, which is the failure #60 exists to
//!   end. Pushedness is read from the refs already on this disk: there is no
//!   `fetch` and no `ls-remote` in this module, so the readout is honest about
//!   being what *this clone* knows and nothing more.
//! - **Uncommitted work removes the offer entirely.** Not a warning, not a
//!   confirmation, not a `--force` behind a second press — the entry carries the
//!   porcelain lines so the caller can print what is in the way, and there is no
//!   spelling of the removal that goes ahead anyway.
//! - **No branch is ever deleted.** `git worktree remove` unregisters a working
//!   copy and leaves `refs/heads/<branch>` exactly where it was, which is why a
//!   removal is a cheap thing to offer: the commits of the run are still on a
//!   branch afterwards, and the operator can make the working copy again.
//!
//! Filled in by:
//! - #60 the worktree inventory, its classification and its removal

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::refusal_from;

/// One record of `git worktree list --porcelain`, as git said it.
///
/// Fields are git's, not this app's: nothing here is interpreted, so a record
/// this app does not understand still travels through the list intact.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Record {
    /// Absolute, and as git spelled it — which is the path with symlinks
    /// resolved, so it compares against a canonicalised root without further
    /// work.
    pub path: PathBuf,
    /// The commit checked out there. Absent on a bare repository's record.
    pub head: Option<String>,
    /// The branch, with `refs/heads/` off the front. Absent when the worktree is
    /// detached or bare.
    pub branch: Option<String>,
    pub detached: bool,
    pub bare: bool,
    /// `Some` when git holds the worktree locked, carrying the operator's reason
    /// where they gave one and empty where they did not.
    pub locked: Option<String>,
    /// `Some` when git's registration points at a directory that is not there —
    /// almost always because somebody deleted it by hand. Git's own words for
    /// why, so the readout can say them.
    pub prunable: Option<String>,
}

/// Whose worktree this is.
///
/// The question this app is allowed to act on is not *is it a research
/// worktree?* but *did this app make it?*, and the two differ on exactly the
/// entries where being wrong is expensive: a directory under our own
/// `.perseverance/worktrees/` that names no ticket is not ours, because nothing
/// here made it, and it is left alone with everything else that is somebody's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Origin {
    /// A worktree this app created for a ticket.
    Ours {
        ticket: u64,
        /// The ticket is not in the set the caller knows about.
        ///
        /// A label and never a licence: an orphan gets the same rules as every
        /// other entry of ours, and is reaped by nothing on its own. It is
        /// worth saying because it is the entry the operator forgot they had —
        /// the ticket closed, or was deleted, or the map moved on — and it is
        /// the one they came to this list to find.
        orphan: bool,
    },
    /// Anybody else's, including the repository's own main worktree.
    Foreign,
}

/// What is uncommitted in a worktree of ours.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Working {
    /// `git status --porcelain` said nothing at all.
    Clean,
    /// It said something. Every line of it, verbatim, for printing: the operator
    /// is being told why a removal is not on offer, and a count would not answer
    /// that.
    Uncommitted { lines: Vec<String> },
    /// The directory is not there, so there is nothing in it to lose. An absence
    /// rather than a failure — this is the ordinary shape of a worktree the
    /// operator deleted by hand, and it is the state that makes the leftover
    /// registration safe to clear.
    Gone,
    /// git was asked and would not answer. Not clean, therefore not removable:
    /// an unanswered question about somebody's uncommitted work is a no.
    Unreadable { detail: String },
}

/// How much of a branch this clone has seen on a remote.
///
/// Read from remote-tracking refs already on this disk. Whatever the remote has
/// gained since the last fetch is not in the answer, and the readout says so
/// rather than reaching for the network to find out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Publication {
    /// Every commit on the branch is reachable from some remote-tracking ref
    /// this clone holds.
    Pushed,
    /// This many commits are on no remote-tracking ref this clone holds. The
    /// number is what the operator needs to decide whether to care.
    Unpushed { commits: usize },
    /// The worktree is on no branch, so there is nothing that could have been
    /// pushed. Removing it would leave its commits reachable from nothing but
    /// the reflog, so it is not offered.
    Detached,
    /// git was asked and would not answer.
    Unknown { detail: String },
}

/// What the probes said about a worktree of ours.
///
/// Absent on a foreign entry, because a foreign worktree is not asked: running
/// `git status` in a colleague's working copy tells this app nothing it is
/// allowed to use, and the whole posture here is that it is none of our
/// business.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Probed {
    pub working: Working,
    pub publication: Publication,
}

/// Permission to remove one worktree, minted by [`offer`] and by nothing else.
///
/// The point of the type is that [`remove`] cannot be called on an entry the
/// rules did not clear, because there is no way to build its argument: the
/// fields are private, there is no public constructor, and the one function that
/// returns it takes a classified entry and applies every rule first. *Foreign is
/// never removed* is therefore a thing the compiler enforces outside this module
/// rather than an `if` somebody can delete.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Removal {
    path: PathBuf,
    ticket: u64,
}

impl Removal {
    /// The directory that would be unregistered.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The ticket whose worktree it is.
    pub fn ticket(&self) -> u64 {
        self.ticket
    }
}

/// One worktree, classified, and — where it is ours — probed and judged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listed {
    pub record: Record,
    pub origin: Origin,
    /// `None` for a foreign entry, and for anything the classifier produced
    /// before the probes ran.
    pub probed: Option<Probed>,
    /// `Some` exactly when every rule cleared this entry. The caller offers the
    /// operator a removal if and only if this is here.
    pub removal: Option<Removal>,
}

/// The four ways this list can fail to be read, and neither of them is a retry.
///
/// Each names a fact about a folder on this disk: no git on the machine, no
/// repository under the folder, git saying no to a listing, git saying no to a
/// removal. None of them is a network condition, because nothing in this module
/// touches the network.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum InventoryError {
    /// No usable `.git` above the folder.
    #[error("this folder holds no usable .git, so it has no worktrees to list")]
    NotAGitRepo,

    /// `git` could not be run at all.
    #[error("no git could be run to list this folder's worktrees ({detail})")]
    NoGit { detail: String },

    /// `git worktree list` ran and said no.
    #[error("git would not list this folder's worktrees: {detail}")]
    ListRefused { detail: String },

    /// `git worktree remove` ran and said no — a lock git was not told to
    /// ignore, or a working copy git found something in, and its own last line
    /// says which.
    #[error("git would not remove the worktree at {}: {detail}", .path.display())]
    RemovalRefused { path: PathBuf, detail: String },
}

/// Every worktree of the repository under `folder`, classified and probed.
///
/// `known_tickets` is the caller's — the app's snapshot of the map, passed in
/// rather than reached for. This crate does not know what a ticket is beyond a
/// number, and the join that turns *ours* into *orphan* is a set lookup rather
/// than a dependency on the model.
///
/// One `git worktree list` for the whole repository, then two reads per entry of
/// ours and none at all per foreign entry. Nothing is cached: the answer is
/// about a directory anybody can change between two calls, and a stale listing
/// offering to remove something is worse than a listing that costs two
/// processes.
pub fn inventory(
    folder: &Path,
    known_tickets: &BTreeSet<u64>,
) -> Result<Vec<Listed>, InventoryError> {
    perseverance_store::common_git_dir(folder).ok_or(InventoryError::NotAGitRepo)?;

    // Spelled out here rather than behind a helper: `scripts/check-repo-writes.mjs`
    // bounds what this workspace runs by reading the argv literals of each
    // `Command::new("git")` chain, and an argv assembled somewhere else is an
    // argv that check cannot see.
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(folder)
        .args(["worktree", "list", "--porcelain"])
        .stdin(Stdio::null());
    let listed = command.output().map_err(|failure| InventoryError::NoGit {
        detail: failure.to_string(),
    })?;
    if !listed.status.success() {
        return Err(InventoryError::ListRefused {
            detail: refusal_from(&listed.stderr),
        });
    }

    let records = parse(&String::from_utf8_lossy(&listed.stdout));

    let root = canonical(&crate::worktrees_root(folder));
    let mut inventory = classify(&root, records, known_tickets);
    for entry in &mut inventory {
        let Origin::Ours { ticket, .. } = entry.origin else {
            continue;
        };

        let probed = Probed {
            working: working_state(&entry.record),
            publication: publication_of(folder, entry.record.branch.as_deref()),
        };
        entry.removal = offer(&entry.record, &probed, ticket);
        entry.probed = Some(probed);
    }

    Ok(inventory)
}

/// Unregisters one worktree, and does nothing else whatsoever.
///
/// No branch is deleted, here or anywhere in this crate: `git worktree remove`
/// takes the working copy out of git's registration and leaves
/// `refs/heads/<branch>` pointing at the same commit it pointed at before. That
/// is what makes the offer safe to accept — the run's work is still on a branch,
/// and `worktree_for` will hand the same branch back if the operator wants the
/// directory again.
///
/// A directory the operator already deleted is removed by the same command and
/// is not a special case: git clears its own registration and says nothing. No
/// `git worktree prune` is run for it, because prune is repository-wide and
/// would drop registrations this app never made — ADR 0022's refusal, still
/// standing, now that the narrow command turns out to cover the case the broad
/// one was wanted for.
///
/// `--force` appears nowhere: a lock the operator set, or a state git will not
/// unregister quietly, comes back as [`InventoryError::RemovalRefused`] with
/// git's own sentence in it.
pub fn remove(folder: &Path, removal: &Removal) -> Result<(), InventoryError> {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(folder)
        .arg("worktree")
        .arg("remove")
        .arg(&removal.path)
        .stdin(Stdio::null());

    let finished = command.output().map_err(|failure| InventoryError::NoGit {
        detail: failure.to_string(),
    })?;

    match finished.status.success() {
        true => Ok(()),
        false => Err(InventoryError::RemovalRefused {
            path: removal.path.clone(),
            detail: refusal_from(&finished.stderr),
        }),
    }
}

/// `git worktree list --porcelain`, as records.
///
/// A pure function over text on purpose: the format is the part most likely to
/// meet something this app has never seen — a bare repository, a lock with no
/// reason, a path with a space in it — and every one of those is a string in a
/// test rather than a repository somebody has to build first.
///
/// Records are separated by blank lines and each begins with `worktree <path>`.
/// Anything before the first `worktree` line, and any field this app has no use
/// for, is skipped rather than refused: a listing from a newer git that grew a
/// field is still a listing.
pub fn parse(porcelain: &str) -> Vec<Record> {
    let mut records = Vec::new();
    let mut current: Option<Record> = None;

    for line in porcelain.lines() {
        let line = line.trim_end();
        let (field, value) = match line.split_once(' ') {
            Some((field, value)) => (field, value.trim()),
            None => (line, ""),
        };

        match field {
            "worktree" => {
                records.extend(current.take());
                current = Some(Record {
                    path: PathBuf::from(value),
                    head: None,
                    branch: None,
                    detached: false,
                    bare: false,
                    locked: None,
                    prunable: None,
                });
            }
            _ => {
                let Some(record) = current.as_mut() else {
                    continue;
                };
                match field {
                    "HEAD" => record.head = Some(value.to_string()),
                    // Kept as the short name because that is what the operator
                    // reads and what `rev-list` is happy to be given.
                    "branch" => {
                        record.branch = Some(
                            value
                                .strip_prefix("refs/heads/")
                                .unwrap_or(value)
                                .to_string(),
                        )
                    }
                    "detached" => record.detached = true,
                    "bare" => record.bare = true,
                    "locked" => record.locked = Some(value.to_string()),
                    "prunable" => record.prunable = Some(value.to_string()),
                    _ => {}
                }
            }
        }
    }

    records.extend(current);
    records
}

/// Ours or foreign, and which of ours the caller has forgotten about.
///
/// Pure, and deliberately: it touches no filesystem and starts no process, so
/// the rule that decides what this app may delete is tested against hand-written
/// text on a machine with no git and no repository.
///
/// `root` is `<folder>/.perseverance/worktrees`, canonicalised by the caller,
/// because git prints canonical paths and a comparison between one canonical
/// path and one symlinked one answers *foreign* about our own directory.
///
/// The ticket is read from the last path component and, failing that, from the
/// stem of a `research/<ticket>-<slug>` branch. Both, rather than either: the
/// directory name is what this app writes, and the branch is what survives an
/// operator who moved the directory with `git worktree move`. An entry under our
/// own root that yields no ticket by either route is **foreign** — nothing here
/// made it, and there is no cost to leaving alone something we cannot name.
pub fn classify(root: &Path, records: Vec<Record>, known_tickets: &BTreeSet<u64>) -> Vec<Listed> {
    records
        .into_iter()
        .map(|record| {
            let origin = match ticket_of(root, &record) {
                Some(ticket) => Origin::Ours {
                    ticket,
                    orphan: !known_tickets.contains(&ticket),
                },
                None => Origin::Foreign,
            };
            Listed {
                record,
                origin,
                probed: None,
                removal: None,
            }
        })
        .collect()
}

/// The ticket this record is a worktree of, or `None` if it is not ours.
fn ticket_of(root: &Path, record: &Record) -> Option<u64> {
    // The root itself is not under the root, so the main worktree cannot be ours
    // even if the operator picked a folder inside somebody's `.perseverance`.
    if !record.path.starts_with(root) || record.path == root {
        return None;
    }

    let named = record
        .path
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.parse::<u64>().ok());
    if named.is_some() {
        return named;
    }

    let branch = record.branch.as_deref()?;
    let rest = branch.strip_prefix("research/")?;
    let stem = rest.split_once('-').map(|(stem, _)| stem).unwrap_or(rest);
    stem.parse::<u64>().ok()
}

/// Whether this entry may be removed, and the slip that says so.
///
/// The only place a [`Removal`] is made, and the whole of the rule:
///
/// - Uncommitted work, or a `git status` that would not answer, is a no. There
///   is no confirmation behind which it becomes a yes.
/// - A branch with commits on no remote this clone has seen is a no, and so is a
///   detached HEAD, which has no branch to have pushed. *Pushed*, never
///   *merged*: a worktree waiting for review is a worktree the operator can have
///   their disk back from, because everything in it is on a remote.
/// - A lock is a no. The operator wrote that lock down in git themselves, and
///   the spelling that overrides it is `--force`, which this crate does not say.
/// - A directory that is already gone is a **yes** where a clean one would be:
///   there is nothing in it to lose, and the leftover registration is exactly
///   the litter the operator opened this list to clear. Its branch is still
///   checked for pushedness, because refs live in the shared git directory and
///   outlive the working copy.
fn offer(record: &Record, probed: &Probed, ticket: u64) -> Option<Removal> {
    if record.locked.is_some() {
        return None;
    }
    match probed.working {
        Working::Clean | Working::Gone => {}
        Working::Uncommitted { .. } | Working::Unreadable { .. } => return None,
    }
    match probed.publication {
        Publication::Pushed => {}
        Publication::Unpushed { .. } | Publication::Detached | Publication::Unknown { .. } => {
            return None
        }
    }

    Some(Removal {
        path: record.path.clone(),
        ticket,
    })
}

/// What `git status --porcelain` says in the worktree, or that it is not there.
///
/// The absence is answered before git is asked rather than by reading a failure:
/// a missing directory is an ordinary state of this list, and a state inferred
/// from an error message is a state that changes when git rewords one.
fn working_state(record: &Record) -> Working {
    if record.prunable.is_some() || !record.path.is_dir() {
        return Working::Gone;
    }

    let finished = Command::new("git")
        .arg("-C")
        .arg(&record.path)
        .args(["status", "--porcelain"])
        .stdin(Stdio::null())
        .output();

    let finished = match finished {
        Ok(finished) => finished,
        Err(failure) => {
            return Working::Unreadable {
                detail: failure.to_string(),
            }
        }
    };
    if !finished.status.success() {
        return Working::Unreadable {
            detail: refusal_from(&finished.stderr),
        };
    }

    let lines: Vec<String> = String::from_utf8_lossy(&finished.stdout)
        .lines()
        .map(str::trim_end)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect();

    match lines.is_empty() {
        true => Working::Clean,
        false => Working::Uncommitted { lines },
    }
}

/// How many commits of this branch are on no remote-tracking ref this clone has.
///
/// `rev-list --count <branch> --not --remotes` rather than a comparison against
/// a configured upstream, for two reasons. A research branch pushed by the agent
/// may have no upstream configured in this clone at all, and a rule keyed on
/// upstream would call it unpushed forever. And *contained in some remote-
/// tracking ref* is the honest form of the question: a branch whose tip is
/// already on `origin/main` because the pull request merged is as safe to let go
/// of as one still sitting on `origin/research/60`, and neither is *merged into
/// the default branch*, which is the test #60 refuses.
///
/// Asked of `folder` and not of the worktree: refs live in the shared git
/// directory, so the answer is the same either way, and this way it is still
/// available for a worktree whose directory the operator deleted.
fn publication_of(folder: &Path, branch: Option<&str>) -> Publication {
    let Some(branch) = branch else {
        return Publication::Detached;
    };

    let finished = Command::new("git")
        .arg("-C")
        .arg(folder)
        .args(["rev-list", "--count", branch, "--not", "--remotes"])
        .stdin(Stdio::null())
        .output();

    let finished = match finished {
        Ok(finished) => finished,
        Err(failure) => {
            return Publication::Unknown {
                detail: failure.to_string(),
            }
        }
    };
    if !finished.status.success() {
        return Publication::Unknown {
            detail: refusal_from(&finished.stderr),
        };
    }

    match String::from_utf8_lossy(&finished.stdout).trim().parse() {
        Ok(0) => Publication::Pushed,
        Ok(commits) => Publication::Unpushed { commits },
        Err(failure) => Publication::Unknown {
            detail: failure.to_string(),
        },
    }
}

fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// Hand-written porcelain: the main worktree, one of ours, one of ours whose
    /// directory is gone, and a colleague's.
    const LISTING: &str = "\
worktree /repo
HEAD 1111111111111111111111111111111111111111
branch refs/heads/main

worktree /repo/.perseverance/worktrees/60
HEAD 2222222222222222222222222222222222222222
branch refs/heads/research/60-worktree-hygiene

worktree /repo/.perseverance/worktrees/61
HEAD 3333333333333333333333333333333333333333
branch refs/heads/research/61-something
prunable gitdir file points to non-existent location

worktree /repo/../elsewhere/theirs
HEAD 4444444444444444444444444444444444444444
branch refs/heads/feature/theirs
locked in use
";

    fn root() -> PathBuf {
        PathBuf::from("/repo/.perseverance/worktrees")
    }

    fn known(tickets: &[u64]) -> BTreeSet<u64> {
        tickets.iter().copied().collect()
    }

    fn a_repository() -> Option<TempDir> {
        crate::tests::a_repository()
    }

    fn probed(working: Working, publication: Publication) -> Probed {
        Probed {
            working,
            publication,
        }
    }

    fn a_record(path: &str) -> Record {
        Record {
            path: PathBuf::from(path),
            head: Some("2".repeat(40)),
            branch: Some("research/60-worktree-hygiene".to_string()),
            detached: false,
            bare: false,
            locked: None,
            prunable: None,
        }
    }

    #[test]
    fn the_porcelain_becomes_one_record_per_worktree() {
        let records = parse(LISTING);

        assert_eq!(records.len(), 4);
        assert_eq!(records[0].path, PathBuf::from("/repo"));
        assert_eq!(records[0].branch.as_deref(), Some("main"));
        assert_eq!(records[0].head.as_deref(), Some(&*"1".repeat(40)));
        assert_eq!(
            records[2].prunable.as_deref(),
            Some("gitdir file points to non-existent location")
        );
        assert_eq!(records[3].locked.as_deref(), Some("in use"));
        assert!(records.iter().all(|record| !record.bare));
    }

    /// The shapes a real git prints that a naive parser mangles: a bare
    /// repository with no `HEAD` line, a detached worktree with no branch, a
    /// lock with no reason, a path with a space in it, and a field from a
    /// version of git this app has never met.
    #[test]
    fn the_odd_records_survive_intact() {
        let records = parse(
            "worktree /repo\nbare\n\n\
             worktree /repo/my worktrees/one\nHEAD abc\ndetached\nlocked\n\n\
             worktree /repo/two\nHEAD def\nbranch refs/heads/x\nsomething-new whatever\n",
        );

        assert_eq!(records.len(), 3);
        assert!(records[0].bare && records[0].head.is_none());
        assert_eq!(records[1].path, PathBuf::from("/repo/my worktrees/one"));
        assert!(records[1].detached && records[1].branch.is_none());
        assert_eq!(records[1].locked.as_deref(), Some(""));
        assert_eq!(records[2].branch.as_deref(), Some("x"));
    }

    /// The main worktree is the operator's own checkout. Whatever else this list
    /// is for, it is never for offering to delete that.
    #[test]
    fn the_main_worktree_and_a_strangers_are_foreign() {
        let listed = classify(&root(), parse(LISTING), &known(&[60, 61]));

        assert_eq!(listed[0].origin, Origin::Foreign);
        assert_eq!(listed[3].origin, Origin::Foreign);
        assert!(listed.iter().all(|entry| entry.removal.is_none()));
    }

    /// An orphan is ours whose ticket the caller no longer knows about. It is a
    /// label on the same entry in the same list — not a second list, and not a
    /// reason of its own to remove anything.
    #[test]
    fn an_unknown_ticket_is_an_orphan_and_stays_in_the_list() {
        let listed = classify(&root(), parse(LISTING), &known(&[60]));

        assert_eq!(
            listed[1].origin,
            Origin::Ours {
                ticket: 60,
                orphan: false
            }
        );
        assert_eq!(
            listed[2].origin,
            Origin::Ours {
                ticket: 61,
                orphan: true
            }
        );
        assert_eq!(listed.len(), 4);
    }

    /// Two routes to the number, because the directory name is what this app
    /// wrote and the branch is what survives somebody moving the directory. A
    /// path under our own root that answers neither is not ours: nothing here
    /// made it.
    #[test]
    fn the_ticket_is_read_from_the_directory_or_from_the_branch() {
        let listed = classify(
            &root(),
            parse(
                "worktree /repo/.perseverance/worktrees/moved-aside\n\
                 branch refs/heads/research/60-worktree-hygiene\n\n\
                 worktree /repo/.perseverance/worktrees/scratch\n\
                 branch refs/heads/notes\n\n\
                 worktree /repo/.perseverance/worktrees/60\n\
                 branch refs/heads/something-entirely-else\n",
            ),
            &known(&[60]),
        );

        assert_eq!(
            listed[0].origin,
            Origin::Ours {
                ticket: 60,
                orphan: false
            }
        );
        assert_eq!(listed[1].origin, Origin::Foreign);
        assert_eq!(
            listed[2].origin,
            Origin::Ours {
                ticket: 60,
                orphan: false
            }
        );
    }

    /// The classifier on its own mints nothing. A slip needs the probes, and the
    /// probes need a disk.
    #[test]
    fn classification_alone_offers_no_removal() {
        assert!(classify(&root(), parse(LISTING), &known(&[]))
            .iter()
            .all(|entry| entry.removal.is_none() && entry.probed.is_none()));
    }

    #[test]
    fn a_pushed_clean_worktree_is_offered() {
        let slip = offer(
            &a_record("/repo/.perseverance/worktrees/60"),
            &probed(Working::Clean, Publication::Pushed),
            60,
        )
        .expect("an offer");

        assert_eq!(slip.path(), Path::new("/repo/.perseverance/worktrees/60"));
        assert_eq!(slip.ticket(), 60);
    }

    /// Uncommitted work removes the offer rather than qualifying it. There is no
    /// second press, no confirmation and no force behind which this becomes a
    /// yes — and the lines are kept so the operator is told what is in the way.
    #[test]
    fn uncommitted_work_removes_the_offer_entirely() {
        let working = Working::Uncommitted {
            lines: vec![" M src/lib.rs".to_string(), "?? notes.md".to_string()],
        };

        assert!(offer(
            &a_record("/repo/.perseverance/worktrees/60"),
            &probed(working.clone(), Publication::Pushed),
            60,
        )
        .is_none());

        let Working::Uncommitted { lines } = working else {
            unreachable!()
        };
        assert_eq!(lines, [" M src/lib.rs", "?? notes.md"]);
    }

    /// Pushed and not merged is the whole point: waiting for a merge would pin a
    /// worktree open behind an unreviewed pull request. What is refused is the
    /// branch nobody but this disk has ever seen.
    #[test]
    fn commits_on_no_remote_remove_the_offer() {
        for publication in [
            Publication::Unpushed { commits: 3 },
            Publication::Detached,
            Publication::Unknown {
                detail: "git said nothing".to_string(),
            },
        ] {
            assert!(
                offer(
                    &a_record("/repo/.perseverance/worktrees/60"),
                    &probed(Working::Clean, publication.clone()),
                    60,
                )
                .is_none(),
                "{publication:?}"
            );
        }
    }

    /// A directory the operator deleted has nothing in it to lose, so the
    /// leftover registration is offered exactly as a clean one is — that
    /// litter is what they opened this list to clear.
    #[test]
    fn a_directory_already_gone_is_still_offered() {
        assert!(offer(
            &a_record("/repo/.perseverance/worktrees/60"),
            &probed(Working::Gone, Publication::Pushed),
            60,
        )
        .is_some());
    }

    /// A lock is the operator saying no in git's own vocabulary, and the only
    /// spelling that overrides it is `--force`.
    #[test]
    fn a_locked_worktree_is_not_offered() {
        let mut record = a_record("/repo/.perseverance/worktrees/60");
        record.locked = Some("running overnight".to_string());

        assert!(offer(&record, &probed(Working::Clean, Publication::Pushed), 60).is_none());
    }

    /// git that will not answer about uncommitted work is not a clean worktree.
    #[test]
    fn an_unreadable_worktree_is_not_offered() {
        assert!(offer(
            &a_record("/repo/.perseverance/worktrees/60"),
            &probed(
                Working::Unreadable {
                    detail: "fatal: not a git repository".to_string()
                },
                Publication::Pushed
            ),
            60,
        )
        .is_none());
    }

    #[test]
    fn a_folder_that_is_no_repository_refuses() {
        let folder = TempDir::new().expect("a temporary directory");

        assert_eq!(
            inventory(folder.path(), &known(&[])),
            Err(InventoryError::NotAGitRepo)
        );
    }

    /// End to end against a real git: our worktree is ours, the operator's own
    /// checkout is foreign, and a branch this clone has never pushed anywhere is
    /// not on offer however clean it is.
    #[test]
    fn a_real_repository_lists_its_own_worktree_as_ours() {
        let Some(folder) = a_repository() else {
            return;
        };
        let made = crate::worktree_for(folder.path(), 60, "Worktree hygiene").expect("a worktree");

        let listed = inventory(folder.path(), &known(&[60])).expect("a listing");

        let ours = listed
            .iter()
            .find(|entry| crate::same_directory(&entry.record.path, &made.path))
            .expect("our worktree is listed");
        assert_eq!(
            ours.origin,
            Origin::Ours {
                ticket: 60,
                orphan: false
            }
        );
        assert_eq!(
            ours.probed.as_ref().map(|probed| &probed.working),
            Some(&Working::Clean)
        );
        // No remote at all, so nothing on this branch is anywhere but here.
        assert!(matches!(
            ours.probed.as_ref().map(|probed| &probed.publication),
            Some(Publication::Unpushed { .. })
        ));
        assert!(ours.removal.is_none());

        let main = listed
            .iter()
            .find(|entry| crate::same_directory(&entry.record.path, folder.path()))
            .expect("the main worktree is listed");
        assert_eq!(main.origin, Origin::Foreign);
        assert!(main.probed.is_none());
    }

    /// The rule the operator is trusting when they accept an offer: the working
    /// copy goes, the branch stays, and the commits of the run are still on it.
    #[test]
    fn a_removal_leaves_the_branch_where_it_was() {
        let Some(folder) = a_repository() else {
            return;
        };
        let made = crate::worktree_for(folder.path(), 60, "Worktree hygiene").expect("a worktree");
        let before = crate::tests::tip_of(folder.path(), &made.branch).expect("a branch tip");

        let removal = Removal {
            path: made.path.clone(),
            ticket: 60,
        };
        remove(folder.path(), &removal).expect("removes the worktree");

        assert!(!made.path.exists(), "the directory is still there");
        assert_eq!(
            crate::tests::tip_of(folder.path(), &made.branch).as_deref(),
            Some(&*before),
            "the branch moved or went"
        );
        assert!(crate::branch_exists(
            &perseverance_store::common_git_dir(folder.path()).expect("a git directory"),
            &made.branch
        ));
    }

    /// A worktree whose directory the operator deleted by hand: it is in the
    /// list as an ordinary entry with `Gone` in it, listing it raises nothing,
    /// and removing it raises nothing either.
    #[test]
    fn a_hand_deleted_directory_lists_and_removes_without_an_error() {
        let Some(folder) = a_repository() else {
            return;
        };
        let made = crate::worktree_for(folder.path(), 60, "Worktree hygiene").expect("a worktree");
        std::fs::remove_dir_all(&made.path).expect("the operator deletes it");

        let listed = inventory(folder.path(), &known(&[60])).expect("a listing");
        let ours = listed
            .iter()
            .find(|entry| matches!(entry.origin, Origin::Ours { ticket: 60, .. }))
            .expect("the deleted worktree is still an entry");
        assert_eq!(
            ours.probed.as_ref().map(|probed| &probed.working),
            Some(&Working::Gone)
        );

        remove(
            folder.path(),
            &Removal {
                path: made.path.clone(),
                ticket: 60,
            },
        )
        .expect("removes a registration whose directory is gone");

        let after = inventory(folder.path(), &known(&[60])).expect("a listing");
        assert!(
            !after
                .iter()
                .any(|entry| matches!(entry.origin, Origin::Ours { .. })),
            "the registration is still there"
        );
        assert!(crate::branch_exists(
            &perseverance_store::common_git_dir(folder.path()).expect("a git directory"),
            &made.branch
        ));
    }

    /// Uncommitted work end to end: the lines come back verbatim, and no offer
    /// comes back with them.
    #[test]
    fn a_dirty_worktree_carries_its_lines_and_no_offer() {
        let Some(folder) = a_repository() else {
            return;
        };
        let made = crate::worktree_for(folder.path(), 60, "Worktree hygiene").expect("a worktree");
        std::fs::write(made.path.join("notes.md"), "unsaved\n").expect("writes in the worktree");

        let listed = inventory(folder.path(), &known(&[60])).expect("a listing");
        let ours = listed
            .iter()
            .find(|entry| matches!(entry.origin, Origin::Ours { ticket: 60, .. }))
            .expect("our worktree is listed");

        let Some(Working::Uncommitted { lines }) =
            ours.probed.as_ref().map(|probed| probed.working.clone())
        else {
            panic!("expected uncommitted work, got {:?}", ours.probed);
        };
        assert!(
            lines.iter().any(|line| line.contains("notes.md")),
            "{lines:?}"
        );
        assert!(ours.removal.is_none());
    }
}

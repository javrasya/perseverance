use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The repository a folder is bound to.
///
/// It appears nowhere in the schema. Deriving it on every read is what makes a
/// rename or a transfer on GitHub a non-event here: there is no stored copy to
/// go stale.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoRef {
    pub owner: String,
    pub name: String,
}

/// The three ways a folder can fail to name exactly one GitHub repository.
///
/// Each of these is a **fact about a folder on this disk**, established without
/// touching a network — this crate cannot open a socket. That is why none of
/// these messages may read like a failed request: the fix for "there is no
/// `.git` here" is to pick a different folder, and the fix for a failed GitHub
/// read is to wait or sign in. Conflating them sends the user to the wrong fix.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RepoBindingError {
    /// No usable `.git` — either none at all, or a `.git` file whose `gitdir:`
    /// pointer leads nowhere, which is what a worktree left behind by a deleted
    /// clone looks like. Both are the same fact for the reader — there is no
    /// repository here to read remotes from — and the sentence has to be true
    /// of both, so it names both rather than asserting the first.
    #[error(
        "this folder holds no usable .git: either there is none here, or the .git here points at \
         a git directory that is not there"
    )]
    NotAGitRepo,

    /// A repository, but nothing in its config names a repository on GitHub.
    #[error(
        "this folder is a git repository, but none of its remotes names a repository on GitHub"
    )]
    NoGitHubRemote,

    /// Several remotes name *different* GitHub repositories.
    ///
    /// One folder, one repository, one issue home. Picking between `origin` and
    /// `upstream` on the user's behalf would be a guess about where their work
    /// lives, so the remotes are named back and the choice stays theirs.
    #[error(
        "this folder's remotes name more than one repository on GitHub ({}); one folder binds to \
         one repository, and that is not a difference to guess at",
        .candidates.join(", ")
    )]
    AmbiguousRemotes { candidates: Vec<String> },
}

/// Derives the GitHub repository behind a folder, from that folder alone.
///
/// The git config is read as **text** rather than by shelling out to `git`: it
/// keeps this crate free of child processes (a child process belongs to
/// `perseverance-pty` or to `perseverance-env`, and neither of them is a crate
/// whose subject is a file on this disk) and makes the whole thing testable
/// against a directory with a hand-written config file and no git installed
/// anywhere.
///
/// The ambiguity rule, stated once so it is not re-argued: several GitHub
/// remotes that all resolve to the **same** `owner/repo` bind fine — a fork
/// workflow that lists the same repository twice is not a dilemma. Remotes that
/// resolve to **different** `owner/repo` are ambiguous and refuse, naming the
/// remotes involved. Owner and name are compared case-insensitively, because
/// `Octocat/Hello-World` and `octocat/hello-world` are one repository and it
/// would be perverse to call them a conflict.
///
/// Only `github.com` counts. A remote pointing anywhere else is not a GitHub
/// remote and is passed over in silence.
pub fn bind_repo(folder: &Path) -> Result<RepoRef, RepoBindingError> {
    let git_dir = git_dir(folder).ok_or(RepoBindingError::NotAGitRepo)?;

    // A `.git` with no readable config has no remotes, which is a different
    // fact from having no `.git` at all.
    let config = std::fs::read_to_string(config_path(&git_dir)).unwrap_or_default();

    let mut candidates: Vec<String> = Vec::new();
    let mut distinct: Vec<(String, RepoRef)> = Vec::new();

    for (remote, url) in remote_urls(&config) {
        let Some(repo) = github_repo(&url) else {
            continue;
        };
        let key = format!("{}/{}", repo.owner.to_lowercase(), repo.name.to_lowercase());
        if !candidates.contains(&remote) {
            candidates.push(remote);
        }
        if !distinct.iter().any(|(seen, _)| seen == &key) {
            distinct.push((key, repo));
        }
    }

    match distinct.len() {
        0 => Err(RepoBindingError::NoGitHubRemote),
        1 => Ok(distinct.remove(0).1),
        _ => {
            candidates.sort();
            Err(RepoBindingError::AmbiguousRemotes { candidates })
        }
    }
}

/// Resolves `.git`, which is a directory in a plain clone and a **file** in a
/// worktree or a submodule. Supporting the file form is not an edge case here:
/// perseverance's own harness creates worktrees, so it is the ordinary case.
fn git_dir(folder: &Path) -> Option<PathBuf> {
    let dot_git = folder.join(".git");
    let metadata = std::fs::metadata(&dot_git).ok()?;

    if metadata.is_dir() {
        return Some(dot_git);
    }

    let pointer = std::fs::read_to_string(&dot_git).ok()?;
    let target = pointer
        .lines()
        .find_map(|line| line.trim().strip_prefix("gitdir:"))?
        .trim();
    if target.is_empty() {
        return None;
    }

    let target = PathBuf::from(target);
    let resolved = if target.is_absolute() {
        target
    } else {
        folder.join(target)
    };

    resolved.is_dir().then_some(resolved)
}

/// The git directory every worktree of one repository shares, derived from any
/// one of them: the clone's own `.git`, reached from a worktree through its
/// `commondir`.
///
/// Public because the things that belong to *the repository* rather than to
/// *this checkout* live under it, and `.git/info/exclude` is one of them.
/// `perseverance-worktree` writes its ignore line there and asks for the
/// directory here rather than deriving it again — one git-layout rule, one home,
/// for the same reason [`bind_repo`] reads config as text instead of asking a
/// child process where things are.
pub fn common_git_dir(folder: &Path) -> Option<PathBuf> {
    git_dir(folder).map(|git_dir| common_of(&git_dir))
}

/// A worktree's git directory holds no config of its own; `commondir` points at
/// the clone that does. Following it is what makes a folder inside
/// `.claude/worktrees/` bind to the same repository as its parent checkout.
fn config_path(git_dir: &Path) -> PathBuf {
    common_of(git_dir).join("config")
}

fn common_of(git_dir: &Path) -> PathBuf {
    if let Ok(common) = std::fs::read_to_string(git_dir.join("commondir")) {
        let common = common.trim();
        if !common.is_empty() {
            let common = PathBuf::from(common);
            return if common.is_absolute() {
                common
            } else {
                git_dir.join(common)
            };
        }
    }
    git_dir.to_path_buf()
}

/// Every `url` under every `[remote "…"]`, paired with the remote's name.
///
/// A deliberately small INI reader rather than a config-file dependency: git's
/// on-disk format is simple, and the only thing we need out of it is remote
/// URLs. `pushurl` is ignored — where you push is not where the issues live.
fn remote_urls(config: &str) -> Vec<(String, String)> {
    let mut urls = Vec::new();
    let mut remote: Option<String> = None;

    for line in config.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }

        if let Some(header) = line.strip_prefix('[') {
            let header = header.split(']').next().unwrap_or("");
            remote = remote_name(header);
            continue;
        }

        let Some(name) = &remote else { continue };
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if !key.trim().eq_ignore_ascii_case("url") {
            continue;
        }
        let value = value.trim().trim_matches('"').trim();
        if !value.is_empty() {
            urls.push((name.clone(), value.to_string()));
        }
    }

    urls
}

/// `[remote "origin"]`, and the legacy `[remote.origin]` spelling git still
/// accepts. Anything that is not a remote section clears the current remote, so
/// a `url` under `[core]` is never mistaken for one.
fn remote_name(header: &str) -> Option<String> {
    let header = header.trim();

    let (kind, rest) = match header.split_once(char::is_whitespace) {
        Some((kind, rest)) => (kind, rest.trim()),
        None => match header.split_once('.') {
            Some((kind, rest)) => (kind, rest.trim()),
            None => (header, ""),
        },
    };

    if !kind.eq_ignore_ascii_case("remote") {
        return None;
    }

    let name = rest.trim_matches('"').trim();
    (!name.is_empty()).then(|| name.to_string())
}

/// Recognises the three spellings a GitHub remote actually turns up in:
/// `https://github.com/o/r(.git)`, `git@github.com:o/r(.git)` and
/// `ssh://git@github.com/o/r(.git)`. Anything else, including any other host,
/// simply is not a GitHub remote.
fn github_repo(url: &str) -> Option<RepoRef> {
    let (host, path) = host_and_path(url.trim())?;
    if !host.eq_ignore_ascii_case("github.com") {
        return None;
    }

    let mut segments = path.split('/').filter(|segment| !segment.is_empty());
    let owner = segments.next()?;
    let name = segments.next()?;
    // `github.com/o/r/something` is a page, not a repository remote.
    if segments.next().is_some() {
        return None;
    }

    let name = name.strip_suffix(".git").unwrap_or(name);
    if owner.is_empty() || name.is_empty() {
        return None;
    }

    Some(RepoRef {
        owner: owner.to_string(),
        name: name.to_string(),
    })
}

fn host_and_path(url: &str) -> Option<(&str, &str)> {
    for scheme in ["https://", "http://", "ssh://", "git://", "git+ssh://"] {
        let Some(rest) = strip_scheme(url, scheme) else {
            continue;
        };
        let (authority, path) = match rest.find('/') {
            Some(cut) => (&rest[..cut], &rest[cut..]),
            None => (rest, ""),
        };
        return Some((bare_host(authority), path));
    }

    // scp-style: `[user@]host:path`, which carries no scheme at all.
    let (authority, path) = url.split_once(':')?;
    if path.is_empty() {
        return None;
    }
    let host = authority.rsplit('@').next().unwrap_or("");
    if host.is_empty() {
        return None;
    }
    Some((host, path))
}

/// Drops any userinfo and any port, leaving the host to compare against
/// `github.com`.
fn bare_host(authority: &str) -> &str {
    let host = authority.rsplit('@').next().unwrap_or("");
    host.split(':').next().unwrap_or("")
}

fn strip_scheme<'a>(url: &'a str, scheme: &str) -> Option<&'a str> {
    let head = url.get(..scheme.len())?;
    if head.eq_ignore_ascii_case(scheme) {
        url.get(scheme.len()..)
    } else {
        None
    }
}

/// The vocabulary of a failed request. No refusal this crate produces may
/// contain any of it, because nothing this crate does involves a request.
#[cfg(test)]
pub(crate) const NETWORK_VOCABULARY: &[&str] = &[
    "reach", "connect", "network", "timeout", "offline", "retry", "server", "http",
];

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// A repository fixture is built here rather than checked in, because git
    /// refuses to track a path containing a `.git` component — and because a
    /// fixture built from text proves the point that no git binary is involved.
    fn repo_with_config(config: &str) -> TempDir {
        let dir = TempDir::new().expect("a temporary directory");
        std::fs::create_dir(dir.path().join(".git")).expect("creates .git");
        std::fs::write(dir.path().join(".git").join("config"), config).expect("writes config");
        dir
    }

    #[test]
    fn a_folder_with_no_dot_git_is_not_a_git_repository() {
        let plain = TempDir::new().expect("a temporary directory");

        let refusal = bind_repo(plain.path()).expect_err("refuses");

        assert_eq!(refusal, RepoBindingError::NotAGitRepo);
    }

    #[test]
    fn a_git_repository_with_no_remote_at_all_says_it_has_no_github_remote() {
        let repo = repo_with_config("[core]\n\trepositoryformatversion = 0\n");

        let refusal = bind_repo(repo.path()).expect_err("refuses");

        assert_eq!(refusal, RepoBindingError::NoGitHubRemote);
    }

    #[test]
    fn a_remote_on_another_host_does_not_count_as_a_github_remote() {
        let repo = repo_with_config(
            "[remote \"origin\"]\n\turl = git@gitlab.com:octocat/hello-world.git\n",
        );

        let refusal = bind_repo(repo.path()).expect_err("refuses");

        assert_eq!(refusal, RepoBindingError::NoGitHubRemote);
    }

    #[test]
    fn a_url_outside_any_remote_section_is_not_mistaken_for_a_remote() {
        let repo = repo_with_config("[core]\n\turl = https://github.com/octocat/hello-world.git\n");

        let refusal = bind_repo(repo.path()).expect_err("refuses");

        assert_eq!(refusal, RepoBindingError::NoGitHubRemote);
    }

    #[test]
    fn remotes_pointing_at_different_repositories_refuse_and_name_the_remotes() {
        let repo = repo_with_config(
            "[remote \"origin\"]\n\turl = https://github.com/octocat/hello-world.git\n\
             [remote \"upstream\"]\n\turl = https://github.com/github/hello-world.git\n",
        );

        let refusal = bind_repo(repo.path()).expect_err("refuses");

        assert_eq!(
            refusal,
            RepoBindingError::AmbiguousRemotes {
                candidates: vec!["origin".to_string(), "upstream".to_string()],
            }
        );
        let message = refusal.to_string();
        assert!(message.contains("origin"));
        assert!(message.contains("upstream"));
    }

    #[test]
    fn several_remotes_pointing_at_the_same_repository_bind_rather_than_refusing() {
        let repo = repo_with_config(
            "[remote \"origin\"]\n\turl = git@github.com:octocat/hello-world.git\n\
             [remote \"mirror\"]\n\turl = https://github.com/Octocat/Hello-World\n\
             [remote \"backup\"]\n\turl = ssh://git@github.com/octocat/hello-world.git\n",
        );

        let bound = bind_repo(repo.path()).expect("binds");

        assert_eq!(bound.owner.to_lowercase(), "octocat");
        assert_eq!(bound.name.to_lowercase(), "hello-world");
    }

    #[test]
    fn ssh_https_and_scp_style_remote_urls_all_name_the_same_repository() {
        let spellings = [
            "https://github.com/octocat/hello-world.git",
            "https://github.com/octocat/hello-world",
            "https://octocat@github.com/octocat/hello-world.git",
            "git@github.com:octocat/hello-world.git",
            "git@github.com:octocat/hello-world",
            "ssh://git@github.com/octocat/hello-world.git",
            "git://github.com/octocat/hello-world.git",
        ];

        for spelling in spellings {
            let repo = repo_with_config(&format!("[remote \"origin\"]\n\turl = {spelling}\n"));

            let bound = bind_repo(repo.path()).unwrap_or_else(|_| panic!("{spelling} binds"));

            assert_eq!(
                bound,
                RepoRef {
                    owner: "octocat".to_string(),
                    name: "hello-world".to_string(),
                },
                "{spelling}"
            );
        }
    }

    #[test]
    fn a_dot_git_file_pointing_at_a_gitdir_still_binds() {
        let clone = repo_with_config(
            "[remote \"origin\"]\n\turl = https://github.com/octocat/hello-world.git\n",
        );
        let worktree = TempDir::new().expect("a temporary directory");
        let worktree_git_dir = clone.path().join(".git").join("worktrees").join("slice");
        std::fs::create_dir_all(&worktree_git_dir).expect("creates the worktree git dir");
        std::fs::write(worktree_git_dir.join("commondir"), "../..\n").expect("writes commondir");
        std::fs::write(
            worktree.path().join(".git"),
            format!("gitdir: {}\n", worktree_git_dir.display()),
        )
        .expect("writes the .git file");

        let bound = bind_repo(worktree.path()).expect("binds");

        assert_eq!(bound.owner, "octocat");
        assert_eq!(bound.name, "hello-world");
    }

    #[test]
    fn a_dot_git_file_pointing_nowhere_is_not_a_git_repository() {
        let broken = TempDir::new().expect("a temporary directory");
        std::fs::write(broken.path().join(".git"), "this is not a gitdir pointer\n")
            .expect("writes a nonsense .git file");

        let refusal = bind_repo(broken.path()).expect_err("refuses");

        assert_eq!(refusal, RepoBindingError::NotAGitRepo);
        // There is a `.git` in this folder. The refusal may not say otherwise,
        // because "there is none" would send the reader to `git init`.
        assert!(refusal.to_string().contains("points at"));
    }

    #[test]
    fn the_three_binding_refusals_are_distinct_from_each_other() {
        let messages = [
            RepoBindingError::NotAGitRepo.to_string(),
            RepoBindingError::NoGitHubRemote.to_string(),
            RepoBindingError::AmbiguousRemotes {
                candidates: vec!["origin".to_string(), "upstream".to_string()],
            }
            .to_string(),
        ];

        assert_ne!(messages[0], messages[1]);
        assert_ne!(messages[1], messages[2]);
        assert_ne!(messages[0], messages[2]);
    }

    #[test]
    fn no_binding_refusal_reads_like_a_network_failure() {
        let refusals = [
            RepoBindingError::NotAGitRepo.to_string(),
            RepoBindingError::NoGitHubRemote.to_string(),
            RepoBindingError::AmbiguousRemotes {
                candidates: vec!["origin".to_string(), "upstream".to_string()],
            }
            .to_string(),
        ];

        for refusal in refusals {
            let lowered = refusal.to_lowercase();
            for word in NETWORK_VOCABULARY {
                assert!(
                    !lowered.contains(word),
                    "{refusal:?} reads like a network failure because of {word:?}"
                );
            }
        }
    }
}

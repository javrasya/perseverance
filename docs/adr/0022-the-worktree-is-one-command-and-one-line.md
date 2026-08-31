# 22. The worktree is one command and one line, in a crate of its own

Status: accepted (2026-08-31)
Context: [#58 the research run](https://github.com/javrasya/perseverance/issues/58),
under the spec [#28](https://github.com/javrasya/perseverance/issues/28). It sits
on the harvest key ADR 0011 settled — per folder, on the absolute spawn
directory — and it is the first ticket in this repository whose acceptance
criteria include a write inside the operator's own checkout.

## Context

A research run is the one run nobody is watching. It edits files, commits and
pushes, and it does all of that while the operator is somewhere else in the same
repository doing their own work. Starting it in the picked folder would put an
unattended agent's edits into the checkout a person is reading, so the run needs
a working copy of its own: a git worktree at
`<folder>/.perseverance/worktrees/<ticket>` on `research/<ticket>-<slug>`,
created before the child is spawned.

Two facts about this workspace made *where does that live* the real question.

**Nothing in the tree shells out to `git`, at all, and no crate depends on
`git2` or `gix`.** `crates/store/src/repo.rs` reads the git config as *text* and
says why: a child process belongs to `perseverance-pty` (the sessions an operator
watches) or to `perseverance-env` (the framed, abandoned login-shell harvest),
and neither is a crate whose subject is a file on a disk. A one-shot
`git worktree add` is neither of those children. It is not a session and it is
not an environment source; it is a command that runs, finishes, and leaves a
directory behind.

**Nothing in the tree writes inside the operator's repository.** The read-only
charter (`crates/github/src/lib.rs`, ADR 0003) is about GitHub mutations and does
not cover this, and the *writes nothing* claims of `perseverance-env` are about
the harvested environment. But the pattern held anyway: every file this harness
has ever written — the registry, the prompt overrides — lands outside the folder
somebody picked.

## Decision

**A worktree is its own crate, `perseverance-worktree`**, the eighth, for the
reason ADR 0001 and ADR 0002 made the registry and the harvest their own: it
carries policy — what counts as *already ours*, what refuses, what is appended
and what is never rewritten — and the app crate's charter is wiring only. It is
not folded into the store, whose manifest says *no socket, no Tauri, no child
process* and where a `Command` would quietly retire that sentence; and it is not
folded into `perseverance-pty` or `perseverance-env`, whose subject is a child
that keeps running and a child that answers a question, neither of which
describes a command that makes a directory.

Its whole surface is `worktree_for(folder, ticket, title) -> Worktree`, plus the
two derivations behind it — `branch_for` and `worktree_path` — exposed because a
later ticket that lists or removes worktrees needs the same two answers and must
not compute them again.

**It shells out to `git`, and takes no library.** `git2` and `gix` would each
add a large dependency (and, for `git2`, a C build and a TLS story on a Windows
runner) to spend it on one command. More decisively: a worktree is an entry in
the operator's own repository, and the thing that should create it is the same
`git` they use, with their config, their hooks and their version's semantics —
not a second implementation of worktree layout that agrees with theirs until the
day it does not. The bet is symmetric with the store's: *reading* git is text on
a disk and needs no git installed; *writing* git is `git`.

**The command runs exactly once per press, and every read around it is text.**
Whether a path already holds our worktree, which branch is checked out in it,
and whether the branch exists at all are all read off the disk — a `.git` file's
`gitdir:` pointer, that directory's `HEAD`, `refs/heads/…` and `packed-refs`.
This is the store's argument reused rather than restated: it keeps the whole
reuse path answerable on a machine with no git, and it means a refusal never
costs a process.

**`perseverance-worktree` depends on `perseverance-store` for one function.**
`common_git_dir` — the git directory every worktree of a repository shares — was
already derived there, by `bind_repo`, because a folder inside a worktree has to
bind to the same repository as its parent checkout. `.git/info/exclude` lives in
that same directory. Two copies of a git-layout rule are two copies that drift,
so the private helper became public rather than being written twice. The
dependency direction is odd to read (*the worktree crate depends on the
registry*) and it is the right one: the store owns *what git's directories mean*,
and this crate owns *what we do to them*.

**The write inside the operator's repository is bounded to two things and
declared here**: the worktree directory it created, and one line —
`/.perseverance/` — appended to `.git/info/exclude`. The tracked `.gitignore` is
never touched, because hiding this harness's scratch space is a fact about this
machine and not a commit somebody has to review. The append is additive and
idempotent: the file is opened in append mode and never read back and rewritten,
so an operator's own excludes cannot be reordered, folded or truncated, and a
file that does not end in a newline gets one before ours rather than having our
line glued onto theirs.

**Nothing about a worktree is stored.** The registry's schema gains no row.
Everything is derived from the path and the ticket, which is what makes a
directory the operator deleted by hand a non-event rather than a reconciliation
problem, and what lets a process that never created a worktree find it again.

**Nothing is ever deleted, moved or forced.** A path holding something that is
not this ticket's worktree refuses; a branch checked out in another worktree
refuses (git says so and its sentence is carried); no `git` at all refuses; and a
worktree that cannot be hidden refuses. `--force`, `-B` and `git branch -d`
appear in this crate nowhere. Removal is #60's verb.

**The spawn directory is the worktree, and that is the entire worktree change to
the harvest.** `where_it_runs` in `crates/app/src/lib.rs` returns the worktree
for a research press and the picked folder for every other one, and that path is
what reaches `plan_in` — so the environment harvest, the adapter's program
resolution and the PTY's working directory are three answers about one directory.
ADR 0011 keyed the harvest on the absolute canonical spawn directory, which
*deletes the worktree question rather than answering it*: a worktree is another
canonical directory, so it gets its own harvest and no code anywhere reasons
about worktrees to make that true. The accepted cost is a fresh login-shell
harvest per worktree — up to 20 s on Windows, sharing nothing with the parent
checkout — and it is not to be optimised away by teaching the cache about
worktrees.

## Alternatives

**`git worktree add` inside `perseverance-store`.** It is where the git
derivations are, and it is the one place that would have needed no new crate. It
also carries the SQLite file and a manifest that promises no child process; a
`Command` there makes the registry a thing that runs programs, and the next
convenient command has no argument left to stop it.

**`git worktree add` inside `perseverance-env` or `perseverance-pty`.** Both
already spawn. Neither is about a directory: `perseverance-env` is an
environment source that *never writes a file*, and inverting that for one caller
would cost the cheapest correctness claim in the workspace; `perseverance-pty`
owns children that stay alive and are watched, and a command we wait for and
throw away is not one of those.

**`git2` or `gix`.** Rejected above. The extra weight would be tolerable; the
divergence from the operator's own git would not.

**Running `git worktree prune` when the directory was deleted by hand.** It
would let a press recover from an operator who removed the folder but kept the
branch. `prune` is repository-wide and would drop registrations this app never
made — a colleague's worktree on an unmounted drive included — and this crate
deletes nothing. The press refuses instead, with git's own `hint: … prune …` line
in the sentence, and the operator runs the word. Orphan surfacing is #60's.

**A `worktrees` table in the registry.** It buys a listing without walking git,
and it buys a class of bug this repository has spent two ADRs avoiding: a stored
row that disagrees with the disk. `git worktree list` is the authority, and #60
reads it.

**Writing the ignore line to `.gitignore`.** It would be visible and reviewable,
which sounds like a virtue until you notice it is a commit in somebody else's
repository, proposed by a tool, about a directory only this machine has.

**Slugging the title with Unicode intact.** Git allows it; two operating systems'
shells, terminals and filesystems make it a coin flip. The slug is ASCII
alphanumerics, lowercased, non-alphanumerics collapsed to single dashes, trimmed,
cut at 40 characters and trimmed again — and a title that slugs to nothing yields
`research/<ticket>`, which is legal and is the half of the name that identifies
the work anyway.

## Consequences

The invariant *the harness writes nothing inside the operator's repository* is
gone, and it did not decay — it was spent, once, on the one thing that cannot be
done from outside. What replaces it is narrower and checkable by reading one
crate: **one directory this app created, and one line in a file git already
treats as local-only**. That bound is enforced rather than asserted:
`npm run check:repo-writes` reads the non-test Rust of the whole workspace and
refuses a mutating `git` subcommand outside `worktree add` in
`crates/worktree/`, a forcing flag in any `git` argv including that one, a file
opened for rewriting rather than appending in that crate, and any mention of the
tracked `.gitignore`. It is honest about its edges, and its own doc block says so
in full: the child session editing the operator's checkout is the point of a work
run and no scan of this workspace bounds it, and a bare `fs::write` into the
picked folder would need the path traced from `where_it_runs` to a call site,
which is more than source text can say. What it does bound is every route the
harness itself has ever taken into that repository.

`perseverance-store` grew a public function that has nothing to do with the
registry. That is the price of not writing git's directory layout down twice, and
it is paid in one exported name whose doc comment says who it is for.

A research press now has a failure mode no other press has, on a machine where
every credential is fine: git missing, a path occupied, a branch checked out
elsewhere. Each is a sentence the socket returns, refused before anything is
staked, claimed or counted — the same chain and the same order as every other
refusal in `start_working`.

Second presses on the same ticket reuse the worktree silently, which is what
makes a research run resumable at all: the branch is where the last run's commits
are, and starting a new session is not a reason to lose them.

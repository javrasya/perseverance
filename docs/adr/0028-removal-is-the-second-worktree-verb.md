# 28. Removal is the second worktree verb, and the slip is minted by the classifier

Status: accepted (2026-08-31)
Context: [#60 Worktree hygiene](https://github.com/javrasya/perseverance/issues/60),
under the spec [#28](https://github.com/javrasya/perseverance/issues/28). It
spends the second half of
[ADR 0022](0022-the-worktree-is-one-command-and-one-line.md) — the crate that is
allowed to run `git`, and the bound on what it may run — and it keeps that ADR's
refusal of `git worktree prune` intact.

`0028` and not one of the numbers below it: the directory holds two ADRs
numbered `0010`, two numbered `0020`, two numbered `0022`, two numbered `0023`,
two numbered `0024`, two numbered `0026` and two numbered `0027`, and `0027` is
the highest number in use.

## Context

ADR 0022 gave this app one command inside somebody else's repository — `git
worktree add` — and said the rest in a sentence: *removal is #60's verb*. #60 is
now here, and it arrives with a directory that fills up. Every research run makes
a worktree, nothing takes one away, and the ones the operator most wants gone are
the ones they have most thoroughly forgotten: a ticket that closed, a ticket that
was deleted, a run they abandoned on a Friday.

Three questions decide whether a removal is safe, and each has an answer that
sounds reasonable and is wrong.

*Whose worktree is it?* An `if` at the top of the removal function is not an
answer. The check and the deletion are two lines apart today and forty apart
after the next feature, and a colleague's worktree removed by this app is a
mistake nobody gets to undo.

*Is the work safe?* **Merged** is the intuitive answer and it is the one #60
explicitly refuses: a pull request waiting three days for review would pin its
worktree open for three days, which is precisely the state that fills the
directory up. **Pushed** is the honest bound — the commits exist somewhere other
than this disk — and it is answerable from refs already on this disk.

*What about a directory the operator deleted by hand?* ADR 0022 met this one
already and refused `git worktree prune`, which is repository-wide and would drop
registrations this app never made.

## Decision

**Removal is a second `worktree` verb, and it is `git worktree remove <path>`.**
That command unregisters the one directory on its argv and nothing else, and — as
it turns out — it clears the registration of a directory that is already gone,
which is the case `prune` was wanted for. So ADR 0022's refusal of `prune` stands
unamended: the broad command is still never run, and the narrow one covers the
case. `scripts/check-repo-writes.mjs` now admits three `worktree` subcommands in
`crates/worktree/` — `add`, `list` and `remove` — reads the subcommand as a
literal so a verb assembled at runtime is not mistaken for a listing, and refuses
`move`, `lock`, `unlock`, `repair` and `prune` exactly as before.

**The slip does not cross the Tauri seam, and the press re-derives it.** The
WebView is handed a boolean — *there was an offer when this listing was derived*
— because a `Removal` sent to the frontend would be a value the frontend could
keep, replay, or invent. The boolean decides what is drawn; it decides nothing
else. `remove_worktree` takes a folder and a directory, lists the folder again,
finds the entry whose record names that directory, and calls the crate only on a
slip that this call minted. The re-derivation is the point rather than a second
belt: a worktree that was clean when the list was drawn and has an unsaved edit
in it now must refuse, and the only thing that can know is git, asked again. The
set of known tickets is read on this side too, from the app's own snapshot of the
map, so the frontend cannot decide what counts as an orphan by what it sends.

**No branch is ever deleted, and that is what makes the offer cheap.** `git
worktree remove` leaves `refs/heads/research/<ticket>-<slug>` pointing where it
pointed, so accepting an offer costs a working copy and never a commit — and
`worktree_for` hands the same branch back if the operator wants the directory
again. `git branch -d`, `-D` and `--delete` appear nowhere, and the check refuses
the flags on sight.

**Permission is a value, not a branch of an `if`.** `remove` takes a `Removal`
whose fields are private and which is returned by exactly one function — the one
that applies every rule to a classified entry. There is no public constructor, so
outside `crates/worktree/src/inventory.rs` there is no way to name a foreign
worktree to this app's removal at all. *Foreign is never removed* stops being a
runtime check somebody can move and becomes a thing that does not compile.

**A slip is minted only for ours, clean, unlocked, and pushed.** Uncommitted work
removes the offer entirely — the entry carries the `git status --porcelain` lines
so the operator is told what is in the way, and there is no confirmation and no
force behind which it becomes a yes. A lock is the operator's own no, written in
git's vocabulary. *Pushed* means `git rev-list --count <branch> --not --remotes`
is zero: every commit is on a remote-tracking ref **this clone already has**. No
`fetch` and no `ls-remote` — the readout says what this disk knows, and a listing
that reached for the network would be a listing that hangs on a VPN.

**Pushed is asked about a working copy, so a gone directory is not asked.** The
rule protects commits sitting in a directory the operator would otherwise have to
write again; a registration whose directory they have already deleted has no such
directory, and `git worktree remove` leaves its branch untouched either way. So a
gone entry is offered whether or not anybody pushed it, and the lock is the only
rule above that still reaches it. Asking it for pushedness anyway would refuse
the likeliest litter there is — the run abandoned on a Friday, on a branch nobody
ever pushed — and refuse it into a dead end: `worktree_for` will not build a
working copy over a stale registration, `prune` is still never run, and the
ticket would be neither runnable nor clearable from inside this app. The one gone
entry still refused is one on no branch at all, where the removal would leave the
run's commits reachable from nothing it keeps.

**Ours is a path, an orphan is a set lookup, and neither is stored.** *Ours* is a
worktree under `<folder>/.perseverance/worktrees/` that names a ticket, by its
directory name or by its `research/<ticket>-` branch; anything else, the
operator's own main worktree included, is foreign and is not even probed.
*Orphan* is ours whose ticket is not in the set the caller passed in — the app's
snapshot of the map, handed down rather than reached for, so this crate still
knows nothing about the model. An orphan is a label in the same list under the
same rules: being forgotten is a reason to show something, never a licence to
reap it.

**The inventory is derived on every call, and the schema gains nothing.** No
table, no migration, no row — for the reason ADR 0022 gave and this one has no
grounds to revisit: a stored worktree is a fact that can disagree with the disk,
and `git worktree list --porcelain` is the authority. The parser over that text
is a pure function, so the rules above are tested against hand-written listings
on a machine with no git and no repository, and the handful of tests that do
build a real repository skip where there is none.

## Alternatives

**A `--force` behind a confirmation, for the dirty worktree.** It is one dialog
away in every file manager ever written, and it is how an operator loses an
afternoon's uncommitted work to a keystroke. The offer is absent instead, and the
lines that made it absent are printed.

**Removal offered on merged.** Rejected in the ticket and again here: waiting for
a merge pins worktrees open indefinitely behind an unmerged pull request, which
is the condition that fills the directory in the first place.

**Gating the gone directory on pushedness too, for one rule with no
exceptions.** It reads tidier and it strands the operator: the entry the rule
would refuse is a registration with no working copy behind it, so the refusal
buys no commit any safety, and the row would say *removing it clears the
registration and nothing else* directly above a sentence declining to. The
exception is written down here instead of being tidied away.

**A `fetch` before judging pushedness.** It would make the answer current, at the
price of a network round trip inside a listing, an authentication prompt with no
terminal to answer it in, and a hang on a repository whose remote is unreachable.
The answer is what this clone knows, and the readout says so.

**A boolean `removable` field on the entry.** Cheaper to write and unenforceable:
a caller that reads it wrongly, or a later field added beside it, removes
somebody's working copy. A value only one function can mint costs one type and
makes the mistake unspellable.

**Probing foreign worktrees anyway, to show the operator more.** A `git status`
in a colleague's working copy is a read this app can do and has no use for: the
entry is never removable, so the only thing the answer could change is how much
of somebody else's business is on our screen.

## Consequences

ADR 0022's bound is wider by exactly one command, and it is still one paragraph
long: this app runs `git worktree add`, `list` and `remove` inside the operator's
repository, appends one line to `.git/info/exclude`, and forces nothing. The
check that enforces it grew a subcommand allowlist rather than a per-crate
exception, and its own known-bad inputs now include a `worktree` verb it cannot
read as a literal.

The app crate gains a listing whose entries it may render freely and remove only
by handing back a value this crate gave it. The set of known tickets is the app's
to supply, which keeps the join between *a worktree on disk* and *a ticket on the
map* in the one place that already holds both.

A worktree whose directory the operator deleted by hand lists as an ordinary
entry — git keeps the registration, prints its own `prunable` reason, and the
probes answer *gone* rather than raising anything. Clearing it is where the git
on the machine can differ: on the git this was built against (2.50) `git worktree
remove <path>` clears such a registration by itself, which is what lets ADR
0022's refusal of `prune` stand. Where `remove` will not do that, the entry comes
back as a refusal carrying git's own words — on that path, its `hint:` line
naming `prune` — the listing goes on showing the entry, and running the
repository-wide command stays the operator's decision rather than becoming this
app's escalation.

A worktree whose directory is still there and whose commits are on no remote is
never offered for removal, which means an operator who wants that disk space back
has to push or delete it themselves. That is the intended asymmetry: this app is
allowed to take away a copy of something, and never the last copy. Where the
directory is already gone there is no copy left to take away, only git's
registration of one, and that is offered on the lock alone.

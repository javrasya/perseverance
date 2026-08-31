# 28. A queue entry is not a run

Status: accepted (2026-08-31)
Context: [#59 The research
queue](https://github.com/javrasya/perseverance/issues/59), under the spec
[#28](https://github.com/javrasya/perseverance/issues/28). ADR 0020 settled the
revalidation a spawn is gated on, ADR 0021 the rail a press arrives from, and
ADR 0027 separated the GitHub invariant from the keyboard invariant. This
settles what happens to a press that passes every one of those guards and meets
a ceiling.

`0028` because `0027` is the highest number on disk and several numbers below it
were already written twice from parallel worktrees. Code that cites this ADR
spells the whole slug rather than the digits, for the reason ADR 0027 gives.

## Context

Research was the one press that could be made four times over. Every other run
in the harness is bounded by something the map can see — one claiming run per
ticket, one keyed run per operator — and research is bounded by neither: four
research runs on four different tickets break no invariant on GitHub and no
invariant at the keyboard, and an operator mapping a spec presses it as fast as
the rail will take it.

What they do contend for is invisible from here. A research run spends the agent
account's usage limits and the GitHub account's rate budget, and **both are held
against an account rather than against a checkout**. Nothing in this process can
read either one: there is no endpoint that answers *how much of your usage limit
is left*, and the rate budget the poller watches is one of the two, not both.

So the harness was refusing the fifth press. A refusal is the wrong answer to a
press that is going to be fine in four minutes — it puts the operator in a
polling loop against their own screen — and the two obvious alternatives are
worse: spawning anyway spends a budget that is already spent, and writing a
placeholder onto the map invents state GitHub does not have.

## Decision

**The ceiling is app-global, and its occupancy is the child process.** One
number for the whole app, not one per folder: four crossings each running four
research runs would be sixteen against one account budget, and no crossing can
see the other three. What occupies a slot is a live research child and nothing
else — `Terminals::live_research` counts children, so a run whose child has
exited frees its slot the moment it exits, whatever the ticket under it did.
Work and Ask are never counted and never queued: Work is bounded by the claim
and Ask writes nothing at all (ADR 0027), and putting either behind this ceiling
would make the interesting presses the ones that wait.

**Four is a labelled guess with a stated basis and a stated revisit
condition**, not a settled number: small enough that a machine sitting at it
still has a keyboard, large enough that a map's research phase is not
serialised. The evidence that would move it is one-directional and named on
`RESEARCH_CEILING` — a research run dying on a usage limit while slots were
still free.

**Configurable means one row of the app key/value table, and today it is
editable by hand only.** `research_ceiling` is a row beside the launcher
override's, parsed where the override is parsed, and a cell that is not a
positive decimal reads as *no stored ceiling* rather than as a failure — a
ceiling nothing could be compared against would hold every research press in the
app in a queue nothing leaves. Zero is inside that reading: there is no *stop all
research* preference, and an operator who wants one has the press they can
decline to make.

The first cut of this shipped a getter and a setter as Tauri commands with no
caller anywhere under `src/`. They are deleted. **Two commands standing in for a
decision nobody has taken are worse than the absence**, because the next reader
counts them as the answer and stops looking, and because the precedent they were
argued from — the launcher's `use_override` — is genuinely wired to a field. The
decision actually left open is *where an app-global preference lives*: this app
has no settings surface, and the launcher argues at length that the override
field sits inside the error it fixes precisely because there is no such screen.
That is deferred here in the record rather than answered by a dead surface. The
operator who needs a different ceiling writes the row; the operator who needs to
change it *while a queue is standing* is the evidence that says the screen has to
exist, and the commands come back with it.

**`Started::Queued` is a third answer, not a softer refusal.** The press passed
every guard — the awaited revalidation, the fresh reading, the takeability
comparison — and what it met was the ceiling, so the crossing is told the ticket
and the place, counted from one because a person reads it. There is no run
number to carry, and that absence is the whole difference from `Spawned`.

**A queue entry stakes nothing, and the list of nothings is the definition.** No
child, no worktree, no claim, no run number, no PTY, no row in `Model`, no entry
in the ledger, nothing on the snapshot the WebView draws. It is drawn in the rack
and nowhere else — the rack's own channel, `pending-runs`, mirrored by
`src/rack/pending.ts` rather than by anything under `src/views/`, and
`findQueueReferences` in `tests/support/checks.ts` runs over the view sources to
keep it that way. **The harness never invents state GitHub does not have**: a
waiting ticket is a ticket nobody has claimed, and the graph says so.

**The frontier takes a second input that is not GitHub's, and it reaches exactly
one decision.** A press that wrote nothing was invisible to every read, so the
derivation went on designating the ticket already waiting, Start Working admits
nothing but the designated number, and the queue capped at one entry — *six
presses, four spawns, two entries* was a screen the app could not produce. So
the derivation takes `spoken_for`, the ticket numbers this window has accepted a
press for, keyed by the folder's path because an issue number means nothing
across two repositories. It moves `Frontier::of`'s designation and nothing else:
the row keeps the state, the kind, the counts and the drawing GitHub's answer
gave it, so a waiting ticket never reads as claimed to the graph, to the
snapshot or to the foreign-claim announcement. It is a derivation-time input
taken from the queue at the top of each tick and written down nowhere, which is
what keeps *a pending entry stakes nothing* structural rather than a convention.
A press that *spawned* needs no such input: the agent takes its own claim and the
next read learns it from GitHub, which is the only writer there is. A waiting
press has nobody to do that for it, and that asymmetry is the whole reason the
parameter exists. The baseline the ledger resumes from is given the same slice,
because two readings of one window that could disagree would report a frontier
move the moment an operator looked away and back.

**A freed slot starts the next entry with no further press, and the dequeue is a
press rather than a resume.** The entry has been sitting for minutes; the world
moved. So the drain asks the same awaited revalidation a press asks, takes a live
reading keyed to *the entry's own* folder and map — `Ledgers` says which folder
the ledger it holds is a reading of, so an entry is answered by its own
repository or by no reading at all — and then asks the guard the verb that queued
it would have asked. A folder with no live reading starts nothing, ever.

The order is the press's order inverted, and that is the one thing a queued entry
may not copy from a press. A press is made by somebody looking at the map, so its
revalidation is always about the map in front of them; an entry is not, and the
question *is anybody looking at this entry's map* is a lock and no network. Asked
second, it threw away a forced, off-cadence, human-authority poke per entry per
turn — an unanswerable queue setting the cadence ADR 0007 owns and spending the
budget ADR 0008 says the poller yields first. Asked first, a poke is spent only
on an entry this window could actually answer, and the reading is then taken
again on the other side of it, because the first one is exactly what the fresh
pass replaced.
Without those guards `booked` recorded a claim as this harness's own for a ticket
it may never have taken, which is exactly what suppresses the foreign-claim
announcement.

**The entry carries the verb it was pressed on, because the two verbs admit
disjoint nodes.** Start Working admits a node the map offers to start and Resume
admits one the map reports as claimed, and `NodeState` gives those two names to
states that cannot both be true — so a single takeability question at the drain
was a queue that accepted a Resume press, told the operator it starts on its own,
and then popped it and refused it with *#N is not something this map offers to
start any more*. A Start entry is re-asked `Node::is_takeable`, which is what the
frontier comparison a queued entry cannot make was standing in for; a Resume
entry is re-asked `why_the_claim_cannot_be_resumed`, whole and unedited, against
the fresh reading. **A queue may only make promises the code behind it can
keep**, and the alternative — refusing Resume at the ceiling instead — was
rejected because a stranded research claim is exactly the press this queue exists
to absorb.

**An entry nobody could take a reading for keeps its place; only a reading that
was taken and said no ends a press.** *A freeing slot starts the next queued run
with no further press* is a promise about slots, not about where the operator is
looking, and the live reading is keyed to the entry's own folder and map — so a
child exiting while the operator reads another map would otherwise pop the whole
standing queue and refuse it one entry per turn, and six presses followed by a
glance elsewhere would lose the last two. So the recheck answers three ways and
not two: *this map says no* is the entry's own answer and it leaves with a
sentence; *nobody is watching this entry's folder* is a fact about the window,
and the entry is put back at the front of the queue in press order and
reconsidered on a later turn. The drain still walks past it to the entries
behind, because this queue spans every folder the operator has open and a head
that is off screen is no reason for a tail that is on it to wait. The one absence
that does end a press is the folder leaving this app's list: no turn will ever be
able to answer that entry, so waiting for it would be waiting forever.

**A revalidation that is not a read is the same kind of absence.** The deadline
running out is *held under a floor, or queued behind a read already in flight* —
the expected answer whenever the rate-limit reserve holds the poller, so refusing
on it would make the promise conditional on GitHub's budget being comfortable. A
pass that asked nobody is a fact about this app. And a failed tick is a read of
whatever repository the poller is watching, which is not this entry's unless the
operator happens to be sitting on it: a transient unreachable on one folder
ending every press queued against another is evidence about the wrong repository
destroying presses it was never about. All three keep the entry's place. The
interactive press keeps the opposite rule and the four sentences that go with it,
because somebody is standing in front of it who can read *GitHub could not be
reached* and press again; a queued entry has nobody, so that sentence would be
the last anyone heard of it.

**And none of that happens on the readout tick.** Two GitHub round trips, a
worktree of its own, an environment harvest and a PTY spawn on the three-hertz
thread froze every rack readout and the poller's own falling edge for seconds.
The tick sends one nudge into a single-slot channel and goes on; a third thread
listens and drains, and the nudge is sent only when a free slot could actually
take an entry — a queue standing against a full ceiling is one no turn can pop,
and waking a drain for it three times a second is load on the account whose
limits are the whole reason the ceiling exists.

**An entry that is starting is still a press.** The single slot keeps the same
entry from being handed out three times a second, but the start it is handed to
is seconds long — a revalidation, two reads, a worktree, a harvest, a spawn — and
an entry that had left the queue for that window existed nowhere: no rack row, no
`spoken_for`, so the next derivation designated the ticket again and a press
landing in the window found a frontier that offered it and room the drain had not
booked yet. So the queue holds two lists under one lock, and an entry is in one
of them from the press until there is a run, a sentence, or its place back.
`spoken_for` and the rack read both; only the drain's own pop reads the first
alone.

**A deferred spawn that fails is reported once, as a sentence, and never
retried.** The press it came from was answered long ago, so the rack prints the
refusal beside the queue on exactly one emission. It is not a row: a refused
entry has left the queue and is not waiting for anything, and a row for one would
be a queue entry that never drains. The harness surfaces its own failures and
does not paper over them with a retry the operator did not ask for.

## Consequences

An entry can outlive every reading that could have started it, and nothing tells
the operator so. A press queued against a folder they never open again sits in
the rack indefinitely: it holds no child, no worktree and no claim, and it drives
no reads — the nudge waits for a free slot and the recheck asks the window before
it asks GitHub — so it costs nothing but the row and the slot it is still owed,
and the process dying is what collects it. That is the price of not refusing an entry for the window's absence,
and it is the cheaper of the two mistakes: a standing entry can be read and
ignored, and a lost press has to be noticed first. The thing to watch for is a
rack whose queue never shortens; a way to withdraw an entry is the answer to it,
and no one has asked for one yet.

The queue lives in the process and dies with it. A quit loses what has not
started — which is correct, because nothing was staked: no checkout to clean up,
no claim to release, nothing on GitHub that would have to be reconciled on the
next launch. What the operator loses is a press.

The ceiling cannot be changed from the screen. An operator sitting at four live
runs with three waiting has exactly two moves — wait, or edit a row and restart —
and that cost is the price of the deferral above. It is the thing to watch for:
the first report of it is the argument for the settings surface.

`PendingRun` is mirrored by hand in TypeScript. The type lives in `crates/app`
rather than in the model crate — deliberately, because a field on the snapshot is
the first thing a view would draw a queue entry from — so no generator emits a
declaration for it and nothing fails a build when a field is added on the Rust
side. What stands in for the generator is the shape being pinned from both ends:
the Rust test asserts the wire keys and their count, and `tests/rack.test.tsx`
asserts the mirror against the same names.

`spoken_for` is a second input to a derivation whose whole virtue was that it
read GitHub and nothing else. The mitigation is its reach — one designation, one
call site, no persistence — and it is worth restating in any review that widens
it: the moment a second decision reads it, a local press starts moving what the
map says.

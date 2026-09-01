# 23. Resume is a UI verb over a claim already made

Status: accepted (2026-08-31)
Context: [#49 The two endings](https://github.com/javrasya/perseverance/issues/49),
under the spec [#28](https://github.com/javrasya/perseverance/issues/28). It
rests on [ADR 0022](0022-a-runs-ending-is-two-independent-facts.md) for the two
facts a run ends by and for the rule that nothing about a run is persisted, and
on [ADR 0021](0021-the-rail-is-four-sockets-and-a-press-carries-its-own-adapter.md)
for what a press is.

## Context

A claim outlives the process that took it. The claim is an assignment on GitHub
and nothing this app holds, so quitting the app, losing the machine or killing a
pane leaves the ticket assigned and the work half done — the stranded claim
`WORK_LOSS` already promises somebody will pick up. Resume is the press that
picks it up.

The tempting reading of *resume* is **reattach**: keep a session id, hand it back
to the adapter's own `--continue`, and put the operator back in the conversation
they left. It is the wrong reading twice over. A session id is a fact about a
process, and the process is gone; storing one would mean a store schema, a
lifetime nothing can honour, and a row that is a lie the moment the machine
reboots. And it is not what the operator needs: what they need is an agent
working on their ticket, which the ticket itself already describes.

The second tempting reading is a **second prompt** — a `resume-ticket` template
that says *you are picking up work already started*. That is a sixth template and
a second behaviour, and a second behaviour is a second thing to keep true.

## Decision

**Resume is a pure UI verb, and the only thing that distinguishes it from Start
Working is a precondition.**

`resume_working` in `crates/app/src/lib.rs` is `start_working` with one guard
swapped and two put back by hand. It takes the same press — `folder`, `ticket`,
`adapter` — gates on the same awaited revalidation, and reaches the same
`spawn_at`, `render`, `plan_in` and `kind_of`. Where Start Working requires
`Frontier::Designated(ticket)`, Resume requires the node to read
`NodeState::Claimed` on the model that revalidation just produced.

**The two guards Resume cannot inherit, it re-states.** Start Working's target
comes from the frontier, and the frontier's resolver has already answered two
questions by the time it designates anything: `Node::is_takeable` refuses a node
that is not a wayfinder ticket, and a ticket this host is not allowed to take is
reported as `Frontier::NotOnThisMachine` rather than designated. Resume's target
is the operator's selection, which has been through no resolver at all — and
`NodeState` is derived from state and never from kind, so an assigned, unblocked
spec node and an assigned, unblocked unclassified child both read `Claimed`, as
does an assigned ticket labelled for another platform. Both are selectable rows
in the Route. So `why_the_claim_cannot_be_resumed` asks both in front of its
state match: *is this a wayfinder ticket*, which is what keeps the destination a
destination rather than something an agent is launched at and a child with no
recognised wayfinder type unspawnable; and *is this bound to another machine*,
because [ADR 0015](0015-platform-bound-work-is-a-clause-in-the-one-resolver.md)
promises of that label family that nothing is hidden and nothing is launched, and
a claim over one is not the exception. Without the first, `kind_of` falls through
to `RunKind::Work` and a work brief is rendered for a node no brief fits. The
rail asks the same two questions in front of the same state, so the button is
recessed with the reason on it rather than armed on a press that could only be
refused.

**The prompt is byte-identical.** One `prompt::work_ticket`, one
`prompt::Coordinates`, one `work-ticket.md`, and the override read at spawn
wholesale as it already is. There is no verb in the template, on the coordinates
or in either command's arguments, and a test pins all three. What that buys is
that a resumed session cannot behave differently for having been resumed.

**The three-way step 1 is what makes it legal.** The brief already tells the
agent what to do about the assignee it finds: unassigned — claim it and proceed;
assigned to you — proceed, writing nothing; assigned to anyone else — stop and
say so. A session handed a claim it must not touch refuses by reading its own
brief, which is the only correctness guard there is and the only one there needs
to be.

**Identity is deliberately not consulted.** The model carries a *count* of
assignees and no logins, on purpose, and every run of this harness assigns the
same login — so *claimed by me* is liveness, not identity, and this side could
not decide it if it wanted to. Resume is therefore offered over any `Claimed`
node. The GraphQL read is not extended with logins, no comparison is written, and
nothing is ever un-assigned: the harness is a read-only observer of GitHub with
exactly one writer, and that writer is the agent.

**A live claim is re-focused, never re-spawned.** One foreground run per crossing
is structural — one crossing, one pane — so a resume is refused while this window
already holds a run staked on that ticket in that folder whose child has not
exited. The match is on the folder as well as the number, because an issue number
is unique inside one repository and means nothing across two. The rail, not this
command, is what turns that refusal into a re-focus.

**Nothing is written down before the spawn succeeds**, and nothing new is written
down at all. On success the same three writes and the same bind Start Working
does: the stakes, the claim, the run count, the monitored pane. A refusal at any
step leaves the graph and the ledger exactly as the revalidation left them and is
a sentence returned to the socket — never a `Degraded`, and never a silent retry.

## Consequences

**A ticket that has gained a blocker is not resumable.** `NodeState` is derived
in strict precedence — resolved, then blocked, then claimed, then takeable — so a
ticket assigned to the operator with an open blocker in its way reads `Blocked`
and Resume refuses it. That is a consequence of the one derivation the whole app
reads, and this file does not get to soften it with a second opinion about what
*claimed* means. If it ever needs softening, it is softened in `derive.rs`, for
every reader at once.

**A resumed session starts cold, and the template is the mitigation.** It has no
transcript, no context and no memory of what the last one was doing. What it has
is the sentence already in `work-ticket.md` sending it to read the ticket's
existing comments before it starts, which is why a partial finding posted to the
ticket survives a dead run and one held in a dead process does not. That is a
reason to keep posting findings to the ticket, and it is upstream of this
decision rather than answered by it.

**No session id, no reattach, no store change.** The byte scan over
`crates/store` that ADR 0022 leans on keeps this honest: nothing named `session`,
`run_id` or `runs` may appear in a file that outlives the launch, and no adapter
learns `--continue`, `--resume` or `--session-id`.

**`RunReadout` gains the ticket and the folder its run is staked on.** Together
they are the value that joins a run to a node, and the rail needs that join to
tell *claimed with a live terminal* from *claimed with none* — which is the whole
of which of the two things a press does. Both halves, because the join is the
same one `live_run_on` makes: an issue number is unique inside one repository and
means nothing across two, and this window holds every folder's runs at once, so a
rail joining on the number alone would answer a claim in one repository with
somebody else's run in another — moving the pane onto an unrelated agent and
sending no command at all, which is the one branch of this verb Rust is never
asked about. `crates/pty` is untouched and still does not know what a ticket or a
repository is: both values are derived in `crates/app`, where the stakes already
live.

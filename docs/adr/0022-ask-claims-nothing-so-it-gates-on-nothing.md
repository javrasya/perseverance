# 22. Ask claims nothing, so it gates on nothing

Status: accepted (2026-08-31)
Context: [#55 Ask, on any node of the open
map](https://github.com/javrasya/perseverance/issues/55), under the spec
[#28](https://github.com/javrasya/perseverance/issues/28). ADR 0020 settled the
revalidation a spawn is gated on, and ADR 0021 settled the rail the press
arrives from. This settles what a press that writes nothing has to wait for.

## Context

Every spawn built before this one exists to make a write land on GitHub: a work
run takes an assignment, a charting run creates issues, a compose run attaches a
document. So every one of them is gated the same way — an awaited revalidation
first, then a comparison against a fresh reading of the map — because the thing
the harness cannot repair is two writers on one ticket.

Ask is the first run that writes nothing. It answers a question the operator
types into it, out loud, and its whole template is the six writes it may not
make. Gating it the way its siblings are gated would buy a round trip to GitHub
— and a `checking…` the operator has to sit through — to find out whether
somebody else holds a claim that this run was never going to take.

Underneath that sat a second question. "One foreground human-in-the-loop run"
had been carried as a single rule, and Ask is where it stops being one: a
question about the ticket a live work run is holding is exactly the question an
operator wants to ask, and refusing it would make the interesting nodes the
unaskable ones.

## Decision

**The rule was two rules, and they are written down as two.** The *GitHub
invariant* is at most one **claiming** run: one ticket has one writer, and it is
enforced by the claim, the frontier comparison and the revalidation that keeps
them honest. The *keyboard invariant* is at most one **keyed** run: there is one
operator and one pane, so exactly one run has the keys at a time, and it is
enforced by the monitor bind and nothing else. Ask is subject to the second and
outside the first.

**So `ask` gates on nothing.** No revalidation, no `Claims` handle, no frontier
comparison, no phase or rung check, no duplicate-run guard, no queue and no
ceiling. A live claiming work run and a live compose run both stay live and
neither refuses the press. What is left are the honest refusals — no map is
open, that number is not on this map, no token, no operator, the store's own
sentence, and whatever the spawn itself refuses with — and every one of them is
a sentence returned to the socket rather than a `Degraded` on the graph.

**It takes the keys anyway.** A successful spawn binds the monitor, so the pane
follows the question even while a claiming run is going. That is the keyboard
invariant doing its job, and it is why the two rules had to be separated before
this command could be written.

**Any node, and no body inlined.** A ticket, the map's spec, or a child with no
`wayfinder:` label: all three are askable, because the unclassified child is the
one you most need to ask about. The template carries coordinates only — the one
piece of map content that travels inline is the *claimed* ticket's question, and
this run claims nothing — so Ask asks GitHub for nothing before the spawn beyond
the operator login it had already memoised.

**Its own `RunKind`, with its own loss sentence.** `RunKind::Ask` is chosen at
the call site, as `Compose` is, because a press has no ticket type to map from —
an Ask on a spec node has none at all. Its quit sentence may borrow neither
neighbour's: there is no claim for Resume to pick up and nothing unposted
waiting to go, so what it loses is the conversation and nothing else.

**And the kind crosses the seam, because *claiming* is half of every join to a
node.** A run's stakes name a node with a number and a folder, and Ask stakes the
node it is asking about — the same pair a work run stakes on the ticket it is
holding. Naming is not holding, and nothing on the wire said so: `RunReadout`
carried the pair and no kind, so Resume's join (`liveRunOn` here,
`Terminals::live_run_on` there) answered a question as if it were the claim's own
run, and the resolution join in `Terminals::noticed` handed a question about a
closed node the ending *the ticket closed*. Both are the decision above being
read backwards — the GitHub invariant reaching a run declared outside it — so the
fix is in the same place the decision is: `RunKind` now serialises, `RunReadout`
carries `kind`, and `RunKind::claiming` (mirrored as `claiming` in
`src/terminal/runs.ts`) is what both joins ask. Work and research claim; chart,
compose and Ask do not. A non-claiming run therefore never enters the resolution
table at all, which is what keeps its ending `Live` until its child exits and
`Exited` afterwards, whatever the node under it did.

**What #56 still owes.** The kind is on the wire and no surface draws it yet:
the rack is #56's, and *appears in the rack as its own kind* is met on this
branch only in the sense that the substrate is there and correct. #56 reads
`RunReadout.kind` and needs nothing further from this side.

## Consequences

Ask is the cheapest button on the rail. It answers in the time it takes to spawn
a child, because there is no awaited poll in front of it, and the one thing that
can make it fail slowly is the spawn itself.

The prohibition is prose and not a sandbox. Nothing at the process level stops
an Ask session from running `gh issue comment`; the six verbs and the escape
valve are the whole enforcement, and read-only enforcement below the prompt is
deliberately out of scope for v1. The conformance test in `crates/app/src/prompt.rs`
asserts the verbs and the valve word for word, because losing one of them is a
silent failure everywhere else.

A finding an Ask session makes comes back as a sentence in the reply, never as a
write. That costs the operator a hop — they press Start Working, or file the
ticket themselves — and it buys the property the whole harness rests on: every
resolution on the map has a session behind it that claimed it.

## The socket

Ask is the third **spawning** socket on a rail that is four boxes in one fixed
order (ADR 0021). It arrived as a real button rather than as a fifth box,
because a socket that appears when its ticket lands is a rail that changes shape
under a hand.

Its conditions are the honest ones and only those, in the order an operator
meets them: no map is open, nothing is selected, the selection is not on the
open map, no folder is open, that folder is still being read, and no agent CLI
was found in it. The first is read off `model.map.number` and never off the
frontier — asking the frontier whether there is a map would borrow the answer to
*is there a takeable ticket*, and would darken Ask on exactly the finished map
where a question is what is left to have. The third is Rust's `#N is not on map
#M` said in front of the press rather than bought with one.

What is **absent** is the decision above, written into the derivation. The
selection's kind is not read, so the spec node and an unclassified child are
askable. The label that binds a node to another machine is not read, because
nothing is being launched at it. The node's state is not read for what it says —
only for whether the node is on this map at all — because a run that takes no
claim has nothing for `claimed` or `blocked` to refuse. The rung, the frontier
and a compose already open are not read, and neither are the live runs: there is
no ceiling here and no queue. A reader who finds one of those facts back in
`askSocket` is looking at the GitHub invariant leaking into a socket that is
outside it.

The one rule that does reach the socket is about **presses** and not runs: one
crossing sends one command at a time, so an Ask press in flight recesses the two
spawning sockets beside it with `ASK_IS_OUT`, exactly as theirs recess Ask. That
is the rail refusing to send a second command from one hand, and it is not a
gate on Ask — the moment the answer lands, the socket is filled again over
whatever run is still going.

A successful press binds the monitor on this side too, which is the keyboard
invariant declared where the operator can see it: the keys follow the question.

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

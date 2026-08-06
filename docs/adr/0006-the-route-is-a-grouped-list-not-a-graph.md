# 6. The Route is a grouped list, not a graph

Status: accepted (2026-08-06)
Context: [#34 The Route](https://github.com/javrasya/perseverance/issues/34),
under the spec [#28](https://github.com/javrasya/perseverance/issues/28). The
question was opened in [#10](https://github.com/javrasya/perseverance/issues/10)
and the shell that settled it is
[#11](https://github.com/javrasya/perseverance/issues/11). The registry that
will eventually hold rule declarations is
[#42](https://github.com/javrasya/perseverance/issues/42), which this decision
deliberately puts nothing into.

## Context

Four views were designed against the same map, and the one genuine disagreement
between them was whether fan-out is worth drawing — an edge from each ticket to
every ticket it unblocks, so the shape of what opens up is on screen as lines.
#10 recorded that both readings are defensible and that they lead to different
products, and answered it by shipping four views rather than by making one of
them deviate from the others.

The argument against drawing it is that a fan of edges reads as capacity. Six
lines leaving a node say *six things can now start*, and on this map the takeable
tickets are all human-in-the-loop, so the honest number of things that can start
in parallel is one. Drawing the fan tells the operator something true about the
graph in a way that is false about their day.

#11 then settled the shell. Twelve mockups were built and all four reviewers
picked the same one — C5 · Sprung — and inside it the same view as the global
default: The Route. That mockup is the acceptance bar for what The Route looks
like, and what it shows is not a drawing at all. It is a list.

This matters more than a styling choice, because it post-dates #34's own body.
The ticket was written expecting hand-rolled SVG, a longest-path ranker, and
`unlocks N` as a declared deviation against a fan-out rule. None of the three
survives the shell round, and a view built to the ticket rather than to the bar
would have been a second answer to a question already answered.

## Decision

**The Route is a grouped list in one column. It draws no edge at all.**

The DAG is the wrong primitive for *what do I work on next*. That question wants
one answer and a short queue behind it, and a graph answers it by drawing
everything at once and leaving the ranking to the eye. So the structure is
carried by two channels the eye reads first: **membership of a section** — Now /
Next, Frontier, Blocked, Resolved — and **position in the column**. Everything a
row adds beyond that, it adds in words.

Edges get words rather than pixels. `blocked by N` on the row that waits, where
N is the count of that node's named blockers this map still shows as open; and a
note on the same row when a blocker names an issue with no row here, because a
map that cannot judge a blocker must say so rather than count it.

**Zero drawn edges is Structural under [#42](https://github.com/javrasya/perseverance/issues/42),
not a declared deviation.** A declared deviation is a view failing a Judged rule
of the encoding contract — fog on the contract, a worklist item, something
scheduled to be worked off. Not drawing edges is not a failure awaiting repair;
it is the view's thesis, and the reason there are four views instead of one.
Filing it as a deviation would schedule this design for deletion and hand #42 a
worklist entry whose only correct resolution is to delete the entry — the exact
mistake #42 says is paid four times over.

## Alternatives

**Draw the fan and mute it.** Rejected: a muted line is still a line, and the
reading it produces — capacity the operator does not have — is the one this
declines to produce. Muting changes how loud the wrong answer is, not which
answer it is.

**Draw the fan behind a toggle.** Rejected here and answered elsewhere: the
other three views draw it, and the operator switches to one of them. A per-view
toggle is how four views become one view with four settings, and #10's answer
was four views.

**Show the number and the fan.** Rejected: the number would then be a legend for
the lines rather than a substitute for them, and the capacity misreading
survives intact beside it. This is also why `unlocks N` is not built at all —
the ancestor round's convergence scalar did not survive into the shell, and a
number nobody has a picture to check it against is worse in a list than it was
on a graph.

**Keep the ranked columns as a second Route mode.** Rejected: it is the toggle
again with a longer name, and it would keep a longest-path ranker, a router and
five geometry constants alive for a view no ticket has scheduled. Dead code with
a doc comment on it is still dead code, and the ranker is deleted rather than
parked.

## Consequences

**The Route cannot say *which* tickets a node opens up.** That question belongs
to the three views that draw the fan, and the operator switches to one of them
to ask it. It cannot say *which* one blocks a row either: the count is here and
the identity is the detail panel's, [#54](https://github.com/javrasya/perseverance/issues/54),
which the spec already lists as carrying blockers and blocked. #34 ships no
blocker identity anywhere, so #54 must not arrive expecting it to exist.

**A cycle is invisible in the pane, and that is correct.** The old ranked view
said so above the picture, because columns drawn around a cycle are a guess. A
list makes no such guess: a member of a cycle lands in Blocked because its own
state says *blocked*, which is true rather than inferred, and no order between
its members is being claimed. There is nothing left to admit to.

**The pane is structurally immune to the crossing problem.** Zero edges drawn
means zero edges to cross, at any n. That is the one clause of the ancestor
round's O(1) argument the built thing actually earns; the rest of it — capped
regions, `N more`, a fixed rail height — is not implemented, and the pane
scrolls instead.

**`waitsOn` survives with a new justification.** It was added to the derived
`Node` by this ticket because ranking needs adjacency, and adding it was Rust
work: `crates/model` reads GitHub's blocked-by connection, drops the blockers
belonging to another repository — an issue number means nothing outside the
repository that issued it, so `other/repo#75` would otherwise be counted against
this map's `#75` — and the generated bindings and every fixture on both sides of
the seam were regenerated behind it. The ranking is gone; the field stays,
because the derived model carries no per-node blocker count and `waitsOn` is
therefore the only source for `blocked by N` and for *this blocker has no row
here*. What the pivot from ranked columns to a list cost was zero *further*
Rust: nothing was re-derived, no binding was regenerated a second time, no
fixture changed shape again, and `npm run dev:web` from fixtures alone kept
working throughout.

**Falsifiability.** A rule nobody can fail is a rule nobody declared, so this
decision is asserted rather than described. `tests/route-view.test.tsx` and
`tests/dev-web.test.tsx` each check that the pane contains zero `svg`, `path`,
`line`, `polyline`, `polygon` and `canvas` elements and zero `[data-link]` —
unconditionally, in every state the view can be put into: nothing selected, a
node selected, a map with nothing on it, and no map open. There is no exception
clause, because an exception is a place for a graph to come back.

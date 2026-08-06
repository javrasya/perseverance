# 5. The Route declines to draw fan-out

Status: accepted (2026-08-06)

Context: [#34 The Route](https://github.com/javrasya/perseverance/issues/34),
under the spec [#28](https://github.com/javrasya/perseverance/issues/28). The
rule this declares against was settled in
[#10](https://github.com/javrasya/perseverance/issues/10); the registry that
will eventually hold declarations is
[#42](https://github.com/javrasya/perseverance/issues/42), which is blocked by
this ticket.

## Context

Four graph views were designed against the same map. Three of them draw
fan-out: an edge from each resolved ticket to every ticket it unblocks, so the
shape of what opens up is on screen as lines. The Route does not. This was the
one genuine disagreement among the four, and it was settled by shipping both
readings rather than picking one — the operator chooses per task, which they
cannot do if one reading was never built.

The argument against drawing it is that a fan of edges reads as capacity. Six
lines leaving a node say *six things can now start*, and on this map the
takeable tickets are all human-in-the-loop, so the honest number of things that
can start in parallel is one. Drawing the fan tells the operator something true
about the graph in a way that is false about their day.

The argument for drawing it is that the fan is the graph, and a view that hides
an edge is a view whose ranking cannot be justified from what is on screen.

## Decision

The Route draws no fan-out. What a node opens up is a number on the node —
`unlocks N` — and nothing else. Selecting a node draws that node's upstream
links only: what stands between the operator and starting it. Downstream stays a
number.

This is a **declared deviation**, not a defect and not an omission: it is
written here, it is restated — and pointed back at this file — in
`src/views/route/Route.tsx`'s module doc comment, and both halves of it are
asserted against the mounted component —
with nothing selected the Route renders zero link paths, with a node selected it
renders that node's upstream link and no other, and `unlocks N` is read off the
drawn node. A deviation nobody can fail is a deviation nobody declared, and half
a deviation that cannot be failed is the half that quietly stops shipping.

## Alternatives

*Draw the fan and mute it.* Rejected: a muted line is still a line, and the
reading it produces is the one this declines to produce.

*Draw the fan behind a toggle.* Rejected here and answered elsewhere: the other
three views draw it, and a per-view toggle is how four views become one view
with four settings.

*Show `unlocks N` and the fan.* Rejected: the number would then be a legend for
the lines rather than a substitute for them, and the capacity misreading
survives intact.

## Consequences

The Route cannot answer *which* tickets a node unlocks without a selection; that
question belongs to the views that draw the fan, and the operator switches to
one of them to ask it.

`unlocks N` is only as true as the edges behind it, so the edges had to arrive
with this ticket rather than after it: the derived `Node` carries `waitsOn` —
every blocker GitHub named, filtered in Rust to this repository — and the Route
transposes that into its edge set. A number nobody could check is not a
substitute for a picture, which is what `N` would have been against an edge set
the seam did not carry.

What the ranking still cannot account for is said above the picture instead of
being drawn: tickets that wait on each other have no longest path between them,
and an edge naming an issue that is not a child of this map has no row to join.
Both are sentences on screen, because a column that cannot be justified from the
map is absence disguised as presence.

When the rule registry of
[#42](https://github.com/javrasya/perseverance/issues/42) lands, this
declaration moves into it as the Route's entry against the fan-out rule and this
ADR becomes the pointer. The registry is blocked by this ticket, which is why
the declaration starts here: a deviation that waits for its mechanism is a
deviation that ships undeclared.

# 25. The Plate is shapes and words, and it spends no motion

Status: accepted (2026-08-31)
Context: [#63 The Plate](https://github.com/javrasya/perseverance/issues/63),
under the spec [#28](https://github.com/javrasya/perseverance/issues/28). It
rests on [ADR 0006](0006-the-route-is-a-grouped-list-not-a-graph.md) for what a
view may do with what crosses the seam, on
[ADR 0016](0016-the-fog-is-a-named-region-with-two-absences.md) for the two
absences this view has to draw, on
[ADR 0017](0017-out-of-scope-is-not-progress.md) for the cut it decorates rather
than counts, and on
[ADR 0020](0020-the-contract-is-thirteen-rules-in-three-tiers.md) for the tiers
that decide which of those obligations is a test and which is a declaration.

`0025` and not `0005`: `0005` is missing rather than free — the directory also
holds two ADRs numbered `0010`, two numbered `0020` and two each at `0022`,
`0023` and `0024`, so `0024` is the highest number in use and this is the one
after it.

## Context

The Plate is the second view, and it is the first that draws a graph. Every
decision below comes from one fact: **the contract binds meaning and never
geometry**, so the Plate is not allowed to look like the Route and is not
allowed to *mean* anything different from it.

The Route encodes with position in a list and with words. A diagram has neither
to spend: a station is a mark on a field, and what tells one mark from another
has to be visible in the mark. That is where three decisions had to be made.

**What tells eleven things apart.** The four node states, the designated
frontier, the destination, unclassified, the cut, the ticket type, AFK versus
HITL, and *not on this machine* are eleven encodings, and a first pass reaches
for eleven colours. Rule 3 forbids that outright for unclassified — a fail-safe
that a retheme can erase is not a fail-safe — and the same argument applies to
every one of them the moment somebody prints the screen or turns the contrast
up. So the eight facts about the *graph* are eight **shapes**: an open disc, a
squared station with a bar, a lozenge in a second outline, a wide ring with a
hub, a small closed disc, a strike across it, a square on the diagonal with a
dashed edge, and a terminus chevron. The three facts about the *reader* — what
kind of ticket this is, whether it runs with somebody at the keyboard, and
whether this machine may start it — are **words** on the name plate, because
none of them is a property of the topology and all three are read by a page
search and a screenshot. Colour survives as a second channel that carries
nothing on its own.

**What hover is for.** Rule 10 hands each view its own hover semantics and
forbids putting anything load-bearing behind it. A transit diagram's own reading
of hover is not disclosure at all: it is *which line is this part of*, answered
by bringing one thread forward and letting the rest of the network recede. That
is the question a list cannot answer and the reason this view exists, so the
Plate spends its hover on exactly that and reveals nothing — every station,
plate, tag and reason is painted before a pointer arrives, and the keyboard
lights the same thread on focus.

**Whether to spend motion.** Rule 9 rations motion to running versus stale
claim. `NodeState` is `resolved | blocked | claimed | takeable` and no field on
this side says whether work is in flight, so the subject the ration exists for
is unrepresentable here — the tension the registry already records against rule
9. The Route spends its one licensed animation on `claimed`, the nearest thing
to liveness this half of the app has. The Plate could have inherited that
argument and drawn a pulsing train lozenge.

## Decision

The Plate draws a Beck transit diagram — a station per child, octolinear track
per *waits on*, ranks left to right, sidings under the drawing for children
nothing waits on, a fan stem where finishing one station frees several — and
encodes the graph in shapes, the reader's facts in words, and nothing in hue
alone.

Hover and keyboard focus enlarge one station and bring its whole thread forward
while the rest recedes to a lower but legible opacity. Nothing is disclosed and
nothing is withdrawn, and the view ships no `title` attribute and no `<title>`
element anywhere.

**The Plate spends no motion at all.** There is no `animation` and no
`transition` in its stylesheet. The liveness the Route draws as a pulse, this
view draws as a lozenge inside a second concentric outline — a still form
carrying *somebody has this ticket in their hands* on its own. Under
`prefers-reduced-motion` the drawing is identical to the drawing at rest, so
rule 12's residue has nothing to be lost from.

The legend is part of the drawing rather than a decoration on it. A siding is
the one convention an operator cannot read off the picture, so the margin names
it in words and counts the sidings actually drawn — and the legend, like the
fog, lives in a fixed-width column beside the field that the topology cannot
grow into.

## Consequences

The Plate can be rethemed to one ink and stay readable, which is the property
rule 3 asks for and the conformance suite collapses tokens to check. Nothing on
the drawing is hidden behind a pointer, so a screenshot of it is the whole of
it.

The cost is registered honestly in `docs/contract/declarations/plate.md`: a name
too long for its reserved plate is clipped, and this view offers no way to read
the rest in place — no tooltip, because that is the thing rule 10 is about, and
no wider plate, because the plate's width is the box the router is routing
around and widening it is a geometry change rather than a paint one. That is the
one declared deviation, and it is a worklist item rather than an exemption.

Spending no motion also means this view carries no evidence about rule 9's open
tension. The day the model carries a running bit, the Route's licensed animation
and this view's still lozenge move together — and until then, two views answer
liveness two ways and both answers are still.

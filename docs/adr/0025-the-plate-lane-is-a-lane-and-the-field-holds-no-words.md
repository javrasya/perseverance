# 25. The plate lane is a lane, and the field holds no words

Status: accepted (2026-08-31)
Context: [#64 Deep Field: the second view](https://github.com/javrasya/perseverance/issues/64),
under the spec [#28](https://github.com/javrasya/perseverance/issues/28). It
rests on [ADR 0006](0006-the-route-is-a-grouped-list-not-a-graph.md) for what a
view is, what it may be handed, and why The Route declines to draw a graph at
all; on [ADR 0020](0020-the-contract-is-thirteen-rules-in-three-tiers.md) for
the tier this view's rule-11 reading is judged under; and on
[ADR 0022](0022-the-dial-is-four-detents-and-nothing-switches-by-itself.md) for
the shell-level floor and stand-down this view's own stand-down sits beneath.

`0025` and not `0022`: the number is one above the highest already on disk,
which is not the file count. `0005` was never written, and `docs/adr/` holds two
ADRs numbered `0010`, two numbered `0020`, two numbered `0022`, two numbered
`0023` and two numbered `0024` — twenty-eight files before this one, and `0024`
is the highest number among them.

## Context

Deep Field is the second registered view and the first one that draws a graph.
The Route answers *what do I work on next* as a grouped list and deliberately
draws no edge; Deep Field answers *what is holding what*, which cannot be
answered without drawing the dependency structure. Registering it is what
crossed the existing fixture space with a second view — 19 fixtures × 2 themes ×
2 motion settings, and no new fixture, because a fixture is a value of the model
and not a view's exhibit — and it is what put a second column on
`docs/contract/matrix.md` and a second file under
`docs/contract/declarations/`.

Drawing a graph is what makes rule 11 — *a view's graph field may not double as
its label surface* — a live question for the first time. The decisions below are
that question's answer and its consequences.

## The plate lane and the field are two coordinate spaces, not two halves of one

Every word this view has to say about a node is on a **plate**, in a lane of
real DOM on the left, in map order. The **field** on the right is one
`aria-hidden` `<svg>` of bare circles and cubics with no text node anywhere in
it. Annotation therefore has reserved space that the topology cannot grow into,
because the topology's coordinate space starts after the boundary and the
words' does not exist inside it.

The reason the split lands there rather than as a margin around a drawing with
labels in it is **rank 0**. Charting a map produces a burst of independent
tickets, so eleven sources against ranks of four, two, one and one is the
ordinary shape of a map at this view's n, not the pathological one — the
`ledger-sweep` fixture is exactly that shape. Eleven labels beside eleven marks
in one tall column is precisely the field doubling as the label surface, and the
words would lie over the fan-out leaving that column, which is the densest part
of the picture at exactly the n this view claims competence at (12–25 nodes).

The alternative was to draw each plate *at* its node and reserve the gutter for
the map's own annotation. It keeps a node's words next to its position and costs
a lookup between lanes; the shipped reading keeps the field legible at a
structurally wide rank 0 and costs the operator a glance sideways. It was chosen
because a layout that only reads well on the tidy diamond is the wrong way round
— the tidy diamond is the exception. A reader may disagree, and
`docs/contract/declarations/deep-field.md` says so under rule 11 rather than
presenting the reading as forced.

The consequence the operator pays is that correspondence between the lanes is by
node number and nothing else: a plate prints `#N` and its mark carries
`data-mark-node`. The consequence the codebase gets is that exactly one element
per node carries `data-node`, which is what lets the conformance surface count
rows without counting each node twice.

## The clearance is 34px and stays view-local

Rule 11's corollary — a zone boundary needs clearance from the graph's own marks
— ships as `GUTTER_CLEARANCE`, 34px of blank on the field side of the boundary
that no mark and no drawn ink may enter at any n. A control point may, and that
is deliberate: the router's `reach` is half an edge's horizontal span and is
left unclamped in `deepField.ts`, so a refused back edge's second handle lands
inside the clearance. What keeps that off the screen is the clip rather than the
router — the field's `viewBox` starts at `split.field.x`, the boundary plus the
clearance, so the viewport drops anything left of it. The invariant is therefore
about ink and not about handles, and if `reach` is ever clamped to the boundary
this paragraph and rule 11 in `docs/contract/declarations/deep-field.md` have to
be rewritten together. It is promoted into no
registry, and that is the decision rather than an oversight: the rule binds the
clearance, not the 34. The number came out of this view's design round at this
view's plate width and column pitch, and asserting it contract-wide would
cargo-cult one view's fix at three views that never had the problem — which is
what the meta-rule prohibits. `tests/deep-field.test.ts` holds the invariant
over every fixture and every hand-built shape — the marks by their
`at.x - radius`, the edges by sampling the drawn extent of each cubic rather
than reading its control points; nothing holds the number but this view.

The boundary itself is drawn once, as the plate lane's right edge, a consequence
of `split.plates.width` rather than a second x free to disagree with the first.

## The band-relaxed organic scatter was built and rejected on sight

Before the strict rank columns there was a layout that took the rank assignment
as a band and let a node drift inside it — a small vertical and horizontal
jitter to break the grid, on the theory that an organic scatter reads as a map
rather than as a table and that the eye follows a curve better when its endpoints
are not aligned. It was built, rendered, and rejected on sight.

What it lost is comparability. With columns exact, *what is holding what* is
answered by horizontal position alone: everything at one x is one rank, and an
edge always travels rightwards. With the band relaxed, two nodes of the same
rank sit at different x, so the reader has to decide whether the difference means
anything before reading anything else — and it means nothing. The scatter also
made the wide rank 0 worse rather than better: jitter in a column of eleven costs
vertical space and buys no separation the pitch was not already giving.

It is recorded here because the rejected option is part of the decision. A later
round that wants an organic field should know it was tried, and that what sank
it was not taste but that a position which varies without meaning is a position
a reader has to rule out.

## The fan-out is drawn from the blocker to what it releases

An edge leaves the ticket that is blocking and lands on the ticket it unblocks,
so read left to right the picture is ground covered rather than debt owed. That
direction is why this view draws what ADR 0006 had The Route decline: The Route's
argument was that an operator asking *what next* is served by a grouped list and
a spray of edges is noise against that question. Deep Field asks a different
question, and for it the fan-out is the answer rather than the noise — but only
in this direction, where a resolved blocker's edge is history the operator can
stop planning around and is drawn fainter for it rather than dropped.

The back edge the ranker refuses is drawn anyway, marked, and named in words on
both plates it touches. A cycle is a fact about the map and nobody's to resolve
from here; a view that silently omitted the edge that caused the shape would
leave the operator looking at a picture with no explanation in it.

## The width floor is a constant and the stand-down is not

Two things measure width for this view, and they answer different questions.

The shell's floor is `VIEW_FLOORS["deep-field"]` in `src/panes/dial.ts`, and it
asks *does the view column exist at all* — one number per view, maxed with
`COLUMN_FLOORS.view`, read by the dial, the switcher and the shell's stand-down.
It is `widthNeededFor(2)`: two rank columns' worth, the narrowest picture in
which one ticket is drawn releasing another, which is the whole of what this
view is for. It is asked of the layout rather than written down, so the plate
lane, the clearance and the column pitch cannot drift away from the number the
dial promises.

The view's own stand-down asks *does this map fit*, and its answer moves with
the map: `widthNeededFor(depth)` is three column pitches wider for a four-rank
map than for a one-rank map, and no constant in the shell can say that. When it
does not fit, the view renders which view, why, what it needs and what it has —
and keeps the three integers and the frontier alive, because a map is still
being worked while the picture of it does not fit. It offers no exits: widening
is the dial's and opening another view is the switcher's, and a second set of
controls inside the view would be two controls for one move.

That last part is a departure from `src/chrome/MapChip.tsx`'s rule — the phase,
the three counts and the frontier are the footer's line, and anything that
repeats them is a second reading of the same numbers in a place with less room
to be right — so it is recorded here rather than left to be discovered. The
departure is confined to the stand-down. The drawn field repeats neither: its
header carries the competence line, which is this view's own reading and appears
nowhere else, and nothing more. The stand-down repeats both because the picture
they belong to is not on screen; the footer does still spell them at every dial
position (`describeModel` in `src/App.tsx`), so this is a repetition of last
resort rather than the only place the numbers can be read, and what it buys is
that the column the operator opened still answers in the place they are looking.
The two readings cannot disagree because both are `map.counts` and
`map.frontier` copied, never re-derived. If the stand-down ever grows a number
it computes for itself, this exception stops being defensible.

## Consequences

The view spends no motion. Every distinction it carries — five forms across a
plate glyph and an SVG mark, a cleared edge, a refused one — is geometry, so
`prefers-reduced-motion: reduce` changes nothing here and the app's licensed
animation list stays one entry long.

Registration cost the declarations and the matrix and nothing else in the way of
gates: `tests/contract-declarations.test.ts` went red the moment `"deep-field"`
entered `VIEWS` and went green on prose, `tests/conformance/support/views.ts`
was a type error until the view said how the contract reads in it, and
`docs/contract/matrix.md` gained a column. The conformance driver learned to open
a view that is not the default by seeding the one remembered-view key before the
app boots, which is how an operator's last session opens it too.

One obligation is outstanding and it is not closed by this ADR: the judged
declarations are prose a human reads against the rendered Deep Field artifact,
which does not live in this repo; that diff and that signature are a person's,
and nothing here simulates either.

The other one — the WebKit reading, the only automated reading the tighter CSS
floor ever gets — has since been taken, and it cost two changes outside this
view before it read anything about it. The map side's launcher was growing on
equal terms with the view, so the view was drawn into 135px of a 640px map side
and every fixture stood down; and the conformance driver read at whatever share
the default detent left, rather than opening the dial where a view is drawn.
Both are recorded in `docs/contract/declarations/deep-field.md`, which is where
what that run returned belongs. What is still owed there is the third: the
shell's floor for this view is a view-box number compared against a map-side
width, so the shell can mount the view into a column its own neighbours leave
too narrow and the stand-down this ADR designs fires from inside where the
shell's — the one with the exits on it — should have.

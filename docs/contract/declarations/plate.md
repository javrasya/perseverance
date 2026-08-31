# The Plate — declarations

What this view does about the five rules of the encoding contract that a person
keeps. One section per judged rule, in prose, stating what the shipped view
actually does — including where it does not comply. There are no boxes to tick
here on purpose: a box gets ticked, and a ticked box says nothing about the
view.

Structural and asserted rules have no section here and no route to one. A red
assertion is a failure with no appeal, and a structural rule has nothing to
declare.

Where this view does **not** comply with a judged rule, say so in a paragraph of
its own that begins with the word `Deviation` and a colon, as the first thing on
the line and with no bold, bullet or dash around it. A near miss reads as an
ordinary statement, so `tests/contract-declarations.test.ts` goes red on one
rather than letting a declared deviation ship as a silent carve-out. A declared
deviation is a worklist item, never an exemption.

## What this view is, in one paragraph

The Plate draws the map as a Beck transit diagram: a station per child, a length
of octolinear track per *waits on*, ranks left to right so a track never points
backwards, sidings under the drawing for children nothing waits on and that wait
on nothing here, and a fan stem where finishing one station frees several. Where
a station goes was decided in `src/views/plate/plate.ts` and `router.ts` — ranks,
sidings, fan-out, every corner, and an eight-anchor label box per station with a
two-cell gap the router will not cross. `Plate.tsx` turns cells into pixels and
picks a shape per encoding, and computes nothing about the graph.

The eleven encodings are eleven *shapes and words*, not eleven hues: an open
disc is takeable, a squared station with a bar across it is held up, a lozenge
inside a second outline is claimed, a wide ring with a hub is the designated
frontier, a small closed disc is done, a strike across that disc is a cut, a
square on the diagonal with a dashed edge is unclassified, and a terminus
chevron is the spec. The ticket type, AFK versus HITL, and *not on this machine*
are words on the name plate, because a word is the channel that survives both a
retheme and a screenshot.

## Rule 4 — Absence is never zero

The fog rides beside the graph rather than in it, in the margin column, and it
is stamped rather than counted: `NOT YET SPECIFIED` is the first thing in the
region and the number is the second, so the region says *what* is missing before
it says *how much*. The two absences differ in form and not in a character. A
region nobody surveyed prints an em dash in the interface face where a numeral
would go and draws no hatched ground beneath the stamp at all; a surveyed region
prints a numeral in the mono face and always draws its ground, whether the count
is nought or forty. So *surveyed and found nothing* and *nobody has been here*
are two different pictures rather than two different glyphs in the same picture,
and nothing on this side ever renders a missing heading as a count — the model
hands over `Fog` as a sum type and the unsurveyed arm has no number in it to
print. The hatched ground is a fixed height that does not vary with the count,
so it is a texture and not a gauge.

The same refusal covers the two absences this drawing can make on its own. A
child that waits on an issue no station here stands for is counted in the margin
and named there, rather than drawn as a station with nothing attached to it. And
where somebody's authored pin has walled a station in, the router answers with
no track rather than running one through a reserved label box — so the legend
carries a line saying how many links are on the map and not in the picture. An
edge dropped in silence would be the failure this rule exists to refuse in its
purest form: the drawing would read as a map with one fewer dependency in it,
and nothing on screen would be wrong enough to notice. Both lines appear only
where the count is above nought, so neither is a zero standing in for an absence
of the thing it counts.

The asserted floor under this rule is the fixture-level absence check, and what
it settles is that no `0` appears where the fog is drawn on the unsurveyed
fixtures and that the em dash is a form-level difference. The residue is *names
itself*, and this view's answer to it is the stamp: the words `NOT YET
SPECIFIED` are the region's name, they are in the document rather than in a
tooltip or a heading elsewhere, and they say what the region is about rather
than labelling a number.

## Rule 10 — Hover discloses nothing

Hover on the Plate is the transit convention and it is this view's own
semantics: bringing a pointer or the keyboard focus onto a station enlarges that
station and brings its whole thread forward — every station reachable from it
along the track, and every length of track between them — while the rest of the
network recedes to a lower opacity. That answers *which thread is this part of*,
which is a question about the picture, and it is the reason the view exists
beside a list that cannot answer it.

Nothing is disclosed by it. Every station, every name plate, every tag, every
cut reason and every length of track is in the document and painted before
anything is hovered; what changes is salience and nothing else, and the receded
network stays at a legible opacity rather than disappearing. This view ships no
`title` attribute and no `<title>` element anywhere — not on a station, not on
the cut plate, not on the fog — so there is no tooltip carve-out being leaned
on either. The keyboard gets exactly what the pointer gets: focus lights the
same thread hover does, so the one question hover answers is not answered to
pointer users alone.

A station can be dragged to where the operator thinks it belongs, and that
affordance is **not** hover-only: the margin carries a sentence saying so, drawn
beside the legend before anything is hovered, so the one gesture this view has
that a reader could fail to discover is announced in words rather than by a
cursor that changes shape when a pointer happens to cross a station. The cursor
still changes; it is the second channel and it carries nothing on its own.

The same sentence names the gesture with no pointer in it. A focused station
moves one cell per arrow key and goes back to where the plate drew it on
Backspace, and neither of those is guessable from a focus ring — an arrow key
discloses less than a cursor does, because nothing about a lit station suggests
it would move if one were pressed. So both hands of the gesture are in the one
paragraph, from the first paint, on every map this view draws. Putting the whole
arrangement back is a button rather than a further keystroke, in that same
margin and reachable by tab like every station: it is the one act here with
nothing behind it to undo, and a chord that did it would be a chord found by
accident. It is drawn only where there is an arrangement to put back, which is a
fact about the map and not about where anybody is pointing.

The floor asserted for this rule is that nothing hover-reveals is absent
elsewhere, and this view meets it by revealing nothing at all. A long name is
clipped by its plate, and the recovery for that is stated under rule 11 rather
than here, because it is a clipping question and not a disclosure one.

## Rule 11 — The field is not the label surface

The drawing and the annotation are two regions with a hard edge between them.
The legend and the fog live in a fixed-width margin column beside the field — a
fixed share of the width and not a share of what is left over, because
annotation that shrinks as the graph grows is annotation the topology is growing
into. The field itself never spills into that column, and the column carries no
station, no track and no mark.

Inside the field the same rule is kept by construction rather than by care. Each
station's name plate is drawn at the box the eight-anchor solver reserved for
it, the router treats every reserved box as blocked and will not route a track
through one, and the geometry keeps a two-cell gap between stations so a plate
always has somewhere to go. The plate is drawn at exactly the reserved box and
`overflow: hidden` holds it there, so a long title is clipped by the plate
rather than allowed to grow out into the lanes the track runs through; a cut
station is given two boxes across, and the doubling is in the reservation rather
than in the paint. `labelsFor` widens that station's box to
`CUT_LABEL_COLUMNS` before an anchor is chosen, so the wide box is what the
solver placed, what the router has in its blocked set, what `boundsOf` sized the
drawing around, and what `Plate.tsx` draws the plate at — one number, arrived at
once, whichever of the eight anchors the station ends up facing. Nothing widens
a plate after the boxes are reserved, because a width invented at paint time
would be pixels laid over cells the router still believed were free.
The whole title string stays in the document however
short the plate is, so a search, a screen reader and a test all still find it.
A station somebody dragged is placed by the same construction rather than
beside it. The pin is an input to the geometry — `plateOf(map, pins)` puts the
pinned station in the authored cell and lays every generated station out around
it — so a pinned station is routed to, reserved a label box by the same
eight-anchor solver, and counted in the same extent as any other. Nothing moves
a station after the boxes are reserved, which is what keeps the router from
routing around a box no plate is in. Where the pins and the graph have come
apart — a pin for a child the map no longer has, or a child no pin names — the
plate is stamped provisional, given a construction margin, and the legend says
so, because a drawing that is partly somebody's hand and partly generated should
not present itself as authored whole.

The legend is what keeps the field from having to explain itself: a siding is
the one convention on the drawing an operator cannot read off the picture, so it
is named in words in the margin, with the count of sidings actually drawn. The
same margin carries the one thing the picture cannot say about itself — that the
map is outside the twelve-to-twenty band this view is competent at. Where the
verdict is `thin`, `crowded` or `hairball` it is the first line of the legend,
counted in stations, so a map this view is not for is read rather than
discovered; a map inside the band gets no such line, because a drawing doing
what it was built for has nothing to warn a reader about.

Deviation: a title too long for its plate is clipped and this view offers no way
to read the rest of it in place — no tooltip, by rule 10, and no expansion. The
operator recovers the full string by selecting the station and reading it in the
rail, or by opening the Route. Widening the plate would mean widening the
reservation the router is routing around, which is a geometry change in
`plate.ts` rather than a paint one, and it belongs with the slice that measures
this view against real maps.

## Rule 12 — Still-state equivalent

This view spends no motion. There is no `animation` and no `transition` in
`Plate.module.css`, and no SMIL anywhere in it, so every distinction the Plate
draws is a still distinction already and there is no reduced-motion fallback for
one to be lost from. Under `prefers-reduced-motion: reduce` the drawing is
identical to the drawing at rest, mark for mark and word for word, because the
global rule that kills `animation` has nothing here to kill.

That is a decision and not an accident. Rule 9 rations motion to running versus
stale claim, and `NodeState` is `resolved | blocked | claimed | takeable` with
no bit anywhere on this side saying whether work is in flight — so the subject
motion is rationed *to* is unrepresentable here. The Route spends its one
licensed animation on `claimed`, which is the closest this half of the app comes
to liveness; the Plate draws the same fact as a lozenge inside a second
concentric outline, which carries *somebody has this ticket in their hands*
alone and standing still. Enlargement on hover is instant and has no transition
on it, so it is a change of state rather than motion, and it carries no
distinction of its own that a still reading would lose.

## Rule 13 — Resolved stays locatable

A resolved station is drawn as a small closed disc in faint ink at 0.7 opacity,
and that is the whole of the recession. It keeps its place on the line, its
name plate, its number, its tags, its `tabIndex`, its click handler and its
selection, and it is a `<g>` in the document like every other station rather
than a mark thinned out of the drawing. The track that reaches it and the track
that leaves it are drawn at full weight, because the thread is a fact about the
graph and not about how interesting its far end is: a chain of finished work
still has to be followable back from where the frontier is now.

The floor asserted for this rule — present in the DOM, non-zero opacity,
hit-testable, keyboard-focusable — is met on all four counts over every fixture,
including the map where every child is closed. The residue is salience, and this
view's answer is that resolved recedes in ink weight and in glyph size and in
nothing else: it never loses its words, its shape stays one of the seven the
legend and the retheme keep distinct, and it stays the same size relative to its
neighbours whether or not anything is hovered. When a thread is lit, a resolved
station on that thread comes forward with the rest of it, which is the reading
this view is for — *what did this thread already get through* is the question a
receding-past-legibility answer would destroy.

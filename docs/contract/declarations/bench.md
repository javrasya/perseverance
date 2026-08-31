# The Bench — declarations

What this view does about the five rules of the encoding contract that a person
keeps. One section per judged rule, in prose, stating what the shipped view
actually does — including where it does not comply. There are no boxes to tick
here on purpose: a box gets ticked, and a ticked box says nothing about the
view.

A declaration is written when the view is designed or redesigned, not at every
commit. It is a claim about this view's answer to a rule, and a view's answer
changes when someone changes the view — so this file is read in the round that
changes the layout, and the gates in `tests/contract-declarations.test.ts` are
what make sure it exists at all. Structural and asserted rules have no section
here and no route to one: a red assertion is a failure with no appeal, and a
structural rule has nothing to declare.

Where this view does **not** comply with a judged rule, the statement is a
paragraph of its own opening with the word `Deviation` and a colon, first thing
on the line, with no bold, bullet or dash around it. That exact opener is the
one piece of structure this format has, and it is what lifts the paragraph onto
the worklist in `docs/contract/matrix.md`. A near miss reads as ordinary prose,
so `tests/contract-declarations.test.ts` goes red on one rather than letting a
carve-out ship silently. A declared deviation is a worklist item, never an
exemption.

The Bench is a schematic: ranks running down the page, one plate per node placed
at a coordinate the arithmetic in `src/views/bench/bench.ts` chose, and the
dependencies drawn as orthogonal wires between them. Position *is* the topology
here, which is the whole of its distance from The Route, and what the operator
gets for it is fan-out — how many tickets wait on this one. Two consequences run
through every section below: the drawing is an HTML plate layer over an
`aria-hidden` SVG wire layer, so every word on the canvas is a real element that
wraps, takes focus and is found by a page search; and nothing on it is derived
or kept — `benchOf(model, width)` is called on every render and its answer
outlives nothing.

## What the floors under these sections do and do not cover

Four of the five judged rules below have an *asserted floor* underneath them: a
machine check in `tests/conformance/support/rules.ts`, fanned out over the whole
fixture space by `tests/conformance/rules.spec.ts` and reaching this view
through the surface this view declares in `tests/conformance/support/views.ts`.
A floor settles the part of a rule that has a DOM signature and stops there, and
what each section calls a residue is what it deliberately leaves to a reader.
Rule 11 is the fifth and has no floor at all, by decision; its section says why.

One floor does not reach this view, and that is stated rather than assumed.
Rule 4's floor binds a fog region, this view renders none, and the surface says
so (`fog: null`) — so the entry skips here on a written precondition instead of
passing because it found nothing to fail on. The section below is therefore the
whole of rule 4's answer for The Bench, and it is prose a human weighs rather
than a check a machine settles. The fixture space, the engine and the two
preference axes are the contract's and not this view's, and are described once
in [The Route's declarations](route.md#what-the-floors-under-these-sections-do-and-do-not-cover).

## Rule 4 — Absence is never zero

The Bench draws no fog region, and that is a decision rather than an omission.
The fog is what nobody has specified yet: it is not a node, it has no rank, and
nothing waits on it. A graph of the children has no coordinate that could hold
it, and inventing one — a plate off to the side, a band above rank zero — would
be this canvas asserting a place in the topology for a thing that has no place
in it. The fog stays with the chrome, which already draws it and already carries
rule 4's asserted floor there, and this view therefore never renders a fog
heading as a count because it never renders a fog heading at all.

The call this file has to make explicitly, because the next view's author reads
it: that missing region is **not** recorded here as a deviation. The rule binds
what a view does when it has an absence to show, and rule 7's corollary is what
puts an absence with no node behind it in the chrome. A reader who disagrees is
disagreeing with the placement rather than with the encoding, and the argument
they owe is where a thing with no rank and no dependents sits on a drawing whose
only coordinate is rank and dependents. This declaration says there is no such
place.

What answers rule 4 on the canvas itself is the pair of blocker tallies, and the
answer is that they are counted apart and never summed. A plate prints *waiting
on 3* and *1 off this map* as two separate facts, each drawn only when it has
something to say, and there is no third number over them. One total would be
exactly the failure this rule names: *4 in the way* folds a state the map knows
about — a dependency that is not on this map at all, and that closing everything
here will not clear — into a numeral that reads as ordinary blocked work. The
absence of the second tally is the claim *nothing off this map is holding it*,
and it is made by the tally not being there rather than by a zero.

Fan-out is the deliberate exception and runs the other way: *unblocks 0* is
printed on every plate that has it, because *closing this frees nobody* is a
true and useful claim and it is the claim an operator opens this view to read.
A zero is only forbidden where it stands for something nobody counted; here it
is something somebody counted and found none of. The judged residue is whether a
plate with neither blocker tally reads as *nothing is in its way* rather than as
*this plate is missing its tallies*, and the answer this view offers is the
mark: a takeable square and a hatched blocked bar are different shapes before
any word is read, so the state is never carried by the tallies alone.

## Rule 10 — Hover discloses nothing

Nothing is disclosed on hover because nothing is held back. A schematic labels
its parts: everything a plate has to say — its number, its whole title, its
mark, its fan-out, its two tallies, its kind, and its cut reason where it has
one — is text or geometry in the document at rest. There is no `title`
attribute anywhere in `src/views/bench/Bench.tsx`, no `details`, no
`aria-expanded`, and no pointer handler of any kind: a plate carries `onClick`
and `onKeyDown`, both of which do the same one thing, which is select the node.

The only `:hover` rule in `src/views/bench/Bench.module.css` sets
`border-color`, and the pixel of lift it used to carry went when this view was
registered. Rule 10's floor walks the live CSSOM for hover selectors touching a
disclosure property and counts `transform` among them, because a transform is
one of the ways something that was not on screen arrives on it. The floor reads
the whole page rather than one view's root, so an unregistered stylesheet costs
nothing and a registered one turns the floor red for every view at once. An edge
is not the weaker answer anyway: it is the half of that hover that survives every
semantic colour collapsing to one value, and the fill is left untouched so a
hovered plate still cannot be mistaken for a selected one.

Two honest limits. The floor never moves a pointer — it reads stylesheets and
attributes over a rendering at rest, so a disclosure driven by a JS pointer
listener would pass it untouched; nothing under `src/views/bench/` registers one
today, but that is a fact about this revision and a reader checking a later one
has to read the handlers. And a plate's title is clamped to two lines by the
browser, never by the view: the whole string stays in the document, so it is
found by a page search, read aloud in full and asserted on, but a third line is
not visible on the canvas and no pointer recovers it. That is a legibility
question about the plate box rather than a disclosure behind hover — the missing
line is behind no gesture at all — and this declaration records it as the former.

## Rule 11 — The field is not the label surface

The field is the canvas and the label surface is a column beside it. The rank
rail is a fixed 56px column (`RANK_RAIL`, `src/views/bench/Bench.tsx`) that sits
outside the canvas box entirely: the canvas is sized to exactly the width
`benchOf` laid the plates out in, and the rail is its sibling rather than an
overlay on it, so the topology cannot grow into the annotation in the literal
sense the rule asks for. One rank label is drawn per band, at the band's own top
and as tall as the whole band, so a rank that wrapped into five rows of plates
is labelled beside all five of them rather than beside the first.

The labels are set as labels and not as parts of the drawing: mono, micro,
tracked, uppercased, in the faintest ink the palette has, against plates that
carry sentence-case titles in the primary ink at the body size. A rank label is
therefore not something a reader can mistake for a plate even at a glance and
even with every semantic colour collapsed, because the distinction is in the
face and the case rather than in the ink. Inside the canvas there is no second
annotation to worry about: the wires carry no labels at all, and the tally each
wire restates is printed in words on the plates at both of its ends.

The corollary — a zone boundary needs clearance from the graph's own marks — is
answered by which ink the boundary is drawn in. The rail's right border is a
hairline in `--s-line-quiet`, while every wire on the canvas is drawn in
`--s-line-strong`, so the line that separates the annotation column from the
field is quieter than any line inside the field and cannot be read as an edge
running down the page. The band boundaries themselves are drawn as nothing at
all: a rank is bounded by the gap of blank canvas below it, which is space
rather than a mark, and space cannot be misread as a dependency.

Nothing on the field grows past what the arithmetic reserved for it. The box is
per plate and it is computed from what that plate has to say: `heightOf` in
`bench.ts` counts the title's two clamped lines, the lines the micro chips wrap
onto at the plate's own content width, and — on the doubled plate a cut node
gets — the lines the cut's reason takes at forty words. Rows are then laid out
from those heights rather than from one constant, so a wrapped band's second row
starts below the tallest plate on its first. `Bench.module.css` therefore needs
no `z-index` on any plate and has none: nothing is painted over anything, which
is also what keeps rule 13's floor honest for the plate that would otherwise
have been underneath.

The check on that is a measurement and not the arithmetic restating itself.
`tests/conformance/bench-box.spec.ts` renders `wide-map` in a real browser at two
widths and asserts that every plate's rendered height is inside the height the
view reserved for it, and that no two plates overlap.

## Rule 12 — Still-state equivalent

The Bench authors no animation at all, so its reduced-motion rendering and its
full-motion rendering are the same rendering. There is no `@keyframes` and no
`animation` property anywhere in `src/views/bench/Bench.module.css`; the whole
of the app's motion ration is enumerated as a single licensed entry in
`tests/motion-ration.test.ts` — The Route's `.markClaimed::after` ping — and
this view adds none to it. That is the strongest form the rule can be satisfied
in: a distinction that was never carried by motion cannot be lost when motion is
taken away, and there is no fallback here to go wrong because there is no
fallback.

The claimed mark is where that decision was actually made, and it was made by
spending nothing. #10 recorded this view's liveness vocabulary as marching ants
on the wires plus a 1Hz blink on the claimed plate, and recorded no still state
for either, which is the gap rule 12 exists because of. The halo drawn here is a
static ring — `content`, a 1.5px border in the plate's glyph ink at half
opacity, inset four pixels — and it says *somebody is on this* on a
reduced-motion machine, on a still screenshot and in a printout identically.
Marching ants were refused for a second and harder reason as well: an ant train
says *this edge is live*, and no such bit crosses the seam. `NodeState` is four
words and none of them is *running*.

Rule 12's floor still runs over this view, and it is worth saying what it reads.
The entry does not name what owes a still form; it walks the stylesheets under
`src/` for animated selectors and then asserts the pair the registered still
form describes, against whichever view is on screen. On The Bench that pair
resolves through this view's own glyph: with `prefers-reduced-motion: reduce`
on, the claimed plate's mark carries no animation, still draws its ring, and
still differs from the mark on a plate in any other state. The residue is the
one the rule always leaves — a machine can prove the two marks differ, not that
the surviving difference is the one the motion was making — and on this view
that residue is small, because the motion it is compared against was never
authored.

The two `transition` declarations on a plate are the only time behaviour changes
over time here, and they are interaction feedback rather than an encoding:
background and border colour, on a hover and on a selection, both settling into
an end state that is the whole of the message. With the media query on they
arrive instantly at that same end state, so nothing a plate says depends on
having watched it change. No Bench entry belongs in the motion ration, and none
was added to it.

## Rule 13 — Resolved stays locatable

Resolved recedes in ink weight and in nothing else. The rule
`.plate[data-mark="resolved"]` reassigns two component tokens — the plate's ink
to the secondary ink and its quiet ink to the faint one — and reassigns nothing
else: no `opacity` on the plate, no `display`, no `visibility`, no filter, and
no change to the border it shares with every other plate. A finished ticket
keeps its coordinate on the canvas, keeps its click, keeps its focus ring and
keeps every wire that runs into or out of it, which is what makes it possible to
ask *what did closing this free* about work that is already done.

It keeps its place in the topology in the stronger sense too. Rank is computed
from the longest path in edges and takes no notice of state, so a resolved node
is not swept to the bottom of the drawing or into a section of its own the way a
grouped list would do it — it stays in the band its dependencies put it in, with
its wires still drawn, and the shape of the graph an operator is reading is the
real one rather than the graph of the unfinished part. The mark is a distinct
shape as well as a quieter ink, so the state survives every semantic colour
collapsing to one value.

The floor asserts four DOM facts over every fixture — present, non-zero opacity
through the whole ancestor chain, hit-testable at its own centre point, and
focusable from the keyboard — and this view clears all four by construction: a
plate is an `li` with `tabIndex={0}` and the wire layer above it is
`pointer-events: none`, so the point at a plate's centre belongs to the plate.
`tests/bench-view.test.tsx` reads the resolved block directly and fails on
anything arriving in it that reduces visibility rather than salience, which is
the same claim asserted one layer down where it is cheap to check.

The residue is salience, and it is a real question here rather than a formality.
A plate can clear all four floors and still be gone to a reader, and this view's
own author predicted that resolved work would disappear from the canvas by
design. It does not, but the honest statement of how far it recedes is this: two
token steps of ink on the title and the facts, with the plate's fill, border,
size and position untouched. A reader who finds that a resolved plate on a
crowded canvas has become background rather than quiet has found this
declaration wrong, and the fix is a smaller step in the ink rather than anything
in the floor — the floor would have passed either way, which is the whole reason
this paragraph exists.

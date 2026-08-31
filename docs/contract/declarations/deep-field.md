# Deep Field — declarations

What this view does about the five rules of the encoding contract that a person
keeps. One section per judged rule, in prose, stating what the shipped view
actually does — including where it does not comply. There are no boxes to tick
here on purpose: a box gets ticked, and a ticked box says nothing about the
view.

A declaration is written when the view is designed or redesigned, not at every
commit. It is a claim about this view's answer to a rule, and a view's answer
changes when someone changes the view — so this file is read in the round that
changes the layout, and the gates in `tests/contract-declarations.test.ts` are
what make sure it exists at all.

Structural and asserted rules have no section here and no route to one. A red
assertion is a failure with no appeal, and a structural rule has nothing to
declare.

Where this view does **not** comply with a judged rule, say so in a paragraph of
its own that begins with the word `Deviation` and a colon, as the first thing on
the line and with no bold, bullet or dash around it — that exact opener is the
one piece of structure this format has, and it is what lifts the paragraph onto
the worklist in `docs/contract/matrix.md`. A near miss (`**Deviation:**`, a list
item, an em dash for the colon, or the sentence buried mid-paragraph) reads as an
ordinary statement, so `tests/contract-declarations.test.ts` goes red on one
rather than letting a declared deviation ship as a silent carve-out. A declared
deviation is a worklist item, never an exemption.

## What the floors under these sections do and do not cover

Four of the five judged rules below have an *asserted floor* underneath them: a
machine check in `tests/conformance/support/rules.ts`, fanned out over the whole
fixture space by `tests/conformance/rules.spec.ts`. A floor settles the part of
a rule that has a DOM signature and stops there, and what each section below
calls a residue is what the floor deliberately leaves to a reader. Rule 11 is
the fifth and has no floor by decision; its section says why, and in this view
rule 11 is not a corner case — it is the reason the view has the shape it has,
so the section is the longest one here and is the whole of that rule's evidence.

The space the floors run over is 19 checked-in `Snapshot` fixtures × 2 themes
(light, dark) × 2 motion settings (full, reduced) = 76 states, and registering
this view in `VIEWS` is what crossed that existing space with it — no fixture
was added for it and none should be, because a fixture is a value of the model
and not a view's exhibit. `FIXTURE_NAMES` in `src/snapshot/fixtures.ts` is the
fixture half and `fixtureSpace()` in `tests/support/contract.ts` crosses it with
the other two.

Two things about this view make its floors read differently from The Route's,
and both are consequences of the split declared under rule 11. The first is
that **one node is two elements here**: a plate in the lane and a mark in the
field. `tests/conformance/support/views.ts` points every row-shaped hook at the
plate, because the plate is where the words are and the mark carries a different
attribute precisely so a count of rows stays a count of nodes. The second is
that this view can decide it does not fit: below `widthNeededFor(depth)` it
renders a stand-down in place of the picture, keeping the three integers and the
frontier alive. **At the viewport the conformance projects run, every fixture
stands down, and the first WebKit run is what found that out.** The arithmetic
this paragraph used to carry read the map side as the view's box. It is not:
the map side is a flex line of three columns — the drop region that holds the
folder launcher, the view, and the rail — and the launcher is `flex: 1` on that
line exactly as the view is, so the two split whatever the fixed rail leaves.
Measured in `Desktop Safari` at 1280px: at the default `split` detent the view
is drawn into **135px** of a 640px map side, and even at the `map` detent, with
the whole window on the map, it is drawn into **445px**. `widthNeededFor(3)` is
512. So no dial position on a 1280px window draws a three-rank map, and the
floors below are, as of this run, read against the stand-down rather than
against the picture — which is a hole in the reading and not a green.

Three things have to change together before that hole closes, and none of them
is this view's to decide alone. The launcher has to stop growing on equal terms
with the view, which contradicts nothing in #48 — a column with a basis is not a
column that disappeared — but does contradict `COLUMN_FLOORS`'s own stated
priority, where the view is shed last because it is the reason the map side
exists. `VIEW_FLOORS["deep-field"]` has to stop being a view-box number
(`widthNeededFor(2)`) compared against a map-side width, because the shell
mounts a view on that comparison and the view then stands itself down from
inside. And the conformance driver has to open the dial where the view is drawn,
the way it already seeds which view is open. Until then this file's floors are
declared, not read.

The floors run under Playwright against `dev:web` — a frontend-only Vite boot,
no Rust, no Tauri shell, no PTY, no GitHub. WebKit is the required engine,
because macOS ships a WebView pinned to the OS version and exposes no
WebDriver, so this is the only automated reading the tighter CSS floor
(`browserslist`, `safari >= 16.4`) will ever get; Chromium is an optional second
reading and is not what CI gates on. **The suite has not been run against this
view.** It was written in an environment with no `@playwright/test` installed,
so the surface in `tests/conformance/support/views.ts` is unrun and the
declarations below are the only reading these five rules have had here.

## Rule 4 — Absence is never zero

The fog is a named region before it is a counted one. `FogRegion` renders a
`<section>` labelled by its own heading, and the heading is two elements: the
region's name, from `FOG_HEADING`, and then whichever of the two readings the
model carries. An unsurveyed fog stands `NOBODY_SURVEYED` — an em dash — where
the numeral would go, in the `.fogUnsurveyed` face rather than the count's, and
draws no body at all beneath the heading. A surveyed one draws a numeral in
`.fogCount` and always draws a body under it: the operator's own text in a
`<pre>`, or `FOG_ALL_CHARTED` when the region was surveyed and came back empty.
So the two absences differ in three things at once — the face, the character,
and whether anything is drawn underneath — and a reader does not have to read a
glyph to tell *nobody has been here* from *somebody looked and found nothing*.
`—` and `0` are not the same shape anywhere in this view, and nothing in it
renders a missing fog heading as a count.

The asserted floor covers the form half over the whole fixture space: over a
fixture nobody surveyed, the region renders no numeral at all — not in the count
slot and not a digit anywhere in it — and stands its absence in a slot of its
own. What the floor does not settle is the extension the rule carries: that a
view's fog region must *name* itself and not only count itself. That the heading
reads as the name of a place rather than as a caption on a figure is a reading,
and it is the residue here. The same residue covers the em dash itself: nothing
asserts that a reader takes `—` to mean unsurveyed rather than *not applicable*
or *broken*, and the argument that it does is the one ADR 0016 makes, on the
strength of the heading standing beside it.

Two absences elsewhere in this view are the same claim in smaller places, and
neither is under the floor. A plate says `blocked by N` only when N is positive,
so `blocked by 0` never reaches a plate whose state is *blocked*; and a blocker
that is not a child of this map has no row here and no edge, so the plate says
so in words (`beyondTheMapNote`) rather than leaving the count silently short.
The three integers in the readout are counts and not absences — a zero there is
a finding about a surveyed map, which is exactly what rule 4 permits a numeral
to be.

## Rule 10 — Hover discloses nothing

Nothing in this view is behind a pointer. `DeepField.module.css` authors no
`:hover` selector at all — the one token whose name contains *hover*,
`--s-surface-hover`, is a surface step used as a plate's resting fill and is not
reached by hovering anything — and the component binds no `onMouseEnter`,
`onMouseOver` or `onFocus` handler. The two handlers a plate carries are
`onClick` and `onKeyDown` for Enter and Space, which are the same act by two
routes, and the act is selection: a plate the operator picked gets `data-selected`
and `aria-current="true"`, which are read by the app, not by the pointer. The
field is one `aria-hidden` `<svg>` with no listener on any mark or edge, so
there is nothing to hover there either.

**There is no `title` anywhere in this view**, which is the stricter half of the
rule's carve-out rather than a use of it. The carve-out permits a native `title`
that recovers text the layout clipped, and this view has clipped text: a plate's
`.title` is `overflow: hidden` with `text-overflow: ellipsis`, so a long ticket
title is visually cut. What it is not is *gone* — the full string is a text node
in the document, so a screen reader, a page search, a copy and a test all read
the whole of it, and the cut is only ever visual. A `title` would be a
legitimate addition here under the carve-out, and it is not present, so the
floor's first half (every `title` in the rendering recovers text already in the
rendering) passes vacuously for this view.

The asserted floor covers both halves without a pointer: it walks the CSSOM for
hover selectors touching a disclosure property, which catches an accordion and a
fade as readily as a `display: none`, and it holds every `title` on the page to
recovering text already rendered. What it does not settle is *load-bearing* —
whether a fact this view's operator needs is reachable without a pointer. The
residue is therefore the sighted-mouse reading of a clipped title: the string is
in the document for every non-visual reader and for the machine, and a sighted
operator on a narrow pane sees the ellipsis and must widen the pane or open the
ticket. That is a cost, not a disclosure, and it is stated here so a reader can
weigh it rather than discover it.

## Rule 11 — The field is not the label surface

Nothing is asserted under this rule anywhere, and that is a decision rather than
a gap. Misreading a label as a node has no DOM signature to look for, and the
only checkable form of the corollary is a clearance figure, which belongs to one
view's layout — asserting it would cargo-cult that view's fix into the contract,
which the meta-rule prohibits. `RULE_CHECKS[11]` in
`tests/conformance/support/rules.ts` carries `check: null` with the reason
written out, so *nothing is asserted here* is a sentence somebody wrote rather
than a hole in a table. This section is the whole of the rule's evidence, and
for this view it is the rule the whole layout is an answer to.

The answer is a split into two coordinate spaces side by side. On the left is
the **plate lane**: one plate per node, in map order, carrying every word this
view has to say about that node — its number, its title, the word for its state,
its tags, the count it is blocked by, the blockers with no row here, and the
reason it was cut when it was cut. On the right is the **field**: strict rank
columns of bare marks with the fan-out drawn between them, and no text node
anywhere inside the `<svg>`. Annotation therefore has reserved space in the
strongest sense available — a lane of its own that the topology's coordinates
are bounded away from — and the graph field cannot double as the label surface
because there is nothing on it to double as one.

The reason the split lands *there*, rather than as a margin around a drawing
with labels in it, is rank 0. Charting a map produces a burst of independent
tickets, so eleven sources against ranks of four, two, one and one is the
ordinary shape of a map this view is drawn for rather than a pathological one —
`ledger-sweep`, at eleven nodes, is exactly that shape in the checked-in
fixtures. Eleven labels set beside eleven marks in a single tall column is
precisely the field doubling as the label surface, and the words would be laid
over the fan-out leaving that column, which is the densest part of the picture
at exactly the n this view claims competence at (12–25 nodes, `BAND_LOW` and
`BAND_HIGH`). A layout that only reads well on the tidy diamond is the wrong way
round, because the tidy diamond is the exception.

**A reader may disagree with this, and the disagreement is a real one.** The
obvious alternative is that a plate is drawn *at* its node, in its column, with
the gutter reserved for the map's own annotation instead. That reading keeps a
node's words next to its position and costs a lookup between two lanes; this one
keeps the field legible at a structurally wide rank 0 and costs the operator a
glance sideways. This one was chosen because the wide rank 0 is the normal shape
here. Correspondence between the lanes is by node number, which a plate prints
and a mark carries as `data-mark-node`, and that number is the whole of what the
reader has to carry across — which is the honest statement of what the choice
costs. ADR 0025 records the decision and the rejected alternative.

The corollary — a zone boundary needs clearance from the graph's own marks — is
kept as `GUTTER_CLEARANCE`, a **view-local 34px** on the field side of the
boundary that no mark and no curve may enter at any n, checked over every
fixture and every hand-built shape by `tests/deep-field.test.ts`. It is
deliberately promoted into no registry. The rule binds the clearance, not the
34: the number came out of this view's design round at this view's plate width
and column pitch, it is a starting value rather than a settled one, and a
contract-level constant would be one view's fix asserted at three views that
never had the problem. The boundary itself is drawn once, as the lane's right
edge, from `split.plates.width` rather than from a second x free to disagree
with the first.

Read this as a falsifiable claim rather than as immunity. Three things would
make it wrong: a word appearing inside the field's `<svg>`; a mark or a control
point crossing the boundary into the clearance at some n; or the lane and the
field overlapping at any width instead of the view standing down. The first two
are what `tests/deep-field.test.ts` reads on every fixture, and the third is
what the width floor is for.

## Rule 12 — Still-state equivalent

**This view spends no motion, so nothing in it is carried by motion and nothing
is lost when motion is off.** The whole animated surface of the app is still The
Route's one `@keyframes ping` on `.markClaimed::after`; `tests/motion-ration.test.ts`
walks every stylesheet under `src/` and this view's adds no entry to the licensed
list, and `tests/conformance/support/rules.ts` keys `STILL_FORMS` by authored
selector, so an animation added here later would arrive with no still form
registered and turn rule 12 red rather than passing unread.

The five distinctions this view draws are all geometry, in both lanes at once.
A plate's glyph is a ring, a thicker ring, a filled disc, a dashed ring or a
faded disc; the mark for the same node in the field wears the same five
distinctions in the SVG grammar — stroke width, dash and fill — and one function,
`formOf`, decides both, so the plate and the mark cannot part company. A cut is
a strike composed onto the resolved disc, not a sixth state, and it is drawn
beside the operator's own words for why. None of it is a hue and none of it is a
frame of animation, so `prefers-reduced-motion: reduce` changes nothing about
what this view says.

The stylesheet does carry exactly one time-valued declaration: a plate's fill
transitions over `--s-motion-fast` when the selection moves. It is a transition
rather than an animation, it runs on a decoration of a fact rather than the fact
(a selected plate is `data-selected` and `aria-current="true"` in the DOM
throughout), and with motion reduced the fill simply arrives at once. No
distinction rides on it, so there is nothing here for a still form to carry.

The asserted floor is exactly the shape of that: it reads the reduced-motion
half of the space, asks rule 9's walk what is animated, and requires a
registered still form for every animated selector it finds. It is currently
satisfied here by there being nothing to check in this view — which is the
compliant answer and not a skip, and is what makes *no motion* a claim the next
commit has to keep rather than a fact about today. The residue is the one the
floor always leaves: a machine can prove two renderings still differ with the
motion off, not that the surviving difference is the one the motion was making.
Here that residue is empty, because no difference was being made by motion.

## Rule 13 — Resolved stays locatable

A resolved node keeps its plate, in map order, in the lane, with every word it
had. `.plate[data-state="resolved"]` reassigns two ink tokens and nothing else —
no `opacity`, no `display`, no `visibility`, no `content-visibility`, which
`tests/deep-field-view.test.tsx` reads that block and fails on — so the recession
is in ink weight and cannot reach the title. The plate keeps `tabIndex={0}`, its
click handler and its Enter/Space handler, so it is hit-testable and
keyboard-focusable exactly like every other plate, and it keeps its selection
behaviour: picking a finished ticket is a thing an operator does, and this view
does not take it away. A plate cut by the map is a decoration on resolved rather
than a sixth state, and it keeps the cut reason as a text node — never behind a
hover — so a branch that stopped says why on screen.

In the field, the same node's mark stays in its rank column at its coordinate
and fades: `.markResolved` sits at `opacity: 0.55`, which is a reduction in
salience well clear of zero, and an edge whose blocker is resolved is drawn in
`--s-line-absent` rather than dropped. Both are deliberate. A cleared edge is
history the operator can stop planning around, and history that vanishes takes
the shape of the map with it — the fan-out is drawn from the blocker to what it
releases, so left to right is ground covered, and deleting the covered ground
would leave the picture unable to say how the frontier got where it is. Nothing
is culled, nothing is capped and nothing is collapsed on a finished map; the
view is its own scrollport and length is what scrolling is for.

The asserted floor covers four things for every resolved node the model carries:
its row is rendered, nothing in the chain above it has faded it to nothing, the
point at its centre belongs to it rather than to something drawn on top, and it
takes focus from the keyboard. The residue is salience — a plate can clear all
four and still be gone to a reader — and it is not asserted anywhere. Two
specific pieces of it are worth naming for whoever reads this view against a
rendering. The mark at 0.55 is the fainter of the two lanes' renderings of the
same node, so on a large finished map the field reads emptier than the lane
does; and the fade is on the mark and the glyph rather than on the plate, which
is what keeps the title at full ink and is the reason the two lanes recede at
different rates at all.

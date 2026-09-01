# The Route — declarations

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

Four of the five judged rules below now have an *asserted floor* underneath
them: a machine check in `tests/conformance/support/rules.ts`, fanned out over
the whole fixture space by `tests/conformance/rules.spec.ts`. A floor settles
the part of a rule that has a DOM signature and stops there, and what each
section below calls a residue is what the floor deliberately leaves to a reader.
The sections state where that line falls, so a reader can tell an asserted claim
from an unasserted one without opening the suite. Rule 11 is the fifth, and has
no floor by decision; its section says why.

The space the floors run over is 19 checked-in `Snapshot` fixtures × 2 themes
(light, dark) × 2 motion settings (full, reduced) = 76 states per view.
`FIXTURE_NAMES` in `src/snapshot/fixtures.ts` is the fixture half and
`fixtureSpace()` in `tests/support/contract.ts` crosses it with the other two,
so adding a state costs one checked-in fixture and no test code. The floors run
under Playwright against `dev:web` — a frontend-only Vite boot, no Rust, no
Tauri shell, no PTY, no GitHub. WebKit is the required engine, because macOS
ships a WebView pinned to the OS version and exposes no WebDriver, so this is
the only automated reading the tighter CSS floor (`browserslist`,
`safari >= 16.4`) will ever get; Chromium is an optional second reading and is
not what CI gates on.

Nineteen is not a target anybody picked. Each fixture is there because it holds
a value of the model that no other fixture holds, and the set is argued from
what the model can express rather than from a number — including the two gates
that go red when a value of `NodeState` or of `Phase` has no fixture reaching
it. How that accounting relates to the spec's "forty-four encodings" is a
contract-level question rather than something this view declares, so it is
settled in
[ADR 0020](../../adr/0020-the-contract-is-thirteen-rules-in-three-tiers.md#the-specs-forty-four-encodings-and-what-the-fixture-set-owes).

The Route is a grouped list in one column — Now/Next, Frontier, Blocked,
Resolved, Out of scope, Unclassified — with the fog and the destination beside
those sections rather than inside them. It **draws no edge at all**, and under
this contract that is structural rather than a deviation:
[ADR 0006](../../adr/0006-the-route-is-a-grouped-list-not-a-graph.md) settles
zero drawn edges as the view's thesis, and the contract's meta-rule says the
contract binds meaning and never geometry. There is no fan-out owed here.

## Rule 4 — Absence is never zero

The floor asserted here runs over the page rather than the view root — a fog
region that moved to the chrome is still the region the rule binds. On every
fixture whose fog is `unsurveyed` it settles that the region renders **no
numeral at all**: the count slot is absent from it, and `innerText` over the
whole region matches no digit anywhere. It also settles that the absence stands
in a slot of its own rather than being left implicit. A differently-styled
numeral would still be a numeral and would fail it. Whether the region also
*names* what is missing is asserted nowhere, and is this section's residue.

The fog is a region and not a section, and it names itself before it counts
itself. `FogRegion` renders a `section` labelled by an `h2` whose first span is
the word `Fog` (`FOG_HEADING`, `src/views/route/route.ts`), and the region is
tied to that heading with `aria-labelledby`, so the name is what the region is
announced as rather than a caption sitting near a number.

The two absences are told apart in form. Where the map's body never named the
fog at all, the slot a numeral would take carries `—` (`NOBODY_SURVEYED`) in a
different face under `data-unsurveyed`, and the region draws nothing beneath the
heading. Where the survey ran and turned up nothing, the count renders as a
numeral under `data-count` and the sentence `nothing left unspecified`
(`FOG_ALL_CHARTED`) is drawn under it — so *nobody looked* and *looked and found
none* differ in the shape of the region, not in one character. No `0` stands for
a missing fog anywhere in this view.

The judged residue is *names itself, not only counts itself*, and this view
answers it with the heading rather than with the number: the fog is the one
thing on the map with no id, no title and no URL, so the word `Fog` is the whole
of its identity and it is drawn every time the region is. What a reader has to
weigh, and no check can, is whether the word `Fog` standing over a `—` reads as
*nobody has looked here yet*, or only as *this box is empty*. The view offers
nothing else to read it by — the unsurveyed region carries no sentence, unlike
the charted-and-empty one — so a reader who finds a bare heading insufficient
has found this declaration wrong, and the fix is a sentence in the region rather
than a change to the floor.

## Rule 10 — Hover discloses nothing

The floor asserted here runs over the page and has two halves. Every `title`
attribute in the rendering must be recovering text the rendering already
carries, which is the carve-out held to exactly what it says and nothing wider.
And no rule in the rendering's own stylesheets may touch a disclosure property —
`display`, `visibility`, `opacity`, `content`, the height and width caps,
`clip-path`, `transform` — on a `:hover` selector; that is walked off the live
CSSOM rather than off the source text, so a gradient-fade reveal and a
`max-height` accordion are caught as readily as `display: none`.

The honest limit of that floor is that **it never moves a pointer.** It reads
stylesheets and attributes over a rendering at rest. A disclosure driven by JS
pointer events rather than by CSS — a `pointerenter` listener that inserts a
node, sets a style property directly, or toggles a class no `:hover` selector
mentions — passes it untouched. Nothing under `src/views/route/` registers such
a listener today, but that is a fact about the current source, not something
this floor holds, and a reader checking this rule on a later revision has to
read the event handlers themselves.

Nothing is disclosed on hover because nothing happens on hover. There is no
`:hover` selector anywhere in `src/views/route/Route.module.css`, and no `title`
attribute anywhere in `src/views/route/Route.tsx`. Every fact a row carries —
its mark, its designation, its blocker tally, its cut reason, its attendance —
is text or geometry in the document at rest.

Two things in the stylesheet read as hover affordances and are not. The
semantic token is spelled `--s-surface-hover`, but the only rule that consumes
it is `.node[data-selected]`, which is the row you picked; and `.node` carries a
`transition: background-color`, which today fires on that selection change and
on nothing else. So the row tint that exists is a selection tint.

The designation mark does not scale, on hover or otherwise. The stylesheet
carries four `transform` declarations and no interaction state selects any of
them. Two are static shape: the destination waypoint's fixed 45° rotation on
`.markDestination`, and the cut strike's centring `translateY` on
`.markCut::after`. The other two are the `scale(0.7)` and `scale(1.25)` steps of
the `ping` keyframes, which a claimed row's halo (`.markClaimed::after`) runs on
a clock of its own — see rule 12. So a mark's pseudo-element does scale; what
nothing here does is scale because of a pointer. The claim in older contract
prose that this view scales the designation on hover is not true of the shipped
view.

The load-bearing residue is the other one, and it is not a DOM question at all:
whether a fact the operator needs is reachable *without* a pointer is a claim
about the task, and two views may answer it differently. The Route's answer is
that a row is one line of text — glyph, title, id, tags, blocker tally, cut
reason — and there is nothing behind a pointer because there is nothing behind
anything. A reader falsifies that by naming a fact they needed off this view and
could get only by pointing at something.

This is compliance by absence rather than by design, and it is the fragile kind:
the transition is already declared on `.node` and the token is already named
`hover`, so the first `:hover` rule that lands inherits both without anyone
deciding to. That is a note for whoever adds one, not a deviation.

## Rule 11 — The field is not the label surface

Nothing is asserted under this rule anywhere, and that is a decision rather than
a gap. Misreading a label as a node has no DOM signature to look for, and the
only checkable form of the corollary is a clearance figure, which belongs to one
view's layout — asserting it would cargo-cult that view's fix into the contract,
which the meta-rule prohibits. `RULE_CHECKS[11]` in
`tests/conformance/support/rules.ts` therefore carries `check: null` with the
reason written out, so *nothing is asserted here* is a sentence somebody wrote
rather than a hole in a table. This section is the whole of the rule's evidence.

The Route is a grouped list in one column and draws no edge at all, so there is
no field for a label to be misread as part of. Rows *are* labels — glyph, title,
id and tags on one line — placed by ordinary block flow inside a section, never
positioned at coordinates; a row's width is capped by `--c-node-plate` (doubled
for a row carrying a cut reason) so an annotation has room the layout cannot
take back. What stands in for a zone boundary here is a section heading with its
rows stacked underneath, and the marks such a boundary could collide with are
glyphs that live inside those rows, one to a line.

Read that as a falsifiable claim about the layout rather than as immunity. Three
things would make it wrong: a mark drawn outside the flow of its own row; a
section heading whose box overlaps a row's glyph at some window width or font
size; or two rows that can overlap each other at all. Any of them puts a
clearance figure back on the table for this view. The claim is not that
misreading is impossible in principle — it is that in this layout a heading and
a mark never share a coordinate, so there is no clearance to measure.

ADR 0006 argued that point partly from a cap — capped regions, an `N more`
affordance and a rail height that stays O(1). None of that shipped. Nothing is
capped, nothing is sliced, there is no `N more`, and every resolved row on a
finished map is rendered; the pane is its own scrollport (`overflow-y: auto` on
`.route`) and scrolling is what it does about length. What the missing cap
changes is the reader's cost on a long map — a scroll rather than a fixed rail —
which is a fact about the pane and not a different answer to rule 11. The stale
half was the ADR's own, and ADR 0006 now records the cap, the `N more` and the
O(1) rail as unbuilt. That is a note for whoever builds them, not a deviation.

## Rule 12 — Still-state equivalent

The floor asserted here runs at the **reduced-motion half of the fixture
space**, and only there: the still form is what `prefers-reduced-motion: reduce`
leaves standing, so the 34 full-motion states have nothing to read and skip with
that precondition stated rather than passing quietly.

What owes a still form is not a name written into the check. It is derived from
the app's motion surface — the same walk over every stylesheet under `src/` that
rule 9 enumerates its ration from (`collectStylesheets` and `readMotion`). Every
animated selector that walk finds must have a still form registered in
`STILL_FORMS`, and every registered still form must match a selector the walk
still finds. So an animation added anywhere under `src/`, or moved from one
selector to another, arrives with no still form registered and turns this rule
red rather than passing unread. That is wider than the earlier floor, which
named the `ping` keyframes and `.markClaimed::after` outright and would have
stayed green over a second animation somewhere else.

Today the walk finds exactly one selector: `.markClaimed::after`, the halo on a
claimed row, animated by the `ping` keyframes in
`src/views/route/Route.module.css`. It is the whole of `src/`'s motion budget.
Its still form is asserted on every fixture that renders a claimed node beside a
node in some other state: with reduce on, the computed `animation-name` on that
pseudo-element is `none`, its `content` is still drawn, its opacity is above
zero, it still has a border of non-zero width, and the same read taken on a node
in another state differs.

The halo is authored as a still ring and the animation is added on top of it —
the `::after` declares its inset, its border and its opacity outright, and only
then takes the animation. The global reduced-motion guard in
`src/styles/global.css` kills `animation` with `!important` on every element and
pseudo-element, so what is left under the media query is the ring itself rather
than nothing. The distinction survives in the still form, and the still form is
the same mark rather than a substitute drawn somewhere else.

The residue is exact, and it is why this rule stays judged: a machine can prove
that the two renderings still differ with the motion off, and it cannot prove
that the difference left standing is the *same* distinction the motion was
carrying rather than an unrelated one that happens to survive. The assertion
above would be just as green if the ring meant something other than *claimed*
and the claimed row merely happened to differ from its neighbour in one of the
values read. This view's answer to that is that the motion is drawn on the ring
and the ring is drawn on the claimed mark, so there is no second difference for
a reader to be reading instead: marks that are not claimed carry no halo at all,
still or moving. A reader falsifies it by finding some *other* visual difference
between a claimed row and an unclaimed one under reduce — which would mean the
surviving distinction is not uniquely the ring's, and the machine's verdict was
riding on the wrong difference.

What the motion means is a separate question and it is registered elsewhere.
Rule 9 records that this animation rides on *someone holds this ticket* rather
than on running-vs-stale, that `NodeState` carries no running bit, and how #43
settled it: `claimed` is the one state that is in progress rather than settled,
and it is the liveness this side of the seam can carry. Rule 9 is asserted and
has no deviation route, so that settlement is the registry's and its
enumeration's, and is not re-filed here.

## Rule 13 — Resolved stays locatable

The floor asserted here is four DOM facts, taken over every resolved node of
every fixture that has one, at every point of the space: the row is present and
visible in the DOM; the product of `opacity` up its whole ancestor chain is
above zero; the point at the centre of the row's box hit-tests to the row itself
rather than to something painted over it; and the row takes focus from the
keyboard. A fixture with no resolved node skips with that precondition stated
rather than passing on nothing found.

Resolved recedes in ink weight and in nothing else. `.node[data-mark="resolved"]`
reassigns two ink tokens — the title to the secondary ink, the quiet text to the
faint one — and the glyph's own recession is on the mark's shape rather than on
the row, so the fade cannot reach the title. The block carries no `opacity`, no
`display`, no `visibility` and no `content-visibility`, and
`tests/route-view.test.tsx` reads that block and fails if one arrives. The four
facts are met by construction on this view: a resolved row sits in a `Resolved`
section that is headed and counted like the others, and nothing is capped or
sliced away at the bottom of a long finished map.

Salience is the residue, and it is the whole of what the four facts cannot
reach: a row can be present, opaque, hittable and focusable and still be gone to
a reader who is scanning rather than searching. How far a view may recede
resolved before that happens is the judgement, and no ratio settles it. The
Route's answer is a deliberately shallow recession — two ink steps and a section
heading, and no third step of any kind, so nothing about a resolved row is
smaller, thinner, collapsed or moved out of reading order. A reader falsifies
that by failing to find a ticket they know is resolved while scanning a long
finished map; the finding would be that two ink steps are one too many, or that
the section sits where nobody looks.

What ships is therefore a plain `Resolved` section. There is no unread mark and
no resolution-comment reading pane anywhere in `src/` — the model carries no
read state and no comment body for a view to render — so the reasons the
contract gives for resolved staying *worth locating* are not reasons this view
can point at yet. Older contract prose cites The Route as the exemplar for rule
13 on the strength of exactly those two, and neither exists here. That is a
citation to correct where it was made, and #10 now carries it; it is not a way
this view answers the rule differently, and nothing about the floor or the ink
weight waits on it. That is a note for whoever builds the reading pane, not a
deviation.

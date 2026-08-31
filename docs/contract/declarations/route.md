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

The Route is a grouped list in one column — Now/Next, Frontier, Blocked,
Resolved, Out of scope, Unclassified — with the fog and the destination beside
those sections rather than inside them. It **draws no edge at all**, and under
this contract that is structural rather than a deviation:
[ADR 0006](../../adr/0006-the-route-is-a-grouped-list-not-a-graph.md) settles
zero drawn edges as the view's thesis, and the contract's meta-rule says the
contract binds meaning and never geometry. There is no fan-out owed here.

## Rule 4 — Absence is never zero

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
of its identity and it is drawn every time the region is.

## Rule 10 — Hover discloses nothing

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

The designation mark does not scale, on hover or otherwise. No mark carries a
`transform` in any interaction state; the two transforms in the stylesheet are
the destination waypoint's fixed 45° rotation and the cut strike's centring
`translateY`, and neither is keyed to a pointer. The claim in older contract
prose that this view scales the designation on hover is not true of the shipped
view.

This is compliance by absence rather than by design, and it is the fragile kind:
the transition is already declared on `.node` and the token is already named
`hover`, so the first `:hover` rule that lands inherits both without anyone
deciding to. That is a note for whoever adds one, not a deviation.

## Rule 11 — The field is not the label surface

There is no graph field in this view, so there is nothing for a label to be
misread as. The Route's rows *are* labels — a glyph, a title, an id and tags on
one line — laid out by the flow rather than positioned on a plate, and a row's
width is capped by `--c-node-plate` (doubled for a row carrying a cut reason) so
the annotation has room the layout cannot take back. A zone boundary needs
clearance from the graph's own marks; there are no marks in a field here, only
section headings above rows.

The immunity holds at any n because it is a property of the layout kind and not
of a measurement, which is also why no figure appears in this declaration: the
meta-rule refuses to promote one view's clearance number into a rule every view
must meet.

ADR 0006 argued that point partly from a cap — capped regions, an `N more`
affordance and a rail height that stays O(1). None of that shipped. Nothing is
capped, nothing is sliced, there is no `N more`, and every resolved row on a
finished map is rendered; the pane is its own scrollport (`overflow-y: auto` on
`.route`) and scrolling is what it does about length. The rule is still kept —
labels cannot collide with a field that does not exist — but the argument
recorded for it names a mechanism this view does not have.

Deviation: the O(1) reading argument in ADR 0006 is not implemented. The pane
scrolls instead of capping, so at a large enough n the reader's cost is a scroll
rather than a fixed rail, and the recorded justification for rule 11's immunity
is ahead of the code. To work off: either build the cap and the `N more`, or
restate the immunity from the layout kind alone and strike the cap from the ADR.

## Rule 12 — Still-state equivalent

Exactly one thing in this view moves: `.markClaimed::after`, the halo on a
claimed row, animated by the `ping` keyframes in
`src/views/route/Route.module.css`. It is the whole of `src/`'s motion budget.

The halo is authored as a still ring and the animation is added on top of it —
the `::after` declares its inset, its border and its opacity outright, and only
then takes the animation. The global reduced-motion guard in
`src/styles/global.css` kills `animation` with `!important` on every element and
pseudo-element, so what is left under the media query is the ring itself rather
than nothing. The distinction survives in the still form, and the still form is
the same mark rather than a substitute drawn somewhere else.

The residue is *carries it alone*: the ring has to be the same distinction the
motion was carrying. It is, because the motion is drawn on the ring and the ring
is drawn on the claimed mark, so there is no second difference for a reader to
be reading instead — the marks that are not claimed carry no halo at all, still
or moving.

What the motion means is a separate question and it is registered elsewhere.
Rule 9 records that this animation rides on *someone holds this ticket* rather
than on running-vs-stale, that `NodeState` carries no running bit, and that the
settling belongs to #43. Rule 9 is asserted and has no deviation route, so that
tension is not re-filed here.

## Rule 13 — Resolved stays locatable

Resolved recedes in ink weight and in nothing else. `.node[data-mark="resolved"]`
reassigns two ink tokens — the title to the secondary ink, the quiet text to the
faint one — and the glyph's own recession is on the mark's shape rather than on
the row, so the fade cannot reach the title. The block carries no `opacity`, no
`display`, no `visibility` and no `content-visibility`, and
`tests/route-view.test.tsx` reads that block and fails if one arrives.

The asserted floor is therefore met by construction on this view: a resolved row
is in the DOM, at full opacity, hit-testable and focusable like every other row,
it sits in a `Resolved` section that is headed and counted like the others, and
nothing is capped or sliced away at the bottom of a long finished map.

The judged half is *salience, not visibility*, and this view's evidence for it is
thinner than the contract's own prose claims. What ships is a plain `Resolved`
section: two ink steps and a section heading. There is no unread mark and no
resolution-comment reading pane anywhere in `src/` — the model carries no read
state and no comment body for a view to render — so the reasons the contract
gives for resolved staying *worth locating* are not reasons this view can point
at yet.

Deviation: older contract prose cites The Route as the exemplar for rule 13 on
the strength of unread marks and a resolution-comment reading pane, and neither
exists. The rule is kept at its floor and the exemplar claim is stale. To work
off: either build the unread mark and the reading pane on top of a model that
carries read state, or move the exemplar to whichever view earns it and leave
this view declaring the ink-weight answer on its own terms.

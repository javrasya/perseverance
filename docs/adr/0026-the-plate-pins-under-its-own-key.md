# 26. The Plate pins under its own key, and draws at one to one

Status: accepted (2026-08-31)
Context: [#63 The Plate](https://github.com/javrasya/perseverance/issues/63),
under the spec [#28](https://github.com/javrasya/perseverance/issues/28). It
rests on [ADR 0020](0020-the-contract-is-thirteen-rules-in-three-tiers.md) for
the tiers a rule is kept in, on
[ADR 0025](0025-the-plate-is-shapes-and-words-and-spends-no-motion.md) for what
this view draws and what it refuses to spend, and on #52's `map_view`, which is
the envelope this lands in.

`0026` and not `0006`: the directory holds two ADRs numbered `0010`, two at
`0020`, and two each at `0022`, `0023` and `0024`, so `0025` is the highest
number in use and this is the one after it.

## Context

Rule 8 of the encoding contract reads: *no stored node positions, except The
Plate, which stores it under its own key*. Until this slice the exception had no
implementation, so the rule was kept **structurally** — nothing in the app could
name a node position, because there was no field, no command and no prop to
write one into. The rule's own registry entry said what would end that: the
exception "arrives as a field on `MapLayout` … and on that day this entry
becomes asserted, because the narrowing turns into a claim about who may use the
field there is."

This is that day, and it forces three decisions.

## Decision

**One field, one writer, one module.** The exception is a second field on
`MapLayout` — the opaque `layout_json` envelope #52 introduced — called `plate`,
carrying a list of `{node, column, row}`. No migration: the column is `TEXT` and
the envelope is read-modify-written, so a build that knows a layout fact this one
does not gets it back. `remember_map_pins` is the only command that takes a
position, and `src/views/plate/pins.ts` is the only module on the WebView side
that names either it or the storage prefix. The prefix is `perseverance.plate.`
and deliberately not `perseverance.dial.`: one prefix per fact, so clearing an
arrangement never clears a window.

The seam is modelled line for line on `src/panes/position.ts` — two Rust command
names that are the Rust side's own, a `localStorage` fallback for the window with
no Rust behind it, one `usable` validator so the browser cell and the store
envelope cannot disagree about what a pin is, every failure swallowed into
*nothing pinned*. A registry that has gone bad costs an operator an arrangement,
not a drawing.

It also lives under `src/views/plate/` rather than beside the dial's seam, and
that placement is the mechanism rather than tidiness. A general home for
positions is exactly how a second view would acquire them without anybody
deciding it should. `ViewProps` carries no position and never will, so the pins
reach the view through a store of the Plate's own: the shell says which
`(folder, map)` is open — it is the only thing that knows the folder — and the
view reads its pins from there and writes them back. Nothing about a position
passes through `src/App.tsx`.

**The pins are an input to the geometry, never a correction applied over it.**
`plateOf(map, pins)` places a pinned station where the pin says and lays every
generated station out around it, so a pinned station is routed to, labelled by
the same eight-anchor solver, and counted in the same extent as any other. Rule
11's reserved label boxes stay reserved because the solver still reserves them —
a pin that moved a station *after* layout would leave the router routing around
a box nothing is in. A pin for a child the map no longer has, or a map that grew
a child no pin names, stamps the plate **provisional** and buys it a
construction margin: the drawing is then partly somebody's hand and partly
generated, and the legend says so rather than the picture pretending it was
authored whole.

**One write per settled gesture, and none per frame.** The drag is two pointer
events — down on the station, up wherever the hand let go — and the difference is
divided by the cell size and rounded, which is the snap. Nothing moves until the
gesture settles, and then the pin lands, the geometry is re-derived once and the
station is drawn in its new cell. That is the same falling edge the dial and a
terminal resize use, and it is also what rule 9 asks of a drag: no transition, no
animation, no motion spent on a claim this view cannot make. The affordance is a
sentence in the margin, drawn before anything is hovered, because an affordance
that only exists under a pointer is one half the operators never find (rule 10).

**Too narrow is answered at natural size or not at all.** The Plate is the one
view that cannot reflow. Scaling the drawing below 1:1 would defeat the whole
point of reserving label boxes in cells of 14px — the plates stop holding the
words the solver reserved room for — so the field is drawn at its natural size
and the view column is the scrollport. That leaves exactly one stand-down, the
floor: `VIEW_FLOORS.plate` is `PLATE_FLOOR` (700px), and under it the shell's own
`standDown` names the view, what it needs, what it has and two exits an operator
can press. `plateStandDown` — this module's own second opinion, with a
`narrowerThanPlate` reading for *above the floor but under this drawing's width*
— is **deleted**. Its second reading has no remedy worth a stand-down now that
the answer is scroll, and a second stand-down type would have been a second thing
entitled to disagree with the registry about when a view is drawn.

## Consequences

Rule 8 is now **asserted** rather than structural, and its check is three
assertions over source text: the envelope has exactly one field a position can
arrive through, one command writes it, and only `src/views/plate/` names it.
Asserted carries no deviation route, so the exception the Plate was granted is
not a door the next view can file itself through — a view that wants stored
positions has to change the rule, not declare against it.

The provisional path is reachable for the first time, which means the legend
entry that explains it is drawn rather than theoretical.

What is not decided here: whether a pin can be undone from the keyboard, and
whether an operator can clear a whole arrangement back to generated. The store
takes an empty list and reads it as *nothing pinned*, so the mechanism is there;
the gesture is not, and it belongs with the slice that measures this view against
real maps.

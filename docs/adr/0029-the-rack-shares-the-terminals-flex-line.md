# 29. The rack shares the terminal's flex line, and its dock goes with it

Status: accepted (2026-08-31)
Context: [#59 The research
queue](https://github.com/javrasya/perseverance/issues/59), under the spec
[#28](https://github.com/javrasya/perseverance/issues/28). ADR 0025 settled that
the rack's tier is a function of the region's width and never of how many runs
are in it. This settles the box that width is a function of — the arrangement
ADR 0025 assumed and nothing enforced — and where the rack's dock lives once the
rack has moved.

## Context

ADR 0025 is written entirely in widths: a `flex: 0 1` fixed basis, an explicit
`min-width` floor that switches off flexbox's content-derived minimum, a table of
what the region is worth at each detent, and `tierFor` reading one measurement of
the region and nothing else. `sides()` in `src/panes/dial.ts` reserves the rack's
floor out of the map side's cap on the same understanding.

None of it was true of the shipped tree. `<Rack>` was mounted inside `.runSide`
— the pane's *column* — so every main-axis rule in `Rack.module.css` was read on
the wrong axis: the basis became a height, and the floor became a cross-axis
minimum that `stretch` had already beaten. The region was simply the pane's
width at every detent. `regionFor` described a layout nobody was producing, the
region never shrank when the line got short, and `tierFor` was handed a number
that said `bays` wherever the dial stood.

This was invisible to the unit tests by construction: `tests/rack.test.tsx` stubs
the measurement, and jsdom lays out nothing, so a rack that had come loose from
the terminal side still read as the right tier and passed.

## Decision

**The rack is a child of `.terminal` and the run side's sibling — one flex line,
two boxes.** The rack is `flex: 0 1 var(--c-rack-basis)` with `min-width:
var(--c-rack-floor)`; the run side is `flex: 1 1 0`. Every pixel the line is
short comes out of the region until it stands on its floor, and out of the pane
after that, which is exactly the arrangement `sides()` and `regionFor` are
written from. The rack keeps ADR 0025's place in the order — on the dial's side
of the pane — so a narrowing terminal side takes the pane's pixels and leaves the
rack standing.

**The rack's dock moved with the rack.** A dock is an *address*: the node panel
names `rack`, and an operator who docks the pass there expects it to appear at
the rack. Left behind in `.runSide` it would have kept the name while pointing
at a box the rack is no longer in. So `Dock dock="rack"` is handed to `Rack` as a
node and drawn in a strip at the foot of the region. The rack owns the strip and
nothing inside it — which panel is docked, which dock is chosen and where the
node travels are all the shell's, and the rack may not learn any of it. The strip
takes height and never width: a docked panel that widened the rack would move the
seam a live agent is laid out against, which is the same defect as putting the
peek's stud in the flow.

**The stud's clearance stays unconditional.** `--c-rack-strip` reserves a line at
the top of the region for the peek stud, which is absolutely positioned against
the *body*. At the `map` detent the terminal side is worth the rack's floor and
its own padding and nothing else, so the rack is the body's top right corner and
an opaque stud would cover the head band — the lamp and `N of M still running`.
At every other detent the rack sits on the dial's side of the pane and the stud
is over the pane's own corner, which has nothing to lose. The reserve is given at
every detent anyway: the region's right edge moves with the dial and its top edge
does not, so there is no inset and no detent-dependent rule that clears it, and a
clearance that came and went with the dial would be a rack that reflowed when the
seam moved.

**The claim is kept in a browser, not in jsdom.**
`tests/conformance/rack-width.spec.ts` reads the rack, its parent and the box
beside it out of the real layout at every detent, and it is what would have
caught the parked rack. Its three row-measuring cases also had to ask for the
`rack` fixture: the default fixture starts no runs, and a rack with nothing in it
draws the empty sentence rather than an `<ol>` to measure.

## Consequences

The rack's geometry is now the terminal side's business, and the terminal side's
two children are the whole of it. Anything that later wants a third box on that
line — a second rail, an inspector — is changing the arithmetic in `sides()` and
`regionFor` together, and the conformance spec is where that shows up.

The reserved strip buys nothing visible at the `split` and `glance` detents; it
is a line of padding at the top of the rack that no stud is over. That is a real
cost, paid to keep the rule detent-independent.

A panel docked at the rack is inside a narrow region. The strip scrolls rather
than being clipped by the region's own `overflow: hidden`, but a rack at its
floor is a poor place to read a boarding pass, and `effectiveDock` already sends
the pass to the spine when the rack collapses. This ADR does not widen that rule;
it only puts the dock where its name says it is.

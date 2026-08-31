# 25. The rack's tier is a function of width, not of N

Status: accepted (2026-08-31)
Context: [#56 The rack](https://github.com/javrasya/perseverance/issues/56),
under the spec [#28](https://github.com/javrasya/perseverance/issues/28). It sits
beside
[ADR 0022](0022-the-dial-is-four-detents-and-nothing-switches-by-itself.md),
which decided that nothing switches the window by itself, and applies the same
rule to the one surface that grows a row every time an operator starts something.

`0025` and not `0005`: `0005` was never written and is left where it is, and
`docs/adr/` holds two ADRs numbered `0010`, two numbered `0020`, two `0022`, two
`0023` and two `0024`. The number is one above the highest on disk, which has not
been the file count for a long time.

## Context

Several agents run at once and their transcripts cannot be read in parallel —
the spec refuses tiling N terminals on exactly that ground. What is worth
knowing across N runs is not what each one is saying but whether each one is
alive, progressing or wedged, and that is four facts per run: what kind of run
it is, how old it is, how much output its terminal has not been handed, and how
long it has been quiet. One row each.

That makes the rack the one piece of chrome whose content arrives from the
world. A run starting, a run landing, a ticket closing and a child dying are all
things that happen while nobody is looking at the window, and each of them
changes what is in the rack. Two readings were available for what that should do
to the window, and they are not compatible.

**The rejected reading: the rack fits itself to what is in it.** It is the
obvious one and every list widget does it — a column sized to its widest cell, a
region that grows a little when a fifth run arrives, rows re-sorted so the noisy
one is at the top. It is also, on this screen, a window that rearranges itself
while an operator is typing into a terminal on the other side of the dial. The
worst version is not even the widening: it is the disappearance. A landed run
whose row is removed is a layout change caused by a process exiting somewhere,
and everything below it moves under a pointer that was aimed at something else.

**The reading taken: the world may change what a row *says*, and only a press
may change what anything *is worth*.** The rack's width comes from a fixed
basis and a floor. Which of three tiers it draws at comes from measuring that
region and from nothing else. Rows are a fixed height, in the order the runs
were opened, and a landed run keeps its row until `endRun` — a press — takes it
away.

## Decision

**The tier is a function of width.** `tierFor(width)` in `src/rack/rack.ts`
takes one number and reads nothing else: not `readouts.length`, not what a row
came out saying, not whether anything is live. `bays` is the full row, `boards`
the working middle, `studs` what is left when the dial has given nearly
everything to the map. The stylesheet is the other half of the claim — the
region is `flex: 0 1` a fixed basis with an explicit `min-width`, which is what
switches off flexbox's automatic content-derived minimum. Without that one
declaration a long enough kind word would widen the region, and the width would
have become a function of what arrived.

**The region has a floor, and there is no tier below it.** `RACK_FLOOR` is
exported from the same module the dial reads, and `sides()` takes it — as
`RACK_RESERVE`, the floor plus the terminal box's own padding — out of the map
end at every position, so the terminal side never closes to zero and the map
side's `max-width` is authored by that same arithmetic — `mapCap()` in the dial,
degrade included — rather than by a second copy of it in the shell. It is authored again as `--c-rack-floor` in pixels — the unit the region is measured in. `studs` floors at zero width, which
is deliberate: a box nobody has laid out yet, a first paint and every jsdom test
all measure zero, and the answer to all three has to be *draw the narrow rack*.
A fourth tier meaning *nothing* would be the one state in which the rack
disappears, which is the thing this ADR exists to forbid.

**Which tier each detent draws — and `glance` is not `studs`.** #56 names a tier
per detent: "full bays at terminal and split, studs at glance, and at map studs
are what is left of the terminal side". The `glance` clause is a drafting error
and is not adopted. `glance` gives the *map* 0.3 of the window
(`FRACTIONS` in `src/panes/dial.ts`), so the terminal side at `glance` is 70% —
wider than at `split`, and the widest terminal side there is short of the
`terminal` detent itself. `tierFor` is monotone in width and stays monotone: a
wider region may never draw a narrower tier, because a tier that went narrow as
the region grew would make *the tier is the width* unreadable at a glance, which
is the only thing the three words are for. Under any monotone function, a
detent that leaves the terminal side more pixels than `split` cannot draw a
narrower tier than `split` draws.

So the table, on a default 1280px window, with the dial's own column measured:

| detent | map side | terminal side | region | tier |
| --- | --- | --- | --- | --- |
| `terminal` | 0 | everything | basis | `bays` |
| `glance` | 0.3 | 0.7 | basis | `bays` |
| `split` | 0.5 | 0.5 | basis | `bays` |
| `map` | all but the reserve | `RACK_RESERVE` | floor | `studs` |

`bays` at the first three because the region never grows past `RACK_BASIS` and
all three leave more than that; `studs` at the last because what is left of the
terminal side there is the reserve exactly, and the region is on its floor.
`tests/rack.test.tsx` walks the four detents and pins each cell of that table.

**`boards` is not reachable by a press on a default window, and that is
accepted.** It is the tier of a free drag and of a small window: the region draws
`boards` whenever it measures between the `boards` and `bays` floors, which a
drag between `split` and `map` passes through, and which `split` itself produces
on a window around 700px. The floors were not retuned to put a detent on it,
because at a fixed basis they cannot be: `terminal`, `glance` and `split` all
leave the region the same number — its basis — so no set of floors tells those
three apart. The only lever that would is making the region a *share* of the
terminal side, and a rack that were a share would be hundreds of pixels wide at
the `terminal` detent, taking them from the pane, which is the thing being read.
A fixed basis and three detents above it is the price of the region not moving.

**Each narrow tier prints what it dropped.** `SHOWN` is the table the component
renders from, and the sentence under the rack's heading is derived from that same
table rather than written beside it, so the two cannot drift. It is text in the
flow: rule 10 of the encoding contract keeps load-bearing information off hover,
and *this rack is not showing you the ticket* has to be distinguishable from
*this run has no ticket* without a pointer. What is dropped first is an ordering
of what a rack is for — `ticket` and `age` are how you recognise a run you
already know about, while `liveness`, `unseen` and `silence` are the question the
surface exists to answer, and they survive to the narrowest tier.

**And draws what it kept, whole.** The sentence is only half the promise. A tier
that keeps `silence` and then renders it as an ellipsis has told the same lie
from the other end — the field is in the accessibility tree, in `textContent`
and in `SHOWN`, and is not on the screen — and jsdom cannot see the difference,
because jsdom measures every box at zero. So the two narrow tiers say the same
facts in fewer characters (`phraseAt` in `src/rack/rack.ts`: `2.1 KB` for
`2,112 bytes unseen`, `quiet 6m` for `last printed 6 minutes ago`) and their rows
wrap onto further lines of a fixed-height box rather than shrinking their fields
to fit one. Not different facts and not coarser ones: what cannot be shortened
without lying about which run it names — `ticket` and `age` — is dropped outright
and named in the sentence instead. `tests/conformance/rack-width.spec.ts` pins
the region to each narrow tier's floor in a real browser and measures every field
the tier claims.

**One moving thing, and a landing is announced by its ceasing.** Rule 9 rations
motion to liveness, and a run readout carries the realest liveness in this app —
a child that is either printing or has stopped. It is still one ration. Four live
runs pinging at once is ambient motion however defensible each ping is alone, so
the animation is spent **once for the whole rack**, on a lamp in its head, and
every row carries the same bit in still form: the word `live` or `landed`, the
ink, and a border. `tests/motion-ration.test.ts` licenses it by selector and
keyframes; `tests/rack.test.tsx` counts the animated elements in the DOM for
every fixture. What that arrangement buys is the announcement: nothing in the
rack ever *starts* moving because something ended. A landing takes a row's live
ink away, and when it was the last live run the lamp stops. There is no flash, no
toast and no arrival animation, so an arrival can never interrupt a sentence
being typed.

**And the ration is the screen's, not this subtree's.** The rack is not the only
surface licensed to move: `Route.module.css` pings a `claimed` node, and at
`split`, at `glance` and at `map` with a map open both surfaces are on screen at
once. A lamp that counted only its own children would meet *at most one animated
element* inside a subtree while the delivered window animated two, which is not
the criterion #56 asks for. So the two licences are arbitrated rather than
listed: `lampPings` in `src/rack/rack.ts` spends the rack's ping only when the
other licence is not being spent, `src/App.tsx` is the one box that can see both
surfaces and is what answers it, and both animated elements carry
`data-animated` so the count is a query over the document.

The rack is the side that yields. What it gives up is the movement and never the
fact — the lit ring and `N of M still running` say the same thing standing still,
which is what a `prefers-reduced-motion` window has been reading all along. Three
properties survive the arbitration and are held to as arithmetic in
`tests/motion-ration.test.ts`: the decision is monotone in the live count, so a
landing can still only ever take the ping away and never start it; no reading of
the two facts spends both licences at once; and the fact the shell hands down is
a fact about the *pressed* arrangement of the window — which view is open, how
the dial is set, whether the view stood down — and never about the graph. That
last one is the one this ticket got wrong first. The shell asked whether any node
was `claimed`, which is polled GitHub data and, worse, is not even the fact the
Route animates on: `markOf` answers `destination` and `unclassified` above the
state, so an assigned spec child suppressed the rack's lamp against a ping nobody
drew. Either way a claim landing would have stopped the lamp and a ticket
resolving would have started it — a ping ceasing with no landing under it, and
motion beginning because something ended, both of which this ticket forbids in as
many words. So the licence goes with the surface the operator turned to rather
than with what happens to be on it: while the Route is drawn the map side holds
it, spent or not, and turning the dial hands it back. An unspent licence is not
lent back, because lending it back is what would put the world in charge of the
lamp; zero animated elements is inside *at most one*, and a lamp that starts on a
resolution is not.

And the other half of *at most one* is that neither licence is spent per thing it
is about. The rack's lamp is one lamp for the whole rack. The Route's halo was
one ping per claimed row, which met the criterion only because every checked-in
fixture stakes exactly one claim — a map staking two animated two elements, and
`tests/dev-web.test.tsx` counted the window and saw nothing. #56 closes that
rather than deferring it, because the criterion is this ticket's: `pingOf` in
`src/views/route/route.ts` names the one row that moves, `.markPing::after`
carries the animation and `.markClaimed::after` keeps the still ring on every
claimed mark. So a second claim loses the movement and keeps the disc, the ring,
`data-mark` and its place under *Now* — exactly what the reduced-motion window has
been reading all along, which is why rationing the halo costs no encoding.
`tests/route-view.test.tsx` paints a multi-claim map and counts one animated
element; `tests/motion-ration.test.ts` counts the view's real element count
instead of assuming it.

## Consequences

The rack takes width off the terminal side, permanently, which is a thing the
peek's stud is careful never to do. The difference is that the stud comes and
goes with a held key — a reflow of a live agent for a gesture that was not about
width — while the rack is always there and only a dial move changes what it is
worth. It sits on the dial's side of the pane so that a narrowing terminal side
takes the pane's pixels first: at the `map` detent what is left of that side is
the rack against its floor, which is the width at which supervising N runs still
works. The reservation degrades rather than inverting the dial — it never takes
more than half of what the two sides share — so on a window too narrow to afford
both, the `map` detent is still the map-most position it is named for.

The peek is drawn at the detent's width and therefore stops short of the rack
too, which is what keeps a glance and the detent shedding the same columns: a
peek at the old full-body width would be a map no position of the dial can
reach.

Silence is printed as a duration and classified as nothing. Quiet-versus-wedged
is #50's, and a rack that guessed would be asserting a diagnosis nobody made —
the same reason a run the harness was never told the stakes of is named as *no
stakes recorded* rather than defaulted to *work*.

The rack is a readout and binds nothing. Choosing which run the terminal shows is
the patchbay's (#57); rows carry no affordance and the monitored binding is
untouched by everything here.

`dev:web` gains a fixture of six runs, and it carries seconds-ago rather than
stamps. Every other fixture in this repo checks in absolute seconds and lets them
age, which is right for *last opened* and wrong here: the state worth drawing is
*silent for six minutes*, and a stamp from the day the file was written would
read as silent for a year.

## What would falsify this

- A rack whose measured region width, or whose tier, differs between one run and
  forty. `tests/rack.test.tsx` draws both at a pinned width and compares.
- A tier that answers *nothing* — a rack that is not on screen at some width,
  including zero.
- A row that appears or disappears for any reason but a press, or a rack that
  re-sorts by activity.
- A second animated element in the rack's subtree at any time, or an animation
  that starts when a run lands rather than one that stops.
- A detent that leaves the region more pixels than another detent and draws a
  narrower tier than it — `tierFor` losing its monotonicity, in the arithmetic or
  on the screen.
- A change to `FRACTIONS`, `TIER_FLOORS` or `RACK_BASIS` that moves a cell of the
  detent table above without this ADR moving with it.
- A field a narrow tier drops that is not named in the sentence that tier prints,
  or a sentence naming a field the tier is in fact drawing.
- A field a tier keeps that is not legible at that tier's floor: clipped to an
  ellipsis, cut off by the row's `overflow`, or on a flex line below the row's
  fixed height. Read in `textContent` it is present; measured it is not there,
  and `SHOWN` is claiming it either way.
- Liveness readable only while something moves: with
  `prefers-reduced-motion: reduce` every animation in this app is killed, and
  live-versus-landed has to survive that in words and in ink.

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
exported from the same module the dial reads, so the terminal side knows what it
owes the rack at every detent, and it is authored again as `--c-rack-floor` in
pixels — the unit the region is measured in. `studs` floors at zero width, which
is deliberate: a box nobody has laid out yet, a first paint and every jsdom test
all measure zero, and the answer to all three has to be *draw the narrow rack*.
A fourth tier meaning *nothing* would be the one state in which the rack
disappears, which is the thing this ADR exists to forbid.

**Each narrow tier prints what it dropped.** `SHOWN` is the table the component
renders from, and the sentence under the rack's heading is derived from that same
table rather than written beside it, so the two cannot drift. It is text in the
flow: rule 10 of the encoding contract keeps load-bearing information off hover,
and *this rack is not showing you the ticket* has to be distinguishable from
*this run has no ticket* without a pointer. What is dropped first is an ordering
of what a rack is for — `ticket` and `age` are how you recognise a run you
already know about, while `liveness`, `unseen` and `silence` are the question the
surface exists to answer, and they survive to the narrowest tier.

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

The Route's `.markClaimed` ping is untouched. Its per-node motion is that view's
identity, and re-rationing it belongs to the contract tickets rather than to
this one; the one-moving-thing claim here is scoped to the rack's own subtree and
the tests say so.

## Consequences

The rack takes width off the terminal side, permanently, which is a thing the
peek's stud is careful never to do. The difference is that the stud comes and
goes with a held key — a reflow of a live agent for a gesture that was not about
width — while the rack is always there and only a dial move changes what it is
worth. It sits on the dial's side of the pane so that a narrowing terminal side
takes the pane's pixels first: at the `map` detent what is left of that side is
the rack against its floor, which is the width at which supervising N runs still
works.

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
- A field a narrow tier drops that is not named in the sentence that tier prints,
  or a sentence naming a field the tier is in fact drawing.
- Liveness readable only while something moves: with
  `prefers-reduced-motion: reduce` every animation in this app is killed, and
  live-versus-landed has to survive that in words and in ink.

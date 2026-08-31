# 21. The dial is four detents, and nothing switches by itself

Status: accepted (2026-08-31)
Context: [#52 The dial: four detents, the stand-down and the switcher](https://github.com/javrasya/perseverance/issues/52),
under the spec [#28](https://github.com/javrasya/perseverance/issues/28). It
rests on [ADR 0006](0006-the-route-is-a-grouped-list-not-a-graph.md) for what a
view is and what it may be handed, and on
[ADR 0010](0010-the-change-ledger-is-a-notification-surface-not-an-archive.md)
for the ledger's address, which this ticket makes a spine rather than a header
slot.

`0021` and not `0020`: `0020` is taken, `0005` was never written and the
directory holds two ADRs numbered `0010`, so the highest number in use is
`0020` and the count of files is no guide.

## Context

The shell shipped a fixed 34rem split between the map and the run. That number
was a placeholder with a comment on it, and everything wrong with it is the same
thing: it is one answer to a question that has four. Reading a route, watching a
run, working a frontier and glancing at a map while an agent talks are four
different uses of one window, and a split that serves all four serves none.

Three decisions were not obvious.

**A detent is a place, not a mode.** The dial has four named positions —
`terminal`, `glance`, `split`, `map` — and free positions between them. Naming
them is what makes them reachable by keyboard, announceable to a screen reader
and storable per map; *not* rounding to them is what keeps the dial a dial. The
alternative, a four-way toggle, was rejected because every window is a different
width: 30% of a laptop and 30% of a monitor are different pictures, and an
operator who wants the seam three pixels over should get it.

**Nothing switches silently.** A view whose floor the current width does not
honour is a real problem with two honest answers — widen the window, or open
something that fits — and the tempting third answer is for the app to pick one.
It may not. A shell that swapped the open view for one that happened to fit
would make the picture on screen something nobody chose, and the operator's next
decision would be taken from a view they did not ask for. So the narrow case is
a **stand-down**: a surface that names the view, the reason, the requirement and
the actual, keeps the three integers and the frontier readable, and offers
exactly two exits, both of which are things a hand presses. The switcher follows
the same rule from the other side: a cap for a view that cannot be drawn here is
still there, still pressable, shaped differently rather than merely tinted, and
pressing it *surfaces and opens* — one press, two consequences, both asked for.

**One resize per gesture, and a collapse is not a size.** The dial's `map`
detent gives the terminal side no pixels at all. The pane stays mounted — the
node is never unmounted, remounted or reparented by a dial move, because an
xterm instance *is* the terminal and the harness holds bytes rather than screens
— but a box with no width still measures, as zero or as `NaN`. A settled
zero-column resize would reflow every live agent session, including ones nobody
is looking at. So a degenerate geometry is refused at the one choke point every
size passes through, and a collapsed box cancels the gesture rather than
settling what the last frames of the collapse measured: a run handed the window
back finds its terminal the size it left it.

## Decision

- The detent vocabulary is exactly **`terminal`, `glance`, `split`, `map`**, in
  that order, as fractions of the window given to the map side. Positions
  between them are legal; a release within a small tolerance of a detent snaps
  onto it and one outside it does not.
- The arithmetic lives in `src/panes/dial.ts` and is pure. Position in, pixels
  out: what each side is worth, which columns are shed, which views are
  honoured, and what a stand-down has to say. The components draw its answers
  and hold none of their own.
- **The app may never swap a view for another by itself**, at any width, for any
  reason. Every change of view is a press.
- **Exactly one PTY resize per completed gesture, and none for any other
  occasion** — unchanged from `src/panes/geometry.ts`, extended with the rule
  that a geometry no terminal could live at is not a geometry and reaches
  nothing.
- The three integers, the frontier, the view switcher, the change ledger and the
  cache stamps live on the spine — the header and footer, outside the body the
  dial divides — so no position of the dial can take any of them off screen.
- **The width every answer is a share of is the measured body box**, not the
  window. The position is applied as a flex-basis percentage of the `.body`
  element, so `position × body` *is* the map side rather than an estimate of it,
  and the stand-down's *needs 420, has 307* is a measurement rather than
  arithmetic about a box that is not on screen. It is measured with a ref and
  `getBoundingClientRect()`, on a window resize and after every render — never
  with a `ResizeObserver`, because the one observer in the app is the pane's and
  it is the single path to a PTY resize. A box measuring under a pixel is a box
  nobody has laid out yet (first paint, and jsdom), and there the window is the
  fallback.
- The dial's own column belongs to neither side. `sides(position, width, reach)`
  takes it as an argument rather than leaving the subtraction to the callers,
  because this is the one function that answers *what each side is worth*: a
  caller that forgot would print a terminal a dozen pixels wider than the
  terminal is. It defaults to `0` for the callers that only read the map side.
- **The launcher sheds at 420px of map side, and that stands.** #48 argues that
  the folder launcher may never disappear, and that is true of every *mode*
  reason a shell could have — a map being open, a run being live, a view being
  up. This is not one of those: it is measured width and nothing else, and the
  dial is on screen at every position, so everything shed comes back with one
  move of one control. A column shed by measurement and restored by one press is
  not a column that disappeared, so #48's claim is discharged rather than
  overridden and the number is left where it is.
- **The four detents are drawn on the dial**, as ticks with their names where
  the body is wide enough to afford them, marking the one the dial is at. They
  run *down the seam* rather than across the body: a horizontal figure spanning
  the window and growing as the dial moved would be a bar filling up, and
  progress in this app is exactly three integers. Ticks are places, the hand is a
  dot among them, and neither is focusable — the detent is already announced by
  `aria-valuetext` on the separator itself.
- The position is remembered **per map**, behind the two functions in
  `src/panes/position.ts`. A stored value that does not parse reads as absence
  and falls back to the default detent. With no map open there is no key and no
  default of its own.

## Consequences

The view registry now has three parallel records over `ViewName` — the names,
the labels and the floors — and a view added to `VIEWS` without a label or a
floor is a type error rather than a cap that reads `route` or a view that claims
to fit anywhere. That is the intended cost: #62, #63 and #64 each arrive as one
entry in each.

Column shedding is by measured width and by nothing else, which means the
launcher can be off screen at a narrow map side. That is a real loss — it is the
only way to a different folder — and it is bounded by the dial being on screen at
every position: everything shed comes back by moving one control. Both halves of
that bargain are pinned in `tests/dial.test.ts`, so a later change that sheds the
launcher without giving it back fails rather than argues.

Measuring the body makes the shell's pixel numbers checkable against the screen
instead of against `window.innerWidth`, and it costs one layout read per render.
It buys the honesty the stand-down is for: the number beside *has* is the number
the view would have been drawn into.

The per-map memory is `localStorage` today. The later slice of #52 that moves it
into the Rust `map_view` table changes `src/panes/position.ts` and nothing else.

The spring-loaded peek is deliberately not here. It is the next slice, and what
this one leaves it is a position the store already holds and one component that
owns the gesture.

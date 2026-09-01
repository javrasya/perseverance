# 25. The node panel is one element with three addresses, and the move is a move

Status: accepted (2026-08-31)
Context: [#54 The node panel, the markdown it prints, and the boarding pass](https://github.com/javrasya/perseverance/issues/54),
under the spec [#28](https://github.com/javrasya/perseverance/issues/28), stories
29 and 30. It rests on
[ADR 0006](0006-the-route-is-a-grouped-list-not-a-graph.md) for what a view is
and what chrome is, on
[ADR 0016](0016-the-fog-is-a-named-region-with-two-absences.md) for the shape an
absence has to have on screen, on
[ADR 0020](0020-the-contract-is-thirteen-rules-in-three-tiers.md) for the
encoding rules this chrome is bound by, and on
[ADR 0022](0022-the-dial-is-four-detents-and-nothing-switches-by-itself.md) and
[ADR 0023](0023-the-peek-borrows-the-dial-and-springs-back.md) for the dial whose
positions the docks ride on and for the borrow-and-spring-back this one copies.

`0025` and not `0024`: the numbers in `docs/adr/` are not a sequence and the file
count is not the next number. `0005` was never written, and `0010`, `0020`,
`0022`, `0023` and `0024` are each two ADRs sharing a number. `0025` is the
lowest number no filename on disk uses.

## Context

A node on The Route is a row: a number, a title, a state and a mark. Everything
else the model knows about it — the type, the blockers, what waits on it, the
claim, the dates, the resolution, the link out — had nowhere to be read. The
obvious answer is a detail panel, and the two questions that are *not* obvious
are the two this ticket is really about.

The first is what a panel does when it has no node. A detail surface spends most
of a session with nothing picked, and the default answer — draw the frame,
leave it empty — is the worst one available, because a blank rectangle looks the
same whether the click missed, the poll dropped the row, or the app broke. The
panel has five states it can be in (no map open, a map with no children, nothing
picked, a selection whose row went away under a re-poll, and a node), and an
operator has to be able to tell them apart without guessing.

The second is where the panel lives. It is chrome, not a view, and three
different places want it: a strip along the spine under the body, the run bar
beside a live agent, and the rack. Letting the operator choose is easy. Letting
them choose *without losing their place* is not: a panel that is unmounted at one
address and mounted at another is a new panel, and a new panel starts at the top
of its scroller with nothing selected in its text. A *text selection* is gone for
good — nothing on this side can put one back — and a scroll offset re-applied a
frame after a remount is a flicker the operator sees.

The app already had this exact problem once, and had already solved it: an xterm
instance *is* the terminal, and moving a terminal between panes is done by
`src/terminal/reparent.ts` — an imperative `appendChild` of a node React does not
own — rather than by rendering it somewhere else. The choice here was to reach
for that primitive a second time, or to write a second mechanism for the panel.

## Decision

**The panel is one element with three addresses, and moving between them is a
move.** It is created once, in `useState`, outside React's reconciler; `<Detail>`
is rendered into it by `createPortal`; and it is relocated by `reparent` — the
terminal's own primitive, unchanged, with its doc comment widened to name its
second user. The app has **one** imperative-reparent mechanism, not two that
drift apart, and it has it for the same reason in both places: a remount throws
away a reading position that nothing on this side could put back.

**The scroller is what travels.** The height cap and `overflow: auto` are on the
pass, not on any dock. A dock that owned the scroll box would hand the next dock
a fresh one on every move, and "the scroll position survives a re-dock" would be
false no matter how carefully the node was reparented. It is necessary and not
sufficient. A move is an `appendChild`, which detaches the node before it
re-inserts it, and Blink and WebKit destroy the layout box — where a scroll
offset lives — on detach. So the dock effect in `src/App.tsx` reads `scrollTop`
and `scrollLeft` off the pass and writes them back around the move: one task, no
frame painted between them, which is what separates this from the remount fix
rejected below. Nobody has watched it happen in a real engine yet. The jsdom test
models the drop rather than observing it (`tests/boarding-pass.test.tsx` makes
the move destroy the offset, so the restore is what keeps it green), and only a
browser — the Playwright suite — could observe the real thing.

**Which dock is a press and never an arrival.** `dock` lives in the UI store
beside `position`, written only by `chooseDock`, which nothing but a press calls
— no poll, no snapshot, no width. The one override is measurement rather than
automation: at the dial's `map` detent the terminal side is worth no pixels, and
a dock there would not be narrow but *invisible with no explanation*, so
`effectiveDock(chosen, terminalWidth)` lends the pass to the spine below
`TERMINAL_DOCK_FLOOR` (280px, the panel's own two columns and nothing else). The
store keeps the operator's choice untouched, the override is re-evaluated on
every width, and widening the dial springs the pass back to where it was put.
That is the same borrow [ADR 0023](0023-the-peek-borrows-the-dial-and-springs-back.md)
makes of the dial's position, and it is deliberately the same shape: a temporary
reading that never becomes a write.

**No dock is ever a blank box.** The two docks not holding the pass each print
where it went and a press that takes it back; a dock holding a pass it borrowed
prints why it is there and the one move that sends it home. This is the panel's
five never-empty states applied to the addresses instead of the contents, and a
dock is not exempt from that rule because it is chrome — under
[ADR 0020](0020-the-contract-is-thirteen-rules-in-three-tiers.md)'s rule 7
corollary, chrome is exactly where the contract is delivered.

**The arithmetic of *where* is pure and lives away from the pixels.**
`src/detail/docks.ts` has no DOM, no React and no pixels beyond the one floor, so
every claim the shell makes about which dock holds the pass is checkable without
mounting anything — the same division `src/panes/dial.ts` keeps, for the same
reason. `src/detail/detail.ts` does the same for *what it says*: the panel's join
and its words are a pure function of the model and the selection.

**The markdown is rendered in the view, and sanitisation is structural.** The one
markdown string this ticket renders — a cut's reason, lifted verbatim out of a
map document — goes through `src/detail/markdown.tsx`, a subset renderer that
builds **React elements and never an HTML string**. Raw HTML in an issue body
lands on screen as its own characters because no parser in the path could have
made an element of it: there is nothing to filter and therefore no filter to get
wrong.

**The renderer is the panel's, and the fog's region is not its customer.** The
other operator prose on this side — the fog's section over on The Route — stays
the one unmodified text node
[ADR 0016](0016-the-fog-is-a-named-region-with-two-absences.md) decided it is,
printed by `<pre className={styles.fogText}>` under `pre-wrap` and the mono
face, so the operator's own indentation and blank lines are on screen as typed.
Two reasons it is not swept in here. The subset has no nested list, so a bullet
the operator indented would come out a sibling of its parent and the indentation
would leave the screen — a loss ADR 0016 accepted nowhere. And the fog is #35's
region, bounded and counted in Rust: changing what it prints is an amendment to
ADR 0016 and belongs to a ticket that can make it, not to this one. Whether the
fog is ever rendered as markdown is left open there.

**Nothing animates on a re-dock.** Rule 9 rations motion to liveness, and a
re-dock is a press. The three stylesheets this ticket adds contain no
`animation`, no `@keyframes`, and no `transition` beyond one hover colour on a
dock's press.

## Alternatives rejected

**Rendering the panel three times and hiding two.** Cheap, and wrong in the way
that matters: three panels means three scroll offsets and three selections, and
whichever one is visible after a press is not the one that was read. It also
triples the DOM the page-scoped conformance walks have to be true of.

**Re-applying the scroll offset after a remount.** It restores the number and not
the position — the operator sees the jump, and a text selection is simply gone.
This is the fix that looks like it works until somebody is reading. Reading the
offset back *inside* the move, as the decision above does, is a different animal:
the node is never unmounted, the selection is never touched, and no frame is
painted between the detach and the write.

**A second reparent helper for the panel.** Rejected on the same grounds the
first one exists: two mechanisms for *move this node* drift, and the one that
moves terminals is the one with the harder constraints and the tests.

**Letting the width write the store.** A dial move that rewrote `dock` would mean
the operator's choice is destroyed by a glance at the map, and widening the dial
would leave the pass where the narrow moment put it. The choice is kept and the
override is recomputed; that is the difference between a borrow and a relocation.

**GitHub's `bodyHTML` / a render endpoint.** It is a rationed request spent per
paint, against the budget
[ADR 0008](0008-the-rate-limit-is-a-budget-the-poller-yields-first.md) is about,
and it returns HTML this side would then have to sanitise — trading a structural
guarantee for a filter.

**Pre-rendering the markdown in Rust.** It puts paint into a model whose whole
claim is that it carries text, and it would make the `check:model-purity` fence
argue with itself.

**A live anchor for the link out.** This WebView has no opener; a real `<a href>`
would navigate the app away from itself. The URL is text you select and copy, and
that is stated on screen rather than left to be discovered.

## Consequences

The panel prints nine fields and three of them are absences with reasons rather
than values: no issue body (the graph query never asks for one, so the title is
the whole question), no claimant name (how many people hold a ticket crosses the
seam and the names do not), no timestamps (the model reads none). Each says what
it is not told and why, because a fact the harness was never given is
form-level distinct from a count that is genuinely nought — the same distinction
[ADR 0016](0016-the-fog-is-a-named-region-with-two-absences.md) draws for the
fog. Widening any of those three is a model change first and a panel change
second, which is the correct order and is the cost of not faking them now.

`Dock` renders the frame and never the panel — its host `div` is appended to by
`reparent` and nothing may be rendered inside it, or React would reconcile
against a child it did not put there and remove it. That is the same contract
`Pane` keeps around a terminal, and it is written in the component's own doc
comment because it is the one way to break this design by accident.

The three docks that exist today are one strip apiece. The rack region #56 owns
is not built here; what landed is one dock in it, so #56 inherits an address
rather than having to invent one.

`TERMINAL_DOCK_FLOOR` is a second width number beside the dial's launcher floor.
Both are measured shedding with a one-press way back, both are in a pure module,
and neither is a mode.

## Falsifiability

**The panel.** `tests/detail.test.ts` pins the join — `panelOf`, `typeOf`,
`blockersOf`, `blockedOf`, the nine headings, and the sentences for the claim,
the dates and each absence — as a pure function of model and selection.
`tests/detail-panel.test.tsx` pins the picture, and its first claim is the one
the ticket is named for: over every fixture the app ships, with nothing selected,
with every node on the map selected in turn, and with a selection that names no
row, the panel leaves words on screen. A sixth state that rendered nothing would
fail there rather than be noticed by an operator.

**The markdown.** `tests/markdown.test.tsx` asserts the subset renders elements
and that raw HTML in the source arrives as characters.
`tests/no-raw-html.test.ts` holds the absence of `dangerouslySetInnerHTML` and
`innerHTML` over the whole of `src/`, so the structural claim cannot be quietly
downgraded to a filter. `npm run check:model-purity` holds the Rust side to
carrying text. `tests/route-view.test.tsx` still asserts the fog's section
reaches the DOM byte for byte, which is what holds the renderer to the panel.

**The pass.** `tests/docks.test.ts` pins `effectiveDock`, `dockedElsewhere` and
`borrowedBecause` without mounting anything. `tests/boarding-pass.test.tsx` boots
the shell and asserts there is exactly one panel in the document at every moment,
that the node arriving at a dock is the **same object** that left the last one,
that its scroll offset comes with it even when the move is made to destroy it,
that the selection it prints is unchanged
across a re-dock, that both docks without the pass name the occupant and offer a
keyboard-reachable press, and that the `map` detent borrows the pass onto the
spine with a sentence and springs it back when the width returns.
`tests/stores.test.ts` holds `chooseDock` to being the only writer of `dock`.

Whether a live **text selection** survives an `appendChild` is the browser's own
behaviour, and jsdom has no layout to exercise it with. It is claimed in prose on
the pass in `src/App.tsx` and is deliberately not faked into an assertion; the
honest place to pin it is the Playwright suite, which is where it belongs when
that suite can be run.

**The chrome, against the contract.** `tests/conformance-chrome.test.tsx` imports
the fog selectors the Playwright suite declares in
`tests/conformance/support/views.ts` and asserts them against the jsdom-rendered
Route in both readings — including that the unsurveyed region prints no digit
anywhere, which is rule 4 — and asserts that the panel and the three docks put no
progress element and no DOM `title` attribute on the page, which are rules 5 and
10 as their page-scoped checks spell them. `tests/motion-ration.test.ts` and
`tests/no-smil.test.ts` walk every stylesheet and every markup file under `src/`,
so the three new stylesheets are already held to spending no motion.
`tests/token-tiers.test.ts` holds them to the token tiers.

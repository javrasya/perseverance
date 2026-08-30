# 18. A child that is not a ticket is not on the work scale

Status: accepted (2026-08-10)
Context: [#37 Fail-safe rendering](https://github.com/javrasya/perseverance/issues/37),
under the spec [#28](https://github.com/javrasya/perseverance/issues/28). It
rests on [ADR 0004](0004-the-webviews-types-are-generated-from-the-model-crate.md)
for the generated seam and the generated fixtures, on
[ADR 0006](0006-the-route-is-a-grouped-list-not-a-graph.md) for what the pane
may do with what crosses it, on
[ADR 0015](0015-platform-bound-work-is-a-clause-in-the-one-resolver.md) for the
rule that a carried verdict is listed and never re-derived, on
[ADR 0016](0016-the-fog-is-a-named-region-with-two-absences.md) for a region
that sits beside the sections rather than among them, and on
[ADR 0017](0017-out-of-scope-is-not-progress.md) for a group placed after the
last one that is progress. The registry that will eventually hold rule
declarations is [#42](https://github.com/javrasya/perseverance/issues/42), which
this decision deliberately puts nothing into.

`0018` and not `0017`: the directory holds two ADRs numbered `0010`, so `0017`
is the highest number in use.

## Context

The classification is three-way and it has been since the model crate was
written. A `wayfinder:<type>` label in the four is a **ticket**;
`wayfinder:spec` is the **spec**; anything else at all — no label, an
unrecognised suffix, two recognised ones that disagree — is **unclassified**.
`ChildKind::of` decides it, `Node::is_startable_work` requires a ticket, and
`Node::is_counted` excludes both non-tickets from `Counts`. Rust had this right
and still has.

The Route did not read it. `routeOf` bucketed on `node.state` alone, and both
non-tickets arrive `takeable` — a spec is open and unassigned and blocked by
nothing, and so is a bug report somebody dragged onto the map. So on the awkward
fixture the heading read **Frontier 5** when two of the five rows were the spec
and one was a stray issue: three rows drawn wearing the ring that means *this is
yours to take*, counted under a heading that means *available work*, and told
apart from the two real ones by a `data-kind` attribute with no consequence on
screen.

Three things about fixing that were not obvious.

**Where the failure actually is.** Nothing was wrong in the model, so there was
nothing to derive. The bug was that a verdict crossed the seam and the pane drew
past it — which makes this a rendering decision with no arithmetic behind it,
and makes *re-deriving anything on this side* the one move that would turn a
drawing bug into a second answer to *may this be started*.

**What *never counted* can mean here.** `RouteSection.count` is always
`rows.length`, deliberately, because a heading that disagrees with what is under
it is a lie an operator can see. That rules out subtracting the spec from a
count: the subtraction would be the disagreement. The only way to stop counting
a row and stay honest is to move it somewhere that prints no count.

**What *non-actionable* can mean before there is an action.** *Start Working* is
[#48](https://github.com/javrasya/perseverance/issues/48) and does not exist.
There is no button to disable, so non-actionability had to be expressed without
inventing the thing it would disable — and inventing one anyway would hand #48 a
second answer that can disagree with `map.frontier`.

## Decision

**Kind decides the group before state does.**

One private function in `src/views/route/route.ts` reads `node.kind.kind` for
grouping, and it is the only reader of it in the file:

```ts
function offTheWorkScale(node: Node): "destination" | "unclassified" | null
```

The bucket a non-ticket lands in and the mark it wears are two answers to one
question, so they are taken from one place and cannot disagree. Nothing is
decided in it — `ChildKind` was settled in Rust off the map's own labels, and
this reads the word and picks a group.

Inside the single walk of `map.nodes` the order is: cut, then kind, then state.
The cut stays first because it is the one thing on this pane an operator wrote
by hand about that exact issue, so a spec the map cut is drawn among the things
the map cut. Kind before state is the fail-safe itself.

**`markOf` asks the same two questions in the same order**, and that is what
makes *cannot disagree* true rather than nearly true. `Node::of` hangs
`Cut::FromScope` on any child GitHub already calls resolved that the map
document names, asking nothing about the kind, so a cut spec is reachable from
real data — and a rule that took the bucket from the cut and the mark from the
kind would file that row under *Out of scope* while drawing it as the
destination. It wears `resolved`, which is also what keeps `.markCut` honest:
the strike is a decoration composed onto a mark that is *true* of the row, and
composed onto the rotated waypoint instead it would inherit the transform and
draw at 45°, which does not read as a strike at all.

**The spec goes to a Destination region with no count; a stray issue goes to a
counted section after Out of scope.**

`Route` gains `destination: readonly RouteRow[]`, beside `fog` and not among
`sections`. It draws between the last section and the fog — on a route the
destination is the far end, and the fog is the unmapped ground beyond it, which
keeps the fog the last `h2` on the pane. Its heading has **two** children where
a section's has three: no numeral, and no placeholder for one, because a slot
standing empty reads as a number that failed to arrive. That is a third form in
the count's slot, after a section's numeral and the unsurveyed fog's em dash.
The region is dropped when there is no spec child, exactly as an empty section
is; there is no second absence to tell apart here the way there is in the fog.

`SectionName` gains `"unclassified"` **last**, after `outOfScope`, by ADR 0017's
own rule read again: the list is the progression of work, and a child nobody
classified is not on it, so it goes after the last group that is. It **is**
counted, and that is the asymmetry with the spec rather than an oversight —
*Unclassified 2* is a true and useful claim about a real fault, two children the
frontier can never reach, and a number is the right thing to say about a backlog
of mislabelled issues. A number over the destination would be counting the thing
all the counting is for.

**Two new marks, and two shapes that are not circles.**

`Mark` goes from five to seven. The first five are a scale of work — somebody is
on it, take this next, yours to take, waiting, done — and these two rows are not
further along or further back on that scale; they are not on it. So they get
marks rather than decorations. `.markUnclassified` is a square with a dashed
border: two departures from every work glyph rather than one, not round and not
solid. `.markDestination` is a filled lozenge, `rotate(45deg)`, off the circle's
axis and filled rather than open — *open* is what the takeable ring says.

The row also **says what it is**. `KindTag` stopped returning `null` for
non-tickets and became an exhaustive switch returning `ReactElement`, so a
fourth `ChildKind` is a compile error rather than a row that quietly says
nothing. That word is the strongest of the three channels: a group is read once
at the top and a shape has to be learned, while text is read by a page search, a
screenshot and a screen reader.

**Nothing is subtracted from a count, and no spawnability predicate crosses into
TypeScript.**

*Frontier* on the awkward map goes 5 → 2 and on `platform-bound-windows` 4 → 3,
each still exactly `rows.length`. `describeModel`, `MapChip` and `Counts` are
untouched, because Rust already excludes both non-tickets from `tickets`. There
is no `data-spawnable`, no `data-actionable` and no view-local predicate: the
single offer surface is `map.frontier`, contract rule 2 says *Start Working
reads the resolver, never the view*, and a boolean invented here is a second
answer. What a non-ticket row loses is the offer. It keeps `tabIndex={0}`, its
click and its selection, because selecting a ticket is not starting one — and
the row an operator most needs to be able to open is the one that is wrong.

*The offer* is three things and the row loses all three. The bucket and the mark
are refused in `route.ts`; the third is in `Route.tsx`, where `data-frontier` is
withheld from a row marked `destination` or `unclassified` and `MarkerTag` reads
`row.mark === "designated"` rather than the boolean underneath it. That is a
**rendering suppression and not a second predicate**: `RouteRow.designated`
still carries `map.frontier`'s word verbatim — hiding it would be this side
resolving rather than reading — and nothing here decides spawnability. What it
stops is the pane handing a later reader a hook the shape it draws contradicts:
`data-frontier` is what every `dev-web` test and, eventually, #48's socket use
to mean *the one thing to take*, and the marker tag is the word *designated* an
operator reads. A row saying *destination* in its glyph and *designated* in its
text is the pane contradicting itself in the same glance.

**Resolved shipped its rule's teeth rather than new CSS.** The recession was
already two ink jobs and nothing else; what was missing was the test its own
comment had been asking for since #34.

## Tier claims under #42

Recorded here and written into no registry, following ADR 0006's precedent
exactly. #42 owns the registry, the declaration slots, the worklist and the
gates; a declared deviation filed from here would be a worklist entry whose only
correct resolution is to delete it.

**Rule 3 — *fail-safe is not styling; unclassified must be visible,
non-actionable, and survive a retheme*.** Non-actionable is **Structural** in
the model: `is_startable_work` requires a ticket, so no unclassified child can
be `map.frontier`, and there is no second predicate anywhere that could say
otherwise. Visible and survives-a-retheme are **Asserted**: a section, a shape
and a word in the DOM, plus the semantic-token-only scan that is this repo's one
mechanical meaning of *survives a retheme*.

**Rule 13 — *resolved must remain locatable; receding is a reduction in
salience, never a reduction in visibility*.** **Asserted**, and it could not be
Structural without taking the stylesheet away from the view: the block is
readable and the test reads it.

## Alternatives turned down

**A sixth section for the spec.** Rejected: a section's count is the rows it
heads, so heading the spec with one prints a number over the destination — and
*never counted* would then have to be a subtraction, which is the disagreement
between a heading and its rows that ADR 0017 spent a whole decision avoiding.

**#36's composed decoration, applied to kind.** Rejected, and the contrast is
the reason. A cut decorates `resolved` because the ticket really *is* closed;
the decoration is a further fact on top of a true one. Of a spec, *yours to
take* is simply false, so composing onto the takeable ring would draw a claim
that is wrong and then annotate it.

**A hue for unclassified.** Rejected: a hue is the fragile answer to *survives a
retheme*. It passes the tier check and can still be reassigned to something that
reads as decoration, and it is gone on a monochrome screen. The treatment is
weight plus geometry plus a word — `--s-ink-primary`, a dashed square, and the
model's own word on the row — and no new semantic token was added, because a job
named *unclassified* is one more thing for a retheme to get wrong.

**Removing the click handler or the tab stop.** Rejected: selection is not
spawning, and an unselectable row would hide the one row an operator most needs
to open in order to fix it — which is exactly what
[#54](https://github.com/javrasya/perseverance/issues/54)'s detail panel is for.

**A new fixture.** Rejected: `awkward-map` already carries an unclassified
child, two spec children and a resolved row at once, `spec-composed` carries a
spec with every ticket resolved, and `platform-bound-windows` carries a spec
beside tickets none of which are offered. Fixtures are the model crate's own
output (ADR 0004), so a new one is Rust work that would have bought no state the
disk already holds.

**An absence sentence for a map with no spec child.** Rejected: that is #35's
move applied where this ticket did not ask for it. The fog is the one place the
absence is the claim, and it is two absences because the model distinguishes
two. A map still being charted has no destination yet, and there is nothing to
tell it apart from.

## Falsifiability

**Rust.** None. Nothing in `crates/` changed, and that is the claim: every
verdict this decision renders was already taken there —
`ChildKind::of`, `Node::is_startable_work`, `Node::is_counted` — and re-deriving
any of them on the TypeScript side is what this decision refuses.

**TypeScript, the arithmetic.** `tests/route.test.ts` gains *a child that is not
a ticket is not on the work scale*: every spec child is at the destination and
in no section on every fixture; four unclassified children, one per `NodeState`,
all land in the unclassified section; the stray issues are headed last, after
the rows the map cut; a hand-built map that designates a spec draws no *Now*
section at all and still carries `designated: true` on the row; a cut spec is
under *Out of scope* wearing `resolved`; the bucket and the mark never disagree
on any fixture **or on the hand-built cut spec no fixture holds**; and every node
is counted exactly once, section counts plus `destination.length` equalling
`map.nodes.length`, on every fixture there is.

**TypeScript, the picture.** `tests/route-view.test.tsx` gains *a stray issue
fails safe*, *the spec is the destination and not a ticket to take*, *resolved
recedes in salience and never in visibility*, and *the pane draws one picture,
whatever the theme is set to*. Between them: the stray issue's heading, mark and
word; no non-ticket carries `data-frontier` or sits under *Now*, *Next* or
*Frontier*, on every fixture; a map whose frontier names a spec — impossible from
Rust, painted anyway — draws no `data-frontier` anywhere and no *designated* word
on that row; a spec the map cut draws as the struck resolved disc every other cut
row wears and not in the destination region; the destination is drawn between the last section
and the fog with the fog still last; its heading has two children and the region
no `[data-count]`; `spec-composed` heads no *Frontier* at all; a resolved row is
focusable, locatable and countable; no row on any fixture is `hidden` or
`aria-hidden`; the `[data-mark="resolved"]` block contains no `opacity`,
`display`, `visibility` or `content-visibility` and reads only `--s-*` jobs; the
unclassified glyph is `dashed` with no `border-radius` and the destination glyph
is a filled `rotate(`; seven marks and seven distinct shapes; and the DOM is
identical under `data-theme="light"` and `data-theme="dark"` while `Route.tsx`
mentions neither the theme nor `matchMedia`.

**End to end.** `tests/dev-web.test.tsx` boots the awkward map and asserts the
drawn order `[77, 75, 76, 72, 71, 70, 73, 74]`, that #70 sits under
*Unclassified* saying so, that #73 and #74 sit under *Destination*, that the
region prints no count, and that the one `data-frontier` on the pane is still
#75.

## Consequences

**The awkward map's drawn order moved**, deliberately, in three test files at
once: `[77, 70, 73, 74, 75, 76, 72, 71]` became
`[77, 75, 76, 72, 71, 70, 73, 74]`. Intra-section order is still `map.nodes`
order — 75 before 76 and 73 before 74 are the operator's own arrangement — and
grouping is still the only thing that moves a row.

**`spec-composed` now draws no Frontier section at all.** Its only open child is
the spec and its frontier reads `nothingToStart`, so the model's answer and the
pane's picture say the same thing: before this, the pane headed *Frontier 1*
over a row nobody could take.

**The destination heading is `route-destination` and not `route-section-*`.**
Every reader in two test files asks for `h2[id^="route-section-"]` to mean *the
groups that head a count*, and the one group that deliberately heads none must
not answer to it — the same distinction the fog's `route-fog` already keeps.

**`GLYPHS` is `satisfies Record<Mark, string | undefined>`, so a seventh mark
without a class is a compile error — but a mistyped class name is not.** The
CSS-module lookup answers `string | undefined`, so the only thing that catches
`styles.markUnclasified` is *seven marks, each a different shape* asserting that
every glyph's class is non-empty. That assertion is load-bearing.

**Nothing in this pane reads a computed colour, and nothing here claims to.**
jsdom does not apply the CSS module. *Survives a retheme* is enforced as the
token-tier scan, plus the form-not-colour assertions on both new glyph blocks,
plus the identical-DOM-under-both-themes case — which is what the spec means by
making it checkable rather than hoped for, and is not the same as a rendered
check.

**The rendered C5 · Sprung artifact is still not in this repo**, so nothing here
is diffed against it. That was #34's one unmet criterion and it is inherited
unchanged.

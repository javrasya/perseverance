# 15. Platform-bound work is a clause in the one resolver

Status: accepted (2026-08-09), amended by ADR 0019 (2026-09-01) in what feeds
`MapsView::labels_truncated` and in what `Truncation::capped()` covers
Context: [#61 Platform-bound work](https://github.com/javrasya/perseverance/issues/61),
under the spec [#28](https://github.com/javrasya/perseverance/issues/28), whose
implementation decisions pin the rule verbatim: *first in map order among
children that are ticket-classified, open, `blockedBy == 0`, unassigned, and
whose `platform:*` label (if any) matches the current machine. One
implementation, Rust-side.* Everything up to the comma before `platform` was
already built by [#33](https://github.com/javrasya/perseverance/issues/33); this
is the missing clause. It rests on
[ADR 0004](0004-the-webviews-types-are-generated-from-the-model-crate.md) for the
seam and on [ADR 0006](0006-the-route-is-a-grouped-list-not-a-graph.md) for what
the pane may do with what crosses it.

## Context

Some work can only be done where the facts are. A ticket whose evidence lives on
a Mac cannot be started on a Windows machine, and offering it there is not a
minor inaccuracy: *Start Working* launches an agent, and the agent would be
launched at a job the operator has already said cannot be done from here.

That much is uncontroversial. Three things about it were not.

**Where the match happens.** The frontier resolver was, before this ticket, not
a function at all — it was one field initialiser inside `Map::of` delegating to
`Node::is_takeable`, whose doc comment declares itself *the whole of frontier
eligibility, spelled once*. A machine check bolted into the `.find(…)` closure
would have compiled, would have worked, and would have made that sentence false;
and a second copy of the predicate is what the whole seam is arranged against.

**Whether the machine is asked or handed in.** `cfg!(target_os)` inside the
derivation is the smallest possible diff and it takes half of this ticket's
acceptance criteria off any given runner: *the frontier on macOS* and *the
frontier on Windows* become two facts no single machine can check. This crate's
charter is that a JSON fixture drives it.

**What an empty frontier means.** `Map.frontier` was `Option<u64>`, and `None`
was already overloaded across empty map, all closed, all blocked, all claimed
and specs-only. Its own doc comment claimed `None` "is a state with its own
reading and not a zero" — aspirational, since nothing carried *which* reading.
A sixth meaning would have been the one that matters most: a map with work left
on it that this machine cannot start looks, in `Option<u64>`, exactly like a map
that has been worked through, and an operator reading *nothing to start* on it
graduates the fog or composes the spec.

## Decision

**One clause, inside `Node::is_takeable`, and nowhere else.**

```rust
pub fn is_takeable(&self) -> bool {
    self.is_startable_work() && !self.bound_elsewhere
}
```

`bound_elsewhere` is computed at derive time in `Node::of` from the raw labels,
which continue not to cross the seam. What crosses is the verdict, exactly as
`kind` and `state` are verdicts over labels and counts.

**The machine is a parameter, named `Machine`, defined in `crates/model`.**
`Model::of(read, machine)` and `Map::of(graph, machine)`. `Machine::host()`
exists, is a `const fn` with no inputs, and is called nowhere inside the
derivation — only at the two production sites in `crates/app`. Three variants,
because `platform:macos` and `platform:linux` are two labels an operator types.

**The frontier is a three-reading enum.**

```rust
pub enum Frontier { Designated(u64), NotOnThisMachine, NothingToStart }
```

Adjacently tagged, which is `ChildKind`'s existing shape on the wire.

**The label is unprefixed and matched fail-closed.** `platform:` and not
`wayfinder:platform:`, as the spec spells it. Labels present and none naming
this machine — including a value this build does not recognise — hold the ticket
back.

**Case is folded before either half is matched, and the label list is asked for
whole.** These are the two ways *fail-closed* could have been true of the value
and false of everything around it. Matched literally, `Platform:macos` is not a
platform label at all, so `named` stays false and the ticket is offered
everywhere — the prefix fails *open* where the value fails closed, and GitHub
itself treats label names as unique case-insensitively, so the distinction was
never real. And a label list GitHub cut off short reads here exactly like a
ticket that never carried a `platform:` label: the query asks for
`labels(first: 100)` (there is no product cap on labels, unlike sub-issues and
linked issues) and `hasNextPage` is parsed into `Truncation::labels`, which the
chrome prints as a caveat of its own — see below for why it is not the caveat
the other three share.

**Nothing else changes.** The `nodes` collect, all three `Counts` closures and
`NodeState::of` are untouched, so a ticket bound elsewhere still renders, still
counts, and is still `Takeable`. It gains a `not on this machine` tag on its row
and nothing else: no new section, no new state, no empty group.

## Consequences

**Two sentences on screen where there was one.** `readout.ts` keeps
`NO_FRONTIER = "nothing to start"` and gains
`NOTHING_FOR_THIS_MACHINE = "nothing for this machine"`. Neither phrase contains
the other, which is what makes *contains* a real assertion on both.

**The ledger names the map-level move and falls back to the catch-all for the
node.** `before.frontier != after.frontier` already draws
`ClauseKind::FrontierMoved`, and `frontier` is already pre-accounted at
`ledger.rs`'s map residual — so a map moving between `Designated(75)` and
`NotOnThisMachine` draws that clause and hangs nothing extra at the map level.

The node level is not free, and it is worth being exact about why. The machine
never changes between two polls — `Machine::host()` is an argument-free
`const fn` — so in production a frontier only moves to or from
`NotOnThisMachine` because somebody edited a `platform:` label, and that edit
flips `Node::bound_elsewhere`. The node residual accounts for `state` and `kind`
and nothing else, by design: *a field added to `Node` after this file was
written* is exactly what its comment says the catch-all is there to carry. So
the row reads `frontierMoved` **and** `unnamed` for that node. That is the
residual working, not a leak — `ClauseKind` has no word for *bound elsewhere*
and inventing one is a vocabulary change this ticket did not ask for — but it
is a catch-all row, and the rejected alternative below is not faulted for
producing one.

**A second resolver is now writable on the WebView side, and forbidden.**
`kind`, `state` and `boundElsewhere` between them are enough material for
*first takeable ticket not bound elsewhere*. It was already nearly so — `kind`
and `state` both crossed before this ticket — and the structural argument in
`derive.rs`'s module doc is correspondingly weaker. The source-level guard named
below is what replaces it.

**Failing closed hides a typo'd ticket from every machine.** `platform:win`
matches nothing, so the ticket sits on screen, counted, and is never designated
anywhere. This is the deliberate direction — failing open launches an agent on a
machine the operator said the work cannot be done on — and the symptom is
visible and is fixed by editing a label. Case is the exception rather than a
counter-example: `Platform:Win` is still a typo and still held back, but
`Platform:macos` is the *same* label GitHub would refuse to create twice, and
reading it as no label at all is the one spelling mistake that would have failed
open.

**A truncated label list is now a fourth truncation flag, and a second
sentence.** `Truncation` gained `labels`. The other three are tripwires for
pages that cannot exist; this one is for a page that can, and it is the only
truncation whose silent version is unsafe rather than merely incomplete — which
is why it is *not* folded into the caveat the chrome already prints. That
sentence says "GitHub answered with more than one page, which its own limits say
cannot happen", and it is fed by `Truncation::capped()` — the connections that
really are capped — while `labels` crosses beside it as
`MapsView::labels_truncated` and draws its own. Folding them together was the
one combination that misinforms: an operator with a hundred-and-one labels on an
issue would be told an impossible thing had happened, and told nothing about the
consequence. The second sentence names it, because it is the only one of the
four with a consequence to name: *a ticket whose platform label was cut off
reads as one that said nothing about machines, so it can be offered on this one
even though it is bound to another*. `Truncation::any()` still means *anything at
all*, and stays what tests and assertions ask; copy asks the halves.

*Amended by [ADR 0019](0019-a-cached-body-is-keyed-to-the-document-that-produced-it.md)
in two respects.* `Truncation::capped()` counted three connections when this was
written and now counts two: the `maps` leg was never one GitHub caps either, so
it was split out to carry `MapsView::maps_truncated` and a sentence of its own.
And `MapsView::labels_truncated` has a second producer that is not a half of
`Truncation` at all — a cached body whose stamp is not this build's raises it
through `MapsView::unvouched`, because a `pageInfo` a narrower document never
asked for answers clean by never having been asked. The sentence quoted above
was weakened by one word for that reason: it now says some of the labels *may*
not have been read.

**The bare prefix can collide.** A repository running its own `platform:`
taxonomy will hold back a child that also carries a `wayfinder:` label. Bounded
twice: an unclassified child is refused by `is_takeable` anyway, and the failure
mode is the visible one above. `WAYFINDER_PREFIX`'s doc comment, which said
"every label this app classifies by starts here", is amended rather than left
false.

**No schema bump.** `graph_cache` stores the raw GraphQL answer and
`resuming_from` re-derives, so nothing on disk holds a serialised `Model`. The
only serialised bodies are the fixtures, and they regenerate in this commit.

## Alternatives rejected

**`cfg!(target_os)` inside the derivation.** Halves the acceptance criteria off
any one runner and breaks the crate's fixture-driven charter. Every fixture
would derive different bytes on a macOS runner, and
`every_dev_web_fixture_is_this_crate_s_own_output` would fail for a reason with
nothing to do with the model. Guarded against by the explicit `FIXTURE_MACHINE`
constant rather than only by intent.

**Reusing `perseverance_agent::Platform`.** Two variants — `Windows` and `Unix`
— which structurally cannot express `platform:macos` versus `platform:linux`,
and no serde or `ts-rs` derives, so its verdict could not cross the seam. The
model crate is also not a place to put a dependency on the crate about launching
CLIs. Its *shape* is copied and its "a parameter, not a `cfg!`" argument is the
one made here; the type is not imported. The new type is `Machine` and not
`Platform` because `crates/app/src/lib.rs` already imports the other one and
calls it at six sites, and two differently-shaped types under one name in one
file is how the wrong one gets passed.

**A sibling `elsewhere: Vec<u64>` beside `Option<u64>`.** Smaller diff, two
costs: two fields that can disagree (the argument `Counts` already makes against
a fourth number), and a reading the WebView would have to compute from a
conjunction — which `readout.ts` is explicitly forbidden from doing. Not a
third: it would have drawn an `unnamed` ledger row on every platform-caused
change, and so does what was built. The difference is only where the catch-all
hangs — on the map there, on the node here — and that is not an argument for
either.

**Putting the clause in the `.find(…)` closure in `Map::of`.** Splits eligibility
across two expressions, makes `is_takeable`'s doc comment a lie, and needs the
same predicate a second time for the empty-frontier reading anyway.

**`wayfinder:platform:`.** Tidier and consistent with the prefix rule, and a
deviation from the spec's own spelling of a label an operator types. Weighed
against the collision risk above and declined. If a reviewer prefers it, only
`PLATFORM_PREFIX` and the fixture label strings change.

**Matching in TypeScript.** ADR 0006 and the module docs of `views.ts`,
`snapshot.ts` and `readout.ts` all already say the WebView resolves nothing.

## Falsifiability

**Rust.** `crates/model/src/derive.rs` gains a *work bound to a machine*
section: the same recorded answer reads `Frontier::Designated(81)` on macOS and
`Frontier::NotOnThisMachine` on Windows; the Windows reading still has five
nodes and `Counts { tickets: 4, open: 4, specs: 1 }`, identical to the macOS
one, with #80/#81/#82 each `Ticket`, each `Takeable` and each `bound_elsewhere`;
the node order is unchanged and #80 is skipped rather than moved; the Windows
reading is `assert_ne!` against the `NothingToStart` that `spec-composed` and
`empty-map` produce; a blocked ticket labelled *for* this machine does not make
the map read as startable; two platform labels are a union and an unrecognised
one fails closed, both as tables over all three machines; a platform label never
changes what `ChildKind::of` says; a differently-cased prefix and a
differently-cased value both land where an exactly-cased one does, beside the
assertion that `wayfinder:` deliberately does *not* fold; and the one recorded
answer reads *three different* frontiers on the three machines, two of which are
not the runner — an assertion a `cfg!` inside the derivation fails on every
host, which naming the three variants would not have been. Separately,
`every_recorded_answer_but_the_bound_one_derives_the_same_on_every_machine`
walks the fixture *directory* — not a list — and asserts every recorded answer
but `platform-bound.json` derives byte-identically on all three, and that
`platform-bound.json` does not. That is what lets the rest of the suite name one
machine and stop thinking about it. `crates/model/src/read.rs` asserts that a
child whose label page was cut off reports `Truncation::labels` rather than
reading as unlabelled, and that it is *not* `capped()` — the assertion that keeps
the chrome's impossibility sentence honest — beside
`a_page_that_cannot_exist_and_a_label_list_that_ran_long_are_two_readings`.
`crates/app/src/lib.rs` pins the seven-field shape of `MapsView` from this side
and asserts that an answer whose only truncation is a label list crosses as
`labelsTruncated` with `truncated` false.

**The generated artifacts.** `crates/model/src/bindings.rs` derives one recorded
answer twice into `platform-bound-macos.json` and `platform-bound-windows.json`,
byte-compares both, and `the_same_map_reads_differently_on_two_machines` asserts
that `frontier` and the per-node `bound_elsewhere` are the *only* two things
that differ between them — field-exhaustively, by reconstruction rather than by
a chosen field list.

**TypeScript.** `tests/snapshot.test.ts` reads the two sentences apart and
checks that neither contains the other, asserts the Windows fixture still lists
and still counts what it will not offer, and greps every file under `src/` for
the `platform:` prefix — the same structural guard that keeps `blockedBy` and
`assignees` off this side. `tests/route.test.ts`
checks the three held-back rows stay under *Frontier*, stay in its count, and
that no row is designated with no *Now* section drawn. `tests/dev-web.test.tsx`
boots `?map=platform-bound-windows` and reads it off the DOM: three
`[data-elsewhere]` rows, zero `[data-frontier]`, and *nothing for this machine*
in the readout. For the two caveats, `tests/maps.test.ts` asserts that only the
capped sentence claims an impossibility and that the label one names the outcome
(*bound to another*) rather than a count, and `tests/dev-web.test.tsx` renders a
label-truncated list and finds its caveat on screen **without** the impossibility
one beside it — then renders both flags and finds both.

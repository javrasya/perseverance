# 20. The contract is thirteen rules in three tiers, and a tier is a fact about today's design rather than a rank among the rules

Status: accepted (2026-08-31)
Context: [#42 The encoding contract](https://github.com/javrasya/perseverance/issues/42),
under the spec [#28](https://github.com/javrasya/perseverance/issues/28). It
registers the thirteen rules of [#10] and the classification #23 drafted, and it
rests on [ADR 0006](0006-the-route-is-a-grouped-list-not-a-graph.md) for what a
view owes and does not owe, on
[ADR 0010](0010-the-change-ledger-is-a-notification-surface-not-an-archive.md)
for the object rule 7 is about, and on
[ADR 0017](0017-out-of-scope-is-not-progress.md) for the arithmetic rule 6
leans on.

`0020` and not `0019`: the directory holds two ADRs numbered `0010`, so there
are twenty files and `0019` is the highest number in use.

This ADR classifies, and — amended in the same ticket — it records where the
judged tier's declarations live and what the rendered matrix is for. The
browser-side assertions are [#43].

## Context

Thirteen sentences had been agreed and none of them said who keeps it. That is
the gap this ADR closes, and it is not a documentation gap. Written as thirteen
equals, the contract invites exactly one workflow — read all thirteen, by eye,
at review time — which is the workflow that already failed for SMIL and for the
token tiers, twice, in this repo. Some of these rules cannot be violated at all
in the code as it stands. Some can be violated and a test would catch it. Two of
them are claims about what a person takes away from a screen, and no test will
ever catch those.

Flattening those three into one list costs in both directions. A rule nobody
can break, listed beside one only a reviewer can settle, makes the reviewer's
rule look like an oversight — *why is there no test for 11?* And a rule that
genuinely needs a person, listed beside twelve that do not, gets an assertion
written for its floor and then reads as covered, which is worse than reading as
uncovered.

The thing being classified is also not the rule. It is **the current design's
grip on the rule**. Rule 7 is structural because `ViewProps` names `model` and
stops; widen that type and rule 7 becomes an assertion per view, with the
sentence unchanged. So a tier has to be re-derivable, and it has to live where a
test can read it.

## Decision

**One ladder, weakest automation last.**

**Structural** — violation is unexpressible. There is no field, no table, no
prop to write it into. **Asserted** — a test decides, and its verdict is the
whole verdict. **Judged** — some part of the obligation is about what a person
reads, so a person decides.

**Each rule gets exactly one tier: the governing one, which is the weakest
automation the current design allows.** Judged if any part of the obligation
needs a person, else asserted, else structural. #23 recorded four rules as
combinations — "Structural + Asserted", "Asserted + Judged" — and a registry
that kept the pairs would have to answer *what happens when this one goes red*
twice per rule. A rule that is structural and asserted is **asserted**: the
asserted half is the half that can fail, and the structural half is written into
its `check` where it belongs, as the reason the asserted half is small.

**The registry is data, in `src/contract/rules.ts`.** No React, no imports at
all, no runtime app dependency — it is read by tests and by #43's assertions,
both from outside a rendered tree. Every entry carries `id`, `name`, the rule's
text verbatim, `subject`, `tier`, `renderBound` and `check`; judged rules carry
an `assertedFloor` where a machine can settle part of it, and otherwise-asserted
rules a `judgedResidue` where it cannot.

**Three subjects, because the tier follows the subject more often than not.**
`codebase` (what the source can express), `rendering` (what ends up on screen),
`reading` (what a person takes away). The three codebase rules are exactly the
three structural ones, and every one of them needs no rendering — but the
converse does not hold: rule 9's subject is a rendering and its check is a walk
over the stylesheets, so it is asserted and not render-bound. The three reading
rules are exactly the three whose tier is judged with no asserted half worth the
name.

**Deviation is a function of tier, written once.** Structural: no deviation and
no declaration slot — deviating would mean a code change that makes the
violation expressible again. Asserted: a red test is a failure, with no appeal.
Judged: deviation is legitimate and must be declared, in writing, where a reader
can weigh it. `deviationFor(rule)` returns the tier's one route by identity, and
the registry test asserts identity rather than equality — a per-rule copy of the
policy is a place for one rule to quietly acquire an appeal its tier does not
grant.

**`renderBound` says whether the fixture space is needed, and the registry
enumerates nothing else.** No cells, no views, no themes, no fixture names. #43
fans its assertions out over render-bound rules × fixtures × themes ×
reduced-motion, and the fixture space is `src/snapshot/fixtures.ts`. It is a
fact about *where the check runs*, not about the tier: an asserted rule settled
against source text, a schema or a stylesheet is not render-bound, and rule 9 is
the one entry today where the two come apart. A matrix written down here would
be an artifact that goes stale the first time a fixture lands, in a way nothing
fails.

### The thirteen, with the mechanism each tier rests on

| # | Subject | Tier | What holds it |
|---|---------|------|---------------|
| 1 One derived model | codebase | **structural** | Rust ships the model complete; `src/snapshot/model.generated.ts` is ts-rs output nobody edits, so there is no second derivation here to disagree with the first. Viewport, hover and read-marks stay legitimately view-local. |
| 2 Singular frontier | rendering | asserted | One resolver, in Rust, and the fields it decides from do not cross the seam. The asserted half — exactly one node carries the designated encoding, in a rendering — is why the entry is not structural. |
| 3 Fail-safe is not styling | rendering | asserted | Collapse every semantic token to one value at `:root` and assert unclassified is still told apart and still not actionable. The token tiers are the **precondition** for that test, not the test. |
| 4 Absence is never zero | rendering | judged | Floor: over the missing-fog fixture, no `0`, and `—` at form level. Residue: *names itself*. |
| 5 No progress bar | rendering | asserted | The positive restatement, over every fixture: three numerals and nothing continuous between them. |
| 6 Out-of-scope is never progress | rendering | asserted | The model already subtracts a cut ticket from both counts (ADR 0017), so no view can add it back. Asserted half: the reason is text in the document, with no hover and no `title`. |
| 7 The ledger is chrome | codebase | **structural** | `ViewProps` names `model` and stops, so the record — which rides on the `Snapshot` beside `model` — is unwritable by a view. |
| 8 No stored positions | codebase | **structural** | The store's migrations have no position column and no `map_view` table at all: a position has nowhere to be written. |
| 9 Motion is rationed | rendering | asserted | Every animation is a CSS animation, so the ration is enumerable over the stylesheets. See the open obligation below. |
| 10 Hover discloses nothing | reading | judged | Floor: nothing hover-revealed that is not present elsewhere or is not a native `title` recovering clipped text. *Load-bearing* is the judgement. |
| 11 The field is not the label surface | reading | judged | Wholly judged: the claim is about misreading, and misreading has no DOM signature. |
| 12 Still-state equivalent | rendering | judged | Floor: the reduced-motion fixture pair stays told apart. Residue: *carries it alone*. |
| 13 Resolved stays locatable | reading | judged | Floor: in the DOM, non-zero opacity, hit-testable, keyboard-focusable. Residue: salience, not visibility. |

### The two restatements

**Rule 5 is registered positively.** The rule as written names one widget —
*no progress bar* — and there are a hundred ways to build the same claim out of
a div. The registered form is **progress is exactly three numerals, with no
continuous element between them**, because the negative is untestable: a check
that knows the word *bar* passes the first gradient, and every fix to it is a
new synonym rather than a stronger claim. The verbatim sentence stays in the
entry's `text`; the restatement is what a test reads.

**Rule 7 is registered as prop narrowing, not as four per-view assertions.**
Its corollary generalises the mechanism: chrome the contract binds but the view
matrix does not cover is delivered to the chrome layer, and its snapshot field
sits outside the view prop type. One narrowing covers every view there will ever
be and every object delivered that way. Per-view assertions would cover today's
views and today's objects — and the difference shows up on the fifth view, which
nobody would notice was uncovered.

### The three judged residues, and which one was ours to find

Only rules 10 and 11 are judged with no asserted half worth the name. Three
others are asserted work with a named human remainder, and their governing tier
is judged because of it: **4** (*names itself* — no assertion tells a name from
a label that happens to be there), **13** (salience, not visibility — a node can
clear all four DOM floors and still be gone as far as a reader is concerned),
and **12**, which #23 had recorded as plainly Asserted.

**Rule 12 is the departure, and the residue is the word *alone*.** The fixture
pair proves the two renderings still differ with the media query on. It cannot
prove that the difference left standing is *the same distinction the motion was
carrying*, rather than an unrelated one that happens to survive — and rule 12's
own second sentence, "a view whose reduced-motion fallback loses a state has not
satisfied the contract", is a claim about a state being *lost*, which is a
reading. Registering 12 as asserted would have made the fixture-pair diff read
as the whole rule, which is the failure mode this ADR exists to prevent: a floor
mistaken for a ceiling because it is green.

Rule 9 was the other candidate and was rejected as a residue on purpose — see
below.

### Rule 9: killing SMIL is what made the ration enumerable, and the tension is recorded rather than fixed

*Motion is rationed* is a claim about a set nobody could previously enumerate.
SMIL animation lives in markup, ignores `prefers-reduced-motion`, and can be
built at runtime through `createElementNS`; with it in the stack, "every
animation in this app" is not a list anybody can produce. The stack-level ban
(`tests/no-smil.test.ts`) means every animation is a CSS animation, and a CSS
animation is a declaration in a stylesheet. So the ration became **a set that
can be collected**: every `animation` declaration and every keyframes block
under `src/`, each animated selector asserted to land on an element carrying the
running-vs-stale claim. A prohibition taken for the reduced-motion rule turned
out to be what made a different rule checkable at all.

**And the enumeration, run today, returns one animation that the rule does not
cover.** `src/` holds exactly one: `ping`, on `.markClaimed::after` in
`src/views/route/Route.module.css`. It rides on *someone holds this ticket*, not
on running-vs-stale — and `NodeState` is `resolved | blocked | claimed |
takeable`, so rule 9's actual subject is not representable on this side of the
seam at all.

That is registered as a `tension` on the entry: an **open obligation**, whose
settling belongs to whoever writes the assertion in #43. It is deliberately not
three other things. It is not a weakening of the rule. It is not a fix applied
here — changing what the one animation means is a view decision, not a
classification one. And it is not a declared deviation: rule 9 is asserted, an
asserted rule has no deviation route, and filing this under one would invent an
appeal the ladder does not grant.

### The meta-rule

Not one of the thirteen, because it governs what may become one:

> The contract binds meaning, never geometry. Edge geometry is view identity and
> must not be standardised: if a proposed rule would make two views look more
> alike without making either more correct, it does not belong in the contract.

It is why rule 11 carries no measurement. One view arrived at a clearance figure
for its own layout; promoting that number to a rule every view must meet would
be cargo-culting one view's fix. The registry test asserts no pixel figure
appears in `src/contract/rules.ts` at all.

It also settles what The Route owes. ADR 0006 already re-tiered it: **zero drawn
edges is structural under this contract, not a declared deviation.** The Route
draws no edge because a grouped list is what it is, and that is the view's
thesis rather than a fan-out it has yet to deliver. Nothing in the contract asks
a view for an edge, and older ticket text asking The Route for a zero-edges
declaration is stale.

### Where a judged rule's answer is written, and what the matrix is for

The tier says a person keeps the rule. The only artifact a person leaves is
prose, so **every judged rule gets a written declaration per view**, in
`docs/contract/declarations/<view>.md` — one section per judged rule, stating
what the view actually does, explicitly free to say it does not comply. The
declaration is a claim about a view's answer to a rule, so **it is written at
view-design time and not per commit**: the round that changes the layout is the
round that re-reads it, and the gates only make sure it exists.

**Presence is asserted; content is not.** `tests/contract-declarations.test.ts`
goes red on a missing view file, a missing section and a stubbed one, and on
nothing else — grading the answer would be the assertion the tier already said
cannot exist. **No checkboxes**: a box invites ticking, a ticked box says
nothing about the view, and by the third view it is a rubber stamp, so a
checkbox anywhere in a declaration is itself a failure. The one piece of
structure the format has is a paragraph opening `Deviation:`, which is what the
worklist collects verbatim — and because it is the only structure, **reaching for
it and missing is red too**: `**Deviation:**`, a list item, an em dash where the
colon goes, or the sentence buried mid-paragraph all parse as plain statement
prose, and a deviation nothing lifts is the carve-out the declaration exists not
to be.

**A declared deviation is a worklist item, never a carve-out.** It is fog on the
contract: something the view owes, rendered where it can be scheduled and worked
off. Structural and asserted rules have no declaration slot and no deviation
route at all, and the tests assert that too — a declaration filed under one
would be an appeal the ladder does not grant.

**Three gates, each keyed to what changed.** Adding a state ships one fixture:
every `NodeState` value must appear on a node of some checked-in fixture, so the
commit that names a fifth state is red until the fixture exercising it lands.
The enumeration is borrowed from `STATE_NAMES`, the one `Record<NodeState, _>`
in `src/`, because a union has no runtime form and a list of state names written
beside it is the parallel list that stays one state behind. Around that gate sit
two cost reductions, so the fixture the gate demands is cheap to add: the fixture
space (fixtures × two themes × reduced-motion) is derived from `FIXTURE_NAMES`,
and no second enumeration of fixture names may exist anywhere for a new one to
have to be added to. Adding a view brings the fixture space and
a declaration for every judged rule, and the gate is driven off `VIEWS`, so the
commit that registers a second view is the commit that goes red. Adding a rule
requires a tier, and a rule landing in *judged* retro-fits a section onto every
existing view — the same assertion, driven from the rule side, with the count
pinned at thirteen so a fourteenth is a deliberate edit.

**The matrix is the instrument and gates nothing.** `docs/contract/matrix.md`,
regenerated from the registry and the declarations by `npm run contract:matrix`,
carries one row per rule — tier, subject, where it is enforced, each view's
declaration status — plus the worklist and the open obligations that have no
deviation route. **Rows are rules, never rule × rendered state**: the unit of
conformance is the rule, and a grid of cells is an artifact that goes stale in a
way nothing fails. The only thing any test asserts about it is that it is
current. A test that read a cell for conformance would make the file the
contract, and a rule would then be kept by whoever last regenerated it.

## Alternatives rejected

**Keeping the combined tiers ("Structural + Asserted") as pairs.** Rejected: a
tier exists to answer *what happens when this fails*, and a pair answers it
twice. The structural half of rules 2 and 6 is not lost — it is written into the
`check` as the reason the asserted half is as small as it is.

**Tiering by how important the rule is.** Rejected, and this is the tempting
one. Rule 1 is the most important sentence in the contract and it is structural,
which under an importance reading would make structural the top tier and judged
the bottom — and then a judged rule reads as a rule that did not make the cut.
The ladder is about *grip*, not weight: a tier is a fact about the current
design, and rule 7 stops being structural the day `ViewProps` widens.

**Writing the view × rule matrix into the registry.** Rejected: it would name
cells, and the cells are a product of two sets that change independently.
`renderBound` is the whole of what an entry needs to say about the fixture space,
and the fan-out belongs to the assertion.

**Deviation notes per rule.** Rejected: the policy is a function of the tier and
nothing else, so thirteen copies of it would be thirteen chances to disagree. The
one thing worth saying per rule — what a machine can and cannot settle — is said
by `assertedFloor` and `judgedResidue`, which are about the check rather than
about the appeal.

**Giving the asserted rules a declaration slot "for completeness".** Rejected:
an appeal route that exists is an appeal route that gets used. A red assertion is
a failure; if the assertion is wrong, the fix is the assertion or the rule, in
review, and not a note beside a shipped violation.

## Consequences

**The registry is now the contract's readable form, and `tests/contract-registry.test.ts`
holds it to being one.** Thirteen entries, ids 1–13, every entry with a subject,
a tier and a mechanism; rules 1, 7 and 8 structural with no declaration slot;
every structural rule non-render-bound, with rule 9 asserted and non-render-bound
too because its check is a stylesheet walk; rule 5 registered positively.

**The structural entries are checked against the tree, not just written down.**
The registry names a `mechanismPath` for each and the test reads it: `ViewProps`
still names `model` and mentions neither the snapshot nor the record (via
`viewPropsFields` in `tests/support/checks.ts`, proved against a widened
declaration as known-bad input, and the same shape `tests/views.test.ts` asserts
from the rule's own side); the store's migrations still declare no position
column and no `map_view` table; the model still arrives as ts-rs output. A
pointer nobody re-reads is a claim about the day it was written, and the day rule
8's mechanism learns Deep Field's exception is exactly the day rule 8's entry
needs re-reading — so that line goes red rather than staying quietly true.

**Nine rules are registered with no check that runs.** Rules 2, 3, 4, 5, 6, 10,
11, 12 and 13 have no automated check in this repo today; the registry says what
the check *is*, and #43 makes it run. That is the honest state and it is now
visible in one file rather than absent from thirteen sentences.

**Two rules can move tier without their text changing**, and that is the design
working. Widen `ViewProps` and rule 7 falls from structural to asserted. Land
`map_view` with Deep Field's key and rule 8's entry has to say which key. Both
are code changes that go red first.

[#10]: https://github.com/javrasya/perseverance/issues/10
[#23]: https://github.com/javrasya/perseverance/issues/23
[#43]: https://github.com/javrasya/perseverance/issues/43

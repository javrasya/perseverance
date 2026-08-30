# 17. Out of scope is not progress

Status: accepted (2026-08-09)
Context: [#36 Out-of-scope is not progress](https://github.com/javrasya/perseverance/issues/36),
under the spec [#28](https://github.com/javrasya/perseverance/issues/28). It
rests on [ADR 0004](0004-the-webviews-types-are-generated-from-the-model-crate.md)
for the generated seam, on
[ADR 0006](0006-the-route-is-a-grouped-list-not-a-graph.md) for what the pane
may do with what crosses it, on
[ADR 0010](0010-the-change-ledger-is-a-notification-surface-not-an-archive.md)
for the clause vocabulary whose last producerless word this ticket retires, and
on [ADR 0016](0016-the-fog-is-a-named-region-with-two-absences.md) for the
section-boundary parse it reuses.

`0017` and not `0016`: the directory holds two ADRs numbered `0010`, so `0016`
is the highest number in use.

## Context

`CLOSED` is GitHub's one word for two different events. A ticket can close
because the decision was **made**, and it can close because the decision was
**cut** — the branch was walked far enough to see it was the wrong branch, and
the work will not be done. The Route counted both, so a map that dropped four
tickets reported four decisions made, and *Resolved* was the number an operator
would have read as progress.

Three things about fixing that were not obvious.

**Where the cut is written.** GitHub has a field for it: `stateReason` is
`COMPLETED` or `NOT_PLANNED`, and `crates/github/src/map-read.graphql` already
selects it — `wire::Child` simply drops it on the floor. But `NOT_PLANNED` says
only that a ticket was not completed. It carries no words, and a cut whose
reason nobody can read is the exact thing this decoration exists to make
visible. The reason lives where the operator wrote it, which is the map
document.

**What a cut is to the rest of the model.** It looks like a fifth `NodeState`
until you ask what would read it. Everything that reads a state — grouping,
focus, the mark, the frontier resolver, `Phase::of` — wants *resolved* out of a
cut ticket, because the ticket really is closed. A fifth variant would turn
every one of those matches into a question about which of the two closings this
is, in exchange for a fact none of them needs.

**What a cut is to the arithmetic.** `Counts` is three numbers and *resolved* is
`tickets - open`, deliberately, because a fourth number is a fourth thing that
can disagree with the other three. Any answer that put out-of-scope on screen as
a number of its own would have to defend that trade a second time.

## Decision

**A cut is read from the map document, keyed on issue links, and never on
prose.**

`## Out of scope` is bounded by the same rule `## Not yet specified` is. ADR
0016's line scan was lifted out of `Fog::of` into `section_under(body, heading)`
— the heading line, up to the next ATX heading, blank lines moved past at both
ends — and both callers now read one boundary out of one document. `Cuts::of`
takes the top-level bullets of that section and, for each, every `#N` it names.

The guard is fail-safe: a `#` whose preceding character is alphanumeric, `_`,
`-` or `/` is refused, so `owner/other#107` cuts nothing on this map. That is
the reading `wire::Blocker::belongs_to` already takes for edges — a reference
this crate cannot be sure is local is not one — and it fails towards *nothing
was cut*, which leaves a ticket counted and on screen where an operator can see
it.

The reason is the bullet line **verbatim**, with its marker and the one space
after it removed, then `trim_end`. That is the whole of the editing. First
mention of a number wins.

**The cut is a decoration on the node, not a fifth state.**

```rust
pub enum Cut {
    InScope,
    FromScope(String),
}
```

Adjacently tagged, a payload on one variant and none on the other, which is
`Fog`'s and `Frontier`'s existing shape on the wire. It rides *beside*
`NodeState`, which stays four, and beside `Mark`, which stays five.

**`Cut::FromScope` is only ever assigned to a child GitHub already calls
resolved.** A link in that section pointing at an open issue leaves the node in
scope, silently. API state wins.

**The exclusion leaves `tickets` as well as `open`.** One private predicate,
`Node::is_counted`, filters both:

```rust
fn is_counted(&self) -> bool {
    self.kind.is_ticket() && matches!(self.cut, Cut::InScope)
}
```

So a cut ticket is subtracted from the denominator rather than added as a number
beside it, `tickets - open` goes on meaning decisions made, and `Counts` is
still three fields.

**On the Route it is a fifth section, and its count is the rows it heads.**
`SectionName` gains `"outOfScope"` last, appended after *Resolved* and inside
the same empty-section filter every other group obeys. `RouteSection.count` is
still `rows.length` — so *Resolved* heads the decisions made by **holding fewer
rows**, not by subtracting anything from a number it also prints. That is the
whole of how the resolved count excludes a cut, and it is checkable against the
screen by counting.

**The reason is visible text, and the plate is drawn double-width to hold it.**
`RouteRow.cut: string | null` carries the bullet whole; the row renders it as
its last child, and `Mark` stays `"resolved"` with a struck bar composed onto
the disc. No `title`, no `aria-describedby`, nothing a pointer has to be held
still to reveal. The room comes from making the plate a measured unit:
`--c-node-plate` caps every row, and a row carrying a reason is
`calc(var(--c-node-plate) * 2)` with the reason a flex item one plate wide.

## Consequences

**`SCHEMA_VERSION` moves 3 → 4.** `Node` gained a required member with no serde
default, so a version-three body no longer deserialises at all — the condition
the constant exists to refuse rather than guess at. ADR 0004's prediction held a
third time: `crates/model/fixtures/no-map-open.json` is `include_str!`d rather
than generated and moved by hand, and the sixteen generated fixtures moved in
one keystroke.

**`ClauseKind::CutFromScope` has a producer, and it was the last word without
one.** It is keyed on the decoration arriving — `(Cut::InScope,
Cut::FromScope(_))` — and drawn **instead of** the resolution rather than beside
it, because a ticket that closed as cut arrived as one fact and two rows would
report progress that is the opposite of what happened. It is one-directional for
the reason `map closed` is: the node residual pre-accounts `cut` only where the
clause fired, so a cut taken back and a reason reworded in place both fall
through to the catch-all, which is where a change nothing can name belongs. The
clause kept the seat #36 reserved for it, between `Resolved` and `Reopened`, so
landing the producer shifted no precedence.

**Every row is now capped at one plate while the section headings still span the
pane.** That is the first place in this view where a row is narrower than its
heading, and it is what gives *double-width* a referent: without a cap there is
no first plate for the second one to be measured against.

**A cut is invisible to everything that reads a state.** Grouping, focus, the
mark and the frontier resolver were left untouched, which is the decoration's
whole point: they go on seeing a resolved ticket, because that is what it is.
The two readers that learned a new word are the arithmetic and the section list.
`Phase::of` is not a third — it reads the counts and nothing else, so it moved
only where the counts did, and a map whose every ticket was cut reads
`Unstarted` rather than finished. Nothing on that map was done, and the second
rung is reached honestly.

**A link in `## Out of scope` pointing at an open issue does nothing at all, and
says nothing about it.** Accepted, and stated rather than left implicit: the
symptom is a ticket the operator believes is cut that is still counted and still
on screen, and the fix is a document edit or a close on GitHub.

**A `#` at column zero inside a fenced code block ends the section**, exactly as
ADR 0016 already accepted for the fog, and now for one more reader of the same
scan.

## Alternatives rejected

**Matching the prose of the bullet.** Rejected: a bullet gets reworded and a
link does not. A sentence-matching parse loses the cut the first time the
operator tightens their own wording, and it would have to decide what an
operator meant — in a section this crate reads structurally and never
semantically.

**A fourth count.** Rejected: *resolved* is `tickets - open` precisely so that
there is no fourth number to disagree with the other three, and a cut counted as
its own field would reinstate the thing that rule exists to prevent. Counting a
cut as resolved reports progress for work nobody did; counting it as open leaves
a map that can never finish. Leaving both is the only reading where the ratio
still means what it says.

**A fifth `NodeState`.** Rejected: every existing reader of a state wants
*resolved* out of a cut ticket, so the variant would buy nothing and cost a new
question in every match — including the frontier resolver, which is the one
place in this app allowed to decide what to work on next.

**The reason behind a hover, or a `title`.** Rejected: a branch that stops must
show why it stopped, and *show* is the word. A reason reachable only by hovering
is absent from a screenshot, from a page search, from a reader and from a
keyboard, which makes it a reason nobody reads.

**Truncating the reason to fit the existing plate.** Rejected, and this is where
the decision is layout rather than styling: the reason takes a plate's worth of
room, so the plate takes two. Ellipsing it would put the operator's own sentence
on screen with its end cut off, which is a hover by another name — the missing
half is still somewhere else.

**Warning about a link that points at an open issue.** Rejected: a warning here
would be this app telling an operator their own document is wrong about a ticket
whose state is on the same screen. API state wins because it is the fact, and
the operator's next edit settles it either way. There is no warning UI anywhere
in this pane and this ticket did not add the first one.

**`stateReason`.** Rejected even though the query already selects it and the
field is one line of `wire::Child` away. `NOT_PLANNED` distinguishes a cut from
a completion and carries no reason at all, so it answers the smaller half of the
question and leaves the half this ticket exists for — the words — with nowhere
to come from. Reading it *as well* would mean two sources for one fact and a
rule for what to do when they disagree; reading only the document means the
place the reason is written is the place the cut is read.

## Falsifiability

**Rust.** `crates/model/src/derive.rs` gains an *out of scope* section:
`a_closed_ticket_the_document_cut_leaves_the_tickets_as_well_as_the_open` pins
the arithmetic, `a_cut_is_a_decoration_on_a_resolved_node_rather_than_a_fifth_state`
pins the shape, `a_link_at_an_open_ticket_decorates_nothing_and_warns_nobody`
pins the refusal, `a_cross_repository_reference_cuts_nothing_on_this_map` and
`what_counts_as_an_issue_reference_is_a_hash_with_nothing_attached_in_front` pin
the guard, `the_reason_is_the_bullet_line_verbatim` pins the editing that does
not happen, and `the_fog_and_the_cut_read_one_boundary_rule_out_of_one_document`
holds the two callers of `section_under` to one boundary.
`crates/model/src/ledger.rs` asserts that a cut draws `cutFromScope` and not
`resolved`, that a cut taken back and a reason reworded reach the catch-all, and
that the clause still sorts between `Resolved` and `Reopened`.

**The generated artifacts.** `crates/model/src/bindings.rs` names
`out-of-scope`, so `the_fixture_directory_holds_exactly_the_cases_this_module_names`
and `every_dev_web_fixture_is_this_crate_s_own_output` hold it to being the
model's own output, and `dev:web` reaches it at `/?map=out-of-scope`. One
recorded answer carries all five acceptance criteria at once: a cut ticket with
a reason, a plainly resolved one beside it, a cross-repository link that cuts
nothing, and a link at an open issue that changes nothing.

**TypeScript.** `tests/route.test.ts` asserts the five section names and their
headings in order, that *Resolved* holds the done ticket alone and *Out of
scope* the cut one alone, that every count is its rows' length, that the cut row
keeps state and mark `resolved`, that the bullet arrives verbatim, and that a
map which cut nothing draws no fifth section. `tests/route-view.test.tsx`
asserts the reason is in the document as text, that the pane carries no `title`
and no described-by in the DOM *or in the source*, that `data-plate="double"` is
on the row with a reason and only there, that the second plate is
`calc(var(--c-node-plate) * 2)` against the first rather than a second literal,
and that the cut glyph is the resolved disc with something added rather than a
sixth mark standing in its place.

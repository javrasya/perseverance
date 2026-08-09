# 16. The fog is a named region with two absences

Status: accepted (2026-08-09)
Context: [#35 Fog as a named region](https://github.com/javrasya/perseverance/issues/35),
under the spec [#28](https://github.com/javrasya/perseverance/issues/28). It
rests on [ADR 0004](0004-the-webviews-types-are-generated-from-the-model-crate.md)
for the seam, on [ADR 0006](0006-the-route-is-a-grouped-list-not-a-graph.md) for
what the pane may do with what crosses it, and on
[ADR 0010](0010-the-change-ledger-is-a-notification-surface-not-an-archive.md)
for the clause vocabulary whose one remaining producerless word this ticket
retires.

`0016` and not `0015`: the directory holds two ADRs numbered `0010`, so `0015`
is the highest number in use.

## Context

A map is a single GitHub issue labelled `wayfinder:map`, "holding the Notes /
Decisions-so-far / Fog body" — `docs/agents/issue-tracker.md`. Two of those
three had never been read by anything. The shipped query already asked GitHub
for `body`; `wire::Issue` had no field for it, so serde dropped it silently on
the way in, and no recorded answer in `crates/model/fixtures/` carried one.

The fog is the part of the map that is worth reading, and it is the part with no
identity. Every other element on the Route has a number, a title and a URL. The
fog has none of the three, because it is precisely the work nobody has cut a
ticket for yet. That is what makes it easy to render as a figure in a margin,
and what makes a figure in a margin the wrong rendering: a number nobody can
click is a smudge.

Three things about reading it were not obvious.

**Whether anything interprets the text.** "Fog" invites summarisation, and the
acceptance criteria refuse it twice over — *parsed structurally, never
semantically*, *no semantic interpretation*. Read against a crate whose charter
is a dependency tree with nothing in it, that also settles the smaller question:
a markdown crate would be a parser deciding what a document means where a line
scan is the whole of what is needed.

**Which side reads it.** `read.rs` carries what the answer *said*; `derive.rs`
carries what we *concluded*, and its module doc says so. A heading match is a
conclusion. So is a bullet count.

**What a missing heading is.** `0` is the answer that destroys the fact. A map
whose body never names the fog has not declared that everything is charted; it
has said nothing at all, and *nobody surveyed* and *surveyed and found nothing*
are different things to know about the same map.

## Decision

**The fog is parsed in Rust, structurally, and the WebView receives it already
bounded and already counted.**

`Fog::of(body)` in `crates/model/src/derive.rs` is a line scan and nothing else:
find the one line that equals `## Not yet specified` (trailing spaces trimmed,
case and everything else exact), take the lines up to the next ATX heading,
count the ones that open a bullet at column zero, and rejoin the rest with
`\n`. No markdown grammar, no dependency, no word read.

The body crosses `read.rs` raw — `wire::Issue` and `MapGraph` each gained a
`body` — which is the same split the labels take: they cross as `Vec<String>`
and are classified one file over.

**The absence is a variant and never a sentinel.**

```rust
pub enum Fog {
    Unsurveyed,
    Surveyed(FogRegion),
}

pub struct FogRegion { pub count: usize, pub text: String }
```

The shape `Frontier` established one ticket earlier, and for its stated reason:
"the absence has always been a state with its own reading and not a zero".
`Unsurveyed` has no payload for a zero to live in, so the two readings are
unrepresentable as one rather than merely documented as two.

Both members, and never only the count. The words are the whole of what makes
the region somewhere to go.

**Only the section reaches the model, never the body it was cut from.** Model
equality is the diff unit. A `Map` carrying the whole document would draw a
ledger row for every keystroke under `## Notes`.

**The fog is a region beside the sections, not a section.** `RouteSection.count`
is documented as "always `rows.length`. A count that is not the rows it heads is
a lie", and the fog has no rows. So `Route` grew a sibling member,
`{ sections, fog }`, and the region is drawn on every map — including a map with
nothing on it, because there the absence is the fact.

**The two readings differ in form and not in a glyph.** The region carries
`data-fog="unsurveyed" | "surveyed"`; the count's slot holds a *different
element* on each (`<span data-unsurveyed>—</span>` in the ui face against
`<span data-count>0</span>` in mono with tabular numerals — the `font-family`
split `Ledger.module.css` already uses so that *first open* and a real count do
not read as the same claim); and the region has a *different number of children*
— one when nobody surveyed, always two when somebody did.

## Consequences

**`SCHEMA_VERSION` moves 2 → 3.** `Map` gained a required member with no serde
default, so a version-two body no longer deserialises at all — which is the
condition the constant exists to refuse rather than guess at. One
hand-maintained file moved with it by hand, exactly as ADR 0004 predicted:
`crates/model/fixtures/no-map-open.json` is `include_str!`d rather than
generated. The other sixteen regenerated in one keystroke.

**`ClauseKind::FogChanged` has a producer.** It is keyed on `Map::fog` and
listed in `clauses_of`'s map-level residual. The residual line is the half that
is easy to miss and does the work: without it every fog change would have drawn
`Unnamed`, which is the state this ticket found the vocabulary in. ADR 0010's
two "no producer" paragraphs are down to one, and `cutFromScope` (#36) is what
is left.

**A `#` at column zero inside a fenced code block ends the region.** Accepted,
and stated rather than left implicit: fence tracking is the first step toward a
markdown grammar in the crate whose defining property is not having one. The
symptom is visible — the section on screen stops early — and the fix is a
document edit.

**The em dash reaches a fourth file.** `environment.ts` and `folder.ts` each
declare their own `NOTHING_YET = "—"`; `route.ts` now declares
`NOBODY_SURVEYED`. One dash for one meaning across the window, declared locally
as its neighbours are.

**Three new fixtures, and the recorded answers behind them are the first in the
repository with a body.** They are swept automatically by
`every_recorded_answer_but_the_bound_one_derives_the_same_on_every_machine`,
which walks the directory rather than a list, and none of them carries a
`platform:` label, so all three derive identically on every machine.

## Alternatives rejected

**A markdown crate in `perseverance-model`.** The whole of what is needed is a
heading match and a bullet count, and a parser library in the crate whose
defining property is having almost no dependencies is a poor trade — the
argument `rfc3339` already made against a date library, and the reason
`scripts/check-model-purity.mjs` exists. It would also have brought a *grammar*:
reference links, setext headings, lazy continuation, and a hundred decisions
about what a line means, in a place the ticket says nothing may mean anything.

**Parsing in TypeScript.** It puts a parser in the render path and gives the two
sides two accounts of where the fog stops. ADR 0006 and the module docs of
`views.ts`, `snapshot.ts` and `readout.ts` all already say the WebView resolves
nothing.

**The whole body on `Map`.** One field instead of two types, and a ledger row on
every keystroke in an unrelated section of the document.

**`Option<usize>`.** The count is the smaller half of what the region carries,
so a shape that carries only the count is wrong before the absence is even
considered — and `None` beside `Some(0)` is one refactor away from being
flattened by a reader reaching for a number.

**A fifth `SectionName`.** It would have to carry a `count`, and `RouteSection`
guarantees that count is `rows.length`. A fog section would be a count nothing
on screen could check, which is the class of failure the whole pane is arranged
against.

**Hiding the region when nobody surveyed.** It is the rule for every other group
— a group is a claim that there is something in it — and it is exactly backwards
here. A region that vanishes when nobody surveyed is the smudge this ticket
exists to prevent.

## Falsifiability

**Rust.** `crates/model/src/derive.rs` gains a *fog* section:
`a_map_whose_body_never_names_the_fog_is_unsurveyed_rather_than_empty` against a
fixture whose body is written and whose fog heading is not (with a bullet under
*Decisions so far*, so a scan that counted bullets without bounding them would
report one and there are none); `a_map_with_no_body_at_all_is_unsurveyed`;
`a_fog_heading_with_nothing_under_it_is_a_survey_that_found_nothing`, asserting
the exact `Surveyed(FogRegion { count: 0, text: "" })` value;
`the_fog_is_bounded_by_the_next_heading_and_counts_only_its_own_bullets`, which
pins `count == 3` on a section holding three top-level bullets, one indented one
and a fourth bullet past the boundary;
`the_fog_section_crosses_verbatim_down_to_the_blank_line_inside_it`, character
for character including the two-space indent and the interior blank line; and
`nothing_of_the_map_body_but_the_fog_reaches_the_derived_model`, which greps the
serialised model for the Notes and the Decisions and finds neither.
`crates/model/src/read.rs` asserts the body crosses that parse whole and unread,
and that an answer without one reads as empty rather than as a refusal.
`crates/model/src/ledger.rs` asserts a moved fog draws exactly `fogChanged` with
no numbers and a count of one, and that two answers differing only under
`## Notes` are one model and draw no row at all. `npm run check:model-purity`
proves no parser dependency was added.

**The generated artifacts.** `crates/model/src/bindings.rs` names
`fog-unsurveyed`, `fog-empty` and `fog-charted`, so
`the_fixture_directory_holds_exactly_the_cases_this_module_names` and
`every_dev_web_fixture_is_this_crate_s_own_output` hold all three to being the
model's own output, and `dev:web` reaches each at `/?map=<slug>`.

**TypeScript.** `tests/route.test.ts` asserts the model's reading is carried
through untouched, that a survey which found nothing is not equal to a map
nobody surveyed, that no section is ever named `fog` and every section count is
still its rows' length, and that the region survives a map the arithmetic gives
no section at all. `tests/route-view.test.tsx` asserts the region names itself on
all three readings; that *nobody surveyed* and *surveyed and found nothing*
differ by which element sits in the count's slot and by how many children the
region has, rather than by a character; that the section reaches the DOM byte for
byte with its indentation and its blank line; that the count on screen is the
model's and not a recount of the lines; and that no edge is drawn in any of the
three fog states. `tests/dev-web.test.tsx` boots all three fixtures and reads the
distinction off a mounted app, including that the indented line is on screen and
is not one of the three, and that the section stopped where the next heading did.

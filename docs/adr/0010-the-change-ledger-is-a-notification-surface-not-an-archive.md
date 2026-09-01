# 10. The change ledger is a notification surface, not an archive

Status: accepted (2026-08-07), amended by ADR 0019 (2026-08-30) in the one
place it refuses a schema bump
Context: [#41 The change ledger](https://github.com/javrasya/perseverance/issues/41),
under the spec [#28](https://github.com/javrasya/perseverance/issues/28), which
asks for a record of what moved between two looks and for that record to be
readable without interrupting anybody. ADR 0004 settled that derivation is
Rust's and the WebView is paint, which decides which side stamps what; ADR 0006
settled that the Route draws no edges, which is why *what changed* had nowhere
to live inside a view; ADR 0009 settled the failure taxonomy, which is what a
poll that did not land carries instead of a row.

## Context

Two questions were open, and they pull in opposite directions.

**Where does the record come from?** GitHub keeps a history — timelines, events,
closed-at timestamps — and it is more complete than anything this app could
assemble. A table of our own would be a second copy of it, written from
whichever polls happened to land, with gaps wherever the app was closed and no
way to tell a gap from a quiet week. It would also be the first thing in this
app with an unbounded on-disk size and a migration to write.

**How loud is it?** *Something changed* is exactly the shape of a toast, and a
toast is the one interruption this app has spent three ADRs refusing. But a
change nobody sees is a change that did not get reported, and an operator who
has to re-read the whole Route to find out what moved has been given nothing.

Underneath both sat a smaller question with a sharper edge. The record's only
possible input is the difference between two derived models, and `Model` is
what every view is handed. A field on `Model` holding the record would be a
field inside the very value the record is computed by comparing — so every tick
would differ from the last on the strength of its own output — and it would be
in reach of every view, which is where a second, worse account of the same
changes gets drawn.

## Decision

**The record is a notification surface. It lives for the session, and GitHub
keeps the history.**

**The input is the model diff, and `Model` equality is the diff unit.**
`changed_from` is literally `self.model != previous.model`. Nothing else feeds
the record: run state is not in `Model` and belongs to the rack, so the boundary
is structural rather than something the differ has to remember to skip.

**It hangs off `Snapshot` beside `model`, and never inside it.** Two
independent reasons, and either alone would be enough. Inside `Model`, the
record is part of the comparison that produces it. And `Model` is precisely
what a view is given — so a field there is a field a view can draw, which is the
opposite of what #28 asks for. Beside it, the exclusion needs no rule:
`ViewProps` in `src/views/views.ts` names `model`, `selected` and `onSelect`,
and a view has nothing to render the record *from*. It is the same mechanism
that keeps `blockedBy` and `assignees` out of the WebView — the frontier is
resolved in Rust and the fields it is resolved from never cross, so a second
resolver on this side has no input rather than a prohibition. Two tests hold the
shape: the prop type declares those three fields and no fourth, and no file
under `src/views/` other than the contract itself has a word for the record.

**The tick is the entry; the change is a clause.** One row per differing poll,
clauses inside it in a fixed precedence — issue-level, edges, claims, derived,
catch-all — and same-kind changes collapse into one clause with a count and the
numbers. The precedence is `ClauseKind`'s own declaration order with `Ord`
derived from it, so no sort site can spell it wrong and there is no second
ordering on the frontend to drift from it.

**The vocabulary is backstopped by a catch-all, and that is the load-bearing
part.** A curated word list is the rejected field shortlist one layer up: it
answers well for the fields somebody thought of and silently answers *nothing
happened* for the rest. So `unnamed` exists, it reads as *changed*, and a
differing tick **always** draws a row — asserted by a `debug_assert` in the
differ rather than left to the shape of the match. A field added later is
carried in free as an unnamed change. Two words were declared here with no
producer behind them so that the precedence would not shift when their tickets
landed, and both have one now: #35 keyed `fogChanged` on `Map::fog` and listed
it in the map-level residual, and #36 keyed `cutFromScope` on `Node::cut` — see
[ADR 0017](0017-out-of-scope-is-not-progress.md). Every word in the vocabulary
is produced by something, and the seats they were holding never moved.

**And the catch-all is a residual rather than an `else`.** Both the node-level
and the map-level one are taken by rebuilding the value the named clauses fully
account for and comparing that against what actually arrived, so a change with a
word for it never consumes the rest of the thing it landed on — a ticket renamed
on its way to closed draws both `resolved` and the catch-all. What that costs is
that nothing may be pre-accounted on a guess: **the node list is reconstructed,
not handed over**, because `Vec<Node>` equality is order-sensitive and map order
is the operator's own drag order. A reorder is a change with no word for it, and
one that draws `frontierMoved` all by itself — the frontier being the first
takeable node in map order — so pre-accounting the arrived list would have
reported the move and silently lost the drag that caused it.

**No causal attribution, ever.** Two resolutions arriving in one diff make
*which one unblocked this* a guess dressed as a record; the model carries no
edge from one change to another, so nothing could settle such a guess even if
it wanted to. A row asserts only that these were true together when we looked.
The rule is enforced twice, because a source scan and a rendered string are two
different claims: no causal connective appears in the three files the record is
written across, and none appears in the vocabulary's *values* or in any string
the describe functions build out of them.

**`announce` is stamped in Rust; the frontend holds only a read marker.**
Liveness has to enter the render path — the numeral counts unread *announceable*
clauses — and the way it is contained is that the whole decision happens once,
in one function, over one finished entry. Not announceable: the catch-all, and a
claim this harness originated plus the frontier move that follows it, which is
the one change an operator can predict. A mixed clause announces, because it
contains a claim you could not predict and announcing is the safe direction. The
frontend's entire share is `readThrough: number` and a sum over
`announce === true`. After a restart everything announces, which is correct
anyway. The record announces by a numeral changing and never by motion or by
taking focus — a test strips the comments from the stylesheet and refuses
`transition`, `animation` and `@keyframes` outright.

**No store of its own.** A session-lifetime `VecDeque` ring, `RING_CAPACITY =
200` per map, shipped whole on every snapshot; plus a cold-start diff against
the `graph_cache` row the poller already writes, producing one *while you were
away* row for the whole gap. No new table, no migration, no
`STORE_SCHEMA_VERSION` bump. An append-only table was refused as a second, less
accurate copy of a history GitHub already keeps. *(Amended: #82 takes the bump.
The `graph_cache` row this diff reads now carries the stamp of the document that
produced it, which is a column on the existing row and not a table beside it —
so the migration and the version-3 bump are the cold-start baseline getting
harder to misread, not the archive this ADR refused. ADR 0019.)*

**Absence is never zero, in three places.** No cache row reads *first open*
rather than `0 changes`; a failed poll draws no row at all and the stale stamp
carries the health; only a zero after a poll that landed with something to
compare against is a number. The first of those is the reason
`ChangeLog::observed` is the only mutator and takes a `&Model` — there is no
method a failed poll could call.

**The stamp that carries the health stops calling itself a live read.**
`Snapshot::aged` downgrades `Source::Github` to `Source::Cache`, because a poll
that did not land leaves the copy the last read left behind and nothing newer
has arrived. Without it the stale stamp printed a second, false clause on every
failed poll: `github` beside a failure is the map list's sentence for a read
that *landed* and could not be stored, so a revoked token rendered as a
cache-write problem. The `dev:web` fixtures for the four conditions are
generated through that path rather than stamped `cache` by hand, so a
regression is a fixture that no longer matches.

**`SCHEMA_VERSION` moves 1 → 2**, because the wire shape changed. The field is
required rather than `#[serde(default)]`: no snapshot is persisted anywhere, the
fixtures are regenerated in-tree by ADR 0004's mechanism, and this crate's
posture is forward-only refusal rather than guessing what an older payload meant.

## Consequences

**The record is gone when the app closes, and that is the trade.** An operator
who wants last Tuesday goes to GitHub, which has it, and has it properly. The
ring bounds a session at 200 entries per map, so a machine left running for a
week loses its oldest rows silently — acceptable for a surface whose job is
*what moved since you looked*, and wrong for anything that called itself an
archive.

**Two clause kinds shipped with no producer, and both have one now.** The
catch-all carried those changes in the meantime, which is exactly its stated
job. #35 put the fog on `Map`, keyed `fogChanged` on it, and added `fog` to the
map-level residual — without that second line every fog change would have gone
to the catch-all, which is the state that ticket found the vocabulary in. #36
keyed `cutFromScope` on `Node::cut` and drew it *instead of* `resolved` rather
than beside it, pre-accounting the decoration in the node residual only where
the clause fired, so a cut taken back still reaches the catch-all — see
[ADR 0017](0017-out-of-scope-is-not-progress.md).

**`announce`'s exclusion still has no producer.** `Claims` is managed state
with a `claimed(number)` that nothing calls yet — #48's to call. Today the slice
is empty, so every claim on screen is somebody else's and announces, which is
correct rather than merely harmless.

**One clause per node per tier.** A node holds one `NodeState`, so a
`Blocked → Claimed` transition reports as `Unblocked` — edges outrank claims in
the precedence — rather than as two clauses. Reporting both would invent an
ordering between two facts that arrived as one value, which is the same
reasoning as *no causal attribution*.

**Entries never revise.** Blocked and then unblocked is two entries. That is
what makes the read marker a marker rather than a diff of its own: `readThrough`
is a `seq`, and everything above it is unread.

**The ticket had to build its own input.** Nothing in the running app derived a
`Model` before this — `snapshot()` was a constant, the map graph was never
requested, and `Watched.map` was documented as *carried, not yet spent*. So #41
also spends the watched map, derives per tick, caches the map's own
`graph_cache` row, adds a `snapshot` event mirroring the `maps` event, and makes
the `snapshot` command answer with the poller's latest derivation. Opening a map
became a real click on `MapRow` for the same reason: the record's input does not
exist until a map can be open.

**`Ledger` deliberately has no `PartialEq`.** A comparable record ends up inside
somebody's equality check, and the check it would end up inside is the one that
decides whether this tick differs from the last. Anything wanting to compare two
of them compares `ledger.entries`.

**`ledger.since` trips the repository's timestamp guard word list.** It does not
fire today, because that guard walks only the `Model`, and the exemption is one
named path with a written reason: it holds `firstOpen | watching`, an answer to
*has a comparison happened yet*, not a clock reading. A guard widened to walk a
whole `Snapshot` needs the same one-path exemption rather than a rename.

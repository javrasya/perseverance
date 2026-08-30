# 19. A cached body is keyed to the document that produced it

Status: accepted (2026-08-30)
Context: [#82 Stamp cached graph bodies with the query document that produced
them](https://github.com/javrasya/perseverance/issues/82), under the spec
[#28](https://github.com/javrasya/perseverance/issues/28). It rests on
[ADR 0003](0003-github-is-read-over-a-blocking-socket-this-app-owns.md) for the
one query document and the one socket, and on
[ADR 0010](0010-the-change-ledger-is-a-notification-surface-not-an-archive.md)
for the ledger whose cold-start baseline is the cached row this stamps — and
for what a `STORE_SCHEMA_VERSION` bump costs.

`0019` and not `0018`: the directory holds two ADRs numbered `0010`, so `0018`
is the highest number in use.

## Context

`graph_cache` stores the GraphQL response verbatim, exactly as GitHub sent it,
and two readers spend it on the first frames of a launch: the folder's map list
becomes the first paint, and the open map's row becomes the baseline the *while
you were away* entry is drawn against. Neither reader knew what question the
body it was reading had been the answer to.

That would be harmless if a body from an older document failed to parse. It
does not. Every field on the read model is `#[serde(default)]`-tolerant —
deliberately, because a read that half-arrives is still worth painting — so a
body recorded under a **narrower** document parses perfectly and quietly answers
with less. It is not drift the reader can see. It is a smaller true statement
presented as the whole one.

#61 already shipped exactly this. It widened both `labels` connections from
`first: 10` to `first: 100` and added `pageInfo { hasNextPage }`. On the first
cold start after that build, a cached child with more than ten labels comes back
with everything past the tenth missing:

- If one of the lost labels is a `platform:` label, the baseline reads
  `bound_elsewhere: false` where the very next live poll reads `true`, and the
  ledger draws a *while you were away* row for a change nobody made. The one
  surface in this app whose entire value is that it reports only real movement
  opens with a lie.
- `labelsTruncated` is derived from the `pageInfo` the old document never asked
  for, so it defaults to `has_next_page: false` and reports clean for precisely
  the read the flag exists to catch.

The second is the sharper one: a flag that reads clean because the question was
never asked is worse than no flag, because an operator believes it.

## Decision

**The cached body carries the identity of the document that produced it, and
nothing derived from a body whose identity is not this build's may be
believed.**

**The identity is the document's bytes.** `MAP_READ_QUERY` is
`include_str!("map-read.graphql")`, and its stamp is FNV-1a over those bytes,
sixteen hex characters. Not a version number beside the file: a version number
is a thing somebody has to remember to bump, and the failure it guards against
is precisely somebody editing the query and not thinking about the cache. The
bytes cannot be edited without the stamp changing. FNV-1a rather than a real
digest because nothing adversarial is being resisted — the only question ever
asked of the value is *are these the same bytes this build sends* — and because
a hash crate would have been `perseverance-github`'s first new dependency for a
sixteen-character string. The arithmetic is a `const fn`; only the hex
rendering is not, because `str::from_utf8` is not `const` on the workspace's
1.82 floor.

**The stamp travels on `FreshRead`.** `FreshRead::query_id` sits beside `body`
and `fetched_at` on the value that has no public constructor outside
`perseverance-github` — the same mechanism that already makes *the cache is
written only on a successful GitHub read* unspellable to break rather than a
rule to remember. The stamp and the body therefore cannot be written from two
places and disagree. `map_read_query_id()` is free-standing beside it so the
reader can ask what this build sends without holding a read.

**A mismatch is scoped to what the stamp is evidence about, and it is never an
error or a deletion.** `under_this_builds_query` in `crates/app` is the whole
comparison, byte-equal or not, and an unstamped row — one a version-2 file
brings through the upgrade — is a mismatch too: `None` is not this build's id
either. What the two readers do with that answer differs, because they spend
the body on different things:

- **A derivation is *first open*.** `cached_under_this_builds_query` hands the
  row back only under this build's stamp, and `resuming_from` takes the `None`
  branch it already had: `ChangeLog::first_open`. Nothing new had to be invented
  for the answer, because *nobody has looked here yet* was already the honest
  thing to say — and the phantom *while you were away* row is the failure this
  ADR exists to close.
- **The map list still paints, with its truncation flags moved to the caveat.**
  `from_cache` reads the row whatever its stamp and paints it through
  `MapsView::of`, then applies `MapsView::unvouched`: `truncated` and
  `labelsTruncated` both go to `true`. The stamp is evidence about a `pageInfo`
  the old document may never have asked for. It is not evidence about whether
  the operator has any maps, and the numbers, titles and states are the part of
  a body a widening leaves alone.

The second is not a softening of the first, it is the same rule aimed at the
same target. A flag that reads clean because the question was never asked is
the harm; a list emptied on the strength of a stamp is a *different* false
statement, and `MapsView::stale` already refuses to make it — `from_cache` is
the copy `poll_once` holds across every failing exit it has, so a stamp that
blanked it would report *your maps are gone* for as long as the polls went on
failing.

The row is **not** deleted. Only a successful GitHub read may delete anything,
and that principle has no exception for a row we happen to dislike. It does not
need one: the condition self-heals, because `ON CONFLICT … DO UPDATE SET`
overwrites the row, stamp included, on the very next successful read.

**It is a new column and a schema bump, and not a new table.**
`ALTER TABLE graph_cache ADD COLUMN query_id TEXT` as `MIGRATIONS[2]`, with
`STORE_SCHEMA_VERSION` at 3 — the compile-time assertion tying the two together
means the bump and the append cannot be separated. Nullable, because SQLite
cannot `ADD COLUMN` a bare `NOT NULL` and because NULL is already this schema's
word for *this fact was not recorded*, as it is for `map_number`.

## Consequences

**This is not the fingerprint #32 killed, and the migration says so.** That
fingerprint was of the **response**, and its only job was to gate the expensive
half of a poll/refetch split — a split that no longer exists, which is why the
column was refused. This is an identity of the **request document**, and its job
is to decide whether a stored body may be believed at all. The two are opposite
directions across the same wire, and the new migration's comment states the
distinction beside the old one's so no later reader concludes #32 was quietly
reversed.

**Every operator takes one first open, once, and never a blank launcher.** The
upgrade to version 3 leaves existing rows unstamped, so the first launch after
it starts every map's ledger from *first open* and paints every folder's list
under the truncation caveat. Both are the correct answer for those rows — nobody
knows what document filled them — and both cost one poll. The list itself is on
screen the whole time, including on a first launch whose poll never lands: that
is the case the scoping is for, since an operator who is offline or rate-limited
would otherwise be told their maps were gone by an upgrade.

**A widening now costs a baseline rather than corrupting one.** Anybody editing
`map-read.graphql` gets the cold start for free, in exchange for nothing they
have to remember. The equivalent hand-maintained constant would have been
correct only for as long as everyone kept bumping it.

**The stamp is not a version and cannot be ordered.** There is no *newer* or
*older* to read out of it, only *same* or *not the same*. A narrowing and a
widening are the same answer, which is right: this build cannot tell what an
unfamiliar document asked for, so believing the body under it is a guess either
way.

**The store compares nothing.** `CachedGraph.query_id` is stored and handed
back; `perseverance-store` has no idea what the current document is and cannot
acquire one — it cannot open a socket. The comparison lives in `crates/app`, in
one place, which is why both readers cannot drift apart.

**`query_id` is named in the `ON CONFLICT … DO UPDATE SET` clause, and a test
holds it there.** That clause enumerates the columns it updates. A column left
out of it keeps its first value forever, so a body from the widened document
would go on wearing the narrow document's stamp — the exact bug, re-entered
through the fix. The test re-caches one `(folder, map)` under a second stamp and
asserts the column moved; a test that only round-tripped one write would have
passed either way.

**Nothing crosses to the WebView.** `CachedGraph` is not in the generated
bindings, no view has a word for the stamp, and the frontend is unchanged. What
a mismatch produces is a `MapsView` and a `ChangeLog` the WebView already knows
how to paint.

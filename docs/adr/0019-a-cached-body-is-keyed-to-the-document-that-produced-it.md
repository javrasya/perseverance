# 19. A cached body is keyed to the document that produced it

Status: accepted (2026-08-30)
Context: [#82 Stamp cached graph bodies with the query document that produced
them](https://github.com/javrasya/perseverance/issues/82), under the spec
[#28](https://github.com/javrasya/perseverance/issues/28). It rests on
[ADR 0003](0003-github-is-read-over-a-blocking-socket-this-app-owns.md) for the
one query document and the one socket, and on
[ADR 0010](0010-the-change-ledger-is-a-notification-surface-not-an-archive.md)
for the ledger whose cold-start baseline is the cached row this stamps.

It **changes** ADR 0010 on one point rather than resting on it. That ADR
recorded #41 as needing no `STORE_SCHEMA_VERSION` bump, and refused an
append-only table beside `graph_cache` as a second, less accurate copy of a
history GitHub already keeps. This one takes the bump ADR 0010 declined — but
for a column on the row that already exists, not for a history beside it, so
what ADR 0010 refused stays refused.

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

**The identity is the document, not a number beside it.** `MAP_READ_QUERY` is
`include_str!("map-read.graphql")`, and its stamp is FNV-1a over it, sixteen hex
characters. Not a version number beside the file: a version number is a thing
somebody has to remember to bump, and the failure it guards against is precisely
somebody editing the query and not thinking about the cache. What the document
asks for cannot be edited without the stamp changing.

**What is hashed is the question, not the file.** A `#`-comment is dropped and a
run of whitespace collapses to one space before a byte reaches the hash, because
the only thing the stamp is ever asked is *could this body be narrower than what
I would get now* and GitHub is never shown a comment. Twenty-three of
`map-read.graphql`'s sixty-two lines are prose, and in this repo prose gets
edited more often than fields do; a reworded rationale that cost every operator
a *first open* baseline plus a `labelsTruncated` caveat would be spending the
cold start on nothing. Inside a string literal both rules are off — there a
space and a `#` are data, and `labels: ["wayfinder:map"]` is a filter whose
narrowing has to bite like any other.

FNV-1a rather than a real digest because nothing adversarial is being resisted —
the only question ever asked of the value is *is this the document this build
sends* — and because a hash crate would have been `perseverance-github`'s first
new dependency for a sixteen-character string. The arithmetic, normalisation
included, is a `const fn`; only the hex rendering is not, because
`str::from_utf8` is not `const` on the workspace's 1.82 floor, so it is rendered
once into a `OnceLock` rather than formatted afresh on every cache read.

**The stamp travels on `FreshRead`.** `FreshRead::query_id` sits beside `body`
and `fetched_at` on the value that has no public constructor outside
`perseverance-github` — the same mechanism that already makes *the cache is
written only on a successful GitHub read* unspellable to break rather than a
rule to remember. It is a **field**, not a lookup: `read_maps` hands the stamp
to `interpret_read` because `read_maps` is where the document was chosen, so a
second query added to that crate cannot quietly produce bodies wearing the map
read's id. It stays one value on the way out too — the writer takes a single
`CachedBody { graph_json, fetched_at, query_id }` rather than three positions.
The stamp and the body therefore cannot be written from two places and
disagree. `map_read_query_id()` is free-standing beside it so the reader can ask
what this build sends without holding a read.

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
- **The map list still paints, with `labelsTruncated` moved to the caveat.**
  `from_cache` reads the row whatever its stamp and paints it through
  `MapsView::of`, then applies `MapsView::unvouched`, which sets
  `labelsTruncated` and touches nothing else. The stamp is evidence about a
  `pageInfo` the old document may never have asked for. It is not evidence about
  whether the operator has any maps, and the numbers, titles and states are the
  part of a body a widening leaves alone.

The second is not a softening of the first, it is the same rule aimed at the
same target. A flag that reads clean because the question was never asked is
the harm; a list emptied on the strength of a stamp is a *different* false
statement, and `MapsView::stale` already refuses to make it — `from_cache` is
the copy `poll_once` holds across every failing exit it has, so a stamp that
blanked it would report *your maps are gone* for as long as the polls went on
failing.

**Of the two truncation flags, only `labelsTruncated` is caveated, and the
asymmetry is which sentence survives being weakened.** It is the one #82 names
and the one #61's widening actually moved, and its sentence is about a page
rather than about GitHub, so there is a true version of it to print under a
stamp: *some of the labels here may not have been read*. `truncated`'s sentence
says GitHub answered a page its own limits forbid, and there is no cautious
version of that — *a cap may have been broken* is a different accusation, not a
softer reading of the same one. That flag is a tripwire whose whole value is
that it has never fired — `crates/model` refuses to fold labels into it for
exactly this reason — and a stamp is evidence about a `pageInfo`, never about
what GitHub did. Setting it would put a sentence about GitHub in front of every
operator on their first launch after the version-3 upgrade, and keep it there
for as long as the polls kept failing, which is the offline and rate-limited
case the scoping was chosen for in the first place. The capped connections
therefore stay **unvouched and silent**: a cap GitHub forbids has never been
observed, and a caveat that asserts something false is not a smaller lie than a
flag that reads clean.

**The `maps` leg came out of `capped()`, because the scoping cannot hold while
it is in there.** `Truncation::capped()` used to be `maps || children ||
blocked_by`, and only two of the three were the ones `map-read.graphql` argues
are impossible — sub-issues at 100 per parent, linked issues at 50 per
relationship. The map list is `issues(first: 100, labels: ["wayfinder:map"])`,
and nothing caps how many issues carry a label, so that page can ordinarily
exist too. Leaving it grouped with the other two cost twice over: a repository
with a hundred and one maps was told GitHub had answered a page *its own limits
say cannot happen*, which is a false statement about GitHub; and a later
widening of `maps(first: N)` or its `pageInfo` would have reproduced this
ticket's own bug on a flag nothing here could vouch for, because reaching for
`truncated`'s sentence would have been false about the other two legs.

So `capped()` is now `children || blocked_by`, the impossibility sentence is
honest about exactly the connections that are capped, and `Truncation::maps`
crosses on its own as `MapsView::maps_truncated` with `MAPS_TRUNCATED_NOTE`
beside it — a page that can ordinarily exist, said the way the label page is
said, naming the consequence an operator acts on: *a map missing from this list
is past the end of it rather than gone*. `MapsView::unvouched` then raises it
alongside `labelsTruncated`, and the Decision above holds with no exception —
nothing derived from a body whose identity is not this build's is believed.

The alternative — a further state on `MapsView` with a sentence of its own,
*this copy was read under a query this build no longer sends, so what it says
was cut off may be incomplete* — was rejected for the two capped legs that
remain. It buys a caveat over flags that have never fired at the price of a
WebView-visible field, a regenerated binding and another note to keep true, and
this ADR's answer is that the honest thing to say about those two is nothing.

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
under the labels caveat. Both are the correct answer for those rows — nobody
knows what document filled them — and both cost one poll. The list itself is on
screen the whole time, including on a first launch whose poll never lands: that
is the case the scoping is for, since an operator who is offline or rate-limited
would otherwise be told their maps were gone by an upgrade.

**The one caveat it does show cost the copy a word, and that is what buying
the reuse was.** `LABELS_TRUNCATED_NOTE` used to assert a fact — *an issue here
carries more labels than one page holds, so some of them were not read* — and
after the upgrade every folder would have worn that sentence while almost none
of them had been cut off by anything. Printing an unknown as a value is what
this app refuses everywhere else: `MapsView::nothing_read_yet` is an absence and
not an empty list, `ChangeLog::first_open` is *first open* and not `0 changes`.
So the sentence was weakened to *some of the labels here may not have been
read*, which is true of both of the flag's producers — a `hasNextPage` a live
read really saw, and a `pageInfo` an unfamiliar document may never have asked
for. The consequence it names is unchanged and is still the actionable half: a
ticket whose platform label was cut off is offered on a machine it is bound away
from.

`MAPS_TRUNCATED_NOTE`, the sentence the `capped()` split added, is hedged in
the same word and for the same reason: `MapsView::unvouched` raises that flag
too, so *some of the maps here may not have been read* is the strongest thing
true of both of its producers.

The rejected alternative was a second sentence per flag, keyed to the stamp on
the `Provenance` channel. It is more precise, and the extra precision buys
nothing an operator does differently — the act under either sentence is a second
look at a designated ticket, or at a list that may be longer than it looks — at
the price of a state on the wire and two more notes to keep true. **It is also
not available for free from what already crosses**, which is worth writing down
because `Provenance` looks like it would carry it: `Source::Cache` is what an
ordinary vouched cache read reports as well, so a caveat keyed off source alone
would print the stamp sentence on every cached paint. Telling the two apart
needs a new state either way, which is the cost this decision declined.

What is lost is real and is recorded here: an operator who reads either caveat
after a live read can no longer tell from the copy alone that the truncation was
*observed* rather than merely possible. The word is the price of one sentence
over two producers. The same weakening is not available to `truncated`, whose
sentence would be wrong about GitHub rather than cautious about a page, which is
why that flag stays silent instead.

**The weakening widened #82's scope, and the ticket says so.** The ticket asked
for stamped bodies and *first open* on a mismatch; a hedged word in a sentence
every live-read operator reads was not in it. The trade is the one recorded
above, and the body of #82 was amended to name it rather than left describing
only the ledger half.

**A widening now costs a baseline rather than corrupting one.** Anybody editing
what `map-read.graphql` *asks for* gets the cold start for free, in exchange for
nothing they have to remember; anybody editing only its prose pays nothing. The equivalent hand-maintained constant would have been
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

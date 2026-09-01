# 24. The remembered dial is one row per map and one write per gesture

Status: accepted (2026-08-31)
Context: [#52 The dial and the peek](https://github.com/javrasya/perseverance/issues/52),
under the spec [#28](https://github.com/javrasya/perseverance/issues/28). It
closes what
[ADR 0022](0022-the-dial-is-four-detents-and-nothing-switches-by-itself.md) left
open: the dial's per-map memory was `localStorage` behind a two-function seam,
and that seam existed so this slice could move it without touching anything
else.

`0024` and not `0023`: `0023` is the peek above.
The number is one above the highest already on disk, which is not the file
count: `0005` was never written, and `docs/adr/` holds two ADRs numbered
`0010` and two numbered `0020`.

## Context

The dial's position was remembered per map in the browser's storage — durable
enough to prove the behaviour, and not the same kind of durable as the rest of
this app's state, which lives in one SQLite file the launcher owns. The store's
schema had been carrying the absence explicitly: a comment in `schema.rs` said
`map_view` belonged to a later ticket, because *a table nobody writes is a claim
the schema cannot keep*. This is that ticket, and there is now something to
write in it.

Two decisions were not obvious.

**The column is `layout_json`, not `dial`.** A `REAL dial` column would have been
narrower, cheaper to read and impossible to get wrong. It was rejected because
the dial is the first thing a map remembers about its layout and will not be the
last — a nickname, a plate for Deep Field, whatever #62 wants — and each of those
would otherwise arrive as its own migration on a table with one row per map. The
envelope makes the second fact a serialisation change rather than a schema
change. The cost is paid in the same coin every JSON cell is: the store cannot
type-check what it holds, so the app crate parses it and **anything it cannot
parse reads as an absence** — the house rule `agent_override` already keeps. A
store that has gone bad costs an operator a remembered position, not a working
window.

The same argument decides what is *not* there. The ticket's schema sketch names
a `nickname` column; nothing in this app renames a map, so it is absent for the
reason the `fingerprint` column is absent from `graph_cache` — a column nobody
writes is the same unkeepable claim as a table nobody writes. And `map_number`
is `NOT NULL` here, unlike in `graph_cache`, because *nothing open* is not a
place the dial can come back to: there is no row for it because there is nothing
to remember.

**The write is on the falling edge of a gesture, not on the move.** A pointer
drag produces dozens of positions a second, and every one of them used to be a
storage write. Against a browser key that was wasteful; against a SQLite
transaction it is unacceptable, and it would be one transaction per frame for a
single decision the operator made once. So the dial's callback says *which kind
of move this is* — `"drag"` or `"settled"` — and only a settled one is written
down. It is deliberately the shape `src/panes/geometry.ts` already uses between
a drag and a `SIGWINCH`, down to the one-line table that answers whether an
occasion counts.

## Decision

`map_view(folder_id, map_number, layout_json)` is the registry's fourth table,
keyed on the folder **id** — the store's own foreign key, so a folder the
operator relocates keeps what its maps were worth — and cascading with the
folder, because taking a folder off the list is the operator disposing of their
own rows. A map nobody has moved the dial on has no row.

`src/panes/position.ts` stays two functions wide and becomes asynchronous.
Behind it: two commands with Rust behind the window, `localStorage` without —
the `hasRustBehindIt()` shape every seam in this app takes, and the reason
`dev:web` still boots with no Rust, no GitHub and no PTY. Nothing outside that
file knows there is a table, a command or a key.

The write happens once per completed gesture: a pointer release, a keyboard
press, a cap that widens the dial, or the map changing under a drag that was
still in progress. A peek writes nothing at all, and cannot — it moves
`peeking`, never `position`, and no file in the spring's path names the seam.

Because the read is asynchronous now, an answer that lands after the operator
has already moved the dial is discarded rather than applied — the ordering rule
the snapshot's subscribe-then-ask already keeps, counted per move rather than
flagged once.

## Consequences

The store speaks schema version 4, and a registry written by version 3 gains an
empty `map_view` on first open: every map comes back at the default detent once,
and no folder and no cached body is lost to the upgrade. A file stamped ahead of
this build is still refused rather than guessed at.

Rule 8 of the contract — *no stored node positions* — now has a table to be
checked against rather than an absence, and `tests/contract-registry.test.ts`
reads `map_view`'s three columns instead of asserting the table does not exist.
That is the exception the rule always said it would have to learn, and it is
still true: where the seam between the map and the run sits is a fact about a
window, not about a node.

What a map is worth is now durable across launches, and only across launches on
this machine — the registry is one file in the OS's application-data directory,
and nothing syncs it. A second window on the same machine reads the same row,
last write winning, which is the same bargain every other row in that file
already makes.

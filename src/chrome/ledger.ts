/**
 * The ledger in words, and the whole of this side's share of its numeral.
 *
 * Every string a change is named with lives in this file and in no other file
 * under `src/`. One vocabulary for the record is the same rule `stamp.ts`
 * holds the staleness vocabulary to, for the same reason: a second phrasing of
 * *frontier moved* is a second thing to keep in step, and two spellings of one
 * fact on one screen is the cost.
 *
 * **Every string here states what was true, never why.** A row asserts only
 * that these were true together at the moment of the look. Two resolutions
 * arriving in one diff make *the one that freed this ticket* a guess dressed as
 * a record — the model carries no edge from one change to another, so nothing
 * on this side could settle such a guess even if it wanted to. So no causal
 * connective appears in this file, in `Ledger.tsx` or in `Ledger.module.css`.
 * The list of the connectives is in `tests/ledger.test.ts`, and it is a test
 * over all three files rather than a convention somebody has to keep.
 *
 * Nothing here decides what is worth announcing. `announce` arrives stamped on
 * every clause, settled once in Rust over the finished entry, and the one
 * number this side owns is `readThrough`: the highest `seq` an operator has
 * read. Every function below is arithmetic or a lookup.
 */

import type { Clause, ClauseKind, Ledger } from "../snapshot/model.generated";

/** What the record is called on the chrome. */
export const LEDGER_LABEL = "Changes";

/**
 * One word per clause kind, and nothing else on this side names one.
 *
 * The order of the keys is [`ClauseKind`]'s own declaration order, so this
 * table reads as the precedence it mirrors — but nothing sorts by it. The
 * precedence is Rust's, applied before an entry crosses the seam, and a second
 * ordering here is exactly the drift one vocabulary exists to prevent.
 *
 * `unnamed` gets *changed* and no more. It is the catch-all: a model field this
 * table cannot name still draws a row, and the honest word for a change nobody
 * has given a name to is the general one. Inventing a specific word for it
 * would be this table claiming to know a thing it was handed no name for.
 */
export const CLAUSE_WORDS: Record<ClauseKind, string> = {
  created: "created",
  removed: "removed",
  resolved: "resolved",
  cutFromScope: "cut from scope",
  reopened: "reopened",
  unclassified: "unclassified",
  specAppeared: "spec appeared",
  unblocked: "unblocked",
  blocked: "blocked",
  claimed: "claimed",
  released: "released",
  frontierMoved: "frontier moved",
  fogChanged: "fog changed",
  phaseChanged: "phase changed",
  mapClosed: "map closed",
  unnamed: "changed",
};

/**
 * A map nothing has been compared for.
 *
 * Absence is never a zero. A map nobody has looked at twice has not failed to
 * move, and a `0` in this slot would report those two states as one. The word
 * stands in place of the numeral entirely — see [`describeUnread`].
 */
export const FIRST_OPEN = "first open";

/** The gap between two sessions, drawn as one row and never as many. */
export const WHILE_YOU_WERE_AWAY = "while you were away";

/**
 * A comparison happened and turned up nothing announceable.
 *
 * Only ever on screen once a poll has landed with something to compare
 * against. That is the state a zero is honest for, and [`FIRST_OPEN`] is the
 * word for the other one.
 */
export const NOTHING_SINCE = "nothing new";

/**
 * How many announceable clauses the operator has not read.
 *
 * Clauses rather than entries: a clause is one collapsed change and an entry is
 * one look. *Two resolutions two seconds apart* is one entry and one clause,
 * and the numeral counts changes rather than looks.
 *
 * A marker past the last `seq` floors at zero on its own, with no clamp — a
 * session longer-lived than the ledger it is marking can only mean everything
 * in the ledger has been read.
 */
export function unreadAnnounceable(ledger: Ledger, readThrough: number): number {
  return ledger.entries
    .filter((entry) => entry.seq > readThrough)
    .reduce(
      (total, entry) => total + entry.clauses.filter((clause) => clause.announce).length,
      0,
    );
}

/**
 * The numeral, or the word standing in place of one.
 *
 * The rule lives here rather than in the component: *absence is never zero* is
 * a statement about the record, and a component holding it would be a second
 * place for it to be spelled differently.
 */
export function describeUnread(ledger: Ledger, readThrough: number): string {
  if (ledger.since === "firstOpen") return FIRST_OPEN;
  return String(unreadAnnounceable(ledger, readThrough));
}

/**
 * One clause, as its word and its count.
 *
 * The numbers are not folded into this string. They are rendered beside it as
 * references an operator can pick a node with, and a `#77` inside a sentence is
 * a reference nobody can click.
 *
 * A map-level clause names no node and carries a count of one. *Frontier moved
 * 1* would be a tally of maps, so those clauses read as the bare word.
 */
export function describeClause(clause: Clause): string {
  const said = CLAUSE_WORDS[clause.kind];
  return clause.numbers.length === 0 ? said : `${said} ${clause.count}`;
}

/**
 * The newest `seq` in the ledger, or `0` for a ledger with no entries.
 *
 * This is the marker an interaction sets: reading the record reads all of it,
 * and the sequence is Rust's own, never one counted up on this side.
 */
export function highestSeq(ledger: Ledger): number {
  return ledger.entries.reduce((highest, entry) => Math.max(highest, entry.seq), 0);
}

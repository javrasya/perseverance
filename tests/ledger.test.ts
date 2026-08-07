import { describe, expect, it } from "vitest";
import {
  CLAUSE_WORDS,
  FIRST_OPEN,
  LEDGER_LABEL,
  NOTHING_SINCE,
  WHILE_YOU_WERE_AWAY,
  describeClause,
  describeUnread,
  highestSeq,
  unreadAnnounceable,
} from "../src/chrome/ledger";
import { FIXTURES, FIXTURE_NAMES } from "../src/snapshot/fixtures";
import type { ClauseKind, Ledger } from "../src/snapshot/snapshot";
import { collect } from "./support/sources";

/**
 * The ledger's arithmetic and its vocabulary, with no DOM anywhere near them.
 *
 * The record is what an operator reads; these are the two things underneath it
 * that can be wrong without looking wrong — a numeral counting the wrong
 * clauses, and a word claiming more than the model handed over.
 */

const away = FIXTURES["while-you-were-away"].ledger;

/** The one entry the resumed fixture carries. */
function theRow() {
  const entry = away.entries[0];
  if (entry === undefined) throw new Error("the resumed fixture has no entry");
  return entry;
}

describe("the numeral counts what Rust stamped and decides nothing itself", () => {
  it("sums the announceable clauses and leaves the catch-all out of the count", () => {
    const clauses = theRow().clauses;
    const announceable = clauses.filter((clause) => clause.announce);

    // Read off the fixture rather than typed in: `announce` is settled once, in
    // Rust, over the finished entry, and a number written down here would be a
    // second account of that decision.
    expect(unreadAnnounceable(away, 0)).toBe(announceable.length);
    // The record is complete and the announcement is selective. The catch-all
    // is carried in the row and left out of the numeral, and this fixture is
    // the one with both kinds of clause in a single entry.
    expect(unreadAnnounceable(away, 0)).toBeLessThan(clauses.length);
    expect(clauses.find((clause) => clause.kind === "unnamed")?.announce).toBe(false);
  });

  it("drops to zero at the seq of the newest entry", () => {
    expect(highestSeq(away)).toBe(theRow().seq);
    expect(unreadAnnounceable(away, highestSeq(away))).toBe(0);
    // And a marker from a session longer-lived than this ledger cannot take the
    // count below zero: it can only mean everything here has been read.
    expect(unreadAnnounceable(away, 99)).toBe(0);
  });

  it("counts changes rather than looks, one entry at a time", () => {
    /* Blocked and then unblocked: two entries, never a revision of one. */
    const twoLooks: Ledger = {
      since: "watching",
      entries: [
        {
          seq: 1,
          occasion: "tick",
          clauses: [
            { kind: "blocked", numbers: [72], count: 1, announce: true },
            { kind: "unnamed", numbers: [76], count: 1, announce: false },
          ],
        },
        {
          seq: 2,
          occasion: "tick",
          clauses: [{ kind: "unblocked", numbers: [72], count: 1, announce: true }],
        },
      ],
    };

    expect(unreadAnnounceable(twoLooks, 0)).toBe(2);
    expect(unreadAnnounceable(twoLooks, 1)).toBe(1);
    expect(unreadAnnounceable(twoLooks, 2)).toBe(0);
    expect(highestSeq(twoLooks)).toBe(2);
    // A ledger with nothing in it marks nothing read, and `0` is the honest
    // marker for it — every real `seq` is above it.
    expect(highestSeq({ since: "watching", entries: [] })).toBe(0);
  });

  it("says first open in place of the number, and never a zero", () => {
    for (const name of FIXTURE_NAMES) {
      if (name === "while-you-were-away") continue;
      // Every other fixture is a map nothing has been compared for. A map
      // nobody has looked at twice has not failed to move, and the two states
      // are two different readings rather than one number.
      expect([name, describeUnread(FIXTURES[name].ledger, 0)]).toEqual([name, FIRST_OPEN]);
    }

    expect(describeUnread(away, 0)).toBe(String(unreadAnnounceable(away, 0)));
    // A zero is available the moment there is one to mean: a poll that landed
    // and turned up nothing announceable.
    expect(describeUnread(away, highestSeq(away))).toBe("0");
    expect(Number.isNaN(Number(FIRST_OPEN))).toBe(true);
  });
});

describe("one file names a change, and it names only what was true", () => {
  it("has a word for every clause kind the generated types declare", () => {
    /*
     * The union is read out of the generated file rather than listed here. A
     * kind added in Rust and left out of the table would otherwise be a clause
     * rendering as `undefined` on the chrome, and a list written down here
     * would be the second copy that made that possible.
     */
    const generated = collect([".ts"]).find(
      (file) => file.path === "src/snapshot/model.generated.ts",
    );
    const union = /export type ClauseKind = ([^;]+);/.exec(generated?.text ?? "");
    const spelled = union?.[1];
    if (spelled === undefined) throw new Error("the generated types declare no ClauseKind");

    const declared = [...spelled.matchAll(/"([a-zA-Z]+)"/g)]
      .map((match) => match[1])
      .filter((kind): kind is ClauseKind => kind !== undefined);

    expect(declared.length).toBeGreaterThan(0);
    // The key order is the declaration order, so the table reads as the
    // precedence it mirrors — and nothing sorts by it on this side.
    expect(Object.keys(CLAUSE_WORDS)).toEqual(declared);
    for (const kind of declared) {
      expect([kind, CLAUSE_WORDS[kind].length > 0]).toEqual([kind, true]);
    }
  });

  it("spells a clause as its word and its count, with the numbers left to the references", () => {
    expect(describeClause({ kind: "resolved", numbers: [77], count: 1, announce: true })).toBe(
      "resolved 1",
    );
    expect(
      describeClause({ kind: "resolved", numbers: [77, 71], count: 2, announce: true }),
    ).toBe("resolved 2");
    // Two resolutions two seconds apart read as what they are, and neither the
    // string nor the count says a word about the order they arrived in.
    expect(
      describeClause({ kind: "frontierMoved", numbers: [], count: 1, announce: true }),
    ).toBe(CLAUSE_WORDS.frontierMoved);
    // The numbers are references an operator picks a node with, so no clause
    // folds one into its sentence.
    for (const clause of theRow().clauses) {
      expect([clause.kind, /#\d/.test(describeClause(clause))]).toEqual([
        clause.kind,
        false,
      ]);
    }
  });

  it("keeps the ledger's words out of every file but the one that owns them", () => {
    /*
     * The same shape `stamp.ts` is held to, and built out of the constants
     * themselves rather than out of a list beside them — a hand-typed list is
     * the drift one vocabulary exists to prevent.
     *
     * The multi-word entries only. The single words in `CLAUSE_WORDS` are the
     * model's own vocabulary and appear as `ClauseKind` and `NodeState` values
     * throughout the generated types, so scanning for those would be scanning
     * for the seam itself.
     */
    const phrases = new RegExp(
      [
        CLAUSE_WORDS.cutFromScope,
        CLAUSE_WORDS.specAppeared,
        CLAUSE_WORDS.frontierMoved,
        CLAUSE_WORDS.fogChanged,
        CLAUSE_WORDS.phaseChanged,
        CLAUSE_WORDS.mapClosed,
        WHILE_YOU_WERE_AWAY,
        // A word boundary, so *nothing newer has arrived* on a cache stamp is
        // not read as this record's absence.
        `${NOTHING_SINCE}\\b`,
        // In quotes: *first open* is ordinary prose in two other doc comments,
        // and it is the string literal that gets one home.
        `"${FIRST_OPEN}"`,
        `"${LEDGER_LABEL}"`,
      ].join("|"),
    );

    const offenders = collect([".ts", ".tsx"])
      .filter((file) => phrases.test(file.text))
      .map((file) => file.path);

    expect(offenders).toEqual(["src/chrome/ledger.ts"]);
  });

  it("puts no causal connective in a single string that reaches the screen", () => {
    /*
     * The scan below reads the files; this reads the values. They are two
     * different claims and the second is the one an operator meets — a source
     * scan passes for a table assembled at runtime, and a table is exactly what
     * this vocabulary is. So every exported string, and every string the two
     * describe functions build out of them over real fixture data, is put
     * through the connectives directly.
     */
    const connectives =
      /\bbecause\b|\bcaused?\b|\bdue to\b|unblocked by|\bled to\b|as a result|\btherefore\b|so that\b/i;

    const rendered = [
      LEDGER_LABEL,
      FIRST_OPEN,
      WHILE_YOU_WERE_AWAY,
      NOTHING_SINCE,
      ...Object.values(CLAUSE_WORDS),
      ...theRow().clauses.map(describeClause),
      describeUnread(away, 0),
      describeUnread(away, highestSeq(away)),
    ];

    expect(rendered.length).toBeGreaterThan(Object.keys(CLAUSE_WORDS).length);
    for (const said of rendered) {
      expect([said, connectives.exec(said)?.[0] ?? null]).toEqual([said, null]);
    }

    /*
     * *Unblocked* is in the table and *unblocked by* is not, and the difference
     * is the whole rule: the first is a state a node arrived in, the second
     * names what put it there. The model carries no edge from one change to
     * another, so nothing on this side could fill in the *by* even if a string
     * here asked for it.
     */
    expect(CLAUSE_WORDS.unblocked).toBe("unblocked");
    // And the catch-all names no field, because it is handed no name. A model
    // field this table cannot spell still draws a row, and *changed* is the
    // honest word for it.
    expect(connectives.test(CLAUSE_WORDS.unnamed)).toBe(false);
    expect(CLAUSE_WORDS.unnamed.split(" ")).toHaveLength(1);
  });

  it("uses no causal connective anywhere in the three files it is written across", () => {
    /*
     * *No causal attribution, ever.* Two resolutions arriving in one diff make
     * *the one that freed this ticket* a guess dressed as a record, and the
     * model carries no edge from one change to another for anybody to settle
     * such a guess from. The rule covers the prose as well as the rendered
     * strings: a doc comment explaining a row in causal terms is the same claim
     * one layer back, and it is where the next renderer would take the idea
     * from.
     */
    const connectives =
      /\b(because|caused?|therefore|which)\b|\bdue to\b|\bunblocked by\b|\bled to\b|\bas a result\b|\bso that\b|\bafter\b/i;
    const owned = [
      "src/chrome/ledger.ts",
      "src/chrome/Ledger.tsx",
      "src/chrome/Ledger.module.css",
    ];

    const files = collect([".ts", ".tsx", ".css"]).filter((file) =>
      owned.includes(file.path),
    );
    expect(files.map((file) => file.path).sort()).toEqual([...owned].sort());

    for (const file of files) {
      expect([file.path, connectives.exec(file.text)?.[0] ?? null]).toEqual([
        file.path,
        null,
      ]);
    }
  });

  it("puts no motion on the record, so the numeral is the whole announcement", () => {
    /*
     * The ledger announces by a numeral changing and never by movement. A CSS
     * transition here would be an interruption in the same modality a toast
     * interrupts in, and it would arrive with news every time a poll landed.
     */
    const sheet = collect([".css"]).find(
      (file) => file.path === "src/chrome/Ledger.module.css",
    );
    expect(sheet).toBeDefined();

    // The comments go first. The rule is written down in the stylesheet itself,
    // and a scan reading its own statement of the rule as a breach of it is a
    // scan nobody can write the reason beside.
    const declared = (sheet?.text ?? "").replace(/\/\*[\s\S]*?\*\//g, "");

    expect(/transition|animation|@keyframes/.test(declared)).toBe(false);
  });
});

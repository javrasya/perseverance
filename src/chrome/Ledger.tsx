import { useState } from "react";
import type { Entry, Ledger as LedgerRecord } from "../snapshot/model.generated";
import {
  CLAUSE_WORDS,
  FIRST_OPEN,
  LEDGER_LABEL,
  NOTHING_SINCE,
  WHILE_YOU_WERE_AWAY,
  describeClause,
  describeUnread,
  highestSeq,
} from "./ledger";
import styles from "./Ledger.module.css";

interface LedgerProps {
  ledger: LedgerRecord;
  /** The highest `seq` the operator has read. The whole of this side's state. */
  readThrough: number;
  onRead: (seq: number) => void;
  onSelectNode: (number: number) => void;
}

/**
 * The change ledger, at a fixed address on the chrome.
 *
 * **Always on screen, never conditional.** A numeral able to vanish is a
 * numeral nobody can trust: an operator glancing at an empty slot cannot tell
 * *nothing has moved* apart from *this window stopped saying*. The same rule
 * keeps the two cache stamps unconditional, and the same failure is the one it
 * is there to prevent.
 *
 * The ledger sits in the chrome rather than in a view. Its own field rides on
 * the snapshot beside `model`, outside the type every view is handed, so *no
 * view renders the ledger* holds structurally and needs no rule. #52 builds the
 * divider's spine, and moving this record onto it is moving one element in one
 * file — the slot is fixed, the address is not settled here.
 *
 * **It announces by the numeral changing and by nothing else.** No role, no
 * live region, no focus call, no motion. A record of things already true is not
 * an interruption, and a number arriving with a movement is a number an
 * operator has to finish watching before reading it.
 *
 * Every word on screen comes from `ledger.ts`, and every judgement in the
 * record was made in Rust: the clause order is the precedence Rust sorted by,
 * `count` is the number Rust collapsed, and `announce` is Rust's stamp. This
 * file spells them and picks nothing.
 */
export function Ledger({ ledger, readThrough, onRead, onSelectNode }: LedgerProps) {
  const [shown, setShown] = useState(false);

  /* Reading the record reads all of it, up to the newest `seq` Rust wrote. */
  const reveal = () => {
    if (!shown) onRead(highestSeq(ledger));
    setShown(!shown);
  };

  /*
   * Newest at the top, on a copy. `entries` arrives oldest-first and belongs to
   * the snapshot, so reversing it in place would reorder the record every other
   * reader holds.
   */
  const newestFirst = [...ledger.entries].reverse();

  return (
    <div className={styles.ledger} data-ledger={ledger.since}>
      <button
        type="button"
        className={styles.face}
        aria-expanded={shown}
        onClick={reveal}
      >
        <span className={styles.label}>{LEDGER_LABEL}</span>
        {/*
          A plain span. *First open* stands in place of the number rather than
          beside it: a map nothing has been compared for has not failed to move,
          and a zero would report both states as one.
        */}
        <span className={styles.numeral} data-first={ledger.since === "firstOpen"}>
          {describeUnread(ledger, readThrough)}
        </span>
      </button>

      {shown ? (
        <div className={styles.record}>
          {newestFirst.length === 0 ? (
            <p className={styles.absence}>
              {ledger.since === "firstOpen" ? FIRST_OPEN : NOTHING_SINCE}
            </p>
          ) : (
            <ul className={styles.entries} aria-label={LEDGER_LABEL}>
              {newestFirst.map((entry) => (
                <Row key={entry.seq} entry={entry} onSelectNode={onSelectNode} />
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * One entry: one look at the map, and every change the look turned up.
 *
 * Entries never revise. Blocked and then unblocked is two rows, each true of
 * the moment it was written, and neither of them edits the other.
 *
 * The clauses are rendered in arrival order. Rust sorted them by the fixed
 * precedence — issue-level, edges, claims, derived, catch-all — and a second
 * sort on this side is a second answer to an ordering already settled.
 */
function Row({
  entry,
  onSelectNode,
}: {
  entry: Entry;
  onSelectNode: (number: number) => void;
}) {
  return (
    <li className={styles.entry} data-seq={entry.seq} data-occasion={entry.occasion}>
      {/* The gap between two sessions reads as itself: one row for the whole of
          it, and the ledger has no way to know how many looks it stands for. */}
      {entry.occasion === "whileYouWereAway" ? (
        <span className={styles.occasion}>{WHILE_YOU_WERE_AWAY}</span>
      ) : null}
      <ul className={styles.clauses}>
        {entry.clauses.map((clause) => (
          <li
            key={clause.kind}
            className={styles.clause}
            data-kind={clause.kind}
            data-announce={clause.announce}
          >
            <span className={styles.said}>{describeClause(clause)}</span>
            {clause.numbers.map((number) => (
              /*
                A reference picks a node and stops there. No scroll, no view
                change, no declaration to the poller — and it sets rather than
                toggles, so a second look at the same record leaves the node
                picked rather than putting it back.
              */
              <button
                key={number}
                type="button"
                className={styles.reference}
                data-node={number}
                title={CLAUSE_WORDS[clause.kind]}
                onClick={() => onSelectNode(number)}
              >
                #{number}
              </button>
            ))}
          </li>
        ))}
      </ul>
    </li>
  );
}

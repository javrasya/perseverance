import {
  FOREIGN_NOTE,
  GONE_IS_ORDINARY,
  LIST_IS_DERIVED,
  LOOK_AGAIN_LABEL,
  NOTHING_WAS_FETCHED,
  ORPHAN_NOTE,
  REMOVAL_KEEPS_THE_BRANCH,
  REMOVE_LABEL,
  WORKTREES_CANNOT_TELL_YOU,
  branchLine,
  inventorySummary,
  lockedLine,
  offersRemoval,
  prunableLine,
  publicationLine,
  uncommittedLines,
  whoseLabel,
  whyNoOffer,
  workingLine,
  type Inventory,
  type WorktreeEntry,
} from "./worktrees";
import styles from "./WorktreeList.module.css";

/** Shared between the button that opens the panel and the panel it opens. */
export const WORKTREE_PANEL_ID = "folder-worktree-panel";

interface WorktreeListProps {
  inventory: Inventory;
  shown: boolean;
  onToggle: () => void;
  onRemove: (worktree: string) => void;
  onLookAgain: () => void;
}

/**
 * Every worktree of the folder you picked, in one list.
 *
 * One list and not two. An orphan — ours, for a ticket the open map does not
 * have — is a row here under the same rules as every other row, because a
 * separate section is where a *clear these* button grows, and there is no
 * removal in this app that is not one press on one directory. A foreign entry
 * is a row too, and gets no control of any kind: not a disabled button with a
 * tooltip explaining itself, which reads as something to argue with, but
 * nothing, plus the sentence saying why there is nothing.
 *
 * Where a removal is not offered, the reason is on the row. The uncommitted
 * case prints every line git gave, in the open: it is the reason the directory
 * is staying, it is the only thing that says whether the work in there matters,
 * and a count of it behind a disclosure would be this panel deciding that on
 * the operator's behalf.
 *
 * There is no key binding here and there is no menu. Buttons, and the panel is
 * in the DOM in both states so `aria-controls` names something real.
 */
export function WorktreeList({
  inventory,
  shown,
  onToggle,
  onRemove,
  onLookAgain,
}: WorktreeListProps) {
  return (
    <section className={styles.holder} aria-label="Worktrees of this folder">
      <div className={styles.bar}>
        <button
          type="button"
          className={styles.disclose}
          aria-expanded={shown}
          aria-controls={WORKTREE_PANEL_ID}
          onClick={onToggle}
        >
          <span className={styles.label}>worktrees:</span>
          <span className={styles.summary}>{inventorySummary(inventory)}</span>
          <span className={styles.chevron} aria-hidden="true">
            {shown ? "▾" : "▸"}
          </span>
        </button>
        {/*
          The list is derived on every call, so asking again is the only way to
          have a fresh one — and it is also the way back from a refusal, which
          replaces the listing rather than annotating a stale one.
        */}
        <button type="button" className={styles.again} onClick={onLookAgain}>
          {LOOK_AGAIN_LABEL}
        </button>
      </div>

      <div
        id={WORKTREE_PANEL_ID}
        className={styles.panel}
        data-shown={shown ? "true" : "false"}
        data-state={inventory.kind}
      >
        {inventory.kind === "refused" ? (
          // Rust's own sentence, unedited. It names a fact about this disk —
          // no git, no repository, a removal git would not make — and this side
          // has no better words for any of them.
          <p className={styles.refusal}>{inventory.detail}</p>
        ) : (
          <>
            <div className={styles.section}>
              <p className={styles.note}>{LIST_IS_DERIVED}</p>
              <p className={styles.note}>{REMOVAL_KEEPS_THE_BRANCH}</p>
              <p className={styles.note}>{NOTHING_WAS_FETCHED}</p>
              <p className={styles.note}>{FOREIGN_NOTE}</p>
              <p className={styles.note}>{ORPHAN_NOTE}</p>
            </div>

            <ul className={styles.entries}>
              {inventory.entries.map((entry) => (
                <li key={entry.path} className={styles.entry} data-whose={entry.whose.kind}>
                  <Row entry={entry} onRemove={onRemove} />
                </li>
              ))}
            </ul>
          </>
        )}

        <div className={styles.section}>
          <h3 className={styles.heading}>What this cannot tell you</h3>
          <ul className={styles.limits}>
            {WORKTREES_CANNOT_TELL_YOU.map((limit) => (
              <li key={limit} className={styles.limit}>
                {limit}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

/** One directory: what it is, what is in it, and either the offer or the reason. */
function Row({ entry, onRemove }: { entry: WorktreeEntry; onRemove: (worktree: string) => void }) {
  const lines = uncommittedLines(entry);
  const lock = lockedLine(entry);
  const prunable = prunableLine(entry);
  const refusal = whyNoOffer(entry);

  return (
    <>
      <div className={styles.head}>
        <span className={styles.whose} data-orphan={isOrphan(entry) ? "true" : "false"}>
          {whoseLabel(entry)}
        </span>
        <span className={styles.branch}>{branchLine(entry)}</span>
      </div>

      {/* Focusable, because a region a keyboard cannot reach cannot be read. */}
      <div
        className={styles.verbatim}
        role="group"
        tabIndex={0}
        aria-label="The worktree's directory, as git spelled it"
      >
        <code className={styles.path}>{entry.path}</code>
      </div>

      <p className={styles.state} data-working={entry.probed?.working.kind ?? "notAsked"}>
        {workingLine(entry)}
      </p>
      <p className={styles.facts}>{publicationLine(entry)}</p>
      {entry.probed?.working.kind === "gone" ? (
        <p className={styles.detail}>{GONE_IS_ORDINARY}</p>
      ) : null}
      {lock === null ? null : <p className={styles.detail}>{lock}</p>}
      {prunable === null ? null : <p className={styles.detail}>{prunable}</p>}

      {/*
        Every line git printed, and never a count. This is the whole of what
        says whether the directory is worth keeping, and it is in the open
        rather than behind a hover or a chevron: the operator is being told why
        there is no button, and the answer is these lines.
      */}
      {lines.length === 0 ? null : (
        <ul className={styles.changes}>
          {lines.map((line, index) => (
            <li key={`${index}-${line}`} className={styles.change}>
              {line}
            </li>
          ))}
        </ul>
      )}

      {/*
        The offer or the reason, and never both — and never a disabled button
        standing in for the reason. A control that is present and refuses is an
        argument; a sentence is an answer.
      */}
      {offersRemoval(entry) ? (
        <button type="button" className={styles.remove} onClick={() => onRemove(entry.path)}>
          {REMOVE_LABEL}
        </button>
      ) : (
        <p className={styles.detail}>{refusal}</p>
      )}
    </>
  );
}

function isOrphan(entry: WorktreeEntry): boolean {
  return entry.whose.kind === "ours" && entry.whose.orphan;
}

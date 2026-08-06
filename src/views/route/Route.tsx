import { useMemo } from "react";
import type { Model, Node } from "../../snapshot/model.generated";
import { NO_MAP_OPEN } from "../../snapshot/readout";
import {
  DESIGNATED_TAG,
  STATE_NAMES,
  beyondTheMapNote,
  blockedByLabel,
  routeOf,
  type Mark,
  type RouteRow,
  type RouteSection,
} from "./route";
import styles from "./Route.module.css";

/**
 * The Route, drawn: the first view, and the first time *a view is a pure
 * function from the derived model to pixels* is tested rather than asserted.
 *
 * **A grouped list in one column.** Structure is section membership and
 * position in the column — the loudest channel there is — and everything a row
 * adds to that, it adds in words. Edges get words and never pixels: `blocked
 * by N` on the row that waits, and a note when a blocker has no row here. There
 * is no rank, no coordinate, no canvas and no line: nothing is drawn between
 * two rows, so there is nothing to place and nothing to route around. ADR 0006.
 *
 * No graph library and no layout library anywhere behind it, and now nothing
 * for one to do. The list is real DOM rather than hand-rolled SVG, which is
 * what lets the browser ellipsise a title while the whole string stays in the
 * document, and what lets a row take the app's own focus ring instead of a
 * hand-painted one.
 *
 * Nothing is derived in this file. One call to `routeOf` answers with every
 * section, heading, count, mark and tally that reaches the screen: no counting
 * here, no filtering, no grouping and no state resolution, which is what makes
 * the claim checkable — and no positions are stored anywhere, because the same
 * model always answers with the same list.
 *
 * **Import this file as `Route.jsx`.** It sits beside `route.ts`, and macOS and
 * Windows filesystems are case-insensitive, so an extensionless `./Route`
 * resolves to the arithmetic module — which exports a `Route` *type* — and this
 * component is never found. The `.jsx` specifier maps to `Route.tsx` under
 * bundler resolution and matches nothing else.
 */

/*
 * One shape per mark. The row carries the mark as `data-mark` for everything
 * that is a colour; the glyph carries it as a class because a ring, a dot and a
 * hatch are different geometry rather than one shape in five colours.
 *
 * `satisfies` rather than an annotation: it makes a missing mark a compile
 * error while leaving the CSS-module lookup its own type.
 */
const GLYPHS = {
  takeable: styles.markTakeable,
  designated: styles.markDesignated,
  claimed: styles.markClaimed,
  blocked: styles.markBlocked,
  resolved: styles.markResolved,
} satisfies Record<Mark, string | undefined>;

interface RouteProps {
  model: Model;
  selected: number | null;
  onSelect: (number: number | null) => void;
}

export function Route({ model, selected, onSelect }: RouteProps) {
  /*
   * A memo and nothing more. `routeOf` is deterministic and cheap, so this
   * saves a pass over the nodes and buys no correctness — if it were ever load
   * bearing, the list would be state and the sections would be stored.
   */
  const route = useMemo(() => {
    const map = model.map;
    if (map === null) return null;
    return routeOf(map);
  }, [model]);

  if (route === null) {
    /* An absence, and the chrome's own words for it rather than a second set. */
    return (
      <section className={styles.route} aria-label="The Route">
        <p className={styles.absence}>{NO_MAP_OPEN}</p>
      </section>
    );
  }

  return (
    <section className={styles.route} aria-label="The Route">
      {route.sections.map((section) => (
        <Section
          key={section.name}
          section={section}
          selected={selected}
          onSelect={onSelect}
        />
      ))}

      {/*
        Resolved is the last section #34 draws, and what it draws is C5's muted
        title and id. The guarantee that a resolved row stays focusable,
        locatable and countable through a retheme is #37's, rule and test both.
      */}
      {/*
        Out of scope sits here, between Resolved and Fog. #36 — it is a
        decoration on resolved rather than a fifth state, and the counts stay at
        three.
      */}
      {/*
        Fog sits here, last inside this same column. #35 — it must name itself
        and not only count itself, and a missing heading is `—` and never `0`.
      */}
    </section>
  );
}

/**
 * One section: a heading that carries its own count, and the rows it counts.
 *
 * The heading is `section.heading` and never a choice made here — the top
 * section reads *Now* or *Next* depending on whether anything is claimed, and
 * that is a fact about the map, decided where the map is read. Sections with no
 * rows never arrive, so there is no empty group to draw.
 */
function Section({
  section,
  selected,
  onSelect,
}: {
  section: RouteSection;
  selected: number | null;
  onSelect: (number: number | null) => void;
}) {
  const headingId = `route-section-${section.name}`;

  return (
    <>
      <h2 className={styles.sectionHeading} id={headingId}>
        <span className={styles.sectionName}>{section.heading}</span>
        <span className={styles.rule} aria-hidden="true" />
        <span className={styles.sectionCount}>{section.count}</span>
      </h2>
      <ul className={styles.rows} aria-labelledby={headingId}>
        {section.rows.map((row) => (
          <Row
            key={row.node.number}
            row={row}
            selected={selected === row.node.number}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </>
  );
}

/**
 * One row.
 *
 * `data-state` and `data-mark` are both here and they are two different
 * claims. `data-state` is the model's own word, spelled and never re-derived —
 * what GitHub decided about this ticket. `data-mark` is the pane's encoding,
 * which folds the designation in: a takeable node the map designates is marked
 * *designated* while its state stays *takeable*, and nothing has to look at two
 * attributes to know which ring to draw.
 */
function Row({
  row,
  selected,
  onSelect,
}: {
  row: RouteRow;
  selected: boolean;
  onSelect: (number: number | null) => void;
}) {
  const { node } = row;

  /* Picking the node you already picked puts it back, so a selection is never
     something you have to go somewhere else to undo. */
  const choose = () => onSelect(selected ? null : node.number);

  return (
    <li
      className={styles.node}
      data-node={node.number}
      data-state={node.state}
      data-kind={node.kind.kind}
      data-mark={row.mark}
      data-frontier={row.designated ? "" : undefined}
      data-selected={selected ? "" : undefined}
      /* The same word `FolderRow` uses for the row you picked, so the fill is
         not the only place the choice is said. */
      aria-current={selected ? "true" : undefined}
      tabIndex={0}
      onClick={choose}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        // Space scrolls the pane otherwise, which moves the thing being picked.
        event.preventDefault();
        choose();
      }}
    >
      <span className={styles.glyph} aria-hidden="true">
        <span className={GLYPHS[row.mark]} />
      </span>
      <span className={styles.id}>#{node.number}</span>
      {/* In full. The stylesheet ellipsises it, so the whole title is still in
          the document to be found, read aloud and asserted on. */}
      <span className={styles.title}>{node.title}</span>
      <Note row={row} />
      <span className={styles.tags}>
        <MarkerTag row={row} />
        {/*
          Only a positive number. `blocked by 0` on a row whose state is
          *blocked* is a contradiction an operator can see, and a zero is worth
          no ink either way. A finished row cannot reach here with a number at
          all — nothing holds up work that is already done, and `blockersOf`
          empties the tally rather than leaving this to remember it.
        */}
        {row.blockers.unresolved > 0 ? (
          <span className={styles.tag}>{blockedByLabel(row.blockers.unresolved)}</span>
        ) : null}
        <KindTag node={node} />
        {row.attendance === null ? null : (
          <span
            className={
              row.attendance === "AFK" ? `${styles.tag} ${styles.tagAfk}` : styles.tag
            }
          >
            {row.attendance}
          </span>
        )}
      </span>
    </li>
  );
}

/**
 * The one thing a row says about itself in a sentence rather than a word.
 *
 * A blocker with no row on this map is the fact worth the slot: the map cannot
 * say whether it is done, so it is said here rather than counted into `blocked
 * by N`, which would be this map asserting something it has nothing on screen
 * to back.
 *
 * C5's other notes are not built. *Claimed by this session · 04:12* needs a run
 * clock and a session identity, *closed 14:22 · pty still alive* needs both and
 * a process, and *unblocked by #11 closing* needs a change ledger. None of the
 * three is in the derived model, so building any of them would mean inventing
 * state rather than reading it.
 */
function Note({ row }: { row: RouteRow }) {
  if (row.blockers.beyondTheMap === 0) return null;
  return <span className={styles.note}>{beyondTheMapNote(row.blockers.beyondTheMap)}</span>;
}

/**
 * The marker tag: cold for the one to start, warm for the one already running.
 *
 * Claimed wins, the same precedence the mark uses and for the same reason —
 * a designated node somebody is already on would otherwise read as free.
 * *Claimed* is the model's own word, deliberately: C5 says *running*, which is
 * a claim about a live PTY that this view cannot verify.
 */
function MarkerTag({ row }: { row: RouteRow }) {
  if (row.mark === "claimed") {
    return <span className={`${styles.tag} ${styles.tagLive}`}>{STATE_NAMES.claimed}</span>;
  }
  if (row.designated) {
    return (
      <span className={`${styles.tag} ${styles.tagDesignated}`}>{DESIGNATED_TAG}</span>
    );
  }
  return null;
}

/**
 * What kind of work this is, in the words `/to-issues` labels it with.
 *
 * A ticket only. A spec is not a kind of ticket and an unclassified child is a
 * child nobody classified, so neither gets a word invented for it here —
 * `data-kind` carries what the model said, and how an unclassified child reads
 * on screen is #37's.
 */
function KindTag({ node }: { node: Node }) {
  if (node.kind.kind !== "ticket") return null;
  return <span className={styles.tag}>{node.kind.type}</span>;
}

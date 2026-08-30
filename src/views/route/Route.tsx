import { useMemo } from "react";
import type { Fog, Node } from "../../snapshot/model.generated";
import { NO_MAP_OPEN } from "../../snapshot/readout";
/*
 * The props are the shared type and never a local one. A view that declared its
 * own could widen them to the whole snapshot, and what a view is handed is the
 * one place that is decided — see `ViewProps`.
 */
import type { ViewProps } from "../views";
import {
  BOUND_ELSEWHERE_TAG,
  DESIGNATED_TAG,
  FOG_ALL_CHARTED,
  FOG_HEADING,
  NOBODY_SURVEYED,
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
 * model always answers with the same list. The fog is parsed nowhere near here
 * either. What arrives is a region already bounded, already counted and already
 * told apart from a region nobody surveyed; this file chooses a word and a
 * shape for it and reads not one character of it.
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

/* The fog heading's own id, so its region is labelled by it exactly as a
   section's rows are labelled by theirs — and so a reader after the four row
   sections can ask for `route-section-*` and not sweep this one in with them. */
const FOG_ID = "route-fog";

export function Route({ model, selected, onSelect }: ViewProps) {
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
      <FogRegion fog={route.fog} />
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
 * The fog: a region that names itself, counts itself, and says which of the two
 * nothings it is in its shape rather than in a character.
 *
 * **Drawn on every map, including one with nothing else on it.** Every other
 * group here is dropped when it is empty, because a group is a claim that there
 * is something in it. This is the one place where the emptiness is the claim —
 * and the fog is the only element on the map with no identity of its own, which
 * is why it gets a name instead of a number in the margin.
 *
 * The two readings differ in **form** and not only in the glyph, which is what
 * #35 asks for: the unsurveyed region stands an em dash in a different type
 * face where a numeral would go **and draws nothing at all beneath its
 * heading**, while a surveyed one draws a numeral and always draws a body under
 * it. Nothing has to read a character to tell them apart, and neither of the
 * two differences is a colour.
 */
function FogRegion({ fog }: { fog: Fog }) {
  if (fog.fog === "unsurveyed") {
    return (
      <section className={styles.fog} data-fog="unsurveyed" aria-labelledby={FOG_ID}>
        <h2 className={styles.sectionHeading} id={FOG_ID}>
          <span className={styles.sectionName}>{FOG_HEADING}</span>
          <span className={styles.rule} aria-hidden="true" />
          {/* Not a numeral, and not in a numeral's slot: nobody has been here,
              and a zero would report that as a finding. */}
          <span className={styles.fogUnsurveyed} data-unsurveyed>
            {NOBODY_SURVEYED}
          </span>
        </h2>
      </section>
    );
  }

  return (
    <section className={styles.fog} data-fog="surveyed" aria-labelledby={FOG_ID}>
      <h2 className={styles.sectionHeading} id={FOG_ID}>
        <span className={styles.sectionName}>{FOG_HEADING}</span>
        <span className={styles.rule} aria-hidden="true" />
        <span className={styles.fogCount} data-count>
          {fog.region.count}
        </span>
      </h2>
      {fog.region.text === "" ? (
        <p className={styles.fogEmpty}>{FOG_ALL_CHARTED}</p>
      ) : (
        /* One text node, unmodified. The section is not re-rendered from
           markdown, not split into rows and not trimmed: `pre-wrap` in the
           stylesheet is what puts the operator's own line breaks and
           indentation on screen, and the parse in Rust is the only thing that
           ever chose where this string starts and stops. */
        <pre className={styles.fogText}>{fog.region.text}</pre>
      )}
    </section>
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
 *
 * A cut row is a third claim on top of those two and changes neither: the state
 * stays *resolved* and so does the mark, because the ticket really is closed.
 * What it gains is `data-cut`, a struck disc, and the operator's own words as a
 * text node in the document — **never a `title`, and nothing behind a hover.** A
 * branch that stops has to show why on screen, and a reason an operator has to
 * find with a pointer is a reason a screenshot, a search and a reader do not
 * have. That is what `data-plate` buys the room for: the row is drawn two plates
 * wide so the words fit beside the tags rather than under them.
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
      /* The verdict Rust took, carried onto the row so *listed but not
         offered* is a thing on screen rather than an absence of one. */
      data-elsewhere={row.boundElsewhere ? "" : undefined}
      data-cut={row.cut === null ? undefined : ""}
      /* A size and not a position: the row is capped at one plate, and a row
         carrying a reason is capped at two, because the reason takes a plate's
         worth of room. Nothing is placed and nothing is drawn between two
         rows. */
      data-plate={row.cut === null ? undefined : "double"}
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
        {/* The cut's own shape, composed onto the one the mark already chose
            rather than replacing it: C5's `g-oos` decorating a resolved disc,
            which is what a cut is — not a sixth mark. */}
        <span
          className={
            row.cut === null ? GLYPHS[row.mark] : `${GLYPHS[row.mark]} ${styles.markCut}`
          }
        />
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
        {/*
          The one thing on the row that is a fact about the reader rather than
          about the ticket. It sits with the other tags and takes the same
          class: the row keeps its section, its count and its state, and only
          gains a word naming what the ticket is bound to. Ungated on purpose —
          the binding is true of a blocked or resolved row too, and gating it
          would mean deciding startability a second time on this side.
        */}
        {row.boundElsewhere ? (
          <span className={styles.tag}>{BOUND_ELSEWHERE_TAG}</span>
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
      {/*
        Why the branch stopped, in the operator's own bullet, last on the row and
        read from `RouteRow.cut` without a character changed. A text node and
        nothing else: no tooltip, no description hung off a hidden element,
        nothing a pointer has to be held still to reveal — a cut with a reason
        nobody can see is a cut that reads as a finished ticket.
      */}
      {row.cut === null ? null : <span className={styles.reason}>{row.cut}</span>}
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
 * clock and a session identity, and *closed 14:22 · pty still alive* needs both
 * and a process; neither is in the derived model, so building either would mean
 * inventing state rather than reading it.
 *
 * *Unblocked by #11 closing* is a different refusal, and it survives the record
 * of what moved between two looks now existing. That record is chrome at a
 * fixed address, it is not on `ViewProps`, and it names no cause of its own —
 * two resolutions arriving in one look make *the one that freed this row* a
 * guess dressed as a fact. So the note stays unbuilt, and this view has nothing
 * to build it from either.
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

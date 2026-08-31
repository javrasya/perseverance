import { useMemo, type ReactElement } from "react";
import type { Fog, Node } from "../../snapshot/model.generated";
import { NO_MAP_OPEN } from "../../snapshot/readout";
/*
 * The props are the shared type and never a local one. A view that declared its
 * own could widen them to the whole snapshot, and what a view is handed is the
 * one place that is decided — see `ViewProps`.
 */
import type { ViewProps } from "../views";
import { beyondTheMapNote, blockedByLabel } from "../graph";
import {
  BOUND_ELSEWHERE_TAG,
  DESIGNATED_TAG,
  FOG_ALL_CHARTED,
  FOG_HEADING,
  SPEC_TAG,
  STATE_NAMES,
  UNCLASSIFIED_TAG,
} from "../vocabulary";
import {
  DESTINATION_HEADING,
  NOBODY_SURVEYED,
  pingOf,
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
  unclassified: styles.markUnclassified,
  destination: styles.markDestination,
} satisfies Record<Mark, string | undefined>;

/* The fog heading's own id, so its region is labelled by it exactly as a
   section's rows are labelled by theirs — and so a reader after the four row
   sections can ask for `route-section-*` and not sweep this one in with them. */
const FOG_ID = "route-fog";

/* The destination's own id, and it is not `route-section-*` for the same reason
   the fog's is not: a reader asking for the groups that head a count would
   otherwise sweep in the one group that deliberately heads none. */
const DESTINATION_ID = "route-destination";

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

  /* Read once for the pane: the halo is the screen's one moving element and
     not each claimed row's, so the row that draws it is chosen here. */
  const ping = pingOf(route);

  return (
    <section className={styles.route} aria-label="The Route">
      {/* The one row that moves, decided over the whole pane rather than per
          row: #56 rations motion by the screen, so *which* claimed row draws
          the halo is an answer this view gives once. See `pingOf`. */}
      {route.sections.map((section) => (
        <Section
          key={section.name}
          section={section}
          ping={ping}
          selected={selected}
          onSelect={onSelect}
        />
      ))}

      {/*
        Then the far end of the route, and then what nobody has charted. The
        order is the journey: what is being worked, what can be started, what is
        held up, what is done, what was cut, what nobody classified — then where
        all of it is going, and then the ground beyond it. The fog stays the last
        thing on the pane.

        Resolved keeps C5's muted title and id, and it recedes in ink weight and
        in nothing else: `route-view.test.tsx` now holds that block to it, which
        is the test the stylesheet's own comment has been asking for.
      */}
      <Destination rows={route.destination} selected={selected} onSelect={onSelect} />
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
  ping,
  selected,
  onSelect,
}: {
  section: RouteSection;
  /** The number of the one row drawing the halo, from [`pingOf`]. */
  ping: number | null;
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
            pings={row.node.number === ping}
            selected={selected === row.node.number}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </>
  );
}

/**
 * The destination: the spec children, drawn as where the map is going rather
 * than as something to take.
 *
 * **A region and not a section, and the missing count is the whole of it.** A
 * section's heading carries `rows.length` and that is the only honest number
 * this pane can print — so *never counted* cannot be a subtraction anywhere,
 * and the only way to keep the invariant and stop counting the spec is to head
 * it with something that prints no number at all. That is a third form in the
 * slot a numeral would take: a numeral over a section, an em dash over a fog
 * nobody surveyed, and nothing whatsoever over here. The model agrees from the
 * other side — `counts.tickets` has never included a spec, and `counts.specs`
 * is where a number about specs belongs.
 *
 * Dropped when the map has no spec child, exactly as an empty section is: a map
 * still being charted has no destination yet, and there is no second absence to
 * tell apart the way there is in the fog.
 *
 * The rows are ordinary rows. They are selectable and reachable from the
 * keyboard like any other, because selecting is not starting — the one thing
 * they may never be is *offered*, and that is refused in the mark, in the
 * bucket and in `map.frontier`, none of which is a control.
 */
function Destination({
  rows,
  selected,
  onSelect,
}: {
  rows: readonly RouteRow[];
  selected: number | null;
  onSelect: (number: number | null) => void;
}) {
  if (rows.length === 0) return null;

  return (
    <section
      className={styles.destination}
      data-destination
      aria-labelledby={DESTINATION_ID}
    >
      <h2 className={styles.sectionHeading} id={DESTINATION_ID}>
        <span className={styles.sectionName}>{DESTINATION_HEADING}</span>
        {/* Two children where a section has three. There is no count here and
            there is no placeholder for one either: a slot standing empty would
            read as a number that failed to arrive. */}
        <span className={styles.rule} aria-hidden="true" />
      </h2>
      <ul className={styles.rows} aria-labelledby={DESTINATION_ID}>
        {/* Never the halo. `markOf` answers `destination` above the state, so
            a spec child with a session against it is not marked `claimed` here
            and nothing in this region is what `pingOf` looked for. */}
        {rows.map((row) => (
          <Row
            key={row.node.number}
            row={row}
            pings={false}
            selected={selected === row.node.number}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </section>
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
 * `data-kind` is the third, and it is the model's word again: *ticket*, *spec*
 * or *unclassified*, decided in Rust off the map's own labels. It is the only
 * thing on this row about spawnability, and it is not a spawnability flag —
 * there is no `data-spawnable` here and there will not be one, because the
 * single answer to *may this be started* is `map.frontier`, and a second
 * boolean invented on this side is a second answer that can disagree with it.
 * What a non-ticket row loses is the offer, never the row: it keeps its
 * `tabIndex`, its click and its selection, because selecting a ticket is not
 * starting one and the row an operator most needs to open is the one that is
 * wrong.
 *
 * A cut row is a fourth claim on top of those and changes neither of the first
 * two: the state stays *resolved* and so does the mark, because the ticket
 * really is closed.
 * What it gains is `data-cut`, a struck disc, and the operator's own words as a
 * text node in the document — **never a `title`, and nothing behind a hover.** A
 * branch that stops has to show why on screen, and a reason an operator has to
 * find with a pointer is a reason a screenshot, a search and a reader do not
 * have. That is what `data-plate` buys the room for: the row is drawn two plates
 * wide so the words fit beside the tags rather than under them.
 */
function Row({
  row,
  pings,
  selected,
  onSelect,
}: {
  row: RouteRow;
  /**
   * This row is the one drawing the screen's halo.
   *
   * Decided above rather than from `row.mark`, because *is this claimed* and
   * *is this the one element the screen's ration is spent on* are different
   * questions the moment two rows are claimed at once.
   */
  pings: boolean;
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
      /* The keyable hook, and the reason it is not `data-node` above: that one
         means *this is about node N*, which chrome elsewhere says too — some of
         it on controls of its own, with activation of their own — while this
         one means *a row of the route, openable from the keyboard*.
         `src/keys/router.ts` resolves the focused row by this attribute alone,
         so the chord it claims cannot land on something that merely names a
         node. */
      data-node-row={node.number}
      data-state={node.state}
      data-kind={node.kind.kind}
      data-mark={row.mark}
      /*
       * The hook that means *the one to take*, and it is withheld from a row
       * that is not on the scale of work at all. `row.designated` still carries
       * `map.frontier`'s word verbatim — hiding that would be this side
       * resolving rather than reading — but a row marked *destination* or
       * *unclassified* is one the mark has already refused, and drawing the
       * offer's own attribute on it would leave the pane saying two things at
       * once: a waypoint in the glyph and *start here* in the DOM.
       *
       * A rendering suppression and not a second answer. Nothing here decides
       * spawnability; `map.frontier` is still the only thing that does, and it
       * is read once, above, unchanged. What this stops is the pane handing a
       * later reader — a test, a socket — a hook the shape it draws contradicts.
       */
      data-frontier={
        row.designated && row.mark !== "destination" && row.mark !== "unclassified"
          ? ""
          : undefined
      }
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
      /*
       * Reachable by keyboard, and bound by nobody here. `Enter` and `Space`
       * are a row of the one key table in `src/keys/router.ts`, which resolves
       * the row from `data-node-row` above and toggles the same selection this
       * click does — including `preventDefault`, so `Space` does not scroll the
       * pane out from under what is being picked. A second handler here would
       * be a key this app binds outside the router, which
       * `tests/no-loose-keys.test.ts` refuses.
       */
      tabIndex={0}
      onClick={choose}
    >
      <span className={styles.glyph} aria-hidden="true">
        {/* The cut's own shape, composed onto the one the mark already chose
            rather than replacing it: C5's `g-oos` decorating a resolved disc,
            which is what a cut is — not a sixth mark. */}
        {/* `data-animated` on the one mark that moves, and `markPing` is what
            moves it: the halo's still ring is `.markClaimed::after` and every
            claimed row keeps it, while the animation is drawn on this row
            alone. #56 rations motion by the screen rather than by a subtree —
            so the licensed animations have to be countable in one query, or
            *at most one moving element* is a claim nothing can check, and a
            map staking two claims would have animated two things. The
            attribute says the stylesheet is running an animation here; it does
            not choose one. Licensed in `tests/motion-ration.test.ts`. */}
        <span
          className={
            [
              GLYPHS[row.mark],
              row.cut === null ? null : styles.markCut,
              pings ? styles.markPing : null,
            ]
              .filter((name) => name !== null)
              .join(" ")
          }
          data-animated={pings ? "true" : undefined}
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
 *
 * **Read off the mark and not off `row.designated`, so the word and the shape
 * cannot part company.** `markOf` already settled the precedence — a cut, then
 * the kind, then claimed, then the designation — so a row is marked
 * *designated* exactly when the pane is willing to draw the *start this* ring
 * on it. Asking the boolean instead would put the visible word *designated* on
 * a row wearing a waypoint, which is the same contradiction `data-frontier` is
 * gated against and the one an operator would actually read.
 */
function MarkerTag({ row }: { row: RouteRow }) {
  if (row.mark === "claimed") {
    return <span className={`${styles.tag} ${styles.tagLive}`}>{STATE_NAMES.claimed}</span>;
  }
  if (row.mark === "designated") {
    return (
      <span className={`${styles.tag} ${styles.tagDesignated}`}>{DESIGNATED_TAG}</span>
    );
  }
  return null;
}

/**
 * What this child is, in the model's own three words: the ticket type
 * `/to-issues` labelled it with, *spec*, or *unclassified*.
 *
 * **Every child says what it is, and the two that are not tickets say it
 * loudest.** A row nobody classified is the one row on this pane that nothing
 * will ever move, and the group it sits in and the shape it wears both say so —
 * but a group is read once at the top and a shape has to be learned, while a
 * word on the row is read by anyone, by a page search, by a screenshot and by a
 * reader. That is what makes *visibly unclassified* survive a retheme: the
 * strongest of the three channels is text.
 *
 * The switch is exhaustive and the return type is annotated rather than
 * inferred, so a fourth `ChildKind` arriving from Rust is a compile error here
 * rather than a row that quietly says nothing about itself.
 */
function KindTag({ node }: { node: Node }): ReactElement {
  switch (node.kind.kind) {
    case "ticket":
      return <span className={styles.tag}>{node.kind.type}</span>;
    case "spec":
      return <span className={styles.tag}>{SPEC_TAG}</span>;
    case "unclassified":
      return <span className={styles.tag}>{UNCLASSIFIED_TAG}</span>;
  }
}

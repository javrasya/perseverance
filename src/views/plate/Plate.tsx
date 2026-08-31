import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";
import type { Fog, Frontier, Node } from "../../snapshot/model.generated";
import { NO_MAP_OPEN } from "../../snapshot/readout";
/*
 * The props are the shared type and never a local one — `ViewProps` is the one
 * place what a view can see is decided, and this view is handed no width, no
 * positions and no store.
 */
import type { ViewProps } from "../views";
import {
  BOUND_ELSEWHERE_TAG,
  CELL_PIXELS,
  CLAIMED_TAG,
  DESIGNATED_TAG,
  FOG_ALL_CHARTED,
  FOG_HEADING,
  LEGEND_HEADING,
  NOBODY_SURVEYED,
  PIN_NOTE,
  PLATE_LABEL,
  plateOf,
  PUT_BACK,
  SPEC_TAG,
  UNCLASSIFIED_TAG,
  type Cell,
  type Fan,
  type LegendEntry,
  type Plate as Geometry,
  type Station,
  type Track,
} from "./plate";
import { clearPins, pinStation, unpinStation, usePins } from "./pins";
import styles from "./Plate.module.css";

/**
 * The Plate, drawn: the map as a transit diagram, over the geometry `plate.ts`
 * already settled.
 *
 * **Stations for tickets, lines for threads.** A station is a ticket, the track
 * between two stations is *this waits on that*, and a chain of them is a thread
 * of work — which is the one question a list cannot answer and the reason this
 * view exists beside the Route. Track is octolinear because a transit reader
 * already knows what a diagram that only bends by eighths is claiming: the
 * geometry is schematic and the topology is the fact.
 *
 * Nothing here is placed. Ranks, sidings, fan-out, every corner of every track
 * and the eight-anchor label boxes all arrive from `plateOf`, and this file
 * turns cells into pixels and picks a shape per encoding. That is the whole
 * division: `plate.ts` decides where, this decides what it looks like, and
 * neither decides what is true.
 *
 * **Import this file as `Plate.jsx`.** It sits beside `plate.ts`, macOS and
 * Windows filesystems are case-insensitive, and an extensionless `./Plate`
 * resolves to the geometry module — which exports a `Plate` *type* — so the
 * component would never be found.
 */

/*
 * The Plate's own words live in `plate.ts`, and are re-exported here so every
 * caller that already reaches for them through the component goes on working.
 *
 * They moved for the reason the Route's `UNCLASSIFIED_TAG` has always lived in
 * `route.ts`: the conformance surface (`tests/conformance/support/views.ts`)
 * has to name the word an unclassified station is told apart by, and it is
 * loaded by Playwright's own transform, which resolves no CSS module. A test
 * support file that had to import a component to learn a string would drag a
 * stylesheet through a loader that cannot read one — so the words sit in the
 * pure module, which is where a thing neither React nor a sheet has any part in
 * belongs anyway.
 */
export {
  BOUND_ELSEWHERE_TAG,
  CLAIMED_TAG,
  DESIGNATED_TAG,
  FOG_ALL_CHARTED,
  FOG_HEADING,
  LEGEND_HEADING,
  NOBODY_SURVEYED,
  PIN_NOTE,
  PLATE_LABEL,
  PUT_BACK,
  SPEC_TAG,
  UNCLASSIFIED_TAG,
} from "./plate";

/**
 * The keyboard's four headings.
 *
 * The router draws eight and a hand can reach all of them, but a key event
 * carries one heading and there is no second key to combine it with — so a
 * diagonal here is two presses, which the four arrows already spell without a
 * chord nobody would guess at.
 */
const NUDGE = new Map<string, Cell>([
  ["ArrowLeft", { column: -1, row: 0 }],
  ["ArrowRight", { column: 1, row: 0 }],
  ["ArrowUp", { column: 0, row: -1 }],
  ["ArrowDown", { column: 0, row: 1 }],
]);

/**
 * The eleven encodings this view draws.
 *
 * Four node states, the designated frontier, the destination, unclassified and
 * the cut decoration are geometry — a disc, a bar, a lozenge, an interchange
 * ring, a terminus chevron, a square on the diagonal, a strike. The three that
 * are facts about a *reader* rather than about the graph — the ticket type,
 * whether it runs AFK, and whether this machine may start it — are words on the
 * plate, because a word is the one channel that survives both a retheme and a
 * screenshot.
 */
type Mark =
  | "takeable"
  | "designated"
  | "claimed"
  | "blocked"
  | "resolved"
  | "unclassified"
  | "destination";

const GLYPHS = {
  takeable: styles.markTakeable,
  designated: styles.markDesignated,
  claimed: styles.markClaimed,
  blocked: styles.markBlocked,
  resolved: styles.markResolved,
  unclassified: styles.markUnclassified,
  destination: styles.markDestination,
} satisfies Record<Mark, string | undefined>;

/**
 * One station's precedence, and it is the Route's — deliberately.
 *
 * The meta-rule forbids standardising *geometry* between views; it says nothing
 * about meaning, and meaning is the half that must not fork. A cut decides the
 * shape it decorates, then the kind, then claimed, then the designation, then
 * the state. Asking the kind above the designation is the fail-safe: the ring
 * that says *start this* cannot be drawn on a child nobody classified, whatever
 * the frontier says — and what that refuses is the shape and never the reading,
 * because `map.frontier` stays the one answer to *may this be started*.
 */
function markOf(node: Node, designated: boolean): Mark {
  if (node.cut.cut === "fromScope") return node.state;
  if (node.kind.kind === "spec") return "destination";
  if (node.kind.kind === "unclassified") return "unclassified";
  if (node.state === "claimed") return "claimed";
  if (designated) return "designated";
  return node.state;
}

/** Research runs AFK and every other ticket has somebody at the keyboard — the
 *  same line `RunKind::of` draws in Rust, from the same ticket type. */
function attendanceOf(node: Node): "AFK" | "HITL" | null {
  if (node.kind.kind !== "ticket") return null;
  return node.kind.type === "research" ? "AFK" : "HITL";
}

function designatedNumber(frontier: Frontier): number | null {
  return frontier.frontier === "designated" ? frontier.number : null;
}

/**
 * Which thread each station is on, as connected components over the track.
 *
 * This is the hover's whole subject, and it is a fact about the drawing rather
 * than about the model: *which line is this part of* is what a transit reader
 * asks of a station, and the answer is everything reachable from it along the
 * track. A station with no track — a siding — is a thread of one, which is the
 * honest answer rather than a special case.
 */
function threadsOf(plate: Geometry): ReadonlyMap<number, number> {
  const near = new Map<number, number[]>();
  const link = (from: number, to: number) => {
    const known = near.get(from);
    if (known === undefined) near.set(from, [to]);
    else known.push(to);
  };
  for (const track of plate.track) {
    link(track.from, track.to);
    link(track.to, track.from);
  }

  const thread = new Map<number, number>();
  let next = 0;
  for (const station of plate.stations) {
    if (thread.has(station.number)) continue;
    const id = next;
    next += 1;
    const walking = [station.number];
    while (walking.length > 0) {
      const at = walking.pop();
      if (at === undefined || thread.has(at)) continue;
      thread.set(at, id);
      for (const step of near.get(at) ?? []) if (!thread.has(step)) walking.push(step);
    }
  }
  return thread;
}

export function Plate({ model, selected, onSelect }: ViewProps) {
  /*
   * The stations somebody put where they are, from the store the shell opened
   * for this map. Not derived and not view-local invention: rule 8's one
   * exception, arriving through the one seam allowed to name a position, and
   * handed to the geometry rather than applied over it — a pinned station is
   * routed to, labelled by the same eight-anchor solver and counted in the same
   * extent as a generated one, because `plateOf` places it and nothing here
   * moves anything afterwards.
   */
  const pins = usePins();
  const plate = useMemo(() => plateOf(model.map, pins), [model, pins]);
  const threads = useMemo(() => threadsOf(plate), [plate]);

  /*
   * The hand, while it is down. A ref and not state: a drag is dozens of
   * positions a second, the drawing is re-derived from `plateOf` when a pin
   * lands, and re-deriving a router's field per frame would be a new picture
   * thirty times a second. Nothing moves until the gesture settles, and then it
   * moves once — which is also the whole of what rule 9 asks of a drag: no
   * transition, no animation, no motion spent on a claim this view cannot make.
   */
  const grabbed = useRef<{ node: number; from: Cell; x: number; y: number } | null>(null);
  /* Whether the gesture that just ended was a drag. A drag ends in a click the
     browser sends anyway, and a station that got picked because it was moved is
     the app answering a question nobody asked. */
  const dragged = useRef(false);

  const grab = useCallback((node: number, from: Cell, event: ReactPointerEvent) => {
    grabbed.current = { node, from, x: event.clientX, y: event.clientY };
    dragged.current = false;
  }, []);

  /*
   * The gesture, settled: one snap to the grid and one write.
   *
   * The drawing is at natural size — one cell is [`CELL_PIXELS`] on screen and
   * the field scrolls rather than scaling — so pixels of hand become cells by
   * division, and the rounding is the snap.
   */
  const settle = useCallback((event: ReactPointerEvent) => {
    const holding = grabbed.current;
    grabbed.current = null;
    if (holding === null) return;

    const column = Math.round((event.clientX - holding.x) / CELL_PIXELS);
    const row = Math.round((event.clientY - holding.y) / CELL_PIXELS);
    if (column === 0 && row === 0) return;

    dragged.current = true;
    pinStation(holding.node, {
      column: Math.max(0, holding.from.column + column),
      row: Math.max(0, holding.from.row + row),
    });
  }, []);

  /*
   * The same gesture, one cell at a time, from the keyboard.
   *
   * A press is already settled when it arrives — there is no equivalent of the
   * hand still being down — so this is `pinStation` directly, once per press.
   * A station that was never pinned is pinned where it already stands plus the
   * heading, which is why nudging a generated station is the act that authors
   * it: the plate cannot be asked to move a station and go on generating it.
   */
  const nudge = useCallback((node: number, from: Cell, by: Cell) => {
    pinStation(node, {
      column: Math.max(0, from.column + by.column),
      row: Math.max(0, from.row + by.row),
    });
  }, []);

  /* A press that moved is a drag and nothing else. */
  const pick = useCallback(
    (number: number, already: boolean) => {
      if (dragged.current) {
        dragged.current = false;
        return;
      }
      onSelect(already ? null : number);
    },
    [onSelect],
  );

  /*
   * Where the pointer is, and nothing else. View-local by rule 1's own terms —
   * this is where the operator is looking, not something that is true about the
   * map — and it discloses nothing: every station, every word and every length
   * of track is drawn before anything is hovered. What changes is salience.
   */
  const [lit, setLit] = useState<number | null>(null);
  const light = useCallback((number: number | null) => setLit(number), []);
  const thread = lit === null ? null : (threads.get(lit) ?? null);

  const map = model.map;
  if (map === null) {
    /* An absence, in the chrome's own words rather than a second set. */
    return (
      <section className={styles.plate} aria-label={PLATE_LABEL}>
        <p className={styles.absence}>{NO_MAP_OPEN}</p>
      </section>
    );
  }

  const designated = designatedNumber(map.frontier);
  const width = plate.extent.columns * CELL_PIXELS;
  const height = plate.extent.rows * CELL_PIXELS;

  return (
    <section className={styles.plate} aria-label={PLATE_LABEL}>
      <svg
        className={styles.field}
        /* Natural size, and never a scale to fit: the label boxes are reserved
           in cells of [`CELL_PIXELS`], so a drawing squeezed into a narrower
           column is a drawing whose plates no longer hold their own words. Too
           narrow and above the floor, the view column scrolls; under the floor
           the shell stands the view down. */
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="group"
        aria-label="Stations, and the track between them"
        data-field
        data-lit={thread === null ? undefined : ""}
        /* On the field rather than on the station: a hand that let go a little
           past the station it grabbed still finished the gesture it started. */
        onPointerUp={settle}
        /* Off the drawing is a gesture abandoned, not a station put in the
           margin. */
        onPointerLeave={() => {
          grabbed.current = null;
        }}
      >
        {/* Track first, so a station is never drawn under the line reaching
            it. */}
        <g className={styles.tracks} aria-hidden="true">
          {plate.track.map((track) => (
            <TrackLine
              key={`${track.from}-${track.to}`}
              track={track}
              plate={plate}
              receded={thread !== null && threads.get(track.from) !== thread}
            />
          ))}
          {plate.fans.map((fan) => (
            <FanStem
              key={fan.from}
              fan={fan}
              plate={plate}
              receded={thread !== null && threads.get(fan.from) !== thread}
            />
          ))}
        </g>

        <g role="list">
          {plate.stations.map((station) => (
            <StationMark
              key={station.number}
              station={station}
              plate={plate}
              designated={designated === station.number}
              selected={selected === station.number}
              receded={thread !== null && threads.get(station.number) !== thread}
              onPick={pick}
              onGrab={grab}
              onNudge={nudge}
              onUnpin={unpinStation}
              onLight={light}
            />
          ))}
        </g>
      </svg>

      {/*
        The margin: everything that is not the drawing, in space the topology
        cannot grow into. The legend names the conventions the picture cannot
        explain about itself, and the fog rides beside the graph rather than in
        it — it is the one region of the map with no station to be.
      */}
      <aside className={styles.margin}>
        <Legend entries={plate.legend} />
        <p className={styles.note}>{PIN_NOTE}</p>
        {/*
          Only where there is an arrangement to put back. Not a disclosure —
          rule 10 is about what a hover reveals, and this is a fact about the
          map rather than about where anybody is pointing: a plate nobody
          arranged has nothing to undo, and the sentence above it announces the
          gesture long before there is anything to use it on.
        */}
        {pins.size === 0 ? null : (
          <button className={styles.reset} type="button" onClick={() => clearPins()}>
            {PUT_BACK}
          </button>
        )}
        <FogRegion fog={map.fog} />
      </aside>
    </section>
  );
}

/** Cells to pixels, and the only place in the app the two are converted. */
function xOf(plate: Geometry, column: number): number {
  return (column - plate.extent.origin.column) * CELL_PIXELS;
}

function yOf(plate: Geometry, row: number): number {
  return (row - plate.extent.origin.row) * CELL_PIXELS;
}

function pathOf(
  plate: Geometry,
  points: readonly { readonly column: number; readonly row: number }[],
): string {
  return points
    .map(
      (cell, index) =>
        `${index === 0 ? "M" : "L"} ${xOf(plate, cell.column)} ${yOf(plate, cell.row)}`,
    )
    .join(" ");
}

/**
 * One length of track: *this waits on that*, drawn as the router routed it.
 *
 * Not an arrow. Direction is read off the ranks — every track runs left to
 * right, because a rank is how deep in the work a station is — and an arrowhead
 * per edge on a graph this size is a field of chevrons.
 */
function TrackLine({
  track,
  plate,
  receded,
}: {
  track: Track;
  plate: Geometry;
  receded: boolean;
}) {
  return (
    <path
      className={receded ? `${styles.track} ${styles.receded}` : styles.track}
      d={pathOf(plate, track.points)}
      data-track={`${track.from}-${track.to}`}
    />
  );
}

/**
 * A fan: one station unlocking several, drawn as one stem with a knuckle per
 * branch rather than as four unrelated lines leaving the same place.
 *
 * *Finishing this frees four things* is the most actionable fact a dependency
 * graph carries, and the stem says it once.
 */
function FanStem({ fan, plate, receded }: { fan: Fan; plate: Geometry; receded: boolean }) {
  return (
    <g
      className={receded ? `${styles.fan} ${styles.receded}` : styles.fan}
      data-fan={fan.from}
      data-branches={fan.branches.length}
    >
      <path className={styles.fanSpine} d={pathOf(plate, fan.spine)} />
      {fan.branches.map((branch) => (
        <circle
          key={branch.to}
          className={styles.fanKnuckle}
          cx={xOf(plate, branch.leaves.column)}
          cy={yOf(plate, branch.leaves.row)}
          r={2}
        />
      ))}
    </g>
  );
}

/**
 * One station, and the plate that names it.
 *
 * `data-state` and `data-mark` are two different claims, exactly as they are on
 * the Route: the first is the model's own word about the ticket, the second is
 * what this drawing is willing to say about it. `data-frontier` carries
 * `map.frontier` verbatim and is withheld only where the mark has already
 * refused the offer — a suppressed hook, never a second resolver.
 *
 * The plate is the solver's reserved box turned into pixels, and a cut station
 * gets two of them across: the words the branch stopped in are a text node on
 * the drawing, never a tooltip and never a `title`.
 */
function StationMark({
  station,
  plate,
  designated,
  selected,
  receded,
  onPick,
  onGrab,
  onNudge,
  onUnpin,
  onLight,
}: {
  station: Station;
  plate: Geometry;
  designated: boolean;
  selected: boolean;
  receded: boolean;
  onPick: (number: number, already: boolean) => void;
  onGrab: (number: number, from: Cell, event: ReactPointerEvent) => void;
  onNudge: (number: number, from: Cell, by: Cell) => void;
  onUnpin: (number: number) => void;
  onLight: (number: number | null) => void;
}) {
  const { node } = station;
  const mark = markOf(node, designated);
  const cut = node.cut.cut === "fromScope" ? node.cut.reason : null;
  const attendance = attendanceOf(node);

  /* Picking the station you already picked puts it back, so a selection is
     never something you have to go somewhere else to undo. */
  const choose = () => onPick(node.number, selected);

  const x = xOf(plate, station.at.column);
  const y = yOf(plate, station.at.row);
  /* The label's reserved box, in the station's own coordinates. Double across
     when a reason has to fit beside the name — a size, never a position. */
  const box = station.label.box;
  const plateWidth = box.columns * CELL_PIXELS * (cut === null ? 1 : 2);

  return (
    <g
      className={receded ? `${styles.station} ${styles.receded}` : styles.station}
      transform={`translate(${x} ${y})`}
      role="listitem"
      data-node={node.number}
      data-state={node.state}
      data-kind={node.kind.kind}
      data-mark={mark}
      data-siding={station.siding ? "" : undefined}
      data-crowded={station.label.crowded ? "" : undefined}
      /* Withheld from a station the mark has already refused, so the drawing
         never says *terminus* in the shape and *start here* in the DOM. */
      data-frontier={
        designated && mark !== "destination" && mark !== "unclassified" ? "" : undefined
      }
      data-elsewhere={node.boundElsewhere ? "" : undefined}
      data-cut={cut === null ? undefined : ""}
      /* Whose hand put it here, so a reader — and a test — can tell an authored
         station from a generated one without asking the store. */
      data-pinned={station.pinned ? "" : undefined}
      data-plate={cut === null ? undefined : "double"}
      data-selected={selected ? "" : undefined}
      aria-current={selected ? "true" : undefined}
      tabIndex={0}
      onClick={choose}
      onPointerDown={(event) => onGrab(node.number, station.at, event)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          // Space scrolls the pane otherwise, which moves the thing being picked.
          event.preventDefault();
          choose();
          return;
        }
        /* A modified key belongs to the browser or to the window manager, and
           this view does not take one out of their hands. */
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (event.key === "Backspace" || event.key === "Delete") {
          /* Nothing to put back is nothing to do, and the gesture that undoes a
             pin must never be the one that makes one. */
          if (!station.pinned) return;
          event.preventDefault();
          onUnpin(node.number);
          return;
        }
        const by = NUDGE.get(event.key);
        if (by === undefined) return;
        // An arrow scrolls the pane otherwise, which moves what is being moved.
        event.preventDefault();
        /* One press, one cell. A held arrow is the browser repeating itself and
           not a hand making twenty gestures — and rule 9 rations a write to the
           gesture, so autorepeat gets no writes at all. */
        if (event.repeat) return;
        onNudge(node.number, station.at, by);
      }}
      onMouseEnter={() => onLight(node.number)}
      onMouseLeave={() => onLight(null)}
      /* The keyboard gets the emphasis the pointer gets. A thread that only
         comes forward under a pointer answers *which thread is this* to one
         half of the people who ask it. */
      onFocus={() => onLight(node.number)}
      onBlur={() => onLight(null)}
    >
      <g className={styles.glyph} aria-hidden="true">
        <Glyph mark={mark} />
        {/* The cut's own shape, struck across the disc the state already chose
            rather than replacing it: a cut is a decoration, not an eighth
            mark. */}
        {cut === null ? null : (
          <line className={styles.markCut} x1={-8} y1={8} x2={8} y2={-8} />
        )}
        {/* The stub that makes a siding legible as track rather than as a
            station somebody forgot to connect. The legend names it. */}
        {station.siding ? (
          <line className={styles.sidingStub} x1={0} y1={0} x2={CELL_PIXELS} y2={0} />
        ) : null}
      </g>

      <foreignObject
        className={styles.plateBox}
        x={xOf(plate, box.column) - x}
        y={yOf(plate, box.row) - y}
        width={plateWidth}
        height={box.rows * CELL_PIXELS}
      >
        {/*
          The plate itself: HTML inside the drawing, so the browser ellipsises a
          long name while the whole string stays in the document — and so the
          words are clipped by the box the solver reserved rather than growing
          out into the field the track runs through.
        */}
        <div className={styles.name}>
          <span className={styles.id}>#{node.number}</span>
          <span className={styles.title}>{node.title}</span>
          <span className={styles.tags}>
            {mark === "claimed" ? (
              <span className={`${styles.tag} ${styles.tagLive}`}>{CLAIMED_TAG}</span>
            ) : null}
            {mark === "designated" ? (
              <span className={`${styles.tag} ${styles.tagDesignated}`}>{DESIGNATED_TAG}</span>
            ) : null}
            {node.boundElsewhere ? (
              <span className={styles.tag}>{BOUND_ELSEWHERE_TAG}</span>
            ) : null}
            <KindTag node={node} />
            {attendance === null ? null : <span className={styles.tag}>{attendance}</span>}
          </span>
          {/* Why the branch stopped, in the operator's own words, on the
              drawing. A text node and nothing else: no tooltip, no `title`,
              nothing a pointer has to be held still to reveal. */}
          {cut === null ? null : <span className={styles.reason}>{cut}</span>}
        </div>
      </foreignObject>
    </g>
  );
}

/**
 * The shape, and the shape is the whole of it — all seven differ in geometry
 * rather than in hue, so collapsing every colour token to one value leaves
 * every one of them still told apart.
 *
 * Claimed is the train on the line: a lozenge inside a second outline. It
 * carries the only liveness this side of the seam has — somebody has this
 * ticket in their hands — and it carries it standing still, because `NodeState`
 * has no running-vs-stale bit for motion to be spent on.
 */
function Glyph({ mark }: { mark: Mark }): ReactElement {
  switch (mark) {
    case "claimed":
      return (
        <g className={GLYPHS.claimed}>
          <rect className={styles.lozenge} x={-8} y={-4} width={16} height={8} rx={4} />
          <rect className={styles.lozengeRing} x={-11} y={-7} width={22} height={14} rx={7} />
        </g>
      );
    case "designated":
      return (
        <g className={GLYPHS.designated}>
          <circle className={styles.interchange} cx={0} cy={0} r={8} />
          <circle className={styles.interchangeHub} cx={0} cy={0} r={3} />
        </g>
      );
    case "blocked":
      return (
        <g className={GLYPHS.blocked}>
          <rect className={styles.bar} x={-6} y={-6} width={12} height={12} />
          <line className={styles.barSlash} x1={-6} y1={0} x2={6} y2={0} />
        </g>
      );
    case "resolved":
      return <circle className={GLYPHS.resolved} cx={0} cy={0} r={5} />;
    case "unclassified":
      /* A form break and never a hue: a square on the diagonal, the one shape
         on this drawing that is neither a disc nor on a line. */
      return (
        <rect
          className={GLYPHS.unclassified}
          x={-5}
          y={-5}
          width={10}
          height={10}
          transform="rotate(45)"
        />
      );
    case "destination":
      /* The far end of the line, drawn as a terminus. Never the offer's ring: a
         spec is where the map is going, not something to take. */
      return <path className={GLYPHS.destination} d="M -8 -8 L 8 0 L -8 8 Z" />;
    case "takeable":
      return <circle className={GLYPHS.takeable} cx={0} cy={0} r={6} />;
  }
}

/** What this child is, in the model's own three words. The switch is
 *  exhaustive, so a fourth `ChildKind` from Rust is a compile error here rather
 *  than a station that quietly says nothing about itself. */
function KindTag({ node }: { node: Node }): ReactElement {
  switch (node.kind.kind) {
    case "ticket":
      return <span className={styles.tag}>{node.kind.type}</span>;
    case "spec":
      return <span className={`${styles.tag} ${styles.tagSpec}`}>{SPEC_TAG}</span>;
    case "unclassified":
      return (
        <span className={`${styles.tag} ${styles.tagUnclassified}`}>{UNCLASSIFIED_TAG}</span>
      );
  }
}

/**
 * The conventions, named out loud.
 *
 * A siding is the one piece of vocabulary on this drawing an operator cannot
 * read off the picture — track that goes nowhere looks like a mistake until
 * something says it is a claim. The entries arrive from the geometry and appear
 * only when the drawing actually contains the thing they explain, so this is
 * never a legend for somebody else's diagram.
 */
function Legend({ entries }: { entries: readonly LegendEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <section className={styles.legend} aria-labelledby="plate-legend" data-legend>
      <h2 className={styles.marginHeading} id="plate-legend">
        {LEGEND_HEADING}
      </h2>
      <ul className={styles.legendList}>
        {entries.map((entry) => (
          <li className={styles.legendItem} key={entry.key} data-legend-key={entry.key}>
            <span className={styles.legendCount}>{entry.count}</span>
            <span className={styles.legendMeaning}>{entry.meaning}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The fog, riding beside the graph: a region that names itself first and counts
 * itself second.
 *
 * The two absences differ in **form** and not in a character. Nobody surveyed
 * stands an em dash where a numeral would go and draws no ground beneath the
 * stamp at all; a surveyed region draws a numeral and always draws its hatched
 * ground under it. Nothing has to read a glyph to tell the two apart, and
 * neither difference is a colour.
 */
function FogRegion({ fog }: { fog: Fog }) {
  if (fog.fog === "unsurveyed") {
    return (
      <section className={styles.fog} data-fog="unsurveyed" aria-labelledby="plate-fog">
        <h2 className={styles.marginHeading} id="plate-fog">
          <span className={styles.fogName}>{FOG_HEADING}</span>
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
    <section className={styles.fog} data-fog="surveyed" aria-labelledby="plate-fog">
      <h2 className={styles.marginHeading} id="plate-fog">
        <span className={styles.fogName}>{FOG_HEADING}</span>
        <span className={styles.fogCount} data-count>
          {fog.region.count}
        </span>
      </h2>
      {/* The ground nobody has charted, hatched under the stamp. Decoration
          with no reading of its own: everything it says, the stamp above it has
          already said in a word and a numeral. */}
      <div className={styles.hatch} data-hatch aria-hidden="true" />
      {fog.region.text === "" ? (
        <p className={styles.fogEmpty}>{FOG_ALL_CHARTED}</p>
      ) : (
        /* One text node, unmodified: the parse in Rust is the only thing that
           ever chose where this string starts and stops. */
        <pre className={styles.fogText}>{fog.region.text}</pre>
      )}
    </section>
  );
}

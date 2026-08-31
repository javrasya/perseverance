import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from "react";
import type { Node } from "../../snapshot/model.generated";
import { NO_MAP_OPEN } from "../../snapshot/readout";
/*
 * The props are the shared type and never a local one — the same refusal
 * `Route.tsx` states, and the reason it is stated twice is that the check
 * `tests/views.test.ts` runs is per view.
 */
import type { ViewProps } from "../views";
/*
 * The words a plate says, and the arithmetic that sizes the box they go in.
 * *unclassified* and *spec* are still borrowed rather than respelled — they are
 * what a child **is**, decided in Rust and already spelled once for the Route —
 * and `bench.ts` is where that borrowing now happens, because the chip's width
 * is part of the plate's height. Nothing else crosses from that view: the
 * marks, the shapes, the layout and the palette below are the Bench's own.
 */
import {
  HOP_GAP,
  benchOf,
  beyondTheMapLabel,
  fanOutLabel,
  kindTag,
  waitingOnLabel,
  type Edge,
  type Plate,
} from "./bench";
import styles from "./Bench.module.css";

/**
 * The Bench, drawn: the schematic, and the half of the graph The Route cannot
 * say.
 *
 * **A canvas of plates with wires between them.** Rank runs down the page,
 * every plate is placed at a coordinate, and the dependencies are drawn as
 * orthogonal lines that break where they cross. That is the whole of the
 * distance from the Route, which places nothing and draws nothing between two
 * rows: here position *is* the topology, and what the operator gets for it is
 * **fan-out** — how many tickets wait on this one, which is the question *is
 * this the one to unblock* and the reason this view exists beside that one.
 *
 * Nothing is derived here. `benchOf(model, width)` answers with every band,
 * plate, coordinate and polyline that reaches the screen; this file chooses a
 * shape, a word and an ink for what it is handed. It is called on every render
 * and its answer is kept nowhere — no memo, no ref, no store — which is
 * contract rule 8 held the way `bench.ts` holds it: a coordinate that outlives
 * the model it was computed for is a plate sitting where a ticket used to be.
 *
 * **An HTML plate layer over an SVG wire layer**, rather than one SVG canvas.
 * A plate is a real element: it wraps its own title, takes the app's own focus
 * ring, is hit-tested by the browser and is found by a page search. In SVG each
 * of those is either a `foreignObject` or hand-broken text. The wires are the
 * one thing HTML cannot draw, so they are the one thing in SVG — and that layer
 * is `aria-hidden`, because a wire is a restatement of a tally the plate at each
 * end already prints in words.
 *
 * **No fog region, and the omission is the decision.** The fog is what nobody
 * has specified yet — it is not a node, it has no rank and nothing waits on it,
 * so there is no honest place for it on a graph of the children. It stays with
 * the chrome, which already draws it, and this view therefore never prints an
 * absence in a numeral's slot at all. Rule 4's live case here is the pair of
 * blocker tallies, which are counted apart and never summed: *waiting on 3* and
 * *1 off this map* are two claims, and one number over them would be this
 * canvas asserting a state it has no plate for.
 *
 * **No progress anywhere.** Not a bar, not a ratio, not three numerals: what a
 * plate says about itself is its state, its edges and its words.
 *
 * **Import this file as `Bench.jsx`.** It sits beside `bench.ts`, macOS and
 * Windows filesystems are case-insensitive, and that module exports a `Bench`
 * *type* — so an extensionless `./Bench` resolves to the arithmetic and this
 * component is never found. Exactly the landmine `Route.jsx` documents.
 */

/**
 * The rank rail's own column, in pixels, outside the canvas.
 *
 * Rule 11: annotation gets reserved space the topology cannot grow into. The
 * rail is a fixed column beside the drawing, so a rank label never lands on a
 * plate and a plate never has to make room for one.
 *
 * It is a number here rather than only a length in the stylesheet because the
 * measurement and the drawing have to be the same number: `benchOf` is handed
 * the canvas width, which is the frame **less this rail**, and if the two ever
 * disagreed the columns arithmetic and the width floor would stop agreeing with
 * what is on screen. One constant, applied to the rail and subtracted from the
 * frame.
 */
export const RANK_RAIL = 56;

/** What the rail says beside a band. */
export const rankLabel = (rank: number): string => `rank ${rank}`;

/*
 * The chips' words are `bench.ts`'s, and re-exported here because this is where
 * they used to be. They moved with the box: a plate is reserved the height its
 * own content needs, and the widths that wrap the chips onto two lines or three
 * are the widths of these strings — so the arithmetic that sizes the plate and
 * the element that prints the chip have to be reading one spelling.
 */
export { beyondTheMapLabel, fanOutLabel, waitingOnLabel } from "./bench";

/** What the view says when the window is narrower than it can draw in. */
export const standDownNote = (needs: number, has: number): string =>
  `The Bench needs ${needs}px of canvas and has ${has}px.`;

/**
 * The Bench's own encoding, and it is not `data-state`.
 *
 * Seven marks over four states: the state, plus the designation the map made,
 * plus the two kinds of child that are not on the scale of work at all.
 */
type Mark =
  | "claimed"
  | "designated"
  | "takeable"
  | "blocked"
  | "resolved"
  | "unclassified"
  | "destination";

/**
 * One shape per mark, and the shape is the whole of the distinction.
 *
 * Rule 3, and the reason these are classes on an inner element rather than
 * colours on the plate: a square, a hollow diamond, a hatched bar, a filled
 * chevron and a dashed circle are still seven things when every semantic ink on
 * the screen collapses to one value. The plate's ink comes from `[data-mark]`
 * in the stylesheet; the geometry comes from here.
 *
 * `satisfies` rather than an annotation, so a mark added without a shape is a
 * compile error rather than a plate with an empty stud on it.
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

/**
 * One plate's precedence, and it is `markOf` in `route.ts` asked in the same
 * order for the same reasons: the cut first, then the kind, then claimed, then
 * the designation, then the state.
 *
 * The cut first because a cut is a **decoration composed onto resolved** and
 * never a fifth state beside it (rule 6) — so the mark under the strike has to
 * be the state the cut is true of. The kind above the designation because the
 * designated shape is the one thing on this canvas that says *start this*, and
 * a child nobody classified may never wear it whatever `map.frontier` says
 * (rule 3). Claimed above designated because *somebody is on this* is the
 * stronger claim, and two operators sent at one ticket is the failure that
 * ordering prevents.
 */
function markOf(node: Node, designated: boolean): Mark {
  if (node.cut.cut === "fromScope") return node.state;
  if (node.kind.kind === "spec") return "destination";
  if (node.kind.kind === "unclassified") return "unclassified";
  if (node.state === "claimed") return "claimed";
  if (designated) return "designated";
  return node.state;
}

/**
 * The canvas width, measured from the frame and never handed in.
 *
 * `ViewProps` carries no width and is not allowed to grow one, so the view
 * measures its own root — `useBodyBox`'s pattern, and deliberately **not** a
 * `ResizeObserver`: the app has exactly one, it is `Pane`'s, and it stays
 * singular because it is the single path to a PTY resize. After every render
 * plus a window resize is every layout change the shell can cause.
 *
 * A frame below a pixel is not a narrow frame, it is a frame nobody has laid
 * out yet — first paint, and every jsdom test, where `getBoundingClientRect`
 * answers zero for everything. The window is the honest fallback, less the
 * rail, which is the same subtraction the laid-out case makes.
 */
function useCanvasWidth(frame: RefObject<HTMLElement | null>): number {
  const canvasOf = (outer: number) => Math.max(0, outer - RANK_RAIL);
  const [width, setWidth] = useState(() =>
    canvasOf(typeof window === "undefined" ? 0 : window.innerWidth),
  );

  const measure = useCallback(() => {
    const measured = frame.current?.getBoundingClientRect().width ?? 0;
    const next = Math.max(0, (measured >= 1 ? measured : window.innerWidth) - RANK_RAIL);
    setWidth((was) => (was === next ? was : next));
  }, [frame]);

  // No dependency list, and an unchanged measurement sets no state, so this
  // settles in one pass rather than looping.
  useLayoutEffect(measure);

  useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  return width;
}

export function Bench({ model, selected, onSelect }: ViewProps) {
  const frame = useRef<HTMLElement | null>(null);
  const width = useCanvasWidth(frame);

  /*
   * Every render, from the two arguments, and kept nowhere. `benchOf` is a pure
   * function of the model and the width; a memo here would buy nothing the
   * render does not already pay for and would be the first place a stale
   * coordinate could live.
   */
  const bench = benchOf(model, width);

  return (
    <section className={styles.bench} aria-label="The Bench" ref={frame}>
      <Body bench={bench} model={model} selected={selected} onSelect={onSelect} />
    </section>
  );
}

function Body({
  bench,
  model,
  selected,
  onSelect,
}: {
  bench: ReturnType<typeof benchOf>;
  model: ViewProps["model"];
  selected: number | null;
  onSelect: (number: number | null) => void;
}) {
  /*
   * The window's answer first, exactly as `benchOf` asks it first: a canvas
   * this narrow has nothing to say about the map on it. The two numbers are
   * printed rather than an apology drawn — the operator is the one who widens
   * the window, and they cannot widen it by how much without being told how
   * much. No advice about which view to open instead: that is the dial's
   * answer and it already has one.
   */
  if (!bench.drawn) {
    return <p className={styles.standDown}>{standDownNote(bench.needs, bench.has)}</p>;
  }

  const map = model.map;
  if (map === null) {
    /* An absence, in the chrome's own words rather than a second set. */
    return <p className={styles.absence}>{NO_MAP_OPEN}</p>;
  }

  /*
   * `map.frontier`'s number, verbatim and unresolved. Nothing on this side
   * decides what may be started; this reads the one answer there is.
   */
  const designated = map.frontier.frontier === "designated" ? map.frontier.number : null;

  return (
    <div className={styles.stage} style={{ height: bench.height }}>
      {/*
        The rail: rule 11's reserved column, outside the canvas box. It is the
        only annotation on the drawing that is not inside a plate's own bounds,
        and it has its own column so the topology cannot grow into it.
      */}
      <ul className={styles.rail} style={{ width: RANK_RAIL }}>
        {bench.bands.map((band) => (
          <li
            key={band.rank}
            className={styles.rank}
            data-rank={band.rank}
            style={{ top: band.top, height: band.height }}
          >
            {rankLabel(band.rank)}
          </li>
        ))}
      </ul>

      <div className={styles.canvas} style={{ width: bench.width, height: bench.height }}>
        <Wires edges={bench.edges} width={bench.width} height={bench.height} />
        <ul className={styles.plates}>
          {bench.plates.map((plate) => (
            <PlateCard
              key={plate.node.number}
              plate={plate}
              designated={designated}
              selected={selected === plate.node.number}
              onSelect={onSelect}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * The wires, and they are the only thing here that is not HTML.
 *
 * `aria-hidden`, because every edge drawn is a fact the two plates it joins
 * already print in words — *unblocks 3* at one end and *waiting on 2* at the
 * other. A reader that cannot see the canvas loses no claim by not being read
 * a polyline.
 *
 * **Nothing here is animated.** Marching ants were the sketched vocabulary and
 * they are not built: an ant train says *this edge is live*, and there is no
 * liveness bit on this side of the seam for an edge to have — `NodeState` is
 * four words and none of them is *running*. Motion spent on a distinction the
 * model cannot make is motion that lies. Rule 9, and rule 12's still-state
 * question is answered by there being no motion here to have one.
 */
function Wires({
  edges,
  width,
  height,
}: {
  edges: readonly Edge[];
  width: number;
  height: number;
}) {
  return (
    <svg
      className={styles.wires}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      focusable="false"
    >
      {edges.map((edge) => (
        <g
          key={`${edge.from}-${edge.to}`}
          className={styles.wire}
          data-edge={`${edge.from}-${edge.to}`}
        >
          <path className={styles.wireLine} d={pathOf(edge)} />
          <polygon className={styles.wireHead} points={headOf(edge)} />
        </g>
      ))}
    </svg>
  );
}

/**
 * One edge as a path, broken where another edge crosses it.
 *
 * The break is a `M` in the middle of the run and not a second element: one
 * `d`, one stroke, one thing to style. `hops` arrive sorted ascending and are
 * strictly inside the run, so they are walked in the direction the run goes —
 * a right-to-left edge consumes them in reverse, and the gap straddles the
 * crossing rather than starting at it.
 *
 * Nothing is curved. A curve at this scale reads as a relationship rather than
 * as a wire, and two curves that meet are ambiguous where two straight lines
 * are not.
 */
function pathOf(edge: Edge): string {
  const first = edge.points[0];
  if (first === undefined) return "";

  const half = HOP_GAP / 2;
  let drawn = `M ${first.x} ${first.y}`;

  for (let leg = 0; leg + 1 < edge.points.length; leg += 1) {
    const start = edge.points[leg];
    const end = edge.points[leg + 1];
    if (start === undefined || end === undefined) continue;

    const forward = end.x >= start.x;
    const on = edge.hops.filter((hop) => hop.leg === leg).map((hop) => hop.x);
    for (const hop of forward ? on : [...on].reverse()) {
      const before = forward ? hop - half : hop + half;
      const after = forward ? hop + half : hop - half;
      drawn += ` L ${before} ${start.y} M ${after} ${start.y}`;
    }
    drawn += ` L ${end.x} ${end.y}`;
  }
  return drawn;
}

/**
 * The head, at the plate that waits.
 *
 * A drawn triangle rather than a `marker-end`: the path has gaps in it, and
 * which vertex a marker lands on when a path has several subpaths is a thing
 * browsers disagree about. Every edge enters its plate from the top and points
 * down, including the one a cut cycle left running back up the canvas — that
 * edge goes up, along and down again, which is visibly odd, and the map it came
 * from is.
 */
function headOf(edge: Edge): string {
  const end = edge.points[edge.points.length - 1];
  if (end === undefined) return "";
  return `${end.x - 4},${end.y - 7} ${end.x + 4},${end.y - 7} ${end.x},${end.y}`;
}

/**
 * One plate.
 *
 * `data-state` is the model's own word, spelled and never re-derived.
 * `data-mark` is this view's encoding, which folds the cut, the kind and the
 * designation in. `data-kind` is the model's third word. They are three claims
 * and never one.
 *
 * `data-frontier` carries `map.frontier`'s **number** rather than a flag, so a
 * later reader can see which node the map named and not merely that it named
 * one. It is withheld from a plate whose mark has yielded — to `claimed`, to
 * the destination, or to a child nobody classified — because drawing the
 * offer's own attribute there would leave the canvas saying two things at once:
 * a shape that refuses the offer and *start here* in the DOM. A rendering
 * suppression and never a second answer; `map.frontier` remains the only thing
 * that decides.
 *
 * **Resolved stays locatable** (rule 13, and this view's own author named it as
 * the largest cost): a finished plate keeps its place in the canvas, its ink,
 * its click and its `tabIndex`. What it gives up is salience — a quieter fill
 * and a faded glyph — and never visibility. There is no opacity on the plate,
 * no `display`, and nothing is dropped from the drawing.
 *
 * Hover discloses nothing (rule 10): the stylesheet lifts the plate a pixel and
 * brightens its border, and that is the whole of it. There is **no `title`
 * anywhere on this canvas** — not on the plate, not on the title, and
 * emphatically not on the cut's reason.
 */
function PlateCard({
  plate,
  designated,
  selected,
  onSelect,
}: {
  plate: Plate;
  designated: number | null;
  selected: boolean;
  onSelect: (number: number | null) => void;
}) {
  const { node, facts } = plate;
  const isDesignated = designated === node.number;
  const mark = markOf(node, isDesignated);

  /* Picking the plate you already picked puts it back, so a selection is never
     something you have to go somewhere else to undo. */
  const choose = () => onSelect(selected ? null : node.number);

  return (
    <li
      className={styles.plate}
      style={{
        left: plate.x,
        top: plate.y,
        width: plate.width,
        minHeight: plate.height,
      }}
      data-node={node.number}
      data-state={node.state}
      data-kind={node.kind.kind}
      data-mark={mark}
      data-frontier={isDesignated && mark === "designated" ? node.number : undefined}
      data-cut={plate.reason === null ? undefined : ""}
      data-selected={selected ? "" : undefined}
      aria-current={selected ? "true" : undefined}
      tabIndex={0}
      onClick={choose}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        // Space scrolls the canvas otherwise, which moves the thing being picked.
        event.preventDefault();
        choose();
      }}
    >
      <span className={styles.stud} aria-hidden="true">
        {/* The cut's own shape, composed onto the mark rather than replacing
            it: a strike across the resolved square, which is what a cut is. */}
        <span
          className={
            plate.reason === null
              ? GLYPHS[mark]
              : `${GLYPHS[mark]} ${styles.markCut ?? ""}`
          }
        />
      </span>
      <span className={styles.id}>#{node.number}</span>
      {/* In full, and wrapped rather than ellipsised or hidden behind a
          pointer: the whole title is in the document to be read, searched and
          asserted on. */}
      <span className={styles.title}>{node.title}</span>
      <span className={styles.facts}>
        {/*
          Fan-out, on every plate including the ones nothing waits on. A zero
          here is a true and useful claim — *closing this frees nobody* — and it
          is the claim an operator is reading this view to make, so it is never
          left to an absence.
        */}
        <span className={styles.fact} data-fan-out>
          {fanOutLabel(facts.fanOut.length)}
        </span>
        {/*
          The two tallies, apart. Each is drawn only when it has something to
          say, because *waiting on 0* on a takeable plate is a contradiction an
          operator can see — and the pair is never added up.
        */}
        {facts.stillInTheWay > 0 ? (
          <span className={styles.fact} data-waiting-on>
            {waitingOnLabel(facts.stillInTheWay)}
          </span>
        ) : null}
        {facts.beyondTheMap > 0 ? (
          <span className={styles.fact} data-beyond-the-map>
            {beyondTheMapLabel(facts.beyondTheMap)}
          </span>
        ) : null}
        <KindTag node={node} />
      </span>
      {/*
        Why the branch stopped, in the operator's own sentence, laid out in the
        second plate this plate was given for it. A text node and nothing else:
        no ellipsis, no smaller face, no hover and no `title` — a cut whose
        reason nobody can see is a cut that reads as a finished ticket. Rule 6.
      */}
      {plate.reason === null ? null : (
        <span className={styles.reason} data-reason>
          {plate.reason}
        </span>
      )}
    </li>
  );
}

/**
 * What this child is, in the model's own three words.
 *
 * A child nobody classified says so in a word as well as in a shape, because a
 * shape has to be learned while a word is read by anyone, by a page search and
 * by a screenshot — and it is the strongest of the three channels that survive
 * every colour on this canvas collapsing to one. Rule 3.
 *
 * The switch is exhaustive and the return type annotated, so a fourth
 * `ChildKind` arriving from Rust is a compile error here rather than a plate
 * that quietly says nothing about itself.
 */
function KindTag({ node }: { node: Node }): ReactElement {
  switch (node.kind.kind) {
    case "ticket":
    case "spec":
      return <span className={styles.fact}>{kindTag(node)}</span>;
    case "unclassified":
      return (
        <span className={`${styles.fact} ${styles.factLoud}`} data-unclassified>
          {kindTag(node)}
        </span>
      );
  }
}

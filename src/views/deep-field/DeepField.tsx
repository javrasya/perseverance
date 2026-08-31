import { useMemo, useRef, type ReactElement } from "react";
import { THE_WINDOW, useMeasuredWidth } from "../../panes/useMeasuredWidth";
import type { Counts, Frontier, Node, NodeState } from "../../snapshot/model.generated";
import {
  NOTHING_FOR_THIS_MACHINE,
  NO_FRONTIER,
  NO_MAP_OPEN,
} from "../../snapshot/readout";
/*
 * The props are the shared type and never a local one, for the reason
 * `Route.tsx` gives: a view that declared its own could widen them to the whole
 * snapshot, and what a view is handed is decided in exactly one place.
 */
import type { ViewProps } from "../views";
import { beyondTheMapNote, blockedByLabel } from "../graph";
import {
  BOUND_ELSEWHERE_TAG,
  DESIGNATED_TAG,
  SPEC_TAG,
  STATE_NAMES,
  UNCLASSIFIED_TAG,
} from "../vocabulary";
import {
  CIRCULAR_TAG,
  NOBODY_SURVEYED,
  deepFieldOf,
  type FanOut,
  type FieldFog,
  type Mark,
  type Plate,
  type StandDown,
} from "./deepField";
import styles from "./DeepField.module.css";

/**
 * Deep Field, drawn: the plate lane on the left, the field on the right, and
 * the boundary between them.
 *
 * **Every word is on a plate and the field holds none.** That is rule 11 and it
 * is the whole shape of this file — the lane is real DOM, so a title ellipsises
 * in the browser and a plate takes the app's own focus ring, while the field is
 * one `<svg>` of bare circles and paths with no text node anywhere in it. The
 * boundary is `split.boundary`, drawn once as the lane's own right edge, and the
 * blank to its right is `split.clearance`, which the field's viewBox starts
 * after. Neither x is invented here; `deepField.ts` decided both.
 *
 * Nothing is derived in this file. One call to `deepFieldOf` answers with every
 * rank, curve, tally and word that reaches the screen, and with every
 * coordinate the field is drawn at, and the same map at the same width answers
 * the same way every time — which is what makes *no stored node positions*
 * checkable rather than promised. The plate lane is the one thing the layout
 * does not place: it hands over the lane's width, and how tall a plate is and
 * how far the next one sits below it are the stylesheet's, because a plate is
 * as tall as the words in it. There is no store
 * here, no `localStorage`, and nothing remembered between two renders.
 *
 * The one thing this file finds out for itself is how wide it is, because
 * `ViewProps` carries no width and the app's single `ResizeObserver` is
 * `Pane`'s and stays singular — see [`useMeasuredWidth`] in `src/panes`, which
 * this view shares with the shell rather than copying.
 *
 * **Import this file as `DeepField.jsx`.** It sits beside `deepField.ts`, and
 * macOS and Windows filesystems are case-insensitive, so an extensionless
 * `./DeepField` resolves to the arithmetic module and this component is never
 * found. The `.jsx` specifier maps to `DeepField.tsx` under bundler resolution
 * and matches nothing else.
 */

/**
 * The shape a node wears, on its plate and on its mark alike.
 *
 * Claimed above designated, the same precedence The Route uses and for the same
 * reason: a node somebody is already on would otherwise read as free. Below
 * that it is the model's own state word, unchanged.
 *
 * One function for both lanes, so the glyph on the plate and the mark in the
 * field cannot part company — which is what the rule-12 check leans on when it
 * reads the still form out of the row rather than out of the drawing.
 */
type Form = NodeState | "designated";

function formOf(state: NodeState, designated: boolean): Form {
  if (state === "claimed") return "claimed";
  if (designated) return "designated";
  return state;
}

/*
 * `satisfies` rather than an annotation, exactly as `Route.tsx` has it: a
 * missing form is a compile error while the CSS-module lookup keeps its type.
 *
 * Two tables because a plate's glyph is a bordered box and a mark is an SVG
 * circle — the same five distinctions drawn in the two grammars available.
 * Every one of them is geometry: a ring, a thicker ring, a filled disc, a
 * dashed ring and a faded disc, so nothing here needs a hue to be told apart.
 */
const GLYPHS = {
  takeable: styles.glyphTakeable,
  designated: styles.glyphDesignated,
  claimed: styles.glyphClaimed,
  blocked: styles.glyphBlocked,
  resolved: styles.glyphResolved,
} satisfies Record<Form, string | undefined>;

const MARKS = {
  takeable: styles.markTakeable,
  designated: styles.markDesignated,
  claimed: styles.markClaimed,
  blocked: styles.markBlocked,
  resolved: styles.markResolved,
} satisfies Record<Form, string | undefined>;

/* The fog heading's own id, so its region is labelled by it — the same
   arrangement The Route gives the fog, and the same reason it is not swept in
   with anything a reader asks for by a shared prefix. */
const FOG_ID = "deep-field-fog";

/**
 * The stand-down's two measurements, named.
 *
 * The pixels are already on the value; these are the words they are read by.
 * They are local rather than in `deepField.ts` because they say nothing the
 * layout decided — the layout decided the numbers.
 */
const NEEDS_LABEL = "needs";
const HAS_LABEL = "has";

/** The three integers, headed by the model's own field names and nothing else. */
const COUNT_NAMES = ["tickets", "open", "specs"] as const;

export function DeepField({ model, selected, onSelect }: ViewProps) {
  const root = useRef<HTMLElement | null>(null);
  /*
   * The shell's measurement, on this view's own root: one hook, one rule for a
   * box nobody has laid out yet, shared with the body and the seam.
   *
   * `THE_WINDOW` is a stand-in and not a claim. This root is a fraction of the
   * body — a map side beside a terminal — so before the first layout the window
   * over-reports it, badly and knowingly: the alternative is a zero, and a zero
   * stands the view down on every first paint, which would be an artefact of
   * measurement rather than a fact about the pane. Nothing may *assert* against
   * the stand-in, and that is a live constraint on the tests — `getBoundingClientRect`
   * answers zero for everything in jsdom, so a geometry test has to drive this
   * element's own box or it is measuring the window.
   */
  const width = useMeasuredWidth(root, THE_WINDOW);

  /*
   * A memo and nothing more. `deepFieldOf` is pure and cheap, so this saves a
   * pass over the nodes and buys no correctness — if it were ever load bearing,
   * the coordinates would be state, and stored coordinates are the one thing
   * this view may not have.
   */
  const field = useMemo(() => deepFieldOf(model.map, width), [model, width]);

  return (
    <section ref={root} className={styles.deepField} aria-label="Deep Field">
      {field.kind === "noMapOpen" ? (
        /* An absence, and the chrome's own words for it rather than a second
           set. `App` does not mount a view with no map open; the arm exists so
           that the claim does not depend on `App` continuing not to. */
        <p className={styles.absence}>{NO_MAP_OPEN}</p>
      ) : null}

      {field.kind === "standDown" ? <StandDownNotice standDown={field.standDown} /> : null}

      {field.kind === "field" ? (
        <>
          <header className={styles.readout}>
            {/*
              One line, and it is this view's own. The phase, the three counts
              and the frontier are the footer's — `App`'s `describeModel` line
              carries them at every dial position — and `MapChip` states the
              rule this header keeps: a second reading of the same numbers
              beside the picture could only differ from the footer if one of
              them were wrong. Nothing here restates a number the shell already
              says.
            */}
            {/*
              Where this map's n sits against the band, and it is data rather
              than a verdict: the picture below is drawn either way. A view that
              refused a 40-node map would be making the dial's decision, and the
              dial is the shell's.
            */}
            <p className={styles.standing} data-standing={field.competence.standing}>
              {`${field.competence.nodes} nodes · ${field.competence.low}–${field.competence.high}`}
            </p>
          </header>

          <div className={styles.picture}>
            <ul className={styles.lane} style={{ width: field.split.plates.width }}>
              {field.plates.map((plate) => (
                <PlateRow
                  key={plate.node.number}
                  plate={plate}
                  selected={selected === plate.node.number}
                  onSelect={onSelect}
                />
              ))}
            </ul>

            {/*
              The boundary and the blank beyond it, as one element: the line is
              this span's left edge, which sits at `split.boundary` because the
              lane above is exactly `split.plates.width` wide, and the width
              here is `split.clearance` — the blank no mark may enter at any n.
              Drawn once, from the split, rather than an x written twice and
              free to disagree with itself.
            */}
            <span
              className={styles.gutter}
              data-gutter
              style={{ width: field.split.clearance }}
              aria-hidden="true"
            />

            {/*
              The field. `aria-hidden` on purpose and not by omission: every
              node it draws already has a plate beside it carrying the node's
              number, its title, its state and its tally in words, so a reader
              taken through the circles would be taken through the same map
              twice — the second time with no labels, because rule 11 is exactly
              that there are none here.

              The viewBox starts at `split.field.x` — the boundary plus the
              clearance — so every coordinate below is the layout's own number
              with nothing added to it. A control point *may* sit left of that:
              a back edge spanning more than one rank puts one inside the
              gutter, and the viewport clips it rather than the router
              forbidding it. What may not enter the clearance is drawn ink, and
              that is what `tests/deep-field.test.ts` samples every edge's curve
              for — the clip is the belt, the sampled extent is the braces.
            */}
            <svg
              className={styles.fieldPlot}
              data-field
              aria-hidden="true"
              width={field.split.field.width}
              height={field.split.field.height}
              viewBox={`${field.split.field.x} ${field.split.field.y} ${field.split.field.width} ${field.split.field.height}`}
            >
              {/* Edges first, so a mark is never drawn under the line that
                  leaves it. */}
              {field.fanOut.map((edge) => (
                <Edge key={`${edge.from}>${edge.to}`} edge={edge} />
              ))}
              {field.columns.flatMap((column) =>
                column.marks.map((mark) => <FieldMark key={mark.number} mark={mark} />),
              )}
            </svg>
          </div>

          <FogRegion fog={field.fog} />
        </>
      ) : null}
    </section>
  );
}

/**
 * What the view says when this map will not fit at this width.
 *
 * Which view, why, what it needs and what it has — and then the three integers,
 * the frontier and the fog, which stay alive when the graph does not. A map is
 * still being worked while the picture of it does not fit, and a view that goes
 * blank takes the operator's answer with it. The fog is words and costs no
 * width, so withholding it here would drop rule 4's absence — *nobody
 * surveyed* — in the one state where nothing else on screen says it.
 *
 * **No exits, and the absence is the decision.** Widening the pane is the
 * dial's, in `src/panes/dial.ts`; opening a view that does fit is the
 * switcher's. A second set of controls offered from inside the view would be
 * two controls for one move, and the one an operator reached for would be the
 * one that did the least. Nothing below is a button, a link, or anything with a
 * handler on it.
 */
function StandDownNotice({ standDown }: { standDown: StandDown }) {
  return (
    <div className={styles.standDown} data-stand-down>
      <h2 className={styles.standDownView}>{standDown.view}</h2>
      <p className={styles.standDownReason}>{standDown.reason}</p>
      {/* Named the columns above, in `reason`; the pixels are the same fact in
          the units the pane is measured in, and both are said because *four
          columns will not fit* and *596 against 320* answer different halves of
          the operator's next question. */}
      <p className={styles.measure}>
        <span data-needs>{`${NEEDS_LABEL} ${standDown.needs}px`}</span>
        <span data-has>{`${HAS_LABEL} ${standDown.has}px`}</span>
      </p>
      {/* The one place this view repeats the footer's numbers, and the reason
          is that the picture they belong to is not on screen: with the graph
          gone the notice is the whole of the view, and a column opened to
          answer *how far have I come* would otherwise answer nothing. ADR 0025
          records why the stand-down departs from `MapChip`'s rule where the
          drawn field keeps it. */}
      <Progress counts={standDown.counts} />
      <FrontierReading frontier={standDown.frontier} />
      <FogRegion fog={standDown.fog} />
    </div>
  );
}

/**
 * The three integers, and there is nothing continuous anywhere between them.
 *
 * Rule 5 in the one place a view is most tempted to break it: three numbers
 * that look like a fraction invite a bar, and a bar would be this view
 * asserting a rate of progress off a count of tickets. No rule, no track, no
 * fill, no percentage — three numerals, each under the model's own word for it.
 */
function Progress({ counts }: { counts: Counts }) {
  return (
    <ul className={styles.progress} data-progress>
      {COUNT_NAMES.map((name) => (
        <li key={name} className={styles.progressEntry}>
          <span className={styles.progressName}>{name}</span>
          <span className={styles.progressCount} data-count-of={name}>
            {counts[name]}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * What this map has to say about *what next*, in the chrome's own three
 * readings.
 *
 * Read off `map.frontier` and never re-resolved: the two fields Rust decided it
 * from do not cross the seam at all, so there is nothing on this side to
 * disagree with it even if somebody wanted to. The switch is exhaustive and the
 * return type annotated, so a fourth reading arriving from Rust is a compile
 * error here rather than an empty line on screen.
 *
 * The attribute is `data-frontier-reading` and deliberately not `data-frontier`:
 * that name means *this plate is the one to take*, it belongs to exactly one
 * element on the pane, and a second element answering the same selector would
 * make rule 2's singular frontier a matter of which one a reader found first.
 */
function FrontierReading({ frontier }: { frontier: Frontier }): ReactElement {
  const said = (): string => {
    switch (frontier.frontier) {
      case "designated":
        return `#${frontier.number}`;
      case "notOnThisMachine":
        return NOTHING_FOR_THIS_MACHINE;
      case "nothingToStart":
        return NO_FRONTIER;
    }
  };

  return (
    <p className={styles.frontier} data-frontier-reading={frontier.frontier}>
      {said()}
    </p>
  );
}

/**
 * One plate: everything this view has to say about one node, in words.
 *
 * `data-node` is here and nowhere else on the pane — the mark this node gets in
 * the field carries `data-mark-node` instead, so a reader asking for the rows
 * gets one element per node rather than two.
 *
 * `data-state` is the model's own word, spelled and never re-derived.
 * `data-kind` is the model's word again. `data-frontier` is `map.frontier`
 * carried verbatim through `Plate.designated`, ungated: the layout already read
 * the frontier once, and a gate written here would be this side resolving the
 * question a second time, which is the failure rule 2 is about.
 *
 * A cut plate keeps its state and its glyph, because the ticket really is
 * closed; what it gains is `data-cut`, a struck disc, and the operator's own
 * words as a text node — **never a `title`, and nothing behind a hover.** A
 * branch that stopped has to show why on screen, and a reason a pointer has to
 * find is a reason a screenshot, a search and a reader do not have.
 *
 * Selecting is app-level and shared: it arrives on `selected`, it leaves
 * through `onSelect`, and nothing about it is held here. A plate that is not on
 * the scale of work keeps its click, its `tabIndex` and its selection, because
 * selecting a ticket is not starting one and the plate an operator most needs
 * to open is the one that is wrong.
 */
function PlateRow({
  plate,
  selected,
  onSelect,
}: {
  plate: Plate;
  selected: boolean;
  onSelect: (number: number | null) => void;
}) {
  const { node } = plate;
  const form = formOf(plate.state, plate.designated);

  /* Picking the plate you already picked puts it back, so a selection is never
     something you have to go somewhere else to undo. */
  const choose = () => onSelect(selected ? null : node.number);

  return (
    <li
      className={styles.plate}
      data-node={node.number}
      data-state={node.state}
      data-kind={node.kind.kind}
      data-rank={plate.rank}
      data-frontier={plate.designated ? "" : undefined}
      /* The verdict Rust took, carried onto the plate so *listed but not
         offered* is a thing on screen rather than an absence of one. */
      data-elsewhere={plate.boundElsewhere ? "" : undefined}
      data-cut={plate.cut === null ? undefined : ""}
      data-selected={selected ? "" : undefined}
      /* The same word `FolderRow` and The Route use for the row you picked, so
         the fill is not the only place the choice is said. */
      aria-current={selected ? "true" : undefined}
      tabIndex={0}
      onClick={choose}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        // Space scrolls the lane otherwise, which moves the thing being picked.
        event.preventDefault();
        choose();
      }}
    >
      <span className={styles.glyph} aria-hidden="true">
        {/* The cut's own shape, composed onto the one the form already chose
            rather than replacing it: a cut is a decoration on resolved, not a
            sixth state. The still form lives here as well as in the field,
            because the shape a mark wears has to be readable on the plate. */}
        <span
          className={
            plate.cut === null ? GLYPHS[form] : `${GLYPHS[form]} ${styles.glyphCut}`
          }
        />
      </span>
      <span className={styles.id}>#{node.number}</span>
      {/* In full. The stylesheet ellipsises it, so the whole title is still in
          the document to be found, read aloud and asserted on. */}
      <span className={styles.title}>{node.title}</span>
      {plate.blockers.beyondTheMap === 0 ? null : (
        /* No edge is drawn for a blocker with no row here — there is nothing on
           screen for one to leave from — so if the plate does not say it,
           nothing does. */
        <span className={styles.note}>{beyondTheMapNote(plate.blockers.beyondTheMap)}</span>
      )}
      <span className={styles.tags}>
        <MarkerTag plate={plate} form={form} />
        {/* Only a positive number: `blocked by 0` on a plate whose state is
            *blocked* is a contradiction an operator can see. A resolved plate
            cannot reach here with one at all — `blockersOf` empties the tally
            rather than leaving this to remember it. */}
        {plate.blockers.unresolved > 0 ? (
          <span className={styles.tag}>{blockedByLabel(plate.blockers.unresolved)}</span>
        ) : null}
        {plate.boundElsewhere ? <span className={styles.tag}>{BOUND_ELSEWHERE_TAG}</span> : null}
        {/* Both ends of the edge the ranker refused say so. The columns are the
            shape they are because of it, and a picture with no explanation in
            it is the thing this tag exists to prevent. */}
        {plate.circular ? <span className={styles.tag}>{CIRCULAR_TAG}</span> : null}
        <KindTag node={node} />
      </span>
      {/* Why the branch stopped, in the operator's own words, last on the plate
          and read from `Plate.cut` without a character changed. */}
      {plate.cut === null ? null : <span className={styles.reason}>{plate.cut}</span>}
    </li>
  );
}

/**
 * The marker tag: cold for the one to start, warm for the one already running.
 *
 * Read off the form and not off `plate.designated`, so the word and the shape
 * cannot part company — the form already settled the precedence, so a plate
 * says *designated* exactly when it is wearing the designated ring.
 */
function MarkerTag({ plate, form }: { plate: Plate; form: Form }) {
  if (form === "claimed") {
    return <span className={`${styles.tag} ${styles.tagLive}`}>{STATE_NAMES.claimed}</span>;
  }
  if (form === "designated") {
    return <span className={`${styles.tag} ${styles.tagDesignated}`}>{DESIGNATED_TAG}</span>;
  }
  /* Every other plate still says its state in the model's own word. The field
     beside it is bare, so the word here is most of what says where a ticket
     stands, and a synonym would be a second vocabulary. */
  return <span className={styles.tag}>{plate.stateName}</span>;
}

/**
 * What this child is, in the model's own three words.
 *
 * **The unclassified word is a form break and never a hue.** A child nobody
 * classified is the one plate on this pane that nothing will ever move, and the
 * strongest of the three channels saying so is text: a word is read by anyone,
 * by a page search, by a screenshot and by a reader, and it survives a retheme
 * that reassigns every ink on the pane. The stylesheet adds weight and a dashed
 * edge on top of it, and not one colour.
 *
 * The switch is exhaustive and the return type annotated, so a fourth
 * `ChildKind` arriving from Rust is a compile error here rather than a plate
 * that quietly says nothing about itself.
 */
function KindTag({ node }: { node: Node }): ReactElement {
  switch (node.kind.kind) {
    case "ticket":
      return <span className={styles.tag}>{node.kind.type}</span>;
    case "spec":
      return <span className={styles.tag}>{SPEC_TAG}</span>;
    case "unclassified":
      return (
        <span className={`${styles.tag} ${styles.tagUnclassified}`}>{UNCLASSIFIED_TAG}</span>
      );
  }
}

/**
 * One mark: a node's position, and nothing else.
 *
 * `data-mark-node` rather than `data-node`, deliberately. Exactly one element
 * per node carries `data-node` and it is the plate; a mark answering the same
 * selector would double every row a reader counted.
 */
function FieldMark({ mark }: { mark: Mark }) {
  return (
    <circle
      className={`${styles.mark} ${MARKS[formOf(mark.state, mark.designated)]}`}
      data-mark-node={mark.number}
      data-state={mark.state}
      data-designated={mark.designated ? "" : undefined}
      cx={mark.at.x}
      cy={mark.at.y}
      r={mark.radius}
    />
  );
}

/**
 * One edge, from the ticket it leaves to the ticket it unblocks.
 *
 * A cubic with two horizontal handles, and every one of the six numbers is the
 * layout's. The back edge the ranker refused is drawn like any other and marked
 * `data-circular`: the cycle is a fact about the map, and a view that silently
 * omits the edge that caused it leaves the operator looking at a picture with
 * no explanation in it.
 */
function Edge({ edge }: { edge: FanOut }) {
  const [first, second] = edge.bend;
  return (
    <path
      className={styles.edge}
      data-edge={`${edge.from}>${edge.to}`}
      data-cleared={edge.cleared ? "" : undefined}
      data-circular={edge.circular ? "" : undefined}
      d={`M ${edge.start.x} ${edge.start.y} C ${first.x} ${first.y} ${second.x} ${second.y} ${edge.end.x} ${edge.end.y}`}
    />
  );
}

/**
 * The fog: a region that names itself before it counts itself.
 *
 * The two absences differ in **form** and not only in the character. An
 * unsurveyed region stands an em dash where a numeral would go, in a different
 * face, and draws nothing at all beneath its heading; a surveyed one draws a
 * numeral and always draws a body under it. Nothing has to read a character to
 * tell them apart, and the heading is on both — a region that only counted
 * itself would be a figure in the margin rather than a place on the map.
 */
function FogRegion({ fog }: { fog: FieldFog }) {
  if (!fog.surveyed) {
    return (
      <section className={styles.fog} data-fog="unsurveyed" aria-labelledby={FOG_ID}>
        <h2 className={styles.fogHeading} id={FOG_ID}>
          <span className={styles.fogName}>{fog.heading}</span>
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
      <h2 className={styles.fogHeading} id={FOG_ID}>
        <span className={styles.fogName}>{fog.heading}</span>
        <span className={styles.fogCount} data-count>
          {fog.count}
        </span>
      </h2>
      {fog.charted === null ? (
        /* One text node, unmodified: `pre-wrap` in the stylesheet is what puts
           the operator's own line breaks on screen, and the parse in Rust is
           the only thing that ever chose where this string starts and stops. */
        <pre className={styles.fogText}>{fog.text}</pre>
      ) : (
        <p className={styles.fogEmpty}>{fog.charted}</p>
      )}
    </section>
  );
}

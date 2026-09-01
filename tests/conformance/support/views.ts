/**
 * How a view declares itself to the conformance suite.
 *
 * The fan-out is *rules × views × the fixture space*, and the view axis is
 * `VIEWS` — four entries today. A check written against The
 * Route's own selectors would have been a check that silently stopped covering
 * anything the day a second view arrived, so the selectors are not in the checks: they
 * are here, once per view, in a table `satisfies Record<ViewName, ViewSurface>`
 * — which makes a new view a compile error until somebody says how the contract
 * reads in it, rather than a view nothing is asserted about.
 *
 * What a surface may declare is deliberately small, and every field is a hook
 * the *contract* asks for rather than a hook this view happens to have: where
 * the view's root is, whether it is on screen for a given fixture at all, its
 * rows, its designated encoding, the shape it draws for a row, the properties
 * that shape carries its ink on, the word it tells an unclassified child apart
 * by, and its fog region if it renders one.
 * Anything a rule needs beyond those is a rule reaching into one view's layout,
 * which is what the meta-rule prohibits.
 */

import type {
  ChildKind,
  NodeState,
  Snapshot,
} from "../../../src/snapshot/model.generated";
/*
 * One import for both surfaces, and it used to be two: each view declared the
 * word and this file imported both spellings so the checks would notice if they
 * ever disagreed. They cannot disagree now — the word a node is told apart by
 * is the model's, and `src/views/vocabulary.ts` is where it is said once — so
 * the second import would only be this file asserting a table against itself.
 */
import { UNCLASSIFIED_TAG } from "../../../src/views/vocabulary";
import type { ViewName } from "../../../src/views/views";

/**
 * Where a fog region puts its two readings, when a view renders one.
 *
 * `null` on a view that renders none: the fog is then chrome's, by rule 7's
 * corollary, and rule 4 is delivered there rather than passing here vacuously.
 * The selectors are read against the *page* and not against the view root for
 * the same reason — a region that moved to the chrome is still the region the
 * rule binds.
 */
export interface FogSurface {
  /** The region itself, in either of its two readings. */
  readonly region: string;
  /** The slot standing where a count would, when nobody surveyed. */
  readonly unsurveyed: string;
  /** The numeral slot, when somebody did. */
  readonly count: string;
}

export interface ViewSurface {
  /** The view's own root, and how the driver reaches it. */
  readonly root: string;
  /**
   * Whether this fixture puts the view on screen at all.
   *
   * Not every fixture does: `App` mounts no view when no map is open, so the
   * root would never appear and a driver waiting for it would hang. A rule
   * whose subject is the view then skips on a stated precondition rather than
   * passing because it found nothing.
   */
  mounts(snapshot: Snapshot): boolean;
  /** Every node the view renders, one element each. */
  readonly rows: string;
  /** The row for one node, by the number the model calls it. */
  row(number: number): string;
  rowsInState(state: NodeState): string;
  rowsOfKind(kind: ChildKind["kind"]): string;
  /** The designated encoding: *the one to start*, drawn as this view draws it. */
  readonly designated: string;
  /** The shape a row wears, within the row: where the still form of a mark is. */
  readonly glyph: string;
  /**
   * The CSS properties this view's glyph carries its ink on.
   *
   * Rule 3's first assertion collapses every semantic token and then reads the
   * two rows' inks, and *which properties are an ink* is a fact about how a
   * view draws rather than about the rule: an HTML glyph paints in `color`, a
   * border and a background; an SVG mark paints in `fill` and `stroke`. A rule
   * carrying one fixed list would read the channel one view happens to use and
   * pronounce every other view colour-free — vacuously green on exactly the
   * view whose distinctions ride on hue. So the view names its own, here, and a
   * new view has to answer the question before it compiles.
   */
  readonly inks: readonly string[];
  /** The word an unclassified child is told apart by when every colour is gone. */
  readonly unclassifiedWord: string;
  readonly fog: FogSurface | null;
}

const ROUTE: ViewSurface = {
  root: 'section[aria-label="The Route"]',
  mounts: (snapshot) => snapshot.model.map !== null,
  rows: "li[data-node]",
  row: (number) => `li[data-node="${number}"]`,
  rowsInState: (state) => `li[data-state="${state}"]`,
  rowsOfKind: (kind) => `li[data-kind="${kind}"]`,
  /* `data-frontier`, and not `data-mark="designated"`: the mark yields to
     *claimed* when somebody is already on the frontier node, so the mark is not
     where the designation is always readable. The attribute is — it carries
     `map.frontier` verbatim, withheld only from a row the mark has refused. */
  designated: "[data-frontier]",
  /* The glyph is the only aria-hidden child a row has; the other one in this
     view is the rule in a section heading, which is not inside a row. */
  glyph: 'span[aria-hidden="true"] > span',
  /* An HTML glyph: `--c-node-glyph` reaches the text, the rule that stands for
     a blocked bar reaches the border, and a filled disc reaches the
     background. */
  inks: ["color", "border-top-color", "background-color"],
  unclassifiedWord: UNCLASSIFIED_TAG,
  fog: { region: "[data-fog]", unsurveyed: "[data-unsurveyed]", count: "[data-count]" },
};

const BENCH: ViewSurface = {
  root: 'section[aria-label="The Bench"]',
  /* The same answer as the Route's and for the same reason: `App` mounts the
     open view only where a map is open, and which view that is changes nothing
     about it. */
  mounts: (snapshot) => snapshot.model.map !== null,
  /* A plate is the row here — the `li` that carries one node's number, its
     coordinate and its words. The wires are the other half of the drawing and
     are `aria-hidden` restatements of tallies the plates already print, so no
     rule reaches for them. */
  rows: "li[data-node]",
  row: (number) => `li[data-node="${number}"]`,
  /* Both are the model's own words, spelled onto the plate and never
     re-derived; the Bench's seven-way `data-mark` is this view's own encoding
     and is deliberately not what the contract reads. */
  rowsInState: (state) => `li[data-state="${state}"]`,
  rowsOfKind: (kind) => `li[data-kind="${kind}"]`,
  /* `data-frontier` for exactly the Route's reason: `data-mark` folds the cut,
     the kind and the designation together and yields to *claimed*, so the mark
     is not where the designation is always readable. The attribute carries
     `map.frontier`'s number verbatim. */
  designated: "[data-frontier]",
  /* The stud, and the shape inside it: the stud is the plate's only
     `aria-hidden` child, and the mark's geometry — square, hollow diamond,
     hatched bar, dashed circle — is the span it wraps. */
  glyph: 'span[aria-hidden="true"] > span',
  /* An HTML glyph, like the Route's, plus the stud's left edge: the mark is a
     `<span>` whose form is drawn in borders and a background over `color`, and
     the Bench tells a kind apart on `border-left` as well, so all four are
     properties an ink could hide in here. */
  inks: ["color", "border-top-color", "border-left-color", "background-color"],
  unclassifiedWord: UNCLASSIFIED_TAG,
  /* No fog region, and the omission is this view's decision rather than an
     oversight: the fog is not a node, has no rank and nothing waits on it, so
     it has no honest coordinate on a graph of the children and stays with the
     chrome that already draws it. Rule 4 is delivered there, and its
     precondition says so rather than passing here on nothing. */
  fog: null,
};

/**
 * Deep Field, whose two lanes are the whole reason its selectors are not The
 * Route's spelled a second time.
 *
 * **One element per node, and it is the plate.** The lane is real DOM and the
 * field is one `aria-hidden` `<svg>` of bare marks, so a node reaches the
 * document twice — as `li[data-node]` on the left and as
 * `circle[data-mark-node]` on the right. Only the first answers `rows`, which
 * is what keeps a count of rows a count of nodes; the mark carries a different
 * attribute for exactly that reason, and nothing here reaches for it.
 *
 * `designated` is `[data-frontier]` rather than the mark's `data-designated`:
 * the plate carries `map.frontier` verbatim while the drawn ring yields to
 * *claimed*, so the attribute is where the designation is always readable and
 * the shape is not.
 *
 * Nothing here names the plate lane, the boundary, the clearance or a
 * coordinate. Those are this view's layout, the meta-rule keeps them out of the
 * contract's reach, and a surface field naming one would be a rule reading a
 * number that only one view has.
 */
const DEEP_FIELD: ViewSurface = {
  root: 'section[aria-label="Deep Field"]',
  /* The Route's precondition and for the same reason: `App` mounts no view with
     no map open. The view's own width stand-down is a different question, and
     it is the driver's rather than this table's: `load` opens the dial at the
     `map` detent before anything is read, where every map in this fixture space
     is drawn as a picture. A surface that tried to answer it here would be
     answering from a width nothing here can measure. */
  mounts: (snapshot) => snapshot.model.map !== null,
  rows: "li[data-node]",
  row: (number) => `li[data-node="${number}"]`,
  rowsInState: (state) => `li[data-state="${state}"]`,
  rowsOfKind: (kind) => `li[data-kind="${kind}"]`,
  designated: "[data-frontier]",
  /* The plate's one `aria-hidden` child holds the shape the node wears, and the
     span inside it is the form itself — a cut composes onto that rather than
     replacing it. The field's `<svg>` is `aria-hidden` too and is not in a row. */
  glyph: 'span[aria-hidden="true"] > span',
  /* An HTML glyph, like the Route's: the mark is a `<span>` whose form is
     drawn in a border and a background over `color`, so those are the three
     properties an ink could hide in here. */
  inks: ["color", "border-top-color", "background-color"],
  unclassifiedWord: UNCLASSIFIED_TAG,
  fog: { region: "[data-fog]", unsurveyed: "[data-unsurveyed]", count: "[data-count]" },
};

/*
 * The Plate declares the same hooks over completely different geometry,
 * which is the point of the table: a rule reads *the designated node* or *the
 * rows in this state* and never learns that one view draws a list and the other
 * draws a diagram. Its rows are `<g>` elements inside the field, because a
 * station is a group — a glyph, a plate and the words on it — and the hooks
 * ride on the group exactly as the Route's ride on the `<li>`.
 */
const PLATE: ViewSurface = {
  root: 'section[aria-label="The Plate"]',
  /*
   * The same claim as the Route's, and it is a claim about the *model* on
   * purpose: a map is open, so the view is asked for.
   *
   * Whether the shell then draws it is a question about width, and it is
   * answered before this hook is consulted — `load` presses the view's own cap
   * on the switcher, which widens the dial to a position where the wanted view
   * fits and opens it in the same act. The Plate's floor (`VIEW_FLOORS.plate`)
   * is a map side wide enough that the *drawing* gets its 700px once the
   * launcher, the rail and this view's own reserved margin have taken theirs —
   * comfortably past a laptop default, which is why `playwright.config.ts`
   * states the window rather than inheriting one. It is inside what the `map`
   * detent is worth in that window, so at every point of the space the press
   * leaves the diagram drawn. Where it
   * would not — a window too narrow to hold the view at any detent — `load`
   * fails loudly on the stand-down rather than letting this hook go on claiming
   * a root that will never appear.
   */
  mounts: (snapshot) => snapshot.model.map !== null,
  rows: "g[data-node]",
  row: (number) => `g[data-node="${number}"]`,
  rowsInState: (state) => `g[data-state="${state}"]`,
  rowsOfKind: (kind) => `g[data-kind="${kind}"]`,
  /* `data-frontier` for the Route's reason: the mark yields to *claimed* when
     somebody is already on the designated station, so the shape is not where
     the designation is always readable and the attribute is. */
  designated: "[data-frontier]",
  /* The glyph is the station's own aria-hidden group, and the shapes inside it
     are the whole of what a mark is drawn as. */
  glyph: 'g[aria-hidden="true"]',
  /* An SVG mark: every kind and state distinction on this view is `fill` and
     `stroke` off `--c-plate-glyph` — `.markUnclassified` is an unfilled square
     with a dashed edge, `.markTakeable` a filled disc with a heavy one — and
     the group itself paints neither, which is why the probe reads the shapes
     inside it. Reading the Route's three properties here would find one ink on
     a plate that told every kind apart by hue alone. */
  inks: ["fill", "stroke"],
  unclassifiedWord: UNCLASSIFIED_TAG,
  fog: { region: "[data-fog]", unsurveyed: "[data-unsurveyed]", count: "[data-count]" },
};

export const VIEW_SURFACES = {
  route: ROUTE,
  bench: BENCH,
  plate: PLATE,
  "deep-field": DEEP_FIELD,
} satisfies Record<ViewName, ViewSurface>;

export function surfaceOf(view: ViewName): ViewSurface {
  return VIEW_SURFACES[view];
}

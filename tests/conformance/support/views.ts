/**
 * How a view declares itself to the conformance suite.
 *
 * The fan-out is *rules × views × the fixture space*, and the view axis is
 * `VIEWS` — two entries today, four eventually. A check written against The
 * Route's own selectors would be a check that silently stops covering anything
 * the day a second view arrives, so the selectors are not in the checks: they
 * are here, once per view, in a table `satisfies Record<ViewName, ViewSurface>`
 * — which makes a new view a compile error until somebody says how the contract
 * reads in it, rather than a view nothing is asserted about.
 *
 * What a surface may declare is deliberately small, and every field is a hook
 * the *contract* asks for rather than a hook this view happens to have: where
 * the view's root is, whether it is on screen for a given fixture at all, its
 * rows, its designated encoding, the shape it draws for a row, the word it
 * tells an unclassified child apart by, and its fog region if it renders one.
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
  unclassifiedWord: UNCLASSIFIED_TAG,
  fog: { region: "[data-fog]", unsurveyed: "[data-unsurveyed]", count: "[data-count]" },
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
  unclassifiedWord: UNCLASSIFIED_TAG,
  fog: { region: "[data-fog]", unsurveyed: "[data-unsurveyed]", count: "[data-count]" },
};

export const VIEW_SURFACES = {
  route: ROUTE,
  "deep-field": DEEP_FIELD,
} satisfies Record<ViewName, ViewSurface>;

export function surfaceOf(view: ViewName): ViewSurface {
  return VIEW_SURFACES[view];
}

/**
 * How a view declares itself to the conformance suite.
 *
 * The fan-out is *rules × views × the fixture space*, and the view axis is
 * `VIEWS` — one entry today, four eventually. A check written against The
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
import { UNCLASSIFIED_TAG } from "../../../src/views/route/route";
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

export const VIEW_SURFACES = { route: ROUTE } satisfies Record<ViewName, ViewSurface>;

export function surfaceOf(view: ViewName): ViewSurface {
  return VIEW_SURFACES[view];
}

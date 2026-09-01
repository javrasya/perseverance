import type { ChildKind, Frontier, Map, Model, Node, NodeState, TicketType } from "../snapshot/model.generated";
import { NO_MAP_OPEN } from "../snapshot/readout";
/*
 * The map's vocabulary, imported rather than respelled.
 *
 * These constants live under `src/views/route/` because that is where the first
 * surface to need them was built, but none of them is a fact about the Route:
 * `STATE_NAMES` is the model's four words, `SPEC_TAG` and `UNCLASSIFIED_TAG`
 * are `ChildKind`'s own, and `beyondTheMapNote` is the sentence this app says
 * about a blocker that has no row. A second spelling of any of them is a panel
 * and a picture disagreeing about the same node in the same window, which is
 * the one thing a single derived model exists to make impossible. If the Route
 * is ever retired the words move to a module of their own; until then the
 * import is the cheaper direction of the dependency.
 */
import {
  BOUND_ELSEWHERE_TAG,
  DESIGNATED_TAG,
  SPEC_TAG,
  STATE_NAMES,
  UNCLASSIFIED_TAG,
  beyondTheMapNote,
} from "../views/route/route";

/**
 * What the detail panel says, as a value.
 *
 * The panel is chrome and computes nothing of its own: everything below is a
 * presentational join over the model the poller landed, and the selection the
 * UI store holds. No state is derived here — a node's state is `node.state`,
 * decided once in `derive.rs`, and the edges joined below are never read back
 * into an opinion about it. That is not tidiness. The blocker numbers on a node
 * are *every* blocker the answer named, finished ones included, and one of them
 * may not be a child of this map at all; anything inferred from them would be
 * wrong in both directions, which is exactly why the count they would need
 * stayed behind in Rust.
 *
 * **It never renders empty.** Each variant below is a state the window can
 * genuinely be in, each says something different, and there is no fall-through
 * that leaves a blank column: an operator glancing at the panel always learns
 * either a fact about a node or the reason there is no node to have a fact
 * about.
 */
export type Panel =
  /** No map open — an absence, and never an empty map. */
  | { kind: "noMap" }
  /** A map is open and has no children yet. */
  | { kind: "mapEmpty"; map: MapNote }
  /** A map with rows on it, and no row picked. */
  | { kind: "unselected"; map: MapNote }
  /**
   * A selection that outlived its row. The poller replaces the graph whole, so
   * `ui.selection` can name a number the new graph has no node for — the panel
   * says so rather than blanking, because a panel that empties on a re-poll is
   * indistinguishable from a panel that lost the click.
   */
  | { kind: "gone"; number: number; map: MapNote }
  | { kind: "node"; map: MapNote; card: Card };

/** What is true of the map itself, carried onto every branch that has one. */
export type MapNote = { number: number; closed: boolean };

/** One blocker or blocked node, named rather than counted. */
export type Named = { number: number; title: string; state: NodeState };

/**
 * The edges in one direction: the ones with a row here, and how many had none.
 *
 * ADR 0006 gives the Route the *count* and leaves the identity to this panel,
 * so this is where a number becomes a name. A `waitsOn` number with no row on
 * this map is not dropped — cross-repository blockers were already dropped
 * upstream, and silently losing the rest would make a node look unblocked in
 * the one place an operator came to find out why it is not.
 */
export type Edges = { named: Named[]; beyondTheMap: number };

export type Resolution = { kind: "inScope" } | { kind: "fromScope"; reason: string };

/** Everything the panel prints about one node. */
export type Card = {
  number: number;
  /** The node's title. There is no issue body on this side — see [`NO_BODY`]. */
  question: string;
  url: string;
  type: string;
  state: NodeState;
  /** The map's own answer to *what next*, never re-derived from the rows. */
  designated: boolean;
  boundElsewhere: boolean;
  claimed: boolean;
  blockers: Edges;
  blocked: Edges;
  resolution: Resolution;
};

/* ------------------------------------------------------------- the join --- */

/**
 * The ticket types, in the model's own words.
 *
 * The same rule `STATE_NAMES` keeps: an operator reading *grilling* and a
 * developer reading `TicketType::Grilling` are reading one vocabulary. A
 * `Record` so that a fifth type added in Rust is a type error here rather than
 * a blank field on screen.
 */
export const TYPE_NAMES: Record<TicketType, string> = {
  research: "research",
  prototype: "prototype",
  grilling: "grilling",
  task: "task",
};

/**
 * What kind of child this is, as one phrase.
 *
 * Unclassified is named as loudly as the other two. It is the row an operator
 * opens this panel to *fix* — a child nobody labelled, which the frontier will
 * never offer because it cannot tell what it is — so it says its name and
 * carries no verb.
 */
export function typeOf(kind: ChildKind): string {
  switch (kind.kind) {
    case "ticket":
      return `ticket, ${TYPE_NAMES[kind.type]}`;
    case "spec":
      return SPEC_TAG;
    case "unclassified":
      return UNCLASSIFIED_TAG;
  }
}

function nameOf(node: Node): Named {
  return { number: node.number, title: node.title, state: node.state };
}

/**
 * What this node waits on: the rows this map has for those numbers, and a
 * count of the numbers it has none for.
 *
 * Map order is kept — the operator's own drag order in GitHub's UI — because
 * this app never re-sorts the children, and a blocker list sorted by number
 * here would be a second ordering of the same nodes.
 */
export function blockersOf(map: Map, node: Node): Edges {
  const named: Named[] = [];
  let beyondTheMap = 0;

  for (const number of node.waitsOn) {
    const blocker = map.nodes.find((row) => row.number === number);
    if (blocker === undefined) {
      beyondTheMap += 1;
      continue;
    }
    named.push(nameOf(blocker));
  }

  return { named, beyondTheMap };
}

/**
 * What waits on this node: the reverse edges, read off the same adjacency.
 *
 * `beyondTheMap` is structurally zero here and is carried anyway, so the two
 * directions have one shape. A reverse edge can only come from a row that is on
 * this map — a node elsewhere waiting on this one has no `waitsOn` array on
 * this side to be found in — and the panel says as much in words rather than
 * printing a zero that would read as *we looked and found none*.
 */
export function blockedOf(map: Map, node: Node): Edges {
  return {
    named: map.nodes.filter((row) => row.waitsOn.includes(node.number)).map(nameOf),
    beyondTheMap: 0,
  };
}

function designates(frontier: Frontier, number: number): boolean {
  return frontier.frontier === "designated" && frontier.number === number;
}

export function cardOf(map: Map, node: Node): Card {
  return {
    number: node.number,
    question: node.title,
    url: node.url,
    type: typeOf(node.kind),
    state: node.state,
    designated: designates(map.frontier, node.number),
    boundElsewhere: node.boundElsewhere,
    /* The only claim fact that crosses. Who holds it does not — see
       [`CLAIM_ANONYMOUS`]. */
    claimed: node.state === "claimed",
    blockers: blockersOf(map, node),
    blocked: blockedOf(map, node),
    resolution:
      node.cut.cut === "fromScope"
        ? { kind: "fromScope", reason: node.cut.reason }
        : { kind: "inScope" },
  };
}

/**
 * The whole of the panel's arithmetic: a model and a selection in, one variant
 * out, and no branch that comes back with nothing to say.
 */
export function panelOf(model: Model, selection: number | null): Panel {
  const map = model.map;
  if (map === null) return { kind: "noMap" };

  const note: MapNote = { number: map.number, closed: map.closed };
  if (map.nodes.length === 0) return { kind: "mapEmpty", map: note };
  if (selection === null) return { kind: "unselected", map: note };

  const node = map.nodes.find((row) => row.number === selection);
  if (node === undefined) return { kind: "gone", number: selection, map: note };

  return { kind: "node", map: note, card: cardOf(map, node) };
}

/* ----------------------------------------------------------------- copy --- */

/**
 * The panel's own heading. It names the thing rather than the act — *detail*
 * is what a menu calls a screen; this is the node you are looking at.
 */
export const PANEL_HEADING = "Node";

/** The field headings, in the order the panel prints them. */
export const HEADINGS = {
  question: "Question",
  type: "Type",
  state: "State",
  blockers: "Blockers",
  blocked: "Blocked",
  claim: "Claim",
  dates: "Dates",
  resolution: "Resolution",
  link: "Link",
} as const;

/** Said where a map would be. The chrome's words, not a second phrasing. */
export const NO_MAP_HERE = NO_MAP_OPEN;
export const NO_MAP_NOTE = "open one from the map list and a row here will have something to say";

export const MAP_EMPTY = "this map has no children yet";
export const MAP_EMPTY_NOTE = "nothing has been cut into it, so there is no node to look at";

export const NOTHING_SELECTED = "no node selected";
export const NOTHING_SELECTED_NOTE = "pick a row on the map and it is described here";

/** Said when the map itself is closed, on whatever else the panel is saying. */
export const MAP_CLOSED = "this map is closed";

export function selectionGone(number: number): string {
  return `#${number} is not on this map`;
}

export const SELECTION_GONE_NOTE =
  "the graph is replaced whole on every read, and this selection outlived its row";

/**
 * Said under the question, every time.
 *
 * `map-graph.graphql` never asks for a child's body, so no issue body exists on
 * this side at all — not stale, not truncated, absent. The title *is* the
 * question the ticket asks, and this sentence is what stops the panel implying
 * there is prose underneath it that failed to load.
 */
export const NO_BODY = "the title is the whole of it — no issue body crosses the seam";

export const CLAIM_HELD = "held";
export const CLAIM_FREE = "not held";

/**
 * The claim's other half, and the reason it is a sentence rather than a blank.
 *
 * What the read carries about who is on a ticket is a **count** and never a
 * list — `crates/model/src/read.rs` says so on the field itself: *claimed by
 * me* is not a distinction this side can make, so a name here would have to be
 * invented. Saying who is not the panel's to say, and saying nothing at all
 * would read as *nobody*.
 */
export const CLAIM_ANONYMOUS = "who holds it is not carried across the seam";

/**
 * Dates, as a named absence carrying its reason.
 *
 * The model reads no timestamps — `derive.rs` says so on `Node` itself, and it
 * is a decision rather than an omission: model equality is the diff unit, and a
 * timestamp that moves on every unrelated edit would make every poll a change.
 * A dash and this sentence, never a fabricated date and never a zero.
 */
export const NO_DATES = "not carried — this model reads no timestamps";

/**
 * What stands where a value the harness was never told would be.
 *
 * `—` and never `0`, and never a blank. The dash is only half of it: it is set
 * in a different face from a numeral and it always has a sentence under it, so
 * *never told* differs from *told, and it is none* in form rather than in one
 * character. The same em dash the fog's `NOBODY_SURVEYED` spells — one dash for
 * one meaning across the window, declared here as that file declares its own.
 */
export const NOT_TOLD = "—";

export const IN_SCOPE = "in scope";
export const OUT_OF_SCOPE = "out of scope";

/**
 * Said beside a cut node's reason.
 *
 * Out of scope is a decoration on *resolved* and never progress, so the panel
 * prints the state and the cut as two facts rather than folding them into one
 * word. The reason itself is visible text — never a hover, never an ellipsis —
 * because it is the only record of why somebody dropped this.
 */
export const OUT_OF_SCOPE_NOTE = "closed without being done; the reason is the map document's";

/**
 * Said under the URL.
 *
 * Nothing in `src/` renders an external link, and the Tauri capability set
 * grants no opener plugin: an anchor here would navigate the WebView away from
 * the app, and there is no way back from that. Opening it in the operator's
 * browser needs a Rust-side command that a later ticket adds; until then the
 * URL is text you can select and copy, which is what an operator does with it
 * anyway.
 */
export const LINK_NOT_OPENABLE = "select and copy — this window cannot open a browser yet";

/** Nothing waits, and the model genuinely knows it: a real zero, said in words. */
export const NO_BLOCKERS = "nothing in the way";
export const NOTHING_BLOCKED = "nothing waits on this";

/**
 * Said under *Blocked*, because the absence there is structural.
 *
 * The reverse edges can only be found among rows on this map, so *none* here
 * means *none on this map* and nothing at all about the rest of GitHub. The
 * forward direction has [`beyondTheMapNote`] for its unknowns; this direction's
 * unknown is the whole world outside the map, and it is stated once rather than
 * counted.
 */
export const BLOCKED_ONLY_HERE = "only children of this map can be seen waiting";

export { BOUND_ELSEWHERE_TAG, DESIGNATED_TAG, STATE_NAMES, beyondTheMapNote };

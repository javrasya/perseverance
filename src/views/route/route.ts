/**
 * The Route's arithmetic: which section each ticket belongs in, what mark it
 * carries, and how much of what it waits on is still in the way.
 *
 * A pure module, and deliberately so. Nothing here imports React, touches the
 * DOM, reads a clock or a store, or asks anything a second time — `routeOf`
 * called twice on the same model answers with the same sections, which is what
 * lets the pane be a function of the derived model and of nothing a caller
 * could vary.
 *
 * **There is no rank in this file, no coordinate and no edge geometry — not
 * here and not anywhere else in the view.** The Route is a grouped list in one
 * column: position in the column is the encoding, membership of a section is
 * the whole of what the structure says, and everything a row adds to that it
 * adds in words. Nothing is drawn between two rows, so there is nothing to
 * place, nothing to route and nothing to route around. ADR 0006.
 *
 * The failure it exists to prevent is a section or a count the map cannot
 * justify. Three parts to that. **Every section comes from the model's own
 * words** — a node's state, the cut the map document took, or the number
 * `map.frontier` names when it names one — so a row's group is always *the
 * model said so* and never a heuristic.
 * That includes the machine: a ticket labelled for one this is not arrives with
 * the verdict already taken, is grouped and counted exactly like any other
 * takeable ticket, and says so in a word. **Every count is
 * the rows it heads**, built with them rather than beside them, because a
 * heading that disagrees with what is under it is a lie an operator can see and
 * the only sure way to prevent it is to leave nothing to disagree. **Order
 * inside a section is `map.nodes` order and nothing else**, walked once in
 * array order into buckets: there is no comparator in this file and no sort
 * call, because the operator dragged these into this order in GitHub's own UI
 * and re-arranging their rows is answering a question nobody asked with an
 * authority nobody granted.
 */

import type { Fog, Map, Node, NodeState } from "../../snapshot/model.generated";

/*
 * `Map` above is the derived model's map, which shadows the built-in one for
 * the whole of this file. The alias is how the lookup tables here are built —
 * the model's vocabulary is the one worth keeping, and the collection is the
 * incidental thing that gets renamed.
 */
const Lookup = globalThis.Map;

/* ------------------------------------------------------------ blockers --- */

/**
 * What a node waits on, split by whether this map is in a position to judge it.
 */
export type BlockerTally = {
  /** Named blockers with a row on this map that this map does not show as resolved. */
  readonly unresolved: number;
  /** Named blockers with no row here, which this map cannot judge either way. */
  readonly beyondTheMap: number;
};

const NOTHING_IN_THE_WAY: BlockerTally = { unresolved: 0, beyondTheMap: 0 };

/**
 * Every node's blockers, counted once against the states this map is showing.
 *
 * **This is why `waitsOn` crosses the seam at all.** The derived model carries
 * no per-node blocker count — [`Counts`] is tickets, open and specs, and
 * [`Node`] deliberately withholds the count GitHub decided the state from — so
 * these numbers are the only source for `blocked by N`, which is the whole of
 * what a blocked row says about what holds it up. They are also the only source
 * for the second fact, which is rarer and worse to lose: that a blocker names
 * an issue with no row here, so this map cannot say whether it is done.
 *
 * The two are counted apart rather than summed. A blocker this map can see and
 * a blocker it cannot are different claims, and adding them would print a
 * number the rows on screen cannot account for — the failure this whole file is
 * arranged around. A blocker this map shows as resolved is counted into
 * neither: it is out of the way, which is a fact rather than an absence.
 *
 * **A node this map shows as resolved waits on nothing**, whatever it still
 * names, and that is the same rule read from the other end. GitHub closes an
 * issue without clearing what it was blocked by, so a finished ticket arrives
 * carrying open blockers — the awkward fixture's *finished before the thing it
 * waited on* is exactly that — and tallying them would put `blocked by 1` on a
 * row under the heading *Resolved*. Nothing holds up work that is already done,
 * so the emptying happens here, where the arithmetic is, rather than in the
 * view: a row that reads its own tally can then say all of it.
 */
export function blockersOf(nodes: readonly Node[]): ReadonlyMap<number, BlockerTally> {
  const resolved = new Lookup<number, boolean>();
  for (const node of nodes) resolved.set(node.number, node.state === "resolved");

  const tallies = new Lookup<number, BlockerTally>();
  for (const node of nodes) {
    if (node.state === "resolved") {
      tallies.set(node.number, NOTHING_IN_THE_WAY);
      continue;
    }

    let unresolved = 0;
    let beyondTheMap = 0;
    for (const before of node.waitsOn) {
      const settled = resolved.get(before);
      if (settled === undefined) beyondTheMap += 1;
      else if (!settled) unresolved += 1;
    }
    tallies.set(node.number, { unresolved, beyondTheMap });
  }
  return tallies;
}

/* --------------------------------------------------------------- marks --- */

/**
 * The five marks a row can carry, which are the model's four states plus the
 * one designation.
 *
 * Two of C5's seven glyphs are not marks, for two different reasons. `g-oos`
 * never was one: a cut ticket is closed, so its row keeps `resolved` and the
 * cut decorates it — [`RouteRow.cut`] carries the words and the *Out of scope*
 * section carries the row, and neither of those is a sixth state. `g-done` is
 * *resolved by this session*, which needs a run lifecycle and a session
 * identity the derived model does not carry at all, so building it would mean
 * inventing state rather than reading it.
 */
export type Mark = "claimed" | "designated" | "takeable" | "blocked" | "resolved";

/**
 * Whether a ticket is worked with someone at the keyboard or without.
 *
 * The wayfinder's vocabulary and not the model's: nothing crossing the seam
 * says this, so it is derived here from the ticket type — research runs AFK,
 * every other kind of ticket is human-in-the-loop. That makes this the first
 * thing to move the day the model carries attendance itself.
 *
 * One rule, and now two readers of it: `RunKind::of` in `crates/app` draws the
 * same line from the same `TicketType`, because a quit confirmation has to say
 * whether a run strands a claim or loses everything and that question is asked
 * in Rust. Neither side derives the other — the seam carries the ticket type
 * and not the split — so the two are kept identical by saying so here and
 * there, and both move together the day the model carries it.
 */
export type Attendance = "AFK" | "HITL";

/**
 * One row's precedence, top down: claimed beats designated, designated beats
 * the node's state.
 *
 * Claimed first because *somebody is on this* is the stronger of the two claims
 * — a designated node with a session against it is being worked, and marking it
 * as the next thing to pick up would send two operators at one ticket. It keeps
 * `designated` on the row underneath, which is how the heading swaps to *Now*
 * without losing what the frontier said.
 */
function markOf(state: NodeState, designated: boolean): Mark {
  if (state === "claimed") return "claimed";
  if (designated) return "designated";
  return state;
}

function attendanceOf(node: Node): Attendance | null {
  if (node.kind.kind !== "ticket") return null;
  return node.kind.type === "research" ? "AFK" : "HITL";
}

/* ------------------------------------------------------------ sections --- */

/**
 * The sections the pane can draw, in document order.
 *
 * Five, and the fifth is *out of scope*: the rows the map document itself cut,
 * which are resolved to GitHub and are not progress. It can be a section here
 * because it carries a real count — [`RouteSection.count`] is still
 * `rows.length`, and these rows are counted under this heading and under no
 * other. That is the whole of the arithmetic: *Resolved* heads the decisions
 * made because the cut ones are somewhere else, not because anything was
 * subtracted from it.
 *
 * **The fog is not on this list, and for the opposite reason**: it is real, it
 * is drawn, and it is not a section — the count is always `rows.length` and the
 * fog has no rows, so it rides beside the sections on [`Route`] rather than
 * being bent into one.
 */
export type SectionName = "now" | "frontier" | "blocked" | "resolved" | "outOfScope";

export type RouteRow = {
  readonly node: Node;
  /**
   * `map.frontier` named this number. Never re-resolved on this side — and when
   * it names no number, *which* of the two absences that is is also the model's
   * word and not a question asked here.
   */
  readonly designated: boolean;
  readonly mark: Mark;
  readonly blockers: BlockerTally;
  /** null for a spec or an unclassified child: the wayfinder's rule has nothing to say. #37. */
  readonly attendance: Attendance | null;
  /**
   * A copy of `node.boundElsewhere`, and emphatically not a derivation.
   *
   * The machine was matched in Rust, once, inside the one frontier resolver.
   * What crosses is the verdict; this carries it onto the row so *not offered*
   * is legible where an operator is already looking, rather than only true.
   */
  readonly boundElsewhere: boolean;
  /**
   * The words the map cut this ticket in, carried whole off `node.cut`, or null
   * when it was not cut.
   *
   * Never empty when it is here: the reason is the operator's own bullet under
   * `## Out of scope`, and the link naming this ticket is inside that text, so
   * there is always something to read. A row is cut exactly when this is not
   * null — nothing else on the row says so, and in particular `mark` stays
   * `resolved`, because the ticket really is closed and the cut is a decoration
   * on that rather than a sixth mark.
   */
  readonly cut: string | null;
};

export type RouteSection = {
  readonly name: SectionName;
  readonly heading: string;
  readonly rows: readonly RouteRow[];
  /** Always `rows.length`. A count that is not the rows it heads is a lie. */
  readonly count: number;
};

export type Route = {
  readonly sections: readonly RouteSection[];
  /**
   * The known unknowns, as the model settled them.
   *
   * **Always here, unlike a section.** A section with no rows is dropped
   * because a group is a claim that there is something in it; the fog region is
   * the one place on the map where *there is nothing in it* is the claim, and
   * two different nothings at that. Carried through untouched — which of the
   * two readings applies was decided in Rust, and asking again here is
   * resolving, which is the one thing this side may not do.
   */
  readonly fog: Fog;
};

function sectionOf(
  name: SectionName,
  heading: string,
  rows: readonly RouteRow[],
): RouteSection {
  return { name, heading, rows, count: rows.length };
}

/**
 * The whole pane, derived from the model and from nothing else, every call.
 *
 * One walk of `map.nodes`, in array order, appending each node to the bucket
 * its state names — or, when the map document cut it, to the one its cut names
 * instead. That single pass is the entirety of intra-section ordering:
 * no comparator, no second pass, nothing that could reorder rows the operator
 * arranged.
 *
 * The top section is one section with two headings. It holds every claimed node
 * and reads *Now*; with nothing claimed it holds the single node `map.frontier`
 * names and reads *Next*; with neither it is absent, because an absent frontier
 * is a state with a reading of its own — two of them, in fact, *nothing to
 * start* and *nothing for this machine* — and an empty group under a heading
 * would draw either as a shrug. Which of the two it is, is `describeModel`'s
 * sentence to say and not this file's; nothing here asks. The designated row is
 * looked for among the takeable ones and not everywhere: the number
 * `map.frontier` names is by construction the first node in map order that is
 * takeable *and not bound to another machine*, and a node bound elsewhere keeps
 * its `takeable` state, so the narrower rule still lands inside the bucket this
 * looks in. Looking for it where it can be is what stops a number naming
 * something else from putting one node in two sections at once.
 *
 * A section with no rows is left out of the answer entirely rather than handed
 * back empty — the rule `MapList` already established for the same reason. The
 * group is a claim that there is something in it.
 */
export function routeOf(map: Map): Route {
  const blockers = blockersOf(map.nodes);

  /*
   * Read once, above the loop. `map.frontier` names a number in exactly one of
   * its three readings, and the other two are absences with words of their own
   * — spelled by `describeModel`, not decided here. Nothing in this file asks
   * *why* there is no number.
   */
  const designatedNumber =
    map.frontier.frontier === "designated" ? map.frontier.number : null;

  const claimed: RouteRow[] = [];
  const takeable: RouteRow[] = [];
  const blocked: RouteRow[] = [];
  const resolved: RouteRow[] = [];
  const outOfScope: RouteRow[] = [];

  for (const node of map.nodes) {
    const designated = node.number === designatedNumber;
    const row: RouteRow = {
      node,
      designated,
      mark: markOf(node.state, designated),
      blockers: blockers.get(node.number) ?? NOTHING_IN_THE_WAY,
      attendance: attendanceOf(node),
      boundElsewhere: node.boundElsewhere,
      cut: node.cut.cut === "fromScope" ? node.cut.reason : null,
    };

    /*
     * The cut was decided in Rust, off the map document, and by the model's own
     * invariant a node carrying it is already resolved — so this is the same
     * *read the word* rule the switch below follows, asked of the other field.
     * A link in that section naming an open issue never gets here at all: the
     * model leaves such a node in scope, silently, and API state wins.
     */
    if (node.cut.cut === "fromScope") {
      outOfScope.push(row);
      continue;
    }

    switch (node.state) {
      case "claimed":
        claimed.push(row);
        break;
      case "takeable":
        takeable.push(row);
        break;
      case "blocked":
        blocked.push(row);
        break;
      case "resolved":
        resolved.push(row);
        break;
    }
  }

  const working = claimed.length > 0;
  const next = working ? undefined : takeable.find((row) => row.designated);

  const now = working ? claimed : next === undefined ? [] : [next];
  const frontier =
    next === undefined ? takeable : takeable.filter((row) => row !== next);

  return {
    sections: [
      sectionOf("now", working ? NOW_HEADING : SECTION_HEADINGS.now, now),
      sectionOf("frontier", SECTION_HEADINGS.frontier, frontier),
      sectionOf("blocked", SECTION_HEADINGS.blocked, blocked),
      sectionOf("resolved", SECTION_HEADINGS.resolved, resolved),
      sectionOf("outOfScope", SECTION_HEADINGS.outOfScope, outOfScope),
    ].filter((section) => section.count > 0),
    fog: map.fog,
  };
}

/* ---------------------------------------------------------------- copy --- */

/** What holds a row up, as a number and never as a spray of edges. */
export function blockedByLabel(count: number): string {
  return `blocked by ${count}`;
}

/**
 * Said on the row that waits, when one of the numbers it waits on has no row
 * here. The blocker is real and this map cannot judge it either way, so it is
 * said in words rather than counted into `blocked by N` — which would be this
 * map asserting something it has nothing on screen to back.
 */
export function beyondTheMapNote(count: number): string {
  return count === 1
    ? "1 blocker, not a child of this map, has no row here"
    : `${count} blockers, each not a child of this map, have no row here`;
}

/** The word on the cold tag, and the only place the designation is named. */
export const DESIGNATED_TAG = "designated";

/**
 * Names the ticket's binding — a fact about the reader's machine — and says
 * nothing about why the row is where it is.
 *
 * The verdict is decided per node from the labels alone, so the tag travels
 * with it onto every row that carries it, including rows the frontier would
 * not offer anyway because they are blocked, resolved or not tickets. On those
 * the machine is not the reason; it is only the reason on a row that is
 * otherwise startable.
 *
 * A tag beside the others rather than a section of its own: the row keeps the
 * section its state puts it in and is counted there. Moving it would be this
 * side re-grouping the map by a fact that is about the reader, and a group is a
 * claim about the work.
 */
export const BOUND_ELSEWHERE_TAG = "not on this machine";

export const NOW_HEADING = "Now";
export const NEXT_HEADING = "Next";

/**
 * The headings at rest, in sentence case. The stylesheet uppercases them, so a
 * hard-coded capital here would be a divergence from the design nobody sees
 * until they read the DOM.
 *
 * `now` reads *Next* because that is what the section says when nothing is
 * being worked; `NOW_HEADING` replaces it when something is.
 */
export const SECTION_HEADINGS: Record<SectionName, string> = {
  now: NEXT_HEADING,
  frontier: "Frontier",
  blocked: "Blocked",
  resolved: "Resolved",
  outOfScope: "Out of scope",
};

/**
 * The fog names itself.
 *
 * Everything else on this map has an identity — a number, a title, a URL — and
 * the fog has none of the three, because it is the work nobody has cut a ticket
 * for yet. That is exactly why it is named rather than left as a figure in the
 * margin: a region with a name is somewhere an operator can go, and an
 * unlabelled number is a smudge.
 *
 * Sentence case like the section headings, and uppercased by the stylesheet for
 * the same reason.
 */
export const FOG_HEADING = "Fog";

/**
 * What stands where the count would be when the map's body never named the fog
 * at all.
 *
 * `—` and never `0`, and the dash is only half of the answer: it is set in a
 * different face from a numeral and the region draws nothing beneath it, so
 * *nobody surveyed* and *surveyed and found nothing* differ in form rather than
 * in one character. The same em dash `environment.ts` spells as `NOTHING_YET` —
 * one dash for one meaning across the window, declared here as that file and
 * `folder.ts` each declare their own.
 */
export const NOBODY_SURVEYED = "—";

/**
 * Said under the heading when the survey happened and turned up nothing.
 *
 * A real claim, and the reason the surveyed branch always draws something under
 * its heading: an empty region and an unsurveyed one would otherwise look
 * identical below the count, and the count is not the only place the difference
 * is meant to be legible.
 */
export const FOG_ALL_CHARTED = "nothing left unspecified";

/**
 * The on-screen word for each of the four states.
 *
 * The model's own words, deliberately unchanged, in the shape `PHASE_NAMES`
 * already established: the screen and the type say the same thing, so an
 * operator reading *blocked* and a developer reading `NodeState::Blocked` are
 * reading one vocabulary. The palette is neutrals and one indigo, so the word
 * is doing most of the work and cannot be a synonym.
 */
export const STATE_NAMES: Record<NodeState, string> = {
  resolved: "resolved",
  blocked: "blocked",
  claimed: "claimed",
  takeable: "takeable",
};

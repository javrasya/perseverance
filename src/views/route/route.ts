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
 * words** — a node's state, the kind its labels named, the cut the map document
 * took, or the number `map.frontier` names when it names one — so a row's group
 * is always *the model said so* and never a heuristic.
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
 * The blocker tally moved to `../graph` when Deep Field started ranking the
 * same adjacency: one walk, two views. It is re-exported under its old name
 * because it is still the number this pane's rows are built from, and every
 * caller that had it here should go on having it here.
 */
import { NOTHING_IN_THE_WAY, blockersOf, type BlockerTally } from "../graph";

export { blockersOf };
export type { BlockerTally } from "../graph";

/* --------------------------------------------------------------- marks --- */

/**
 * Where a row stands, which is the model's four states plus the one
 * designation — and then the two rows that stand nowhere on that scale.
 *
 * The first five are a scale of work: somebody is on it, it is the one to take
 * next, it is yours to take, it is waiting, it is done. A spec child and a
 * child nobody classified are not further along or further back on that scale;
 * they are not on it. The model already says so — `is_startable_work` requires
 * a ticket, so neither can ever be `map.frontier` and neither is in `counts` —
 * and drawing either of them wearing one of the five would be the pane
 * silently reinterpreting a stray issue as available work, which is the exact
 * failure the third row of the classification exists to prevent.
 *
 * So they get marks of their own rather than a decoration on somebody else's.
 * Contrast [`RouteRow.cut`], which *is* a decoration: a cut row really is
 * closed, so `resolved` is true of it and the cut is a further fact on top —
 * true of a cut spec too, which is why the cut is asked above the kind and a
 * dropped destination wears `resolved` under its strike. Of an *open* spec,
 * *yours to take* is simply false, and a shape that says it anyway is a shape
 * that lies.
 *
 * `g-done` is the one of C5's glyphs still missing: *resolved by this session*
 * needs a run lifecycle and a session identity the derived model does not carry
 * at all, so building it would mean inventing state rather than reading it.
 */
export type Mark =
  | "claimed"
  | "designated"
  | "takeable"
  | "blocked"
  | "resolved"
  | "unclassified"
  | "destination";

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
 * Whether this child is on the scale of work at all, and which of the two ways
 * it is not.
 *
 * **The one reader of `node.kind.kind` in this file, on purpose.** The bucket a
 * non-ticket lands in and the mark it wears are two answers to one question, so
 * they are taken from one place and cannot disagree — a row drawn as the
 * destination while counted under *Frontier* would be the pane contradicting
 * itself in the same glance. [`markOf`] and the walk in [`routeOf`] both ask
 * the cut above this and then ask this, in that order, which is what keeps the
 * agreement true of a cut spec as well as of an open one.
 *
 * Nothing is decided here. `ChildKind` was settled in Rust off the map's own
 * labels: a `wayfinder:<type>` in the four is a ticket, `wayfinder:spec` is the
 * destination, and anything else at all — no label, an unrecognised one, two
 * that disagree — is unclassified. This reads that word and picks a group for
 * it.
 */
function offTheWorkScale(node: Node): "destination" | "unclassified" | null {
  if (node.kind.kind === "spec") return "destination";
  if (node.kind.kind === "unclassified") return "unclassified";
  return null;
}

/**
 * One row's precedence, top down: a cut beats everything, then the kind, then
 * claimed beats designated, and designated beats the node's state.
 *
 * **The cut first, and for the reason the walk below asks it first.** A cut is
 * the one thing on this pane an operator wrote by hand about that exact issue,
 * so it decides the bucket — and the mark has to be decided by the same
 * question in the same order or the two would answer differently about the same
 * row. `.markCut` is a *decoration composed onto a mark that is true of the
 * row*, which is the whole of #36's rule, so the mark under it has to be the
 * state the cut is true of: the model's own invariant is that a cut node is
 * already resolved, and that stays so whether the thing cut was a ticket, a
 * spec or a child nobody classified. A map that drops its own destination has
 * dropped it — it is not still going there.
 *
 * **Then the kind, above the designation, and it is the fail-safe.** The
 * designated ring is the one shape on this pane that says *start this*, and a
 * stray issue dragged onto the map arrives `takeable` like anything else.
 * Asking the kind above the designation means the pane cannot draw that ring on
 * a row that is not a ticket whatever `map.frontier` says. What that refuses is
 * the *shape and the group*: `RouteRow.designated` still carries the model's
 * word verbatim, because hiding what the frontier said would be this side
 * resolving rather than reading. The one answer to *may this be started* stays
 * `map.frontier`, in Rust, where `is_startable_work` requires a ticket.
 *
 * Claimed above designated because *somebody is on this* is the stronger of the
 * two claims — a designated node with a session against it is being worked, and
 * marking it as the next thing to pick up would send two operators at one
 * ticket. It keeps `designated` on the row underneath, which is how the heading
 * swaps to *Now* without losing what the frontier said.
 */
function markOf(node: Node, designated: boolean): Mark {
  if (node.cut.cut === "fromScope") return node.state;
  const off = offTheWorkScale(node);
  if (off !== null) return off;
  if (node.state === "claimed") return "claimed";
  if (designated) return "designated";
  return node.state;
}

function attendanceOf(node: Node): Attendance | null {
  if (node.kind.kind !== "ticket") return null;
  return node.kind.type === "research" ? "AFK" : "HITL";
}

/* ------------------------------------------------------------ sections --- */

/**
 * The sections the pane can draw, in document order.
 *
 * The fifth is *out of scope*: the rows the map document itself cut, which are
 * resolved to GitHub and are not progress. It can be a section because it
 * carries a real count — [`RouteSection.count`] is still `rows.length`, and
 * these rows are counted under this heading and under no other. That is the
 * whole of the arithmetic: *Resolved* heads the decisions made because the cut
 * ones are somewhere else, not because anything was subtracted from it.
 *
 * The sixth is *unclassified*, and it is last for the reason *out of scope* is
 * fifth: this list is the progression of work — being done, startable, held up,
 * finished, dropped — and a child nobody classified is not on that progression
 * at all, so it goes after the last group that is. **It is a section and it is
 * counted, deliberately**: *Unclassified 2* is a true and useful claim about a
 * real fault, two children on this map that the frontier can never reach, and a
 * number is exactly the right thing to say about a backlog of mislabelled
 * issues.
 *
 * **The fog is not on this list, and for the opposite reason**: it is real, it
 * is drawn, and it is not a section — the count is always `rows.length` and the
 * fog has no rows, so it rides beside the sections on [`Route`] rather than
 * being bent into one. [`Route.destination`] is beside them for a third reason
 * again: it has rows, and a count over them would be the wrong claim.
 */
export type SectionName =
  | "now"
  | "frontier"
  | "blocked"
  | "resolved"
  | "outOfScope"
  | "unclassified";

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
  /**
   * null for a spec or an unclassified child: the wayfinder's rule has nothing
   * to say about a thing that is not a ticket, and both defaults are wrong in a
   * way an operator cannot see. What those two rows say instead is their kind,
   * in the model's own word, beside the other tags.
   */
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
   *
   * That holds whatever kind was cut. A spec the map dropped is drawn as a
   * struck resolved disc and not as the destination, because *this is where we
   * are going* is exactly what the operator wrote down that they are no longer
   * doing — and a decoration composed onto a mark the row does not carry is a
   * strike through a claim nobody made.
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
   * The spec children: where all of this is going.
   *
   * **Rows, and deliberately not a [`RouteSection`].** A section's count is the
   * rows it heads, so a spec inside any section is a spec being counted as
   * work — and *never counted* is not a subtraction this side could make and
   * still be checkable, because the one honest count is `rows.length`. The way
   * to stop counting a row is to head it with something that prints no number,
   * which is what this is. The model already agrees from the other side:
   * `counts.tickets` excludes the spec, and `counts.specs` is where a number
   * about specs belongs.
   *
   * Empty when the map has no spec child, and dropped from the screen exactly
   * as an empty section is: a map still being charted has no destination yet,
   * and there is no second absence to tell apart here the way there is in the
   * fog.
   */
  readonly destination: readonly RouteRow[];
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
 * instead, or, when it is not a ticket at all, to the one its kind names. That
 * single pass is the entirety of intra-section ordering: no comparator, no
 * second pass, nothing that could reorder rows the operator arranged.
 *
 * **Kind is asked before state, and the reason is the whole of *fails safe*.**
 * A spec child and a stray issue both arrive `takeable`, so a walk that asked
 * only the state would file both under *Frontier*, count them as available
 * work and draw them wearing the ring that means *this is yours to take*. The
 * three sections at the top — *Now*, *Next* and *Frontier* — are built from the
 * takeable bucket alone, and a non-ticket never reaches it, so no spec and no
 * unclassified child can appear under any of them however the rest of this
 * file changes.
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
  const unclassified: RouteRow[] = [];
  const destination: RouteRow[] = [];

  for (const node of map.nodes) {
    const designated = node.number === designatedNumber;
    const row: RouteRow = {
      node,
      designated,
      mark: markOf(node, designated),
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

    /*
     * And the cut is asked first, above the kind, because it is the one thing
     * on this pane an operator wrote by hand about that exact issue. *We
     * dropped this* is a stronger statement than anything derived from a label,
     * so a spec the map cut is drawn among the things the map cut — the
     * destination is where a map is going, and a cut one is not going there.
     * [`markOf`] asks the two in this same order, so the row's shape is the
     * struck resolved disc every other cut row wears rather than a waypoint
     * with a bar drawn across it at an angle.
     */
    const off = offTheWorkScale(node);
    if (off === "destination") {
      destination.push(row);
      continue;
    }
    if (off === "unclassified") {
      unclassified.push(row);
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
      sectionOf("unclassified", SECTION_HEADINGS.unclassified, unclassified),
    ].filter((section) => section.count > 0),
    destination,
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
  unclassified: "Unclassified",
};

/**
 * The heading over the spec children, and the only group on the pane whose
 * heading stands over no count.
 *
 * *Destination* rather than *Spec*, because the word has to say what the row is
 * for and not only what its label reads: the spec is where the map is going,
 * which is exactly the thing that is never a step along the way. The model's
 * own word for it is on the row itself, as [`SPEC_TAG`].
 *
 * Sentence case like the section headings, and uppercased by the stylesheet for
 * the same reason.
 */
export const DESTINATION_HEADING = "Destination";

/**
 * The two kinds of child that are not tickets, said on the row in the model's
 * own words.
 *
 * The screen and the type read one vocabulary, exactly as `STATE_NAMES` keeps
 * them: an operator reading *unclassified* and a developer reading
 * `ChildKind::Unclassified` are reading the same thing. And the word is the
 * whole of why a stray issue fails safe rather than fails silently — the row is
 * in a group of its own, wearing a shape of its own, and it also *says* what it
 * is, so nothing about it depends on the reader knowing the shapes.
 */
export const SPEC_TAG = "spec";
export const UNCLASSIFIED_TAG = "unclassified";

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

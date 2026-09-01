/**
 * The crossing's four sockets, derived and nothing else.
 *
 * A socket is the layout and the button is the ink. All four — Start Working,
 * Resume, Ask, To Frontier — are on screen at all times and in one order, so a
 * state change is a change of ink and never a change of layout. A button that
 * cannot be pressed is **recessed in the same box**, still visible, still in the
 * accessibility tree, printing the condition that would fill it as visible text.
 * Nothing here is a tooltip: a reason only a hover can reach is a reason nobody
 * reading the screen has.
 *
 * Everything here is a pure function of five facts — what the map says about
 * *what next*, what the operator has selected, what that selection is and where
 * it is bound, what it reads, and what this folder resolved — plus where the
 * press in flight is and which button made it. The
 * rendering in `Sockets.tsx` picks nothing.
 *
 * **The frontier is singular and structural.** The target comes from
 * `model.map.frontier` and from the refusal a press came back with, and from
 * nowhere else: no row of the route, no ranking of this side's own. There is one
 * frontier resolver and it is in Rust.
 */

import type { AdapterReading, FolderReadout } from "../environment/folder";
import type { Frontier, NodeState, Phase } from "../snapshot/model.generated";
import { claiming, type RunReadout } from "../terminal/runs";

/** The four verbs, in the fixed order they occupy the rail in. */
export type SocketId = "start" | "resume" | "ask" | "toFrontier";

/**
 * The ink in a socket.
 *
 * `checking` is a third reading rather than a recessed one: the button is not
 * pressable, but the condition that would fill it is already met and printing
 * one would be a lie about why. It is ink and not motion — movement in this app
 * is rationed to liveness, and a spinner on a button is not liveness.
 */
export type Fill = "filled" | "checking" | "recessed";

export interface Socket {
  id: SocketId;
  label: string;
  fill: Fill;
  /** What would fill it, as visible text. Non-null exactly when recessed. */
  condition: string | null;
  /** The harness's own last sentence about this socket, printed either way. */
  note: string | null;
  /**
   * The number this socket acts on and prints, or `null` when it acts on none.
   *
   * The selection for Ask, the claim under the hand for Resume, the frontier's
   * ticket for To Frontier, and
   * either a ticket or the map for the primary socket — which is why it is a
   * fact about the socket rather than one the rendering works out from an id.
   * The two aimed sockets stopped being aimed at the same number the moment one
   * of them could offer a compose.
   */
  aimedAt: number | null;
}

/**
 * Where the press is, and **whose press it was**.
 *
 * `refused` carries the answer verbatim, because the two fields are different
 * facts: `detail` is what the harness said, and `frontier` is what it learned —
 * `null` meaning *no fresh read landed*, which names no new target at all.
 *
 * `node` is the third fact, and it is **what the press was aimed at**: the
 * selection the question was about, for the one verb the selection alone arms.
 * Ask's refusal names it; the two verbs that re-arm on a fresh read name `null`
 * and are retired by `frontier` above. It is carried rather than read off the
 * rail because the answer lands after the press, and the node under the hand by
 * then need not be the one the press was about — a refusal printed against a
 * node it was never about is a sentence about a press nobody made, which is the
 * same failure `socket` is here to prevent one socket over.
 *
 * The `socket` rides along because two verbs now spawn. A rail that remembered
 * only *a press is out* would print `checking…` on Start Working while Resume
 * was the button under the hand, and would hang Resume's refusal under Start —
 * each of them a sentence about a press nobody made. What it does not change is
 * the re-arm: a frontier is a fact about the map rather than about the verb that
 * happened to learn it, so `standing` reads any refusal's.
 */
export type Press =
  | { kind: "idle" }
  | { kind: "checking"; socket: SocketId }
  | {
      kind: "refused";
      socket: SocketId;
      detail: string;
      frontier: Frontier | null;
      node: number | null;
    };

export interface Crossing {
  /** `model.map.frontier`, or `null` when no map is open. */
  frontier: Frontier | null;
  selection: number | null;
  /**
   * What the selected node reads on the map, or `null` when nothing is selected
   * — and equally when the selection is not a child of the map that is open.
   *
   * The state and not a boolean, because the rail is not entitled to a second
   * opinion about what *claimed* means: the four states are derived once, in
   * strict precedence, in `derive.rs`, and a ticket assigned to the operator
   * with an open blocker in its way reads `blocked` there and must read
   * `blocked` here. This carries that answer across rather than deriving a
   * softer one beside it.
   */
  selectionReads: NodeState | null;
  /**
   * Whether the selection is a wayfinder ticket, and `false` when nothing is
   * selected.
   *
   * Beside the state rather than folded into it, because the two are different
   * facts and the derivation reads only the second: a spec node and an
   * unclassified child both read `claimed` the moment they are assigned with
   * nothing in their way. Start Working meets neither — the frontier's resolver
   * answers *is this a ticket* before it designates anything — and Resume is
   * aimed at the selection, which no resolver has been through, so the answer
   * has to cross here or the rail arms over a node no brief fits.
   */
  selectionIsTicket: boolean;
  /**
   * Whether the selection carries the label that binds it to another machine,
   * and `false` when nothing is selected.
   *
   * The second of the two guards Resume does not inherit, and here for the same
   * reason as the first: the frontier's resolver asks *is this bound elsewhere*
   * before it designates anything, so Start Working can never meet one — while
   * Resume is aimed at the selection, and `NodeState` is derived from state
   * alone, so a ticket assigned to the operator and labelled for another
   * platform reads `claimed` as plainly as any other. Without this the rail
   * arms, and the press buys a full revalidation only to be told what the label
   * already said. `docs/adr/0015` promises of that label family that nothing is
   * hidden and nothing is launched; the node stays on the map and the socket
   * stays in its box, and the refusal is printed before the press rather than
   * after it.
   */
  selectionBoundElsewhere: boolean;
  /**
   * What this folder resolved, or `null` while nothing has come back for it.
   *
   * The whole readout rather than its adapters, because *no adapter here* and
   * *nobody has looked yet* are different answers and only the readout can tell
   * them apart: the harvest this reading waits on is a login shell, bounded in
   * seconds rather than milliseconds, and for all of those seconds a folder is
   * open with nothing known about it. An empty list would say the folder was
   * searched and came up empty, which is a definite negative answer to a
   * question nothing has yet asked.
   */
  environment: FolderReadout | null;
  /** The folder a run would be spawned in, or `null` when none is open. */
  folder: string | null;
  /**
   * The open map's rung on the ladder, or `null` when no map is open.
   *
   * From `model.map.phase` and from nowhere else. **The phase gates the offer
   * and the frontier does not**, because the two answer different questions:
   * the frontier says which ticket is takeable next, and a map with nothing
   * takeable left reads `nothingToStart` whether its tickets were all closed or
   * this machine can start none of them. Only the phase tells *finished* from
   * *stuck*, and a compose offered on the second would brief a session to write
   * a spec about work nobody did. The ladder is derived once, in
   * `crates/model/src/derive.rs`; nothing on this side computes a rung.
   */
  phase: Phase | null;
  /** `model.map.number` — the map a compose would be composed on. */
  map: number | null;
  /**
   * The map a compose run this window started is still writing a spec for, or
   * `null` when none is.
   *
   * The one reading on this crossing that comes from neither the model nor the
   * folder, and it has to: a compose assigns nobody and its map stays on
   * `specReady` until the spec lands at the very end of the run, so the
   * snapshot says the same thing during a compose as it says before one. The
   * window's own spawn is the only trace of it this side has — `Sockets.tsx`
   * remembers the run it started and reads whether the readouts still show it
   * going, which is the same join `Terminals::composing` makes in Rust.
   *
   * The rail is the second half of that guard and never the whole of it: the
   * harness refuses the duplicate press whatever the socket looks like, and
   * this only keeps a filled button from promising a run it would not get.
   */
  composing: number | null;
  press: Press;
}

/**
 * What one press of the primary socket goes out as.
 *
 * Two commands behind one box. The offer rides in the socket Start Working
 * already owns rather than in a fifth one, because the rail is four sockets in
 * one order — a socket that appears when its map finishes is a rail that
 * changes shape under a hand, which is what ADR 0021 and this file's own header
 * exist to prevent. A spec-ready map has no takeable ticket left, so the box is
 * idle at exactly the moment the compose wants it: same box, different ink,
 * different aimed number.
 *
 * The discrimination lives here and not in `Sockets.tsx`, so the rendering goes
 * on picking nothing — it presses what the derivation handed it.
 */
export type StartTarget =
  | { kind: "ticket"; ticket: number }
  | { kind: "compose"; map: number };

export interface Rail {
  /** Exactly four, always, in `SocketId` order. */
  sockets: readonly Socket[];
  /** The ticket To Frontier snaps to, straight off the standing frontier. */
  target: number | null;
  /** What the primary socket would press, or `null` when it would press none. */
  start: StartTarget | null;
  /**
   * The ticket Resume is armed on, and never the one Start Working is.
   *
   * A second armed number rather than a second reading of `target`: the two can
   * never be the same node, because the frontier is the first *takeable* node by
   * construction and a takeable node is one nobody has claimed. A rail printing
   * one number under both buttons would be printing a number that is false under
   * one of them.
   */
  claim: number | null;
  /** The adapter ids offerable at this press, in the order the folder read them. */
  adapters: readonly string[];
}

export const START_LABEL = "Start Working";
/** The primary socket's other word, on a map that is finished. */
export const COMPOSE_LABEL = "Compose Spec";
export const RESUME_LABEL = "Resume";
export const ASK_LABEL = "Ask";
export const TO_FRONTIER_LABEL = "To Frontier";

/** Ink, not motion. See [`Fill`]. */
export const CHECKING_LABEL = "checking…";

export const NO_MAP_OPEN = "open a map — nothing is designated until one is";
export const NOTHING_TAKEABLE = "nothing on this map is takeable";
export const ANOTHER_MACHINE = "the frontier is bound to another machine";
export const NO_FOLDER_OPEN = "open a folder — a run is started somewhere";
export const NO_ADAPTER = "no agent CLI was found in this folder";
/**
 * Not *found nothing* — *has not looked yet*. It stands in front of
 * [`NO_ADAPTER`] for the whole of a harvest, which is a login shell and takes
 * seconds, and it is what an operator sees after pressing *Ask again* or
 * opening a second folder.
 */
export const STILL_READING = "this folder's environment is still being read";
export const ALREADY_THERE = "the frontier is already selected";

export const NOTHING_SELECTED = "select a ticket — Resume picks up the selection";
/**
 * Why a map that is already being composed offers no second compose, in the
 * words `a_compose_is_already_open` in `crates/app/src/lib.rs` refuses with.
 *
 * Said twice on purpose, once per side: the harness is what enforces it — a
 * press that gets past a stale rail is still refused there — and this is what
 * an operator reads instead of a button that would spawn a second session
 * attaching a second `wayfinder:spec` child to the same map.
 */
export const alreadyComposing = (map: number): string =>
  `#${map} already has a compose run open`;

/**
 * Not *claimed by somebody else*: the model carries a count of who has taken a
 * ticket and no logins, on purpose, so *claimed by me* is a fact this side could
 * not decide if it wanted to — and the inputs it would need are kept off this
 * side entirely, which `tests/snapshot.test.ts` pins by scanning for them. What
 * this rail can say is what the node reads, which is exactly the precondition
 * Rust gates on. See `docs/adr/0023`.
 */
export const NOT_A_CLAIM = "the selected ticket is not claimed, so there is nothing to pick up";
/**
 * Met before [`NOT_A_CLAIM`], because kind comes before state: a spec node and
 * an unclassified child can both be assigned, and both read `claimed`. The
 * destination is where the map is going rather than something to launch at, and
 * a child carrying no recognised wayfinder type has no brief to hand an agent.
 */
export const NOT_A_TICKET = "the selected node is not a ticket, so there is nothing to resume";
/**
 * The other guard Resume does not inherit, said in front of the press rather
 * than after it. Rust asks it in this position too — after the kind and before
 * the state — and would refuse the press with the same fact; the difference is
 * only that the refusal there costs a whole revalidation to hear.
 */
export const CLAIM_ELSEWHERE =
  "the selected ticket is bound to another machine, so it is not resumable here";

/**
 * What a socket says while *another* spawning verb's press is out.
 *
 * Derived and never guarded: one crossing sends one command at a time, and a
 * rail that enforced that in the handler would leave the socket beside the one
 * under the hand filled, armed and silent, swallowing a press for the whole of a
 * revalidation. So the fact travels as ink, in the three sentences that name
 * whose press it is. Only the spawning sockets take it — To Frontier sends no
 * command, so a check in flight is nothing to it.
 *
 * [`ASK_IS_OUT`] is about a **press** and never about a run, and the two look
 * alike at exactly the wrong moment. Ask gates on no run at all — a live work
 * run and a live compose leave it filled — but a press it has already made is
 * this crossing's one command in flight, and the socket beside it says so for
 * as long as that answer is still on its way. See
 * `docs/adr/0027-ask-claims-nothing-so-it-gates-on-nothing`.
 */
export const START_IS_OUT =
  "Start Working's press is still out, and one crossing sends one command at a time";
export const RESUME_IS_OUT =
  "Resume's press is still out, and one crossing sends one command at a time";
export const ASK_IS_OUT =
  "Ask's press is still out, and one crossing sends one command at a time";

/**
 * Why there is nothing to ask about, in the words the map's absence has here.
 *
 * Not [`NO_MAP_OPEN`], whose sentence is about designation: nothing about Ask is
 * designated, and the reading it takes is `model.map.number` rather than the
 * frontier. A rail that asked the frontier this question would be borrowing an
 * answer to a different one — *is there a takeable ticket* — and would recess
 * Ask on a finished map, where a question is exactly what is left to have.
 */
export const NO_MAP_TO_ASK_ABOUT = "open a map — a question is asked about a node on one";
/**
 * Not [`NOTHING_SELECTED`], which names the wrong verb and the wrong kind of
 * node. Ask says *node* because a node is what it takes: the spec, an
 * unclassified child and a ticket are all askable, and a sentence saying
 * *select a ticket* would be telling an operator that the interesting half of
 * the map is out of bounds.
 */
export const NO_NODE_SELECTED = "select a node — Ask asks about the selection";
/**
 * The one refusal Rust makes about the number, said in front of the press
 * rather than after it, in the words `ask` refuses with in
 * `crates/app/src/lib.rs`.
 *
 * A function of the number for the reason [`alreadyComposing`] is one: a
 * sentence that names what is wrong is a sentence an operator can act on, and
 * the selection can outlive the map it belonged to — the Route keeps a pointer
 * the ledger has already moved off.
 */
export const notOnThisMap = (node: number): string =>
  `#${node} is not on the open map, so there is nothing here to ask about`;

/** The number a frontier designates, or `null` in either of its two absences. */
export function designated(frontier: Frontier | null): number | null {
  return frontier !== null && frontier.frontier === "designated" ? frontier.number : null;
}

/**
 * The ticket Resume is armed on: the selection, while it is a ticket, is not
 * bound to another machine, and is a claim.
 *
 * All three, and in that order, because the Route makes the destination and the
 * unclassified rows selectable too — and `claimed` is a reading of state alone,
 * so any of them arms this button the moment it is assigned. The two guards in
 * front of the state are the two the frontier's resolver answers for Start
 * Working and nobody answers for Resume; they are asked here in the order Rust
 * asks them, so the rail and the command cannot disagree about which fact
 * refuses first.
 */
export function claimed(crossing: Crossing): number | null {
  return crossing.selection !== null &&
    crossing.selectionIsTicket &&
    !crossing.selectionBoundElsewhere &&
    crossing.selectionReads === "claimed"
    ? crossing.selection
    : null;
}

/**
 * Why there is no claim under the hand, in the order an operator meets them.
 *
 * The selection and never *the one claimed node on the map*: a map with two
 * claims would have that rule silently pick one of them, and the press that
 * followed would spawn an agent on a ticket nobody pointed at. The Route already
 * makes claimed rows selectable, so the pointer exists and it is the operator's.
 */
export function whyNoClaim(crossing: Crossing): string | null {
  if (crossing.frontier === null) return NO_MAP_OPEN;
  if (crossing.selection === null) return NOTHING_SELECTED;
  if (!crossing.selectionIsTicket) return NOT_A_TICKET;
  if (crossing.selectionBoundElsewhere) return CLAIM_ELSEWHERE;
  return crossing.selectionReads === "claimed" ? null : NOT_A_CLAIM;
}

/**
 * The live run this window already holds on that claim, or `null`.
 *
 * **The folder and the number, which is the pair `live_run_on` in Rust matches
 * on**: an issue number is unique inside one repository and means nothing across
 * two, and `runs` is every run this window holds whatever folder it was started
 * in. On the number alone this answered a claim in one repository with somebody
 * else's run in another — and because a press that finds a live run sends no
 * command at all, Rust's own folder-aware check was never reached to refuse it.
 *
 * `over` and not the ending, because the two are independent facts: a run whose
 * ticket closed under it is still a child with a shell in it, and re-focusing
 * that pane is what a hand pressing Resume on that claim is asking for.
 *
 * **And the kind on top of the pair, because naming a node is not holding it.**
 * An Ask run stakes the node it is asking about, in that node's folder — the
 * same two values a work run stakes — so on the pair alone a question about a
 * claim answered for the claim. Resume then took its re-focus branch and bound
 * the pane to the question session, and because that branch sends no command
 * nothing refused and nothing was printed: the operator believed they had
 * resumed work and was reading an Ask.
 */
export function liveRunOn(
  runs: readonly RunReadout[],
  ticket: number,
  folder: string,
): number | null {
  const found = runs.find(
    (run) =>
      run.ticket === ticket &&
      run.folder === folder &&
      claiming(run.kind) &&
      !run.over,
  );
  return found?.run ?? null;
}

/** Why this frontier offers nothing to start, in the readings there are. */
export function whyNothingToStart(frontier: Frontier | null): string | null {
  if (frontier === null) return NO_MAP_OPEN;
  switch (frontier.frontier) {
    case "designated":
      return null;
    case "notOnThisMachine":
      return ANOTHER_MACHINE;
    case "nothingToStart":
      return NOTHING_TAKEABLE;
  }
}

/** Only a resolved adapter is a choice; an unresolved one is not offerable. */
export function offerable(adapters: readonly AdapterReading[]): readonly string[] {
  return adapters
    .filter((adapter) => adapter.resolution.kind === "resolved")
    .map((adapter) => adapter.id);
}

/**
 * Which adapter this press would go out with.
 *
 * The choice belongs to the press: a value the rail holds for as long as the
 * hand is on it, and never a setting read or written anywhere. A pick that has
 * stopped being offerable — the folder re-resolved and lost it — falls back to
 * the first one that still is, because a press carrying a name this folder
 * cannot resolve is a press nobody made.
 */
export function adapterAtPress(
  offered: readonly string[],
  chosen: string | null,
): string | null {
  if (chosen !== null && offered.includes(chosen)) return chosen;
  return offered[0] ?? null;
}

/**
 * Whether two frontier readings say the same thing.
 *
 * Structural and not by identity, because every poll hands this side a freshly
 * decoded snapshot: an identity test would call each tick a move and retire a
 * refusal the map still agrees with.
 */
export function sameFrontier(a: Frontier | null, b: Frontier | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.frontier !== b.frontier) return false;
  return a.frontier === "designated" && b.frontier === "designated"
    ? a.number === b.number
    : true;
}

/**
 * The frontier this rail is standing on.
 *
 * A refusal that named one wins over the snapshot **while it is the newer
 * read** — the pass that press bought is what produced it, and the prop beside
 * it was read before the press. It stops being the newer read the moment a
 * snapshot lands that disagrees with it, and at that moment `Sockets.tsx`
 * retires the refusal back to `idle`; a refusal that is still here has not been
 * contradicted by anything since. So this preference is bounded by that
 * retirement rather than by the session: the arm never outlives its evidence.
 *
 * A refusal that named none re-arms on nothing — it names no target, so the
 * socket keeps the one it already had and prints the sentence beside it.
 */
function standing(crossing: Crossing): Frontier | null {
  const { press, frontier } = crossing;
  if (press.kind === "refused" && press.frontier !== null) return press.frontier;
  return frontier;
}

/**
 * Whether this folder's answer is still on its way.
 *
 * Two ways it can be: no readout has landed at all — which is the state a fresh
 * selection and an *Ask again* both pass through — and a readout that landed
 * mid-harvest, whose adapter list is what was known before the shell answered.
 * Either way the folder has not finished being read, and nothing here is
 * entitled to say what it holds.
 */
export function stillReading(environment: FolderReadout | null): boolean {
  return environment === null || environment.harvest.kind === "harvesting";
}

/**
 * What the primary socket is armed on, in the two things it can be armed on.
 *
 * `specReady` is *every ticket on this map is closed and no spec exists yet*,
 * and it is the only rung that offers a compose: the four others leave the
 * socket exactly as it was, ticket and all — which is also why the offer is
 * gone the moment the map reads `specced`.
 */
export function startTarget(crossing: Crossing, target: number | null): StartTarget | null {
  if (crossing.phase === "specReady" && crossing.map !== null) {
    return { kind: "compose", map: crossing.map };
  }
  return target === null ? null : { kind: "ticket", ticket: target };
}

const aimOf = (start: StartTarget | null): number | null =>
  start === null ? null : start.kind === "compose" ? start.map : start.ticket;

/** Whether the press in flight is this socket's. Nobody else reads `checking…`. */
function checkingOn(press: Press, socket: SocketId): boolean {
  return press.kind === "checking" && press.socket === socket;
}

/**
 * The harness's last sentence to this socket, and never to the one beside it —
 * and never about a node the operator has since moved off.
 *
 * The second half is for the answer that lands late. A press goes out on #41,
 * the selection moves to #42 while the command is still in flight, and the
 * refusal is written to state after the move: no selection change follows it,
 * so the retirement in `Sockets.tsx` never sees it, and the sentence about #41
 * would sit under a socket now armed on #42. Read here against the selection it
 * is simply not this rail's sentence to print, which makes the window between
 * the press and its answer no wider than the window after it. A refusal that
 * named no node was aimed at the frontier, and `standing` retires that one.
 */
function sentenceOn(crossing: Crossing, socket: SocketId): string | null {
  const { press, selection } = crossing;
  if (press.kind !== "refused" || press.socket !== socket) return null;
  return press.node === null || press.node === selection ? press.detail : null;
}

/**
 * Why this spawning socket takes no press while the other one's is out.
 *
 * The whole of *one crossing sends one command at a time*, and derived rather
 * than guarded: a rail that turned the second press away in the handler would
 * leave this socket filled, armed and silent for the length of a revalidation,
 * which is a button lying about what it does. Asked only by the two verbs that
 * send a command — To Frontier is a selection and nothing else, so a check in
 * flight costs it nothing — and never about the socket's own press, which reads
 * `checking…` and is a different sentence.
 *
 * Last of the conditions, because it is the only transient one: a socket with no
 * folder under it says so whether or not a press is out.
 */
function pressOut(press: Press, socket: SocketId): string | null {
  if (press.kind !== "checking" || press.socket === socket) return null;
  switch (press.socket) {
    case "start":
      return START_IS_OUT;
    case "resume":
      return RESUME_IS_OUT;
    case "ask":
      return ASK_IS_OUT;
    /* To Frontier moves the selection and sends nothing, so it is never the
       press in flight — and if it somehow were, it would be nothing to wait on. */
    case "toFrontier":
      return null;
  }
}

function startSocket(
  crossing: Crossing,
  start: StartTarget | null,
  offered: readonly string[],
): Socket {
  const note = sentenceOn(crossing, "start");
  const aimedAt = aimOf(start);

  if (checkingOn(crossing.press, "start")) {
    return {
      id: "start",
      label: CHECKING_LABEL,
      fill: "checking",
      condition: null,
      note,
      aimedAt,
    };
  }

  /* A compose is a run like any other — spawned in a folder, through an adapter
     that folder resolved — so the same three facts gate it, checked in the same
     order and printed in the same words. What the two presses do not share is
     why there might be nothing to press at all: that reading is the frontier's,
     and a compose press cannot get here without a map.

     One condition is a compose's alone, and it is read first because it is the
     more particular answer: a map with a compose already going has a folder
     open and an adapter resolved — that is how the run being named got
     started — so any of the three below would be a truer-sounding reason for
     the wrong thing. */
  const condition =
    start === null
      ? whyNothingToStart(standing(crossing))
      : start.kind === "compose" && crossing.composing === start.map
        ? alreadyComposing(start.map)
        : crossing.folder === null
          ? NO_FOLDER_OPEN
          : stillReading(crossing.environment)
            ? STILL_READING
            : offered.length === 0
              ? NO_ADAPTER
              : pressOut(crossing.press, "start");

  return {
    id: "start",
    label: start?.kind === "compose" ? COMPOSE_LABEL : START_LABEL,
    fill: condition === null ? "filled" : "recessed",
    condition,
    note,
    aimedAt,
  };
}

/**
 * Resume, over a claim the operator already holds.
 *
 * The second half of the condition is Start Working's, constant for constant,
 * and deliberately not a second set of sentences: a resume spawns a child in a
 * folder with an agent in it exactly as a start does, so *no folder open*, *the
 * folder is still being read* and *no agent CLI here* are the same facts, said
 * once. Whether the claim is stale or still has a pane open changes nothing
 * here — both fill this socket, and which of the two a press does is the
 * wiring's, on `liveRunOn`.
 */
function resumeSocket(
  crossing: Crossing,
  claim: number | null,
  offered: readonly string[],
): Socket {
  const note = sentenceOn(crossing, "resume");

  if (checkingOn(crossing.press, "resume")) {
    return {
      id: "resume",
      label: CHECKING_LABEL,
      fill: "checking",
      condition: null,
      note,
      aimedAt: claim,
    };
  }

  const condition =
    claim === null
      ? whyNoClaim(crossing)
      : crossing.folder === null
        ? NO_FOLDER_OPEN
        : stillReading(crossing.environment)
          ? STILL_READING
          : offered.length === 0
            ? NO_ADAPTER
            : pressOut(crossing.press, "resume");

  return {
    id: "resume",
    label: RESUME_LABEL,
    fill: condition === null ? "filled" : "recessed",
    condition,
    note,
    aimedAt: claim,
  };
}

/**
 * Ask, over whatever node the operator pointed at.
 *
 * The third spawning socket, and the one that claims nothing. Its conditions are
 * the honest ones and only those: a question needs a map to be about, a node on
 * that map to be about, and the same three facts about the folder every other
 * spawn needs, because an Ask session is a child in a folder with an agent in it
 * exactly as a work run is. Nothing else recesses it.
 * `docs/adr/0027-ask-claims-nothing-so-it-gates-on-nothing` is why, and the
 * absences below are that decision written into the derivation.
 *
 * **The kind is absent.** `selectionIsTicket` is never read here. A spec node
 * and a child carrying no `wayfinder:` label are both askable — the unclassified
 * child is the one you most need to ask about, and a rail that refused it would
 * make the murky half of the map the unaskable half.
 *
 * **The binding is absent.** `selectionBoundElsewhere` is never read here. That
 * label says who may *launch* at a node, and nothing is being launched at this
 * one; a node another machine is working is still a node an operator can have a
 * question about.
 *
 * **The state is absent.** `selectionReads` is read for one thing only — whether
 * the selection is on the open map at all — and never for what it says.
 * `claimed`, `blocked`, `takeable` and `closed` all fill this socket, because
 * Ask takes no claim and so no state of the node has anything to refuse.
 *
 * **The map's rung and the frontier are absent.** Neither `phase` nor
 * `frontier` nor `composing` is read. A live compose run and a live claiming
 * work run both stay live and neither refuses the press: that is the GitHub
 * invariant, and Ask is outside it.
 *
 * **The live runs are absent.** There is no ceiling here and no queue. The one
 * rule Ask is inside is the keyboard invariant — one pane, one keyed run — and
 * that is enforced by the monitor bind a successful spawn makes, not by a
 * condition that would have kept the press from being made.
 */
function askSocket(crossing: Crossing, offered: readonly string[]): Socket {
  const note = sentenceOn(crossing, "ask");
  /* The selection, and never a ticket or the frontier: Ask acts on the node
     under the hand, so the number on the button is the number that goes out. */
  const aimedAt = crossing.selection;

  if (checkingOn(crossing.press, "ask")) {
    return {
      id: "ask",
      label: CHECKING_LABEL,
      fill: "checking",
      condition: null,
      note,
      aimedAt,
    };
  }

  /* `selectionReads` is `null` in exactly two cases — nothing selected, and a
     selection that is not a child of the open map — so with the second
     condition already past, `null` here is the off-map one. That is Rust's own
     `#N is not on map #M` refusal, printed before the press rather than bought
     with one. */
  const condition =
    crossing.map === null
      ? NO_MAP_TO_ASK_ABOUT
      : crossing.selection === null
        ? NO_NODE_SELECTED
        : crossing.selectionReads === null
          ? notOnThisMap(crossing.selection)
          : crossing.folder === null
            ? NO_FOLDER_OPEN
            : stillReading(crossing.environment)
              ? STILL_READING
              : offered.length === 0
                ? NO_ADAPTER
                : pressOut(crossing.press, "ask");

  return {
    id: "ask",
    label: ASK_LABEL,
    fill: condition === null ? "filled" : "recessed",
    condition,
    note,
    aimedAt,
  };
}

function toFrontierSocket(crossing: Crossing, target: number | null): Socket {
  const condition =
    target === null
      ? whyNothingToStart(standing(crossing))
      : crossing.selection === target
        ? ALREADY_THERE
        : null;

  return {
    id: "toFrontier",
    label: TO_FRONTIER_LABEL,
    fill: condition === null ? "filled" : "recessed",
    condition,
    note: null,
    aimedAt: target,
  };
}

/** The whole rail, from the crossing. Four sockets, always, in one order. */
export function railAt(crossing: Crossing): Rail {
  const offered = offerable(crossing.environment?.adapters ?? []);
  const target = designated(standing(crossing));
  const start = startTarget(crossing, target);
  const claim = claimed(crossing);

  return {
    target,
    start,
    claim,
    adapters: offered,
    sockets: [
      startSocket(crossing, start, offered),
      resumeSocket(crossing, claim, offered),
      askSocket(crossing, offered),
      toFrontierSocket(crossing, target),
    ],
  };
}

/**
 * Why the agent cannot be picked, in the two ways it cannot be.
 *
 * Both are printed as visible text under the name the picker stands on, and
 * neither is ever a `title`: information behind a hover is information a screen
 * reader and a keyboard cannot have, which is the same rule the sockets'
 * conditions already follow.
 */
export const RUN_IS_UP =
  "a run is going in this folder — an agent cannot be swapped under one that is already talking";
export const ONLY_ADAPTER = "this folder resolved one agent CLI, so there is nothing to choose";
/** What the palette prints when there is no picker on screen for it to focus. */
export const NO_PICKER =
  "no picker is on screen — open a folder at the crossing to choose an agent";

/**
 * What the picker is right now: a control, a printed name, or nothing.
 *
 * Derived here rather than branched inside the component, for the reason every
 * other word on the rail is: *unchangeable, and why* is a reading over the runs
 * and the folder, and a component working it out inline would be a second place
 * the answer could drift from — and the one place a unit test could not reach
 * it.
 */
export interface Picking {
  mode: "choice" | "printed" | "none";
  /** The adapter a press would go out with, when there is one. */
  chosen: string | null;
  /** Why it cannot be changed, when it cannot. `null` while it can. */
  fixed: string | null;
}

/**
 * Whether a run this window started in this folder is still going.
 *
 * Joined on the folder as well as the id, the same pair [`liveRunOn`] matches
 * on and for the same reason: this window holds every folder's runs, and a rail
 * printing its picker as locked because some *other* repository has an agent up
 * would be refusing a choice nothing is contending for.
 */
export function runningIn(
  runs: readonly RunReadout[],
  liveRuns: readonly number[],
  folder: string | null,
): boolean {
  if (folder === null) return false;
  return runs.some((run) => run.folder === folder && liveRuns.includes(run.run));
}

/** The picker, from what the folder offers and what is going in it. */
export function picking(
  offered: readonly string[],
  chosen: string | null,
  duringRun: boolean,
): Picking {
  const adapter = adapterAtPress(offered, chosen);
  /* Nothing at all, and no sentence either: the recessed Start Working beside
     it already prints `NO_ADAPTER`, and a second copy of that sentence under an
     empty control would be the rail saying it twice. */
  if (adapter === null) return { mode: "none", chosen: null, fixed: null };
  if (duringRun) return { mode: "printed", chosen: adapter, fixed: RUN_IS_UP };
  if (offered.length === 1) return { mode: "printed", chosen: adapter, fixed: ONLY_ADAPTER };
  return { mode: "choice", chosen: adapter, fixed: null };
}

/** Whether a socket takes a press. The one place `checking…` is unpressable. */
export function pressable(socket: Socket): boolean {
  return socket.fill === "filled";
}

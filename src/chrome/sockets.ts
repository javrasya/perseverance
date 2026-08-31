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
 * Everything here is a pure function of three facts — what the map says about
 * *what next*, what the operator has selected, and what this folder resolved —
 * plus where the press in flight is. The rendering in `Sockets.tsx` picks
 * nothing.
 *
 * **The frontier is singular and structural.** The target comes from
 * `model.map.frontier` and from the refusal a press came back with, and from
 * nowhere else: no row of the route, no ranking of this side's own. There is one
 * frontier resolver and it is in Rust.
 */

import type { AdapterReading, FolderReadout } from "../environment/folder";
import type { Frontier, Phase } from "../snapshot/model.generated";

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
   * `null` for Resume and Ask, the frontier's ticket for To Frontier, and
   * either a ticket or the map for the primary socket — which is why it is a
   * fact about the socket rather than one the rendering works out from an id.
   * The two aimed sockets stopped being aimed at the same number the moment one
   * of them could offer a compose.
   */
  aimedAt: number | null;
}

/**
 * Where the press is.
 *
 * `refused` carries the answer verbatim, because the two fields are different
 * facts: `detail` is what the harness said, and `frontier` is what it learned —
 * `null` meaning *no fresh read landed*, which names no new target at all.
 */
export type Press =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "refused"; detail: string; frontier: Frontier | null };

export interface Crossing {
  /** `model.map.frontier`, or `null` when no map is open. */
  frontier: Frontier | null;
  selection: number | null;
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

/**
 * Resume is #49's and Ask is #55's. Their sockets are here because the rail is
 * four boxes rather than however many verbs happen to be implemented — a socket
 * that appears when its ticket lands is a rail that changes shape, and a rail
 * that changes shape under a hand is what this file exists to prevent.
 */
export const RESUME_ARRIVES = "picking a stopped run back up is not built yet";
export const ASK_ARRIVES = "asking a live run a question is not built yet";

/** The number a frontier designates, or `null` in either of its two absences. */
export function designated(frontier: Frontier | null): number | null {
  return frontier !== null && frontier.frontier === "designated" ? frontier.number : null;
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

function startSocket(
  crossing: Crossing,
  start: StartTarget | null,
  offered: readonly string[],
): Socket {
  const note = crossing.press.kind === "refused" ? crossing.press.detail : null;
  const aimedAt = aimOf(start);

  if (crossing.press.kind === "checking") {
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
     and a compose press cannot get here without a map. */
  const condition =
    start === null
      ? whyNothingToStart(standing(crossing))
      : crossing.folder === null
        ? NO_FOLDER_OPEN
        : stillReading(crossing.environment)
          ? STILL_READING
          : offered.length === 0
            ? NO_ADAPTER
            : null;

  return {
    id: "start",
    label: start?.kind === "compose" ? COMPOSE_LABEL : START_LABEL,
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

  return {
    target,
    start,
    adapters: offered,
    sockets: [
      startSocket(crossing, start, offered),
      {
        id: "resume",
        label: RESUME_LABEL,
        fill: "recessed",
        condition: RESUME_ARRIVES,
        note: null,
        aimedAt: null,
      },
      {
        id: "ask",
        label: ASK_LABEL,
        fill: "recessed",
        condition: ASK_ARRIVES,
        note: null,
        aimedAt: null,
      },
      toFrontierSocket(crossing, target),
    ],
  };
}

/** Whether a socket takes a press. The one place `checking…` is unpressable. */
export function pressable(socket: Socket): boolean {
  return socket.fill === "filled";
}

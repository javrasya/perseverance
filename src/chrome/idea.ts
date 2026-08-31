/**
 * The idea box, derived and nothing else.
 *
 * The same split `sockets.ts` and `Sockets.tsx` make: what the box says and
 * whether it can be pressed is arithmetic over what it was handed, and
 * `IdeaBox.tsx` picks nothing.
 *
 * **This is not a fifth socket.** The rail is four boxes and stays four — a
 * socket that appears when its ticket lands is a rail that changes shape under
 * a hand, which is what `sockets.ts` exists to prevent. The box lives with the
 * map list's *no map in this repository* absence instead, beside the copy that
 * already pre-absolves a charting run leaving no map behind, so the operator
 * reads that a mapless outcome is a success *before* pressing rather than after
 * a run comes back empty.
 *
 * Everything it recesses for is `sockets.ts`'s vocabulary, imported rather than
 * rephrased: one folder is open or none is, one harvest is out or it is not,
 * one adapter list is offerable or it is empty.
 */

import type { FolderReadout } from "../environment/folder";
import {
  NO_ADAPTER,
  NO_FOLDER_OPEN,
  STILL_READING,
  offerable,
  stillReading,
  type Fill,
} from "./sockets";

/** The verb on the button. */
export const CHART_LABEL = "Start Charting";

/** What the box is for, on the control itself. */
export const IDEA_LABEL = "What should be charted?";

/**
 * The one condition of its own. An empty idea is not a press: there is nothing
 * for the charting session to be about, and the prompt Rust renders is built
 * out of these words.
 */
export const NO_IDEA = "type what you want charted";

/**
 * The other condition of its own, and the one that makes a press a single
 * press. The box outlives the spawn — `MapList.tsx` only takes it away once a
 * poll returns the map the run wrote, minutes later — so a `spawned` press that
 * still read as pressable would be a second charting session in the same
 * folder: a second run creating the `wayfinder:*` labels and opening a second
 * map issue. The rail has no equivalent hole because a claimed frontier
 * recesses its socket; nothing recesses this one but this.
 */
export const ALREADY_CHARTING = "a charting session is already running in this folder";

/**
 * Where a charting press is.
 *
 * No frontier on the refusal, unlike `sockets.ts`'s `Press`: a charting run is
 * started in a folder with no map, so there is no *what next* for the harness
 * to have learned and `start_charting` answers none for it. Carrying a field
 * that is always null would be a second reading of a fact this press cannot
 * have.
 */
export type ChartPress =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "spawned"; run: number }
  | { kind: "refused"; detail: string };

export interface Charting {
  /** The folder the run would be started in, or `null` when none is open. */
  folder: string | null;
  /**
   * What this folder resolved, or `null` while nothing has come back for it.
   * The whole readout and not its adapters, for `Crossing.environment`'s
   * reason: *nobody has looked yet* is not *found nothing*.
   */
  environment: FolderReadout | null;
  /** Exactly what is in the box, untrimmed — trimming is this file's to do. */
  idea: string;
  press: ChartPress;
}

export interface Box {
  fill: Fill;
  /** What would fill it, as visible text. Non-null exactly when recessed. */
  condition: string | null;
  /** What the harness said when it refused, verbatim. */
  note: string | null;
  /** The adapter ids offerable at this press, in the order the folder read them. */
  adapters: readonly string[];
}

/** The idea as it would go out. Whitespace is not an idea. */
export function ideaAtPress(idea: string): string {
  return idea.trim();
}

/** The whole box, from the charting. One control, in one place, always. */
export function boxAt(charting: Charting): Box {
  const adapters = offerable(charting.environment?.adapters ?? []);
  const note = charting.press.kind === "refused" ? charting.press.detail : null;

  if (charting.press.kind === "checking") {
    return { fill: "checking", condition: null, note, adapters };
  }

  // A press that landed is not a press again. Read before the chain below,
  // because every one of its conditions is still perfectly satisfiable while
  // the session it already started is running.
  if (charting.press.kind === "spawned") {
    return { fill: "recessed", condition: ALREADY_CHARTING, note, adapters };
  }

  const condition =
    charting.folder === null
      ? NO_FOLDER_OPEN
      : stillReading(charting.environment)
        ? STILL_READING
        : adapters.length === 0
          ? NO_ADAPTER
          : ideaAtPress(charting.idea) === ""
            ? NO_IDEA
            : null;

  return {
    fill: condition === null ? "filled" : "recessed",
    condition,
    note,
    adapters,
  };
}

/** Whether the box takes a press. `checking…` is unpressable, as on the rail. */
export function pressable(box: Box): boolean {
  return box.fill === "filled";
}

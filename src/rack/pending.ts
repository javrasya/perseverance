import { nowSeconds } from "../chrome/age";
import { hasRustBehindIt } from "../snapshot/snapshot";
import type { RunKind } from "../terminal/runs";

/**
 * The research queue, as it crosses — what has been accepted and has not
 * started.
 *
 * **The rack's channel and not the terminal's**, which is why it lives here
 * rather than beside `RunReadout` in `src/terminal/runs.ts`: a waiting entry
 * reaches no PTY, has no bytes to be handed and nothing to confirm, so a module
 * whose whole subject is *how a run's bytes get to a terminal* has nothing to
 * say about one. It is not on the `snapshot` event and not in `Model` either,
 * for the reason `crates/app` keeps it out of both: a queue entry writes no
 * model, takes no claim and touches no ledger, and a field on the snapshot is
 * the first thing a view would draw it from.
 *
 * A hand-written mirror of `PendingRun` in `crates/app/src/lib.rs`, and
 * hand-written is a weakness rather than a style: `PendingRun` lives in the app
 * crate and not in the model crate, so no generator emits a TypeScript
 * declaration for it and nothing fails a build when a field is added on that
 * side. What stands in for the generator is the shape being pinned from both
 * ends — `a_press_at_the_ceiling_is_queued_rather_than_refused` in the Rust
 * tests asserts the wire keys and their count, and `tests/rack.test.tsx`
 * asserts this mirror against the same names.
 *
 * **The ceiling itself has no control on this side, and no command either.**
 * It is one row of the app key/value table, editable by hand and by nothing
 * else, which is a deferral this file is not the place to argue away (ADR
 * `0028-a-queue-entry-is-not-a-run`): a settings control is new chrome with its own address in an app that
 * has no settings screen, and the two commands that used to stand where the
 * control would go were called from nowhere — a surface with no caller reads as
 * the answer and stops the next reader looking for one. The number itself
 * appears nowhere in this file: a ceiling spelled a second time in TypeScript
 * is a ceiling that can disagree with the Rust default that owns it, and a
 * queue drawn against the wrong number is a queue the operator cannot explain.
 */

/**
 * One accepted press that has not started, as Rust writes it.
 *
 * **No `run`, and the absence is the whole of what a pending row is.** There is
 * no run number, no worktree, no claim, no PTY and no byte count, because
 * nothing has been spawned: `there_is_room` refused the spawn and the press was
 * put in line instead. Anything on this side that reaches for a run from one of
 * these is reaching for something that does not exist.
 */
export interface PendingRun {
  /**
   * The entry's own identity, and never a run's.
   *
   * Two separate number spaces, which is why anything keyed off this is
   * prefixed: the queue moves under the rack — an entry ahead of this one
   * starting shortens it — and a row needs an identity that survives that,
   * while a `key` that collided with a run number would swap two rows' state
   * with nothing on screen to show it.
   */
  id: number;
  ticket: number;
  /**
   * Always `"research"` today, and read rather than assumed for `RunReadout`'s
   * reason: a row that inferred *research* from *it was queued* would be
   * drawing a rule it read in a comment instead of a value it was sent.
   */
  kind: RunKind;
  folder: string;
  /** Seconds since the epoch — the clock `RunReadout.opened` and `spoke` use. */
  queued: number;
  /**
   * The sentence a deferred spawn refused with, or `null` while this entry is
   * still waiting.
   *
   * **It crosses exactly once.** `Pending::announced` drains these as it reads
   * them, because a deferred spawn has no socket to answer to — the press it
   * came from was accepted and answered minutes ago — so the emission is the
   * one and only delivery. The command carries none of them at all. A row
   * carrying this is *not* waiting: it has left the queue, and whoever holds it
   * on this side has to hold it themselves or lose it.
   */
  refused: string | null;
}

/**
 * What is still waiting, out of an emission.
 *
 * The event carries the queue plus whatever refused since the last tick, and
 * the two are drawn as different things: rows for the first, a sentence for the
 * second. Splitting here rather than in the component keeps *a refused entry is
 * not a waiting one* a property something can be tested against.
 */
export function waitingOf(announced: readonly PendingRun[]): PendingRun[] {
  return announced.filter((entry) => entry.refused === null);
}

/** What refused on this tick, and will never be sent again. */
export function refusalsOf(announced: readonly PendingRun[]): PendingRun[] {
  return announced.filter((entry) => entry.refused !== null);
}

/**
 * What is waiting, once.
 *
 * Refusals are deliberately absent: they are events, the emission is where
 * events go, and a command that drained them would be a sentence that vanished
 * because the rack happened to ask. Without Rust behind it, a checked-in set
 * named by [`PENDING_PARAMETER`].
 */
export async function loadPendingRuns(): Promise<PendingRun[]> {
  /* The fixture through the same filter the command's own contract puts on it:
     a browser standing in for this channel has to stand in for *what it does
     not carry* as well, or a refusal would arrive by a route Rust has none. */
  if (!hasRustBehindIt()) return waitingOf(pendingFixtureNamed(requestedPendingFixture()));
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<PendingRun[]>("pending_runs");
}

/** The Rust side's string, not one this file invented. */
const PENDING_EVENT = "pending-runs";

/**
 * The queue, on the same tick the readouts arrive on.
 *
 * Emitted from the readouts thread immediately after the drain that starts
 * whatever a landing made room for, and before that tick's `run-readouts`. The
 * caller subscribes and then asks, which is the ordering every channel here
 * uses: the emission is unprompted and the command covers the gap before there
 * is a listener.
 */
export async function watchPendingRuns(
  onPending: (announced: PendingRun[]) => void,
): Promise<() => void> {
  if (!hasRustBehindIt()) {
    /*
     * The one watcher on this side that announces from a fixture rather than
     * going quiet without Rust, and the refusal is the whole reason.
     *
     * A refusal exists on an emission and nowhere else — the command drops it,
     * `announced` drains it as it reads, and the press it came from was
     * answered long ago — so a `dev:web` window that only ever loaded could not
     * be put into the one state where that sentence is on screen, which is
     * exactly the state nobody can conjure in a browser. One announcement and
     * no timer: this stands in for a tick, not for a running harness.
     */
    onPending(pendingFixtureNamed(requestedPendingFixture()));
    return () => {};
  }
  const { listen } = await import("@tauri-apps/api/event");
  return await listen<PendingRun[]>(PENDING_EVENT, ({ payload }) => onPending(payload));
}

/* ------------------------------------------------------------ dev:web --- */

/**
 * What `dev:web` boots a queue from: hand-written entries, checked in, with no
 * Rust process behind them.
 *
 * The states worth looking at are the ones a browser cannot be talked into for
 * `src/terminal/fixtures.ts`'s reason, and this one more so: a queue entry only
 * exists once four research runs are already going, which is four agent CLIs
 * and four worktrees away from anything a `dev:web` tab can do. The refusal is
 * further still — it wants a deferred spawn that failed after the press that
 * ordered it was answered.
 *
 * Durations rather than stamps, for the same reason the run fixtures use them:
 * *queued four minutes ago* keeps its meaning, and an absolute second checked
 * in on the day this file was written reads as a year.
 */
interface FixturePending extends Omit<PendingRun, "queued"> {
  queuedSecondsAgo: number;
}

function stamped({ queuedSecondsAgo, ...entry }: FixturePending): PendingRun {
  return { ...entry, queued: nowSeconds() - queuedSecondsAgo };
}

/**
 * The sets, each named for the reading it puts on screen.
 *
 * `none` is the default and is empty, so a tab opened without asking for a
 * queue is the tab this app has always opened. `waiting` is the fifth and sixth
 * presses of six, which is the acceptance criterion's own arithmetic. `refused`
 * is a queue with one entry still in it and one sentence standing about an
 * entry that has left — the only state in which the refusal wording is on
 * screen at all.
 *
 * Typed rather than cast, so a key renamed in the interface fails the build
 * here instead of leaving a fixture that quietly stopped matching the wire.
 */
export const PENDING_FIXTURES = {
  none: [],
  waiting: [
    {
      id: 1,
      ticket: 61,
      kind: "research",
      folder: "/work/perseverance",
      queuedSecondsAgo: 240,
      refused: null,
    },
    {
      id: 2,
      ticket: 62,
      kind: "research",
      folder: "/work/perseverance",
      queuedSecondsAgo: 96,
      refused: null,
    },
  ],
  refused: [
    {
      id: 3,
      ticket: 63,
      kind: "research",
      folder: "/work/perseverance",
      queuedSecondsAgo: 130,
      refused: null,
    },
    {
      id: 4,
      ticket: 64,
      kind: "research",
      folder: "/work/atlas",
      queuedSecondsAgo: 300,
      refused: "no token is stored for this host",
    },
  ],
} satisfies Record<string, FixturePending[]>;

export type PendingFixtureName = keyof typeof PENDING_FIXTURES;

export const PENDING_FIXTURE_NAMES = Object.keys(PENDING_FIXTURES) as PendingFixtureName[];

export const DEFAULT_PENDING_FIXTURE: PendingFixtureName = "none";

/** A copy each time, so a caller editing one cannot edit the fixture itself. */
export function pendingFixtureNamed(name: PendingFixtureName): PendingRun[] {
  return (structuredClone(PENDING_FIXTURES[name]) as FixturePending[]).map(stamped);
}

/**
 * Which queue a `dev:web` URL asked for.
 *
 * `?pending=` beside `?runs=`, and its own parameter rather than a value of
 * that one: what is waiting and what is running are two channels, and a browser
 * has to be able to put four runs on screen with two entries behind them —
 * which is the reading this whole ticket is about — as well as either alone.
 */
export const PENDING_PARAMETER = "pending";

export function requestedPendingFixture(search?: string): PendingFixtureName {
  const from = search ?? (typeof window === "undefined" ? "" : window.location.search);
  const asked = new URLSearchParams(from).get(PENDING_PARAMETER);
  return isPendingFixtureName(asked) ? asked : DEFAULT_PENDING_FIXTURE;
}

export function isPendingFixtureName(name: string | null): name is PendingFixtureName {
  return name !== null && name in PENDING_FIXTURES;
}

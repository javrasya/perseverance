/**
 * The WebView's view of the map list.
 *
 * These types mirror the app crate's `MapsView` exactly, for the same reason
 * `launcher.ts` mirrors `Folder` and `snapshot.ts` mirrors `Snapshot`: one seam
 * rather than two. A rename on the Rust side is a silent breakage here, so both
 * sides pin the shape with a test.
 *
 * One command reads, and it cannot reach GitHub. `maps` reads the store and
 * holds no token, which is why first paint is cache-sourced and stamped as such
 * rather than merely intended to be.
 *
 * **There is no live-read command.** The only thing that reaches GitHub is the
 * poller, on its own thread, at the cadence #38 gave it; this side declares what
 * it is looking at with `watching` and is told what arrived on the `maps` event.
 * A refresh button that read GitHub itself would be a second thing entitled to
 * write the cache, and *the cadence decided this* would stop being true of any
 * particular read.
 *
 * `maps.fixture.json` is what stands behind this in a browser with no Rust: it
 * carries an open map, a completed one, and a stamp that is already old,
 * because a cache with age on it is a state a fresh browser cannot conjure. The
 * conditions a failed read can be in are conjured no more easily, and
 * [`loadFixture`] borrows those from the generated snapshot fixtures rather
 * than keeping a second, hand-written account of them.
 */

import { stampReason } from "../chrome/stamp";
import { FIXTURES, requestedFixture } from "../snapshot/fixtures";
import { hasRustBehindIt, type Degraded, type Provenance } from "../snapshot/snapshot";
import fixture from "./maps.fixture.json";

/** The label a map is discovered by. Mirrors `perseverance_model::MAP_LABEL`. */
export const MAP_LABEL = "wayfinder:map";

/** One map, as the label found it. Nothing here is derived; #33 owns that. */
export interface MapEntry {
  number: number;
  title: string;
  /** Closed maps group under *Completed*. Grouping, never filtering. */
  closed: boolean;
  url: string;
  /** RFC 3339, as GitHub sent it. */
  updatedAt: string;
}

/**
 * `rateLimit`, as GitHub reported it. Nothing on this side reads it.
 *
 * #39 spent it in Rust, where the poller paces itself from these numbers; what
 * crosses for the WebView to act on is `yieldingToRateLimit`, the conclusion.
 * This stays as the diagnostic it always was, beside the flag derived from it.
 */
export interface RateLimit {
  cost: number;
  nodeCount: number;
  limit: number;
  remaining: number;
  resetAt: string;
}

export interface MapsView {
  folderId: number;
  maps: MapEntry[];
  provenance: Provenance;
  rateLimit: RateLimit | null;
  /** A page GitHub's own limits say cannot exist. Said, never paged through. */
  truncated: boolean;
  /**
   * Whether the rate-limit budget is what is holding the poller's interval
   * down. Decided in Rust — the inputs to that decision are not on this side at
   * all — and true only while the budget is the *winning* term, so the clause
   * it feeds appears while the yielding is what you are waiting for and not
   * merely while a budget exists.
   *
   * The `maps` command always answers `false`, because there is no poller
   * behind it. It arrives true, if it is going to, on the event.
   */
  yieldingToRateLimit: boolean;
}

/* ------------------------------------------------------- the condition --- */

/**
 * The two conditions that stop a read rather than delaying one, as a type.
 *
 * A subset of [`Degraded`] and not a parallel spelling of it: narrowing here is
 * what lets the copy below be exhaustive over exactly the cases that can reach
 * it, so a fifth condition added in Rust is a compile error rather than a
 * section rendering `undefined`.
 */
export type StoppedReading = Extract<Degraded, { reason: "authFailed" | "mapGone" }>;

/**
 * Whether the poller has *stopped* reading, as opposed to merely not having
 * landed a read yet.
 *
 * Exactly the two conditions retrying cannot fix, which is the same partition
 * `backoff_floor` makes on the Rust side — and the reason it is spelled here
 * rather than inferred from a boolean is that the two halves have to agree: the
 * floor answering `Never` and this returning non-`null` are one fact, and a
 * flag beside the condition would be a second one to keep in step.
 *
 * A rate limit is not on this list. It is a wait with an end on it, and a
 * control disabled for it would come back by itself while an operator sat
 * looking at a reason to give up.
 */
export function stoppedReading(view: MapsView): StoppedReading | null {
  const reason = stampReason(view.provenance);
  if (reason === null) return null;
  return reason.reason === "authFailed" || reason.reason === "mapGone" ? reason : null;
}

/* ------------------------------------------------------------- loading --- */

/**
 * Before a folder has been picked, and before anything has been read for one.
 *
 * An absence rather than an empty list: *nobody has looked* and *there are no
 * maps here* are different facts, and the source is what keeps them apart.
 */
export function nothingReadYet(folderId: number): MapsView {
  return {
    folderId,
    maps: [],
    provenance: { source: "none", outcome: { kind: "notAttempted" }, fetchedAt: null },
    rateLimit: null,
    truncated: false,
    yieldingToRateLimit: false,
  };
}

const fixtureView = fixture as unknown as MapsView;

/**
 * A copy each time, so a caller editing one cannot edit the preview itself —
 * and, when `dev:web` was asked for a failed read, the same condition on this
 * list as on the model beside it.
 *
 * **The condition is taken from the snapshot fixture rather than written down
 * here.** Those files are the model crate's own output, compared byte for byte
 * on every `cargo test`, so a reason and a sentence lifted from one cannot come
 * to disagree with what Rust would actually have sent. A second hand-written
 * failure in `maps.fixture.json` would be exactly that drift, with nothing
 * checking it.
 *
 * One parameter drives both, for the same reason: `?map=auth-failed` is a
 * window in one state, and two parameters would let a browser paint a stopped
 * stamp over a healthy list — a screen the app itself cannot produce.
 */
export function loadFixture(folderId: number, search?: string): MapsView {
  const copy: MapsView = {
    ...fixtureView,
    folderId,
    maps: fixtureView.maps.map((map) => ({ ...map })),
  };

  const asked = FIXTURES[requestedFixture(search)].provenance.outcome;
  if (asked.kind !== "failed") return copy;

  return {
    ...copy,
    provenance: { ...copy.provenance, outcome: asked },
    // A failed read reports no budget, exactly as `MapsView::stale` clears it
    // on the Rust side.
    rateLimit: null,
  };
}

/**
 * The cached read. Cannot reach GitHub — there is no token on this path — which
 * is what makes *first paint is cache-sourced* structural rather than an order
 * someone has to keep.
 */
export async function loadMaps(folderId: number): Promise<MapsView> {
  if (!hasRustBehindIt()) {
    return loadFixture(folderId);
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<MapsView>("maps", { folderId });
}

/** Both names are the Rust side's; neither is a string this file invented. */
const WATCH_COMMAND = "watching";
const MAPS_EVENT = "maps";

/**
 * Says what this window is looking at, and answers nothing.
 *
 * It is a poke and a declaration at once. The poller reads the folder named
 * here at the cadence the ladder decides, and `null` is the launcher with
 * nothing picked — the state where the right number of reads is none.
 *
 * There is no return value on purpose: what comes back from a read arrives on
 * the event below, whenever the cadence produced it, and a promise resolving
 * with a list would be a second delivery path that could disagree with the
 * first. A browser has no poller to tell, so this is inert there.
 */
export async function watching(folderId: number | null, map: number | null): Promise<void> {
  if (!hasRustBehindIt()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke(WATCH_COMMAND, { folderId, map });
}

/**
 * Every read the poller lands, live or failed.
 *
 * A failed poll arrives too, as the cached list with a stale stamp — never as
 * silence and never as an empty list. What you were reading is still true of
 * the last time anybody looked, and emptying the screen would assert that the
 * maps are gone on the strength of not having been able to look.
 *
 * Returns the way to stop listening, for the same reason `watchEnvironment`
 * does: a subscription that outlives its component is a leak. A browser
 * subscribes to nothing, because nothing behind it is polling.
 */
export async function watchMaps(onRead: (view: MapsView) => void): Promise<() => void> {
  if (!hasRustBehindIt()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return await listen<MapsView>(MAPS_EVENT, ({ payload }) => onRead(payload));
}

/* --------------------------------------------------------------- lists --- */

/**
 * The maps still being worked, in the order the answer arrived in.
 *
 * Never re-sorted. GitHub answers in the order the operator arranged, and a
 * ranking invented here is a ranking the map cannot justify.
 */
export function openMaps(view: MapsView): MapEntry[] {
  return view.maps.filter((map) => !map.closed);
}

/**
 * The finished ones. Grouped under *Completed* and collapsed — never hidden,
 * because a finished map is reopened to read the decisions it made.
 */
export function completedMaps(view: MapsView): MapEntry[] {
  return view.maps.filter((map) => map.closed);
}

/**
 * Whether the *no map here* copy is the right thing to draw.
 *
 * Only after a read that actually happened. Before one, there is nothing to say
 * about this repository yet, and saying it has no maps would be asserting
 * something nobody has established.
 */
export function hasBeenRead(view: MapsView): boolean {
  return view.provenance.source !== "none";
}

/* --------------------------------------------------------------- stamp --- */

/*
 * The stamp wording moved to `chrome/stamp.ts` when the derived model grew one
 * too. It was never about maps — it only ever read `view.provenance` — and two
 * subsystems stamping the same `Provenance` in two vocabularies is exactly the
 * drift the phrasing is centralised to prevent. Re-exported here because a
 * caller holding a `MapsView` should not have to know where the words live.
 *
 * Only what a caller of that kind actually reaches for. `stampReason` was in
 * this block and imported from it by nobody — the module above uses it, and
 * `chrome/` uses its own — while `CONDITIONS` and `REMEDY`, which `MapList`
 * and its tests genuinely do hold a `MapsView` to reach, were not here at all.
 * A re-export nothing imports is a claim about callers that no caller makes.
 */
export {
  CONDITIONS,
  REMEDY,
  describeStamp,
  stampAge,
  stampDetail,
  stampSource,
} from "../chrome/stamp";

/* ---------------------------------------------------------------- copy --- */

export const MAPS_HEADING = "Maps";

/**
 * Found rather than registered, and the preamble says so — because the first
 * question a list nobody added anything to raises is *where did these come
 * from*.
 */
export const MAPS_PREAMBLE = `Every issue in this repository labelled ${MAP_LABEL} is a map. Nothing is registered here: chart one in your own terminal and it appears the next time this reads.`;

export const COMPLETED_GROUP = "Completed";

/**
 * It says *stay* rather than *open one* on purpose. Reaching a map to read the
 * decisions it made is what the group exists for, and it is also what the map
 * view has yet to arrive with — so this describes what the group is for without
 * promising an affordance that is not on screen.
 */
export const COMPLETED_HINT =
  "Finished maps stay here rather than disappearing, so the decisions they made stay findable.";

export const NO_MAP_HEADLINE = "No map in this repository";

/**
 * Pre-absolving, deliberately.
 *
 * A first charting session that judged the work small enough to just do
 * produces no map, and that is the session working correctly. This copy has to
 * read as a normal state of a folder — never as something that failed, and
 * never as a zero.
 */
export const NO_MAP_COPY =
  "Nothing here carries the map label, and that is a normal thing for a folder to be. A first charting session that judges the work small enough to just do finishes without leaving a map behind. Chart one when the work is worth a graph.";

export const NOT_READ_HEADLINE = "Not read yet";

export const NOT_READ_COPY =
  "Nothing has been read for this folder on this machine. What is here will be found the first time it can be.";

/**
 * The tripwire's sentence. It names what was cut off rather than how much,
 * because the number is beside the point: GitHub's own limits say this cannot
 * happen, so if it has, the thing worth reporting is that it has.
 */
export const TRUNCATED_NOTE =
  "GitHub answered with more than one page, which its own limits say cannot happen. Some of what is here is not on screen.";

/**
 * What a section says when the poller has stopped reading it.
 *
 * One sentence per condition, and each says the same two things: what is on
 * screen is a copy, and what would replace it is not coming without somebody
 * doing something. Neither of them says *error* — the read stopped for a reason
 * that is now true of the world, and an operator who reads *failed* goes
 * looking for something to have gone wrong on their machine.
 *
 * The command is not in here. It comes from `chrome/stamp.ts`'s `REMEDY`, which
 * is one table for the whole app, so the fixing command an operator reads under
 * a map list and the one on the stamp cannot be two different commands.
 */
export const STOPPED_COPY: Record<StoppedReading["reason"], string> = {
  authFailed:
    "This list is the last copy read. Nothing newer will arrive until GitHub accepts a token again, so nothing here can be started from.",
  mapGone:
    "This list is the last copy read. GitHub says this repository is not there, which is not something waiting fixes — open the folder you meant, or check what this one points at.",
};

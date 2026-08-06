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
 * because a cache with age on it is a state a fresh browser cannot conjure.
 */

import { hasRustBehindIt, type Provenance } from "../snapshot/snapshot";
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

/** `rateLimit`, carried and acted on by nobody yet — #39 is that ticket. */
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
  };
}

const fixtureView = fixture as unknown as MapsView;

/** A copy each time, so a caller editing one cannot edit the preview itself. */
export function loadFixture(folderId: number): MapsView {
  return {
    ...fixtureView,
    folderId,
    maps: fixtureView.maps.map((map) => ({ ...map })),
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
 */
export { describeStamp, stampAge, stampDetail, stampSource } from "../chrome/stamp";

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

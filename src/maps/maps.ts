/**
 * The WebView's view of the map list.
 *
 * These types mirror the app crate's `MapsView` exactly, for the same reason
 * `launcher.ts` mirrors `Folder` and `snapshot.ts` mirrors `Snapshot`: one seam
 * rather than two. A rename on the Rust side is a silent breakage here, so both
 * sides pin the shape with a test.
 *
 * Two commands, and the difference between them is the whole cache policy:
 * `maps` reads the store and cannot reach GitHub, `refresh_maps` reads GitHub
 * and is the only thing that may write. First paint calls the first one, which
 * is why first paint is cache-sourced and stamped as such rather than merely
 * intended to be.
 *
 * `maps.fixture.json` is what stands behind this in a browser with no Rust: it
 * carries an open map, a completed one, and a stamp that is already old,
 * because a cache with age on it is a state a fresh browser cannot conjure.
 */

import { relativeAge, secondsFromStamp } from "../chrome/age";
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

/**
 * One live read, and the cache write it entitles.
 *
 * A read that failed comes back as the cached list with a stale stamp rather
 * than as a rejection: what you were reading is still true of the last time
 * anybody looked, and emptying the screen would assert that the maps are gone.
 *
 * A browser has nothing behind it to read, so `dev:web` answers with the same
 * fixture and the same age it already had. That is not a refresh pretending to
 * be one — the stamp does not move.
 */
export async function refreshMaps(folderId: number): Promise<MapsView> {
  if (!hasRustBehindIt()) {
    return loadFixture(folderId);
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<MapsView>("refresh_maps", { folderId });
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

/**
 * How old what you are reading is, permanently on screen.
 *
 * Three states and no fourth: never read, read from GitHub, read from a copy.
 * A failed read does not get a state of its own here — it ages the stamp of
 * whatever is being shown, which is the copy.
 */
export function stampAge(view: MapsView, now?: number): string {
  const at = secondsFromStamp(view.provenance.fetchedAt);
  if (at === null) return "not read yet";
  return relativeAge(at, now);
}

export function stampSource(view: MapsView): string {
  switch (view.provenance.source) {
    case "github":
      return "read from GitHub";
    case "cache":
      return "from the last read";
    case "fixture":
      return "from a checked-in fixture";
    case "none":
      return "nothing read";
  }
}

/**
 * The whole stamp, as one sentence.
 *
 * A failure keeps saying how old the copy is rather than replacing it, because
 * a stamp that swapped the age for an error would stop reporting staleness at
 * exactly the moment staleness started mattering.
 *
 * What the failure clause may *not* do is assert which step failed. A read that
 * landed and could not be stored, a read that was never attempted because the
 * folder names no GitHub repository, and a read that could not reach anything
 * all arrive here as the same shape — telling them apart is #40's ticket, and a
 * clause that guessed would be wrong in two cases out of three. So the two
 * clauses say only what is true of the thing on screen: a live read that will
 * not survive the session, or a copy that nothing newer has replaced. The
 * reason itself rides beside this, in the words of whoever established it.
 */
export function describeStamp(view: MapsView, now?: number): string {
  const failed = view.provenance.outcome.kind === "failed";

  if (view.provenance.source === "none") {
    return failed ? "nothing read yet — nothing newer has arrived" : "nothing read yet";
  }

  const said = `${stampSource(view)} ${stampAge(view, now)}`;
  if (!failed) return said;
  return view.provenance.source === "github"
    ? `${said} — not stored for next time`
    : `${said} — nothing newer has arrived`;
}

/** The reason a read did not land, in the words of whoever established it. */
export function stampDetail(view: MapsView): string | null {
  return view.provenance.outcome.kind === "failed" ? view.provenance.outcome.detail : null;
}

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

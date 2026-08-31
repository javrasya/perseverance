/**
 * What a view is: the props it is handed, and which one the app opens on.
 *
 * The prop type comes first below, and it is the narrower of the two claims —
 * see [`ViewProps`]. The rest of the file is the remembered default.
 *
 * Global means one setting for the whole app — not per folder, not per map.
 * The choice tracks the operator's activity rather than the map's identity: the
 * Route answers *what do I work on next*, it is opened perhaps twenty times a
 * day, and coming back to a different view because you happened to open a
 * different map would be the app forgetting what you were doing. The store that
 * will eventually hold it is the `app` key/value table in `crates/store`; until
 * a command exposes it, `localStorage` is the same shape (app-scoped, survives
 * restart) behind the same two functions, so the swap is one file.
 *
 * There is deliberately no switcher here, and no picker chrome anywhere. The
 * registry has exactly one entry today, the shell's view dial is a later
 * ticket's work, and a dial built now would be making that ticket's decisions
 * early with one detent to show for it. The omission is the decision.
 */

import type { Model } from "../snapshot/snapshot";

export type ViewName = "route";

/**
 * What every view is given, and the whole of it.
 *
 * It names `model` and not `snapshot`, so the change ledger — which rides on
 * the `Snapshot` beside `model` rather than inside it — is not *forbidden* to a
 * view: it is unwritable, for want of anything on this side to write it from.
 * *No view renders the record* is therefore a property of this type rather than
 * a rule somebody has to keep, and the file that holds the exclusion is the
 * only file under `src/views/` allowed to name what it excludes.
 *
 * It is the same mechanism that keeps a second frontier resolver off this side:
 * the four node states and the designated frontier are decided in Rust, and the
 * two fields they are decided from do not cross the seam at all, so a resolver
 * here has no input rather than a prohibition — `tests/snapshot.test.ts` names
 * those two and refuses them the run of `src/`, which is why they are not named
 * here. One type for every view is also what makes
 * that checkable at all — a view free to declare its own props could widen them
 * to the whole snapshot without anything failing.
 */
export interface ViewProps {
  model: Model;
  selected: number | null;
  onSelect: (number: number | null) => void;
}

/** Every view there is, which is currently one. */
export const VIEWS: readonly ViewName[] = ["route"];

/**
 * What each view is called on screen, and the only place it is spelled.
 *
 * A `Record` over `ViewName`, so a view added to `VIEWS` without a name is a
 * type error rather than a switcher cap reading `route`. The switcher, the
 * stand-down and anything else that has to say which view it means all read
 * from here; the width each one needs is the same shape one file over, in
 * `src/panes/dial.ts`.
 */
export const LABELS: Record<ViewName, string> = {
  route: "The Route",
};

/**
 * The Route, unanimously: it serves any n, it is indifferent to a map whose
 * takeable half is enormous, and it is the one view that answers the question
 * the operator actually opens the app with.
 */
export const DEFAULT_VIEW: ViewName = "route";

const STORAGE_KEY = "perseverance.view";

/*
 * The array is what says which strings are views, so a stored value is narrowed
 * against it rather than cast into it. A view removed from `VIEWS` then stops
 * being readable from the store on the next launch, which is the behaviour that
 * matters — a cast would go on opening the app onto a view that no longer
 * exists.
 */
function isViewName(value: string | null): value is ViewName {
  return value !== null && (VIEWS as readonly string[]).includes(value);
}

export function readDefaultView(): ViewName {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (isViewName(stored)) return stored;
  } catch {
    // A WebView with storage denied still gets a working app; it just opens on
    // the default every launch.
  }
  return DEFAULT_VIEW;
}

export function writeDefaultView(view: ViewName): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, view);
  } catch {
    // Same as above: the choice lasts the session rather than forever.
  }
}

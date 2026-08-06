/**
 * Which view the app opens on, remembered globally.
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

export type ViewName = "route";

/** Every view there is, which is currently one. */
export const VIEWS: readonly ViewName[] = ["route"];

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

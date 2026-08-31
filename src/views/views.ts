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
 * Nothing here draws, and there is no switcher *in this file* either: that is
 * the arrangement rather than an omission — `ViewSwitcher.tsx` beside this file
 * is chrome on the shell's spine and reads its caps from here, so the registry
 * stays the one place a view exists and the labels, the floors and the
 * stand-down all point back at it. Three entries now — the Route, the Bench and
 * Deep Field — and the ones past the first are what make that worth anything: a
 * table with one row cannot be told apart from a constant. This file stays the
 * names, the labels, the floors' key and the remembered default; a view is
 * added by naming it here and then answering for it everywhere a `Record` over
 * [`ViewName`] refuses to compile without it.
 */

import type { Model } from "../snapshot/snapshot";

export type ViewName = "route" | "bench" | "deep-field";

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

/**
 * Every view there is, in the order anything offering them offers them.
 *
 * Order is not default: [`DEFAULT_VIEW`] says which one opens, this says which
 * one is reached for first when several fit — and it is also the order
 * [`standDown`] walks when it has to name a view that would fit instead, so the
 * Route leading is the cheapest alternative being offered first.
 *
 * [`standDown`]: ../panes/dial.ts
 */
export const VIEWS: readonly ViewName[] = ["route", "bench", "deep-field"];

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
  bench: "The Bench",
  /* The component's own `aria-label`, spelled the same, so the cap on the
     switcher and the region a reader lands in are one name. */
  "deep-field": "Deep Field",
};

/**
 * The Route, unanimously, and a second view does not reopen it: the Route
 * serves any n, it is indifferent to a map whose takeable half is enormous, it
 * asks the least width of anything registered, and it answers the question the
 * operator actually opens the app with. The Bench answers *which one unblocks
 * the most*, which is a question you go looking for — that is the switcher's
 * job and never the default's.
 */
export const DEFAULT_VIEW: ViewName = "route";

/**
 * Where the remembered view lives, spelled once.
 *
 * Exported because the conformance driver has to seed it before the first
 * render to open a view that is not the default, and a second spelling of this
 * string over there would be a suite that goes on passing after the key
 * changes, asserting against whatever the app opened on instead.
 */
export const VIEW_STORAGE_KEY = "perseverance.view";

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
    const stored = window.localStorage.getItem(VIEW_STORAGE_KEY);
    if (isViewName(stored)) return stored;
  } catch {
    // A WebView with storage denied still gets a working app; it just opens on
    // the default every launch.
  }
  return DEFAULT_VIEW;
}

export function writeDefaultView(view: ViewName): void {
  try {
    window.localStorage.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    // Same as above: the choice lasts the session rather than forever.
  }
}

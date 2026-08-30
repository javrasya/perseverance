import { chooseView, useUi } from "../stores/ui";
import type { ViewName } from "./views";

/**
 * The remembered view.
 *
 * It lives in the UI store now rather than in this hook's own `useState`, and
 * that is #47's doing: the two stores exist so that what the operator is doing
 * and what the poller last derived have different lifetimes. A view held in
 * component state would be a view that a re-render is entitled to have an
 * opinion about; held there, a poll landing cannot reach it.
 *
 * The persistence is unchanged — `readDefaultView` and `writeDefaultView`, the
 * same two functions, still the only ones — so the eventual swap to the `app`
 * key/value table is still one file. Nothing calls the setter yet; the view dial
 * is #52's.
 */
export function useDefaultView(): [ViewName, (view: ViewName) => void] {
  return [useUi().view, chooseView];
}

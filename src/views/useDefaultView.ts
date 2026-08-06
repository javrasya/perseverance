import { useCallback, useState } from "react";
import { readDefaultView, writeDefaultView, type ViewName } from "./views";

/**
 * The remembered view, read once at mount and written the moment it changes.
 *
 * `useTheme`'s shape exactly, minus the effect: a theme has to be applied to
 * the document on every change, and a view is simply what gets rendered, so
 * there is nothing to apply. Nothing calls the setter yet — the view dial is a
 * later ticket — and it exists now so that the ticket which adds one has a
 * place to call rather than a persistence decision to re-make.
 */
export function useDefaultView(): [ViewName, (view: ViewName) => void] {
  const [view, setView] = useState<ViewName>(readDefaultView);

  const choose = useCallback((next: ViewName) => {
    writeDefaultView(next);
    setView(next);
  }, []);

  return [view, choose];
}

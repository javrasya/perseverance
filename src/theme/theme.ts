/**
 * Theme follows the OS, with an explicit override persisted globally.
 *
 * Global means one setting for the whole app — not per folder, not per map.
 * The store that will eventually hold it is the `app` key/value table; until
 * the store lands, `localStorage` is the same shape (app-scoped, survives
 * restart) behind the same two functions, so the swap is one file.
 */

export type ThemePreference = "system" | "light" | "dark";

const STORAGE_KEY = "perseverance.theme";

export function readThemePreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") {
      return stored;
    }
  } catch {
    // A WebView with storage denied still gets a working app; it just follows
    // the OS every launch.
  }
  return "system";
}

export function writeThemePreference(preference: ThemePreference): void {
  try {
    if (preference === "system") {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, preference);
    }
  } catch {
    // Same as above: the preference lasts the session rather than forever.
  }
}

/**
 * The override is expressed as one attribute on the root element, because that
 * is the whole retheme mechanism: semantic tokens are reassigned under
 * `:root[data-theme=...]` and nothing re-renders. Absence of the attribute is
 * how "follow the OS" is spelled.
 */
export function applyThemePreference(preference: ThemePreference): void {
  const root = document.documentElement;
  if (preference === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", preference);
  }
}

import { useCallback, useEffect, useState } from "react";
import {
  applyThemePreference,
  readThemePreference,
  writeThemePreference,
  type ThemePreference,
} from "./theme";

export function useTheme(): [ThemePreference, (next: ThemePreference) => void] {
  const [preference, setPreference] = useState<ThemePreference>(
    readThemePreference,
  );

  useEffect(() => {
    applyThemePreference(preference);
  }, [preference]);

  const choose = useCallback((next: ThemePreference) => {
    writeThemePreference(next);
    setPreference(next);
  }, []);

  return [preference, choose];
}

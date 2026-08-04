import type { ThemePreference } from "./theme";
import styles from "./ThemeSwitch.module.css";

const OPTIONS: ReadonlyArray<{ value: ThemePreference; label: string }> = [
  { value: "system", label: "OS" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

interface ThemeSwitchProps {
  preference: ThemePreference;
  onChoose: (next: ThemePreference) => void;
}

export function ThemeSwitch({ preference, onChoose }: ThemeSwitchProps) {
  return (
    <div className={styles.switch} role="group" aria-label="Theme">
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          className={styles.option}
          aria-pressed={preference === option.value}
          onClick={() => onChoose(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

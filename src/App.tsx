import { useEffect, useState } from "react";
import { DropRegion } from "./chrome/DropRegion";
import { NoMapChip } from "./chrome/NoMapChip";
import { loadSnapshot, noMapOpen, type Snapshot } from "./snapshot/snapshot";
import { ThemeSwitch } from "./theme/ThemeSwitch";
import { useTheme } from "./theme/useTheme";
import styles from "./App.module.css";

export function App() {
  const [preference, chooseTheme] = useTheme();
  const [snapshot, setSnapshot] = useState<Snapshot>(noMapOpen);

  useEffect(() => {
    let live = true;
    loadSnapshot().then((next) => {
      if (live) setSnapshot(next);
    });
    return () => {
      live = false;
    };
  }, []);

  return (
    <div className={styles.app}>
      <header className={styles.chrome}>
        <span className={styles.brand}>perseverance</span>
        <NoMapChip />
        <ThemeSwitch preference={preference} onChoose={chooseTheme} />
      </header>

      <DropRegion>
        <p className={styles.invitation}>Drop a repository folder here.</p>
        <p className={styles.absolution}>
          A first session that charts nothing is a normal first session. The map
          is the output of the work, not its entry fee.
        </p>
      </DropRegion>

      <footer className={styles.readout}>
        <span>schema v{snapshot.schemaVersion}</span>
        <span>source: {snapshot.provenance.source}</span>
        <span>read: {snapshot.provenance.outcome.kind}</span>
        <span>age: {snapshot.provenance.fetchedAt ?? "—"}</span>
      </footer>
    </div>
  );
}

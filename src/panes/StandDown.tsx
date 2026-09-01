import { describeModel } from "../snapshot/readout";
import type { Model } from "../snapshot/snapshot";
import { LABELS, type ViewName } from "../views/views";
import type { Detent, Exit, StandDown as Standing } from "./dial";
import styles from "./StandDown.module.css";

/**
 * A view standing down, said out loud.
 *
 * The one surface in the app that exists to explain an absence, so it names all
 * four things at once: **which** view, **why**, **what it needs** and **what it
 * has**. A blank column, a shrunken rendering or a quiet swap to something that
 * fits would each be the app deciding for the operator; this decides nothing.
 *
 * The three integers and the frontier are printed here too, from the same
 * `describeModel` the footer uses. A stand-down is not a reason to stop knowing
 * where the map stands — it is a reason the map cannot be *drawn*, which is a
 * different fact and a smaller one.
 */
export function StandDown({
  standing,
  model,
  onWiden,
  onOpen,
  onTerminal,
}: {
  standing: Standing;
  model: Model;
  onWiden: (detent: Detent) => void;
  onOpen: (view: ViewName) => void;
  onTerminal: () => void;
}) {
  return (
    <section className={styles.standDown} aria-label="View stood down">
      <p className={styles.what}>
        {LABELS[standing.view]} needs {standing.needs}px of map; this position gives{" "}
        {standing.has}px.
      </p>
      <p className={styles.why}>
        It is not drawn narrower, because a row that has to be guessed at is
        worse than a row that is not there.
      </p>
      {/*
        The same line the footer spells, from the same function. Two renderings
        of one value cannot disagree; a stand-down that hid them would make the
        map's state unreadable for the width of a window.
      */}
      <p className={styles.model}>{describeModel(model)}</p>
      <div className={styles.exits}>
        {standing.exits.map((exit, index) => (
          <button
            key={index}
            type="button"
            className={styles.exit}
            onClick={() => take(exit, onWiden, onOpen, onTerminal)}
          >
            {wording(exit)}
          </button>
        ))}
      </div>
    </section>
  );
}

function wording(exit: Exit): string {
  switch (exit.kind) {
    case "widen":
      return exit.honoured
        ? `Widen to ${exit.detent}`
        : `Widen to ${exit.detent} — the widest this window has, and still short`;
    case "open":
      return `Open ${LABELS[exit.view]} here`;
    case "terminal":
      return "Give the whole window to the terminal";
  }
}

function take(
  exit: Exit,
  onWiden: (detent: Detent) => void,
  onOpen: (view: ViewName) => void,
  onTerminal: () => void,
): void {
  switch (exit.kind) {
    case "widen":
      onWiden(exit.detent);
      return;
    case "open":
      onOpen(exit.view);
      return;
    case "terminal":
      onTerminal();
  }
}

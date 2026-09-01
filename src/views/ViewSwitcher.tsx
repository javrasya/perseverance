import { floorOf, honours } from "../panes/dial";
import { LABELS, VIEWS, type ViewName } from "./views";
import styles from "./ViewSwitcher.module.css";

/**
 * Every view there is, at every position of the dial.
 *
 * **No cap is ever hidden.** A switcher that dropped the views that do not fit
 * would be a switcher that answers *what can I open* differently depending on
 * how wide a window happens to be — and the operator would have no way to learn
 * that the missing one exists, let alone how to get to it.
 *
 * A cap whose view cannot be drawn at this width is drawn *differently in form*:
 * a dashed edge and the width it is short of, printed on the cap. Collapse every
 * semantic colour token in the sheet to one value and the two kinds of cap are
 * still told apart, which is the test that matters — hue alone is not a
 * difference for a operator who cannot see it.
 *
 * Pressing one is a single operator act with two consequences: the dial moves to
 * a position where that view fits, and that view opens. Neither happens on its
 * own. The caller does both — see `App.tsx` — because this component is not
 * allowed to know how to move a dial.
 */
export function ViewSwitcher({
  view,
  mapWidth,
  onChoose,
}: {
  view: ViewName;
  /** What the map side is worth right now, in pixels. */
  mapWidth: number;
  onChoose: (view: ViewName) => void;
}) {
  return (
    <div className={styles.switcher} role="group" aria-label="Views">
      {VIEWS.map((name) => {
        const floor = floorOf(name);
        const fits = honours(floor, mapWidth);
        return (
          <button
            key={name}
            type="button"
            className={fits ? styles.cap : `${styles.cap} ${styles.tight}`}
            data-fits={fits ? "true" : "false"}
            aria-pressed={name === view}
            onClick={() => onChoose(name)}
          >
            <span className={styles.name}>{LABELS[name]}</span>
            {/*
              The reason, on the cap rather than in a tooltip: a reason that has
              to be hovered for is a reason a keyboard never hears.
            */}
            {fits ? null : (
              <span className={styles.reason}>needs {floor}px · widens the dial</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

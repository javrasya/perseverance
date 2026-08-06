import type { Model } from "../snapshot/model.generated";
import { NO_MAP_OPEN } from "../snapshot/readout";
import styles from "./MapChip.module.css";

/**
 * Which map is open, in the chrome.
 *
 * First launch is not a mode. The chip establishes the socket before it holds
 * anything, so an absent map is an empty socket rather than no chip at all —
 * absence is never a zero, and the empty state is an em dash and a name, never
 * a count.
 *
 * What it may not be is a constant. Shipped as one it said *no map open* on
 * every paint, which cost nothing while nothing else on screen could contradict
 * it and became a lie the moment #34 drew the Route underneath it. A picture
 * and a sentence derived from one model can only differ if one of them is
 * wrong; this now reads the same `model.map` the graph and the footer readout
 * do, so there is no third account left to go stale.
 *
 * The words for the absence are `readout.ts`'s. A second phrasing of *no map
 * open* is a second thing to keep in step, and a header disagreeing with a
 * footer is exactly what that costs.
 *
 * With a map open it names the map and stops: the number and the title, which
 * is the whole of the identity the model carries for one. The phase, the three
 * counts and the frontier are the footer's line — a chip that repeated any of
 * them would be a second reading of the same numbers, in a place with less room
 * to be right.
 */
export function MapChip({ model }: { model: Model }) {
  const map = model.map;

  if (map === null) {
    return (
      <div className={styles.chip} data-state="empty">
        <span className={styles.mark} aria-hidden="true">
          —
        </span>
        <span className={styles.label}>{NO_MAP_OPEN}</span>
      </div>
    );
  }

  return (
    <div className={styles.chip} data-state="open">
      {/* Not decorative the way the dash is: the number is what an operator
          types at `gh`, and it is the half of the identity that never elides. */}
      <span className={styles.mark}>#{map.number}</span>
      {/* The whole title on hover, because the row it sits in has an end and a
          GitHub title does not. */}
      <span className={styles.label} title={map.title}>
        {map.title}
      </span>
    </div>
  );
}

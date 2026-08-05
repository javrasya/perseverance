import { useState } from "react";
import {
  COMPLETED_GROUP,
  COMPLETED_HINT,
  MAPS_HEADING,
  MAPS_PREAMBLE,
  NOT_READ_COPY,
  NOT_READ_HEADLINE,
  NO_MAP_COPY,
  NO_MAP_HEADLINE,
  TRUNCATED_NOTE,
  completedMaps,
  hasBeenRead,
  openMaps,
  type MapEntry,
  type MapsView,
} from "./maps";
import styles from "./MapList.module.css";

interface MapListProps {
  view: MapsView;
}

/**
 * The maps in the folder you picked.
 *
 * Three states, and the third is the one worth the file: a repository with no
 * map at all is a normal, non-error state — a first charting session that
 * judged the work small enough to just do leaves none behind — so it gets copy
 * that pre-absolves rather than an empty list that reads as a failure.
 *
 * Closed maps are grouped and collapsed rather than hidden, because a finished
 * map is reopened to read the decisions it already made.
 *
 * Nothing here is derived. No phase, no counts, no frontier: those come with
 * the derived model, and a number invented in a view is a number the graph can
 * disagree with.
 */
export function MapList({ view }: MapListProps) {
  const [completedShown, setCompletedShown] = useState(false);

  const open = openMaps(view);
  const completed = completedMaps(view);
  const read = hasBeenRead(view);

  return (
    <section className={styles.maps} aria-label="Maps">
      <h2 className={styles.heading}>{MAPS_HEADING}</h2>
      <p className={styles.preamble}>{MAPS_PREAMBLE}</p>

      {view.truncated ? (
        <p className={styles.caveat} role="status">
          {TRUNCATED_NOTE}
        </p>
      ) : null}

      {open.length > 0 ? (
        <ul className={styles.list}>
          {open.map((map) => (
            <MapRow key={map.number} map={map} />
          ))}
        </ul>
      ) : (
        /*
         * Not-read and no-map are two absences, not one. Collapsing them would
         * tell an operator whose machine has never reached GitHub that their
         * repository is empty.
         */
        <div className={styles.absence} data-state={read ? "none" : "unread"}>
          <span className={styles.absenceHeadline}>
            {read ? NO_MAP_HEADLINE : NOT_READ_HEADLINE}
          </span>
          <span className={styles.absenceDetail}>{read ? NO_MAP_COPY : NOT_READ_COPY}</span>
        </div>
      )}

      {completed.length > 0 ? (
        <div className={styles.completed}>
          <button
            type="button"
            className={styles.completedToggle}
            onClick={() => setCompletedShown((shown) => !shown)}
            aria-expanded={completedShown}
            aria-controls="completed-maps"
          >
            <span className={styles.completedCaret} aria-hidden="true">
              {completedShown ? "▾" : "▸"}
            </span>
            <span className={styles.completedName}>{COMPLETED_GROUP}</span>
            <span className={styles.completedCount}>{completed.length}</span>
          </button>

          {/*
            Rendered only when open. A collapsed group that kept its rows in the
            document would put them in the tab order behind a caret that says
            they are put away.
          */}
          {completedShown ? (
            <>
              <p className={styles.completedHint}>{COMPLETED_HINT}</p>
              <ul className={styles.list} id="completed-maps">
                {completed.map((map) => (
                  <MapRow key={map.number} map={map} />
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/**
 * One map. The number is its whole identity — a map is an issue, and the app
 * registers nothing — so the number is shown rather than hidden behind a name.
 */
function MapRow({ map }: { map: MapEntry }) {
  return (
    <li className={styles.row} data-closed={map.closed}>
      <span className={styles.number}>#{map.number}</span>
      <span className={styles.title}>{map.title}</span>
    </li>
  );
}

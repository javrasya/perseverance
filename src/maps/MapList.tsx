import { useState } from "react";
import {
  COMPLETED_GROUP,
  COMPLETED_HINT,
  CONDITIONS,
  MAPS_HEADING,
  MAPS_PREAMBLE,
  NOT_READ_COPY,
  NOT_READ_HEADLINE,
  NO_MAP_COPY,
  NO_MAP_HEADLINE,
  REMEDY,
  STOPPED_COPY,
  TRUNCATED_NOTE,
  completedMaps,
  hasBeenRead,
  openMaps,
  stoppedReading,
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
 *
 * **When the poller has stopped reading, every row stays on screen and stops
 * being an affordance.** Disabled in place and never hidden: a missing button
 * and a broken network must not look identical, and a list that emptied itself
 * would be asserting that the maps are gone on the strength of not having been
 * able to look. It is the same idiom `FolderRow` uses for a folder whose drive
 * is unplugged — a change of ink and never a change of layout — reused rather
 * than invented a second time.
 */
export function MapList({ view }: MapListProps) {
  const [completedShown, setCompletedShown] = useState(false);

  const open = openMaps(view);
  const completed = completedMaps(view);
  const read = hasBeenRead(view);
  /* The two conditions retrying cannot fix, and only those. A rate limit is a
     wait with an end on it, and rows disabled for one would come back by
     themselves while somebody sat reading a reason to give up. */
  const stopped = stoppedReading(view);
  const remedy = stopped === null ? null : REMEDY[stopped.reason];

  return (
    <section
      className={styles.maps}
      aria-label="Maps"
      data-degraded={stopped?.reason}
    >
      <h2 className={styles.heading}>{MAPS_HEADING}</h2>
      <p className={styles.preamble}>{MAPS_PREAMBLE}</p>

      {view.truncated ? (
        <p className={styles.caveat} role="status">
          {TRUNCATED_NOTE}
        </p>
      ) : null}

      {/*
        Above the rows rather than beside them, because it is true of all of
        them. Text and not a modal: a condition on the graph is a fact about how
        old the screen is, and a modal is a thing that interrupts you to be
        dismissed. `role` is deliberately absent — this is not an alert and must
        not be announced as one.
      */}
      {stopped === null ? null : (
        <div className={styles.stopped}>
          <span className={styles.stoppedHeadline}>{CONDITIONS[stopped.reason]}</span>
          <span className={styles.stoppedDetail}>{STOPPED_COPY[stopped.reason]}</span>
          {remedy === null ? null : (
            <code className={styles.stoppedRemedy}>{remedy}</code>
          )}
        </div>
      )}

      {open.length > 0 ? (
        <ul className={styles.list}>
          {open.map((map) => (
            <MapRow key={map.number} map={map} disabled={stopped !== null} />
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
                  <MapRow key={map.number} map={map} disabled={stopped !== null} />
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
 *
 * `disabled` greys it and says so to a screen reader; it never removes it. The
 * row is what opening a map will hang off, and opening a map is exactly what
 * needs a read this app cannot currently make.
 */
function MapRow({ map, disabled }: { map: MapEntry; disabled: boolean }) {
  return (
    <li
      className={styles.row}
      data-closed={map.closed}
      data-disabled={disabled}
      aria-disabled={disabled || undefined}
    >
      <span className={styles.number}>#{map.number}</span>
      <span className={styles.title}>{map.title}</span>
    </li>
  );
}

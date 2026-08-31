import { useState, type ReactNode } from "react";
import {
  COMPLETED_GROUP,
  COMPLETED_HINT,
  CONDITIONS,
  LABELS_TRUNCATED_NOTE,
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
  /** The map this window is watching, or `null` for a folder with none open. */
  selected: number | null;
  onOpen: (number: number) => void;
  /**
   * The idea box, drawn inside the *no map here* absence and nowhere else.
   *
   * A node rather than the box itself, because nothing in this file is derived
   * and a control that has to reach a folder's environment and a command is not
   * a thing a list of maps should be holding. Where it goes is this file's
   * decision; what it does is not.
   */
  ideaBox?: ReactNode;
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
export function MapList({ view, selected, onOpen, ideaBox }: MapListProps) {
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
        Its own caveat rather than a second reading of the one above. A page a
        cap forbids and a label list that simply ran long are two facts: the
        first has no action attached to it, and the second changes what the
        screen beside it is claiming, because a ticket whose platform label was
        cut off is offered here whether or not it belongs here. Independent
        conditions, so both can be drawn at once, and neither is written in
        terms of the other.
      */}
      {view.labelsTruncated ? (
        <p className={styles.caveat} role="status" data-labels-truncated="">
          {LABELS_TRUNCATED_NOTE}
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
            <MapRow
              key={map.number}
              map={map}
              disabled={stopped !== null}
              selected={map.number === selected}
              onOpen={onOpen}
            />
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
          {/*
            Under the copy that pre-absolves it, and only in the read-and-empty
            absence. The operator reads that a first charting session which
            leaves no map behind is a success *before* pressing — which is the
            whole reason the box is here rather than on the rail. In the other
            absence there is nothing to say about this repository yet, and
            offering to chart what nobody has looked at would be answering a
            question that has not been asked.
          */}
          {read ? ideaBox : null}
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
                  <MapRow
                    key={map.number}
                    map={map}
                    disabled={stopped !== null}
                    selected={map.number === selected}
                    onOpen={onOpen}
                  />
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
 * **The row is what opening a map hangs off, and that read now exists.** The
 * poller asks GitHub for the graph of whatever map this window declares it is
 * watching, so clicking here is a declaration and not a fetch: it says what
 * this window is looking at, and what comes back arrives on the poller's own
 * channel at the cadence the ladder decided. There is nothing to await, which
 * is why the handler takes only a number and answers nothing.
 *
 * `disabled` greys it and says so to a screen reader; it never removes it. A
 * poller that has stopped reading cannot open a map either — the graph would
 * never arrive — so the button goes inert in place rather than the row going
 * away, which is the same idiom `FolderRow` uses for an unplugged drive.
 */
function MapRow({
  map,
  disabled,
  selected,
  onOpen,
}: {
  map: MapEntry;
  disabled: boolean;
  selected: boolean;
  onOpen: (number: number) => void;
}) {
  return (
    <li
      className={styles.row}
      data-closed={map.closed}
      data-disabled={disabled}
      data-open={selected || undefined}
      aria-disabled={disabled || undefined}
    >
      <button
        type="button"
        className={styles.choose}
        disabled={disabled}
        aria-current={selected ? "true" : undefined}
        onClick={() => onOpen(map.number)}
      >
        <span className={styles.number}>#{map.number}</span>
        <span className={styles.title}>{map.title}</span>
      </button>
    </li>
  );
}

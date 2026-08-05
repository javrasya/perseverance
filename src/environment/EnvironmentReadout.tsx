import {
  CANNOT_TELL_YOU,
  PATH_SPLIT_NOTE,
  STDERR_NOTE,
  TOKEN_NOTE,
  describeContamination,
  describeHarvest,
  factsLine,
  footerSummary,
  harvestHeadline,
  pathEntries,
  shellLine,
  shellNote,
  tokenLabel,
  type EnvironmentReadout as Readout,
} from "./environment";
import styles from "./EnvironmentReadout.module.css";

/** Shared between the button that opens the panel and the panel it opens. */
export const ENVIRONMENT_PANEL_ID = "environment-panel";

/**
 * The widest settled summary the footer slot reserves room for.
 *
 * The slot is sized by this ghost and the live text is laid over it, so the
 * footer holds its shape from the first paint through 1.9 s of Windows profile
 * to whatever comes back — the same socket `FolderRow` gives *Locate…*. A
 * longer line is clipped into the slot rather than allowed to move it; the
 * panel below shows the command verbatim, which is where it belongs anyway.
 */
const SUMMARY_GHOST = "/bin/zsh -lic · harvested · 000 vars";

interface EnvironmentSummaryProps {
  readout: Readout;
  shown: boolean;
  onToggle: () => void;
}

/**
 * The always-visible line, in the footer that already carries machine facts.
 *
 * A second readout would be a second place to look, so this is one more field
 * of the one that exists, plus the button that opens the rest. Not a live
 * region: a `PATH` announced aloud on every launch is hostile, and the button
 * carries `aria-expanded` so it can be found on purpose instead.
 */
export function EnvironmentSummary({ readout, shown, onToggle }: EnvironmentSummaryProps) {
  return (
    <span className={styles.slot}>
      <button
        type="button"
        className={styles.disclose}
        aria-expanded={shown}
        aria-controls={ENVIRONMENT_PANEL_ID}
        onClick={onToggle}
      >
        <span className={styles.label}>env:</span>
        <span className={styles.socket}>
          <span className={styles.ghost} aria-hidden="true">
            {SUMMARY_GHOST}
          </span>
          <span className={styles.summary} data-harvest={readout.harvest.kind}>
            {footerSummary(readout)}
          </span>
        </span>
        <span className={styles.chevron} aria-hidden="true">
          {shown ? "▾" : "▸"}
        </span>
      </button>
    </span>
  );
}

interface EnvironmentReadoutProps {
  readout: Readout;
  shown: boolean;
}

/**
 * What the harvest came to, in evidence rather than in summary.
 *
 * Six sections, in the order an operator would ask: which shell was run, what
 * became of its answer, the `PATH` it produced, whether a token was asked for,
 * what the shell wrote to its other stream, and what none of it can tell you.
 * The last of those is here rather than in a document nobody opens, because two
 * of this app's degradations are invisible by construction and the only way an
 * operator could ever notice one is by reading the `PATH` above them.
 *
 * The panel exists in the DOM in both states so `aria-controls` names something
 * real; `data-shown` is what opens it. Named for the view rather than for the
 * feature, because `environment.ts` holds the seam and two files in one folder
 * may not differ only in casing.
 */
export function EnvironmentReadout({ readout, shown }: EnvironmentReadoutProps) {
  const contamination = describeContamination(readout);
  const entries = pathEntries(readout);

  return (
    <section
      id={ENVIRONMENT_PANEL_ID}
      className={styles.panel}
      data-shown={shown ? "true" : "false"}
      data-harvest={readout.harvest.kind}
      aria-label="Environment"
    >
      <div className={styles.section}>
        <h2 className={styles.heading}>Shell used</h2>
        <code className={styles.command}>{shellLine(readout)}</code>
        <p className={styles.note}>{shellNote(readout)}</p>
      </div>

      <div className={styles.section}>
        <h2 className={styles.heading}>Environment</h2>
        <p className={styles.state} data-harvest={readout.harvest.kind}>
          {harvestHeadline(readout)}
        </p>
        <p className={styles.facts}>{factsLine(readout)}</p>
        <p className={styles.detail}>{describeHarvest(readout)}</p>
        {contamination === null ? null : <p className={styles.note}>{contamination}</p>}
      </div>

      <div className={styles.section}>
        <h2 className={styles.heading}>PATH</h2>
        {/*
         * Unsplit, and scrolling inside its own box so the page body never
         * scrolls sideways. Focusable, because a region a keyboard cannot
         * reach is a region a keyboard user cannot read.
         */}
        <div
          className={styles.verbatim}
          role="group"
          tabIndex={0}
          aria-label="PATH, exactly as it arrived"
        >
          <code className={styles.path}>{readout.path ?? "—"}</code>
        </div>
        <p className={styles.note}>{PATH_SPLIT_NOTE}</p>
        <ol className={styles.entries}>
          {entries.map((entry, index) => (
            <li key={`${index}-${entry}`} className={styles.entry}>
              {entry}
            </li>
          ))}
        </ol>
      </div>

      <div className={styles.section}>
        <h2 className={styles.heading}>Token</h2>
        <p className={styles.state}>{tokenLabel(readout)}</p>
        <p className={styles.note}>{TOKEN_NOTE}</p>
      </div>

      <div className={styles.section}>
        <h2 className={styles.heading}>What the shell wrote</h2>
        <p className={styles.note}>{STDERR_NOTE}</p>
        <div
          className={styles.stream}
          data-tone={readout.stderr.kind}
          role="group"
          tabIndex={0}
          aria-label="What the shell wrote, exactly as it arrived"
        >
          <code className={styles.streamText}>
            {readout.stderr.text === "" ? "—" : readout.stderr.text}
          </code>
        </div>
        <p className={styles.facts}>
          {readout.stderr.bytes} bytes · {readout.stderr.kind}
        </p>
      </div>

      <div className={styles.section}>
        <h2 className={styles.heading}>What this cannot tell you</h2>
        <ul className={styles.limits}>
          {CANNOT_TELL_YOU.map((limit) => (
            <li key={limit} className={styles.limit}>
              {limit}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

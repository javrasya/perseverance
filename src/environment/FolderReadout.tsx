import {
  ASK_AGAIN_LABEL,
  ASK_AGAIN_NOTE,
  FOLDER_CANNOT_TELL_YOU,
  FOLDER_PATH_NOTE,
  NO_PROBE_DECLARED,
  OVERRIDE_APPLIES_TO_EVERY_ADAPTER,
  OVERRIDE_ARGV_NOTE,
  OVERRIDE_SCOPE_NOTE,
  PATH_SPLIT_NOTE,
  PROBE_NOTE,
  RESOLUTION_NOTE,
  SPAWN_DIRECTORY_NOTE,
  STDERR_NOTE,
  degradationHeadline,
  degradationNote,
  folderFactsLine,
  overrideAftermath,
  overrideLine,
  pathEntries,
  probeLine,
  resolutionLine,
  resolutionSource,
  resolutionSummary,
  scopeLabel,
  type FolderReadout as Readout,
} from "./folder";
import { describeHarvest, harvestHeadline, shellLine } from "./environment";
import styles from "./FolderReadout.module.css";

/** Shared between the button that opens the panel and the panel it opens. */
export const FOLDER_PANEL_ID = "folder-environment-panel";

interface FolderReadoutProps {
  readout: Readout;
  shown: boolean;
  onToggle: () => void;
  onAskAgain: () => void;
}

/**
 * What one folder resolved to, in evidence rather than in summary.
 *
 * A second panel rather than fields added to the app-global one, because they
 * answer different questions: that one says what this *process* is running in,
 * this one says what a *folder* resolves under — and the whole point of #45 is
 * that those two can differ, because a version manager answers a folder's pin
 * inside its own process while your start-up files run.
 *
 * The headline fact of each adapter is the **absolute path** it resolved to.
 * That is the only visible form a pin has: the same bare name in two folders can
 * be two different files, and nothing here parses a version or compares one.
 * Wrong-interpreter is made inspectable, never detected.
 *
 * The panel is in the DOM in both states so `aria-controls` names something
 * real; `data-shown` is what opens it.
 */
export function FolderReadout({ readout, shown, onToggle, onAskAgain }: FolderReadoutProps) {
  const entries = pathEntries(readout);

  return (
    <section className={styles.holder} aria-label="This folder's environment">
      <div className={styles.bar}>
        <button
          type="button"
          className={styles.disclose}
          aria-expanded={shown}
          aria-controls={FOLDER_PANEL_ID}
          onClick={onToggle}
        >
          <span className={styles.label}>this folder:</span>
          <span className={styles.summary}>{resolutionSummary(readout)}</span>
          <span className={styles.chevron} aria-hidden="true">
            {shown ? "▾" : "▸"}
          </span>
        </button>
        <button type="button" className={styles.again} onClick={onAskAgain}>
          {ASK_AGAIN_LABEL}
        </button>
      </div>

      <div
        id={FOLDER_PANEL_ID}
        className={styles.panel}
        data-shown={shown ? "true" : "false"}
        data-harvest={readout.harvest.kind}
      >
        <div className={styles.section}>
          <h3 className={styles.heading}>Folder</h3>
          <code className={styles.command}>{readout.folder}</code>
          <p className={styles.facts}>started in {readout.spawnDirectory || "—"}</p>
          <p className={styles.note}>{SPAWN_DIRECTORY_NOTE}</p>
        </div>

        <div className={styles.section}>
          <h3 className={styles.heading}>Shell used</h3>
          <code className={styles.command}>{shellLine(readout)}</code>
          <p className={styles.state} data-harvest={readout.harvest.kind}>
            {harvestHeadline(readout)}
          </p>
          <p className={styles.facts}>{folderFactsLine(readout)}</p>
          <p className={styles.detail}>{describeHarvest(readout)}</p>
        </div>

        <div className={styles.section}>
          <h3 className={styles.heading}>PATH</h3>
          <p className={styles.note}>{FOLDER_PATH_NOTE}</p>
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
          <h3 className={styles.heading}>What each adapter resolved to</h3>
          <p className={styles.note}>{RESOLUTION_NOTE}</p>
          {readout.adapters.map((adapter) => (
            <div key={adapter.id} className={styles.adapter}>
              <span className={styles.adapterName}>{adapter.id}</span>
              <div
                className={styles.verbatim}
                role="group"
                tabIndex={0}
                aria-label={`What ${adapter.id} resolved to`}
                data-resolution={adapter.resolution.kind}
              >
                <code className={styles.path}>{resolutionLine(adapter)}</code>
              </div>
              <p className={styles.facts}>{resolutionSource(adapter)}</p>
              {adapter.probes.length === 0 ? (
                <p className={styles.note}>{NO_PROBE_DECLARED}</p>
              ) : (
                <>
                  <p className={styles.note}>{PROBE_NOTE}</p>
                  <ul className={styles.probes}>
                    {adapter.probes.map((probe, index) => (
                      <li key={`${index}-${probe.program}`} className={styles.probe}>
                        {probeLine(probe)}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          ))}
        </div>

        <div className={styles.section}>
          <h3 className={styles.heading}>Override</h3>
          <code className={styles.command}>{overrideLine(readout)}</code>
          <p className={styles.facts}>{scopeSentence(readout)}</p>
          <p className={styles.note}>{OVERRIDE_SCOPE_NOTE}</p>
          <p className={styles.note}>{OVERRIDE_ARGV_NOTE}</p>
          {/*
           * One stored vector, every adapter. At one adapter that was invisible;
           * at three the list reads like a bug unless the panel says so.
           */}
          <p className={styles.note}>{OVERRIDE_APPLIES_TO_EVERY_ADAPTER}</p>
        </div>

        <div className={styles.section}>
          <h3 className={styles.heading}>Start-up file</h3>
          <p className={styles.state}>{degradationHeadline(readout.degradation)}</p>
          <p className={styles.detail}>{degradationNote(readout.degradation)}</p>
          <p className={styles.note}>{STDERR_NOTE}</p>
          <div
            className={styles.stream}
            data-tone={readout.stderr.kind}
            role="group"
            tabIndex={0}
            aria-label="What the shell wrote in this folder, exactly as it arrived"
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
          <h3 className={styles.heading}>Asking again</h3>
          <p className={styles.note}>{ASK_AGAIN_NOTE}</p>
        </div>

        <div className={styles.section}>
          <h3 className={styles.heading}>What this cannot tell you</h3>
          <ul className={styles.limits}>
            {FOLDER_CANNOT_TELL_YOU.map((limit) => (
              <li key={limit} className={styles.limit}>
                {limit}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

/** Which scope the override got, or what became of the one that was typed. */
function scopeSentence(readout: Readout): string {
  switch (readout.override.kind) {
    case "none":
      return "Nothing overridden. Each adapter's own name is being looked for.";
    case "inUse":
      return scopeLabel(readout.override.scope);
    // Both remaining states are the same sentence the error itself shows, from
    // the same function, so the panel and the field cannot disagree about what
    // became of a vector the operator typed.
    default:
      return overrideAftermath(readout) ?? "";
  }
}

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useNow } from "../chrome/useNow";
import type { RunReadout } from "../terminal/runs";
import { droppedSentence, liveCount, rowsFor, shows, tierFor } from "./rack";
import styles from "./Rack.module.css";

/**
 * Every run, one row each, so several can be supervised without tiling N
 * transcripts nobody can read in parallel.
 *
 * The rack is **chrome**, not a view: it lives at a fixed address in the shell
 * beside the pane, like the ledger and the socket rail, and it is not in
 * `views.ts`, has no contract declaration and widens no `ViewProps`. It is also
 * a readout and nothing else — which run the terminal shows is the patchbay's
 * (#57), and no row here binds, monitors or ends anything.
 *
 * The two claims worth restating where they can be broken:
 *
 * - **The tier is width, never N.** [`tierFor`] is handed one measurement of
 *   this region and reads nothing else — not `readouts.length`, not what a row
 *   came out saying. Nothing about an arrival, a landing, a resolution or a
 *   death can change which tier draws, and the stylesheet keeps the region's own
 *   width off its content so the measurement cannot be moved that way either.
 * - **A landing is announced by the ping ceasing.** There is exactly one moving
 *   element in this subtree at any time — the lamp — however many runs are live.
 *   A row that lands loses its live ink and gains the word `landed`, and if it
 *   was the last live run the lamp stops. Nothing starts moving because
 *   something ended, and nothing here flashes, toasts or slides on arrival: an
 *   arrival may not interrupt a sentence being typed on the other side of the
 *   window.
 */
export function Rack({ readouts }: { readouts: readonly RunReadout[] }) {
  const region = useRef<HTMLElement | null>(null);
  const width = useRegionWidth(region);
  const tier = tierFor(width);

  const rows = rowsFor(readouts, useNow());
  const live = liveCount(rows);
  const dropped = droppedSentence(tier);

  return (
    <section
      className={tier === "studs" ? `${styles.rack} ${styles.studs}` : styles.rack}
      aria-label="The rack"
      data-tier={tier}
      ref={region}
    >
      <div className={styles.head}>
        {/*
          The one animated element in the rack, and it is the rack's rather than
          a row's: N live runs would otherwise be N pings, and the ration is one.
          `data-animated` is what the tests count, so *at most one* is a claim
          about the DOM rather than about how carefully this file was read.
        */}
        <span
          className={live === 0 ? styles.lamp : `${styles.lamp} ${styles.lampLive}`}
          data-animated={live === 0 ? undefined : "true"}
        />
        <span className={styles.count}>
          {rows.length === 0
            ? "no runs"
            : `${live} of ${rows.length} still running`}
        </span>
      </div>

      {dropped === null ? null : <p className={styles.dropped}>{dropped}</p>}

      {rows.length === 0 ? (
        <p className={styles.empty}>Nothing has been started in this window yet.</p>
      ) : (
        <ol className={styles.rows}>
          {rows.map((row) => (
            <li
              key={row.run}
              className={row.live ? `${styles.row} ${styles.rowLive}` : `${styles.row} ${styles.rowLanded}`}
              data-live={row.live ? "true" : "false"}
            >
              {shows(tier, "kind") ? <span className={styles.kind}>{row.kind}</span> : null}
              {shows(tier, "ticket") && row.ticket !== null ? (
                <span className={styles.ticket}>{row.ticket}</span>
              ) : null}
              {shows(tier, "age") ? (
                <span className={styles.age}>opened {row.age}</span>
              ) : null}
              {shows(tier, "unseen") ? <span className={styles.unseen}>{row.unseen}</span> : null}
              {shows(tier, "silence") ? (
                <span className={styles.silence}>last printed {row.silence}</span>
              ) : null}
              {shows(tier, "liveness") ? (
                <span className={styles.liveness}>{row.liveness}</span>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * This region's own width, in pixels.
 *
 * Its own, and never the body's: the rack is one of two boxes on the terminal
 * side and the dial divides the side rather than this box, so a tier chosen from
 * the body would be a tier chosen from arithmetic about a box that is not the
 * one on screen.
 *
 * Two mechanisms, and the second is not redundant. `ResizeObserver` is the
 * browser's own account of a box that changed for a reason this component never
 * rendered for — a font loading, the window resized, the pane's own layout
 * settling. The layout effect covers what the observer cannot: the first paint
 * before any observation has fired, and `jsdom`, which has no `ResizeObserver`
 * at all and would otherwise leave the rack pinned to whatever it opened at.
 * Neither can loop, because an unchanged measurement sets no state.
 *
 * This is *not* the observer `src/panes/useBodyBox.ts` is careful about. That
 * one is `Pane`'s, and its singularity matters because it is the only path to a
 * PTY resize (`src/panes/geometry.ts`). This one reaches no PTY and has nothing
 * to call: it picks a tier and stops.
 */
function useRegionWidth(region: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);

  const measure = useCallback(() => {
    const measured = Math.round(region.current?.getBoundingClientRect().width ?? 0);
    setWidth((was) => (was === measured ? was : measured));
  }, [region]);

  // No dependency list: after every render, because every layout change the
  // shell itself makes — the dial moving, a column shed — is a render.
  useLayoutEffect(measure);

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const held = region.current;
    if (held === null) return;

    const watching = new ResizeObserver(() => measure());
    watching.observe(held);
    return () => watching.disconnect();
  }, [measure, region]);

  return width;
}

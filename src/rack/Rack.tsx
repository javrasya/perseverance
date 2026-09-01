import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useNow } from "../chrome/useNow";
import type { RunReadout } from "../terminal/runs";
import {
  SHOWN,
  droppedSentence,
  lampPings,
  liveCount,
  phraseAt,
  rowsFor,
  tierFor,
  type Field,
} from "./rack";
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
 * - **A tier draws every field it claims, whole.** The row is `SHOWN[tier]`
 *   mapped rather than six hand-written spans, and what each one says comes from
 *   [`phraseAt`], which is where the narrow tiers' shorter wordings live. A
 *   field shrunk to an ellipsis would be `SHOWN` promising something the screen
 *   does not show, so the narrow tiers wrap rather than shrink and say the same
 *   facts in fewer characters.
 * - **A landing is announced by the ping ceasing.** There is at most one moving
 *   element on the *screen* at any time — this lamp — however many runs are
 *   live. A row that lands loses its live ink and gains the word `landed`, and
 *   if it was the last live run the lamp stops. Nothing starts moving because
 *   something ended, and nothing here flashes, toasts or slides on arrival: an
 *   arrival may not interrupt a sentence being typed on the other side of the
 *   window.
 *
 * The ration is the screen's and not this subtree's, which is why the shell
 * hands the rack [`spentElsewhere`]: the Route holds a licence of its own for a
 * halo on a claimed row, and a lamp that counted only its own children would
 * animate a second element beside it. [`lampPings`] is the arbitration, and the rack is
 * the surface that yields — it keeps the fact and loses only the movement,
 * because the filled ring and `N of M still running` say the same thing
 * standing still.
 */
export function Rack({
  readouts,
  spentElsewhere,
}: {
  readouts: readonly RunReadout[];
  /**
   * The map side is drawn, so the screen's one animation is its to spend.
   *
   * Not *a claim exists* and not *the Route is animating right now*: the shell
   * reads it off the pressed arrangement of the window alone, so nothing the
   * world does can start or stop this lamp. See `lampPings` and `src/App.tsx`.
   *
   * Required rather than defaulted: the shell is the only box that can see both
   * surfaces, and a prop with a default is a prop a second call site can forget
   * — which is the two-pings-at-once defect, back with nothing red to show it.
   */
  spentElsewhere: boolean;
}) {
  const region = useRef<HTMLElement | null>(null);
  const width = useRegionWidth(region);
  const tier = tierFor(width);

  const rows = rowsFor(readouts, useNow());
  const live = liveCount(rows);
  const pinging = lampPings(live, spentElsewhere);
  const dropped = droppedSentence(tier);

  return (
    <section
      className={tier === "bays" ? styles.rack : `${styles.rack} ${styles.narrow}`}
      aria-label="The rack"
      data-tier={tier}
      ref={region}
    >
      <div className={styles.head}>
        {/*
          The one animated element on the screen, and it is the rack's rather
          than a row's: N live runs would otherwise be N pings, and the ration is
          one. `data-animated` is what the tests count — here and on the Route's
          claimed node, the only other licence — so *at most one* is a claim
          about the DOM rather than about how carefully this file was read.

          Three states and not two: dark when nothing is running, a filled ring
          when something is and the window's ration is spent elsewhere, and the
          ring plus the ping when it is not. The ring is the still form rule 12
          asks for, so what a suppressed ping costs is the motion and never the
          fact. `data-lamp` is the address the conformance spec reads it by, at
          every one of those states — a spec that found the lamp by its ping
          could not ask whether something was painted over a lamp that is dark.
        */}
        <span
          className={
            live === 0
              ? styles.lamp
              : pinging
                ? `${styles.lamp} ${styles.lampLive} ${styles.lampPing}`
                : `${styles.lamp} ${styles.lampLive}`
          }
          data-lamp="true"
          data-animated={pinging ? "true" : undefined}
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
              {SHOWN[tier].map((field) => {
                const said = phraseAt(tier, row, field);
                return said === null ? null : (
                  <span key={field} className={INK[field]} data-field={field}>
                    {said}
                  </span>
                );
              })}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * Which class each field is drawn in, and `data-field` is how it is found.
 *
 * The attribute is not decoration: `tests/conformance/rack-width.spec.ts`
 * measures these boxes in a real browser to check that a field a tier claims is
 * a field the operator can actually read at that tier's floor, and a spec that
 * reached for the class name would be spelling a CSS-module hash — a test that
 * breaks on a rename instead of on a regression.
 */
const INK: Record<Field, string | undefined> = {
  kind: styles.kind,
  ticket: styles.ticket,
  age: styles.age,
  unseen: styles.unseen,
  silence: styles.silence,
  liveness: styles.liveness,
};

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

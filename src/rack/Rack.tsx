import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useNow } from "../chrome/useNow";
import { monitor, useUi } from "../stores/ui";
import { monitorRun, type RunReadout } from "../terminal/runs";
import type { PendingRun } from "./pending";
import {
  SHOWN,
  droppedSentence,
  lampPings,
  liveCount,
  phraseAt,
  queuedPhraseAt,
  queuedRowsFor,
  refusalLine,
  rowsFor,
  tierFor,
  waitingSentence,
  type Field,
} from "./rack";
import styles from "./Rack.module.css";

/**
 * Every run, one row each, so several can be supervised without tiling N
 * transcripts nobody can read in parallel.
 *
 * The rack is **chrome**, not a view: it lives at a fixed address in the shell
 * beside the pane, like the ledger and the socket rail, and it is not in
 * `views.ts`, has no contract declaration and widens no `ViewProps`. It is the
 * patchbay's selector as well as its readout (#57): a row is pressable and the
 * press patches the monitor onto that run. It still binds and ends nothing —
 * the press moves what the terminal *shows*, never where the keystrokes go.
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
  pending,
  refusals,
  spentElsewhere,
}: {
  readouts: readonly RunReadout[];
  /**
   * What has been accepted and has not started, in press order.
   *
   * Waiting entries only — a refused one has left the queue and is not waiting,
   * so it arrives on `refusals` instead. These are drawn as their own group
   * after the runs, and nothing in this component may treat one as a run: no
   * `monitorRun`, no place in the head's count, no lamp.
   *
   * Required rather than defaulted, for `spentElsewhere`'s reason: a prop with
   * a default is a prop a second call site forgets, and what it would forget
   * here is the whole of what an operator pressed and cannot see.
   */
  pending: readonly PendingRun[];
  /**
   * Deferred spawns that refused, held by the shell because nothing re-sends
   * them.
   *
   * The rack prints them as text near the queue and never as a row: a refusal
   * is not something that is waiting, and a row for one would be a queue entry
   * that never drains.
   */
  refusals: readonly PendingRun[];
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
  const { monitored } = useUi();
  const region = useRef<HTMLElement | null>(null);
  const width = useRegionWidth(region);
  const tier = tierFor(width);

  const now = useNow();
  const rows = rowsFor(readouts, now);
  /*
   * The queue is read on the same clock and is otherwise kept apart from the
   * runs, all the way down: `live` counts rows and never these, so a waiting
   * entry cannot light the lamp or move `N of M still running`. The licence the
   * lamp has under rule 9 is running-versus-stale liveness, and a queue entry
   * is neither — nothing is executing for it to be alive, and nothing has
   * stopped for it to have gone stale.
   */
  const queued = queuedRowsFor(pending, now);
  const live = liveCount(rows);
  const pinging = lampPings(live, spentElsewhere);
  const dropped = droppedSentence(tier);
  const waiting = waitingSentence(queued.length);

  /*
   * The harness first, then the store, and no focus call anywhere in here.
   *
   * `Runs::frame` on the Rust side emits bytes for the one run the harness is
   * monitoring and for no other, so a store that moved on its own would bind a
   * terminal nothing is being written to. Every other `monitor` on this side is
   * safe because the command it followed already set Rust's own; this press
   * sends no command, so it makes the declaration itself — the same shape the
   * Resume press uses in `src/chrome/Sockets.tsx`. `monitorRun` is a no-op with
   * no Rust behind the window, which is what makes this correct in `dev:web`
   * and in jsdom too.
   *
   * And nothing warms. `monitor` cools the binding on every change, and that
   * cooling is the whole of *you can select which run the terminal shows
   * without moving your keyboard to it*: a focus call here would take that
   * back, and would land the caret in a dead child on a row that had exited.
   * Warming the newly monitored run stays the crossing chord, or a click into
   * the terminal.
   */
  const patch = (run: number) => {
    void monitorRun(run).then(() => monitor(run));
  };

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

      {/*
        The empty sentence is about the whole rack, so a queue keeps it off the
        screen: *nothing has been started* is true of two waiting presses — that
        is exactly what they are — but printed directly above two rows saying
        `waiting` it reads as a contradiction rather than as a distinction.
      */}
      {rows.length === 0 && queued.length === 0 ? (
        <p className={styles.empty}>Nothing has been started in this window yet.</p>
      ) : null}

      {rows.length === 0 ? null : (
        <ol className={styles.rows}>
          {rows.map((row) => {
            const patched = row.run === monitored;
            const liveness = row.live ? styles.rowLive : styles.rowLanded;
            return (
              /*
                The row is the button, and the `<li>` around it draws nothing —
                see `.slot` in the stylesheet. A wrapper with a box of its own
                would put a second box between the row and its fields, and the
                fields' real boxes are what `tests/conformance/rack-width.spec.ts`
                measures at each tier's floor.

                A landed run's row is pressable like any other: runs stay in the
                rack as `exited`, and patching the monitor onto one so its crash
                can be read is the point rather than an edge case.

                `aria-current` and `data-monitored` are the mark, and the
                stylesheet adds a ring to them — a form-level difference, so the
                mark is not carried by colour alone and is not hidden behind
                hover. Which row is marked comes from the UI store and never from
                `RunReadout.monitored`, which is Rust's own account: that one lags
                the press by a poll tick, and the `dev:web` fixtures do not drive
                it at all.
              */
              <li key={row.run} className={styles.slot}>
                <button
                  type="button"
                  className={patched ? `${styles.row} ${liveness} ${styles.rowPatched}` : `${styles.row} ${liveness}`}
                  data-live={row.live ? "true" : "false"}
                  data-run={row.run}
                  data-monitored={patched ? "true" : undefined}
                  aria-current={patched ? "true" : undefined}
                  onClick={() => patch(row.run)}
                >
                  {SHOWN[tier].map((field) => {
                    const said = phraseAt(tier, row, field);
                    return said === null ? null : (
                      <span key={field} className={INK[field]} data-field={field}>
                        {said}
                      </span>
                    );
                  })}
                </button>
              </li>
            );
          })}
        </ol>
      )}

      {/*
        What is waiting, in its own sentence beside the head's count rather than
        inside it — `waitingSentence` in `rack.ts` argues why `M` may not grow
        by a press nobody spawned. Text in the flow, like the dropped sentence
        and for rule 10's reason: an operator who pressed six times has to be
        able to see that two of them are still queued without going looking.
      */}
      {waiting === null ? null : <p className={styles.waiting}>{waiting}</p>}

      {queued.length === 0 ? null : (
        <ol className={styles.queue} aria-label="Waiting to start">
          {queued.map((row) => (
            /*
              Not a button, and that is the load-bearing part. A row here is not
              a patchbay source: there is no run to monitor, so a press that
              called `monitorRun` would either declare a run number that does
              not exist or — worse — leave the monitor on whatever it was while
              marking this row as the one on screen. So the queue entry is inert
              markup with no handler, no `data-run` and no `tabIndex`; there is
              nothing here for a press to be wrong about.

              Keyed by the entry's own id with a prefix, because run numbers and
              entry ids are two number spaces: an unprefixed collision would
              have React reuse a run's row for an entry, and nothing on screen
              would say so.
            */
            <li key={`pending-${row.id}`} className={styles.slot}>
              <div
                className={`${styles.row} ${styles.rowWaiting}`}
                data-pending={row.id}
                data-waiting="true"
              >
                {SHOWN[tier].map((field) => {
                  const said = queuedPhraseAt(tier, row, field);
                  return said === null ? null : (
                    <span key={field} className={INK[field]} data-field={field}>
                      {said}
                    </span>
                  );
                })}
              </div>
            </li>
          ))}
        </ol>
      )}

      {/*
        The refusals, as sentences and never as rows. A refused entry has left
        the queue — it is not waiting for anything — and a row for one would be
        a queue entry that never drains. This is the only place a deferred
        spawn's failure is ever reported: the press it came from was answered
        long ago, and the sentence crosses on exactly one emission.
      */}
      {refusals.length === 0 ? null : (
        <ul className={styles.refusals}>
          {refusals.map((entry) => (
            <li key={`refused-${entry.id}`}>{refusalLine(entry)}</li>
          ))}
        </ul>
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

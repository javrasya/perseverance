import { useEffect, useRef } from "react";
import { gesture, type Occasion } from "../panes/geometry";
import { useUi } from "../stores/ui";
import { promptFor } from "./prompts";
import { PromptBlock } from "./PromptBlock";
import type { RunReadout } from "./runs";
import type { Terminals } from "./terminals";
import styles from "./Pane.module.css";

/**
 * The one place a run's terminal is on screen.
 *
 * React renders the **frame** and never the terminal. The node inside is
 * created, kept and moved by [`Terminals`]; this component's whole contribution
 * to it is one call in one effect that says which run belongs here now. That
 * separation is the point — a terminal under React's reconciler is a terminal
 * one key change away from being thrown out, and the harness has no way to put a
 * lost screen back.
 *
 * The split it sits in is fixed. The dial with its detents is #52's, and
 * choosing how much window a pane is worth in this file would be making that
 * ticket's call early.
 */
export function Pane({
  terminals,
  readouts,
}: {
  terminals: Terminals;
  readouts: readonly RunReadout[];
}) {
  const { monitored } = useUi();
  const host = useRef<HTMLDivElement | null>(null);
  const gestures = useRef<ReturnType<typeof gesture> | null>(null);

  /*
   * Which run is on the pane. A move, never a mount: `bind` reparents the node
   * that already exists, and the terminals that come off the pane keep every
   * byte they hold.
   *
   * The effect depends on `monitored` and on nothing else, which is what stops a
   * poll landing from touching the pane at all — the snapshot lives in a
   * different store, and this component never reads it.
   */
  useEffect(() => {
    terminals.bind(monitored, host.current);
  }, [terminals, monitored]);

  /*
   * The pane's size, watched, and turned into at most one resize per completed
   * gesture.
   *
   * `ResizeObserver` is the browser's own account of when a box changed, which
   * is the only thing that can see a drag; `measured("drag", …)` restarts the
   * debounce and sends nothing, and the falling edge is the one thing that
   * reaches a PTY. Every other occasion a size could arrive on — bind, peek,
   * arrival — has no call here to make.
   */
  useEffect(() => {
    const held = host.current;
    if (held === null) return;
    // jsdom has no `ResizeObserver`. A window that cannot watch its own layout
    // keeps the geometry it opened at, which is a smaller loss than a test file
    // that has to stub a browser API to render a frame.
    if (typeof ResizeObserver === "undefined") return;

    const gestured = gesture();
    gestures.current = gestured;

    const measure = (occasion: Occasion) => {
      if (monitored === null) return;
      // Measured by the terminal that is on the pane, because how many
      // characters fit depends on the font the emulator resolved.
      const fits = terminals.for(monitored).measure();
      if (fits !== null) gestured.measured(occasion, fits);
    };

    const watching = new ResizeObserver(() => measure("drag"));
    watching.observe(held);

    return () => {
      watching.disconnect();
      gestured.cancel();
      gestures.current = null;
    };
  }, [terminals, monitored]);

  const readout = readouts.find((run) => run.run === monitored) ?? null;

  /*
   * Read during render rather than held in state: the prompt is written once,
   * by the press that produced the run, and it is already on record before that
   * run is ever the monitored one. A run this window did not start — a window
   * opened after the spawn, a fixture boot — has none, and that is a block that
   * is absent rather than an empty one.
   */
  const prompt = monitored === null ? null : promptFor(monitored);

  return (
    <section className={styles.pane} aria-label="Terminal">
      {/*
        The chrome, and the only place a fact about the stream is ever written
        down. Truncation and desync are printed *here*, next to the terminal and
        never into it: a terminal with `scrollback lost` typed into its buffer
        would be a terminal whose contents are no longer only what the agent
        said, and there would be no way to tell the two apart afterwards.
      */}
      {readout === null ? null : (
        <div className={styles.chrome}>
          {readout.truncated ? (
            <span className={styles.truncation}>
              {readout.dropped.toLocaleString()} earlier bytes are no longer held
            </span>
          ) : null}
          {readout.desynced ? (
            <span className={styles.desync}>
              this terminal is behind, and will be replayed whole when it catches up
            </span>
          ) : null}
          {readout.over ? (
            <span className={styles.over}>
              this run has ended{readout.code === null ? "" : ` (${readout.code})`}
            </span>
          ) : null}
        </div>
      )}

      {prompt === null ? null : <PromptBlock prompt={prompt} />}

      {/*
        The terminal's node is appended here by `Terminals.bind` and is not a
        child React knows about. Nothing may be rendered inside it: React would
        reconcile against children it did not put there and remove them.
      */}
      <div className={styles.host} ref={host} />

      {monitored === null ? (
        <p className={styles.empty}>Nothing is running here yet.</p>
      ) : null}
    </section>
  );
}

import { useEffect, useRef } from "react";
import { gesture, type Occasion } from "../panes/geometry";
import { monitor, useUi } from "../stores/ui";
import { promptFor } from "./prompts";
import { PromptBlock } from "./PromptBlock";
import { endRun, type RunReadout } from "./runs";
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
/**
 * How a run ended, as a sentence.
 *
 * One reading per `RunEnding` and nothing else consulted. The derivation is
 * Rust's — `over` plus the last node state it saw — and re-deriving it here out
 * of the flags that happen to be on the readout would give the app a second
 * opinion about its own ending, which is the one thing ADR 0022 spent a table
 * avoiding. `spent` deliberately says nothing about the child: the ticket
 * closed, and the agent may still be printing.
 */
export function endingSentence(readout: RunReadout): string | null {
  switch (readout.ending) {
    case "live":
      return null;
    case "spent":
      return "the ticket closed — this output is yours to read for as long as you want";
    case "exitedUnresolved":
      return "this run stopped with its ticket still open and still claimed";
    case "exited":
      return `this run has ended${readout.code === null ? "" : ` (${readout.code})`}`;
  }
}

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
  const sentence = readout === null ? null : endingSentence(readout);

  /*
   * The press, and the only thing in this app that ends a run.
   *
   * Nothing automatic reaches it — no timer, no poll, no readout tick — because
   * a run that is over and has nothing left to say is still a run somebody is
   * reading, and the app closing it on the strength of a GitHub read would throw
   * away the last thing the agent printed.
   *
   * The order is the seam's. The harness closes the session first and only then
   * does this side let go of the node, so a disposed terminal can never be the
   * terminal of a session Rust still believes is being watched; `monitor(null)`
   * comes last, because a pane still bound to a run the harness has dropped
   * would be a frame claiming a run that no longer exists.
   */
  const end = async (run: number) => {
    await endRun(run);
    terminals.forget(run);
    monitor(null);
  };

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
          {sentence === null ? null : (
            <span
              className={readout.ending === "exitedUnresolved" ? styles.unresolved : styles.over}
            >
              {sentence}
            </span>
          )}
          {/*
            Offered on every ending but `live`, and it is a real button rather
            than a click handler on the sentence: the ending is a fact and this
            is a decision, and the keyboard has to be able to reach the decision.
            It lives in the chrome and never inside the host node, where xterm
            plants its own helper textarea.
          */}
          {readout.ending === "live" ? null : (
            <button
              type="button"
              className={styles.end}
              onClick={() => {
                void end(readout.run);
              }}
            >
              End this run
            </button>
          )}
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

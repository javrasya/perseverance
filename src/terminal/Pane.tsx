import { useEffect, useRef } from "react";
import { briefSpan } from "../chrome/age";
import { collapsed, gesture, type Occasion } from "../panes/geometry";
import { monitor, useUi } from "../stores/ui";
import { promptFor } from "./prompts";
import { PromptBlock } from "./PromptBlock";
import { endRun, type RunReadout, type RunSignal } from "./runs";
import { forgetSpill, useSpill, type Spill } from "./spill";
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
 * How much window it is worth is the dial's, and this file has no opinion about
 * it beyond one: a box the dial has collapsed is measured as *no size* rather
 * than as a small one, so a detent that hands the whole window to the map
 * reflows no live agent.
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

/**
 * The silence, as an observation.
 *
 * Every word here is a thing that is true of the screen — how long it has been
 * still, and who is waiting on it. None of them is a thing that is true of the
 * program: *hung*, *stuck*, *dead*, *frozen* and *fault* are all guesses about
 * a child this side has never seen, and a run idle for an hour because somebody
 * is reading a diff would be slandered by every one of them. So an hour of a
 * person thinking reads as `quiet · 62m`, for any elapsed and forever.
 *
 * The elapsed is printed and never compared. What a duration *means* is a joint
 * predicate over who is waiting and what the ticket says — `docs/adr/0025` — and
 * a threshold written on this side would be a second copy of that predicate,
 * silently disagreeing with the one Rust derives from six values this file can
 * only see two of.
 *
 * Two readings print nothing at all. `nothing` is a child that has exited, and
 * what that means is the ending sentence already beside this; `spent` is a
 * closed ticket, which the same sentence already carries. Saying either twice
 * in two vocabularies is how the two come to disagree.
 */
export const QUIET_READING = "quiet";
export const AWAITING_OPERATOR_READING = "waiting for you";
/*
 * The trust prompt is named and never raised. It is the agent CLI's own modal,
 * already on screen in the terminal immediately below this sentence, and the
 * harness's whole contribution is to say where to look: a condition is a fact,
 * and a modal is a thing that interrupts you to be dismissed.
 */
export const AWAITING_OPERATOR_DETAIL =
  "the readiness rule ran out before this session opened, and what it is waiting on — most likely this CLI's own prompt asking you to trust the folder — is in the terminal below";
export const UNWATCHED_READING = "nobody is watching";
export const UNWATCHED_DETAIL = "this run has printed nothing, and nothing has ever classified it";

export function silenceSentence(readout: RunReadout): string | null {
  const silence = readout.silence;
  switch (silence.kind) {
    case "nothing":
    case "spent":
      return null;
    case "quiet":
      return `${QUIET_READING} · ${briefSpan(silence.silentForMs)}`;
    case "wedged":
      return silence.why === "awaitingOperator"
        ? `${AWAITING_OPERATOR_READING} · ${briefSpan(silence.silentForMs)} — ${AWAITING_OPERATOR_DETAIL}`
        : `${UNWATCHED_READING} · ${briefSpan(silence.silentForMs)} — ${UNWATCHED_DETAIL}`;
  }
}

/**
 * The last thing a watch classified this run as, in one word.
 *
 * `null` prints nothing, and the nothing means *no watch has ever classified
 * this run* — a fact about the run's history. It is never worded as a fact
 * about the adapter, and there is deliberately no branch here on whether one
 * emits signals at all: every run is drained on identical terms, so the
 * question has no call site to be asked from.
 *
 * Still, all three of them. `busy` is a word and not a spinner — the pane's
 * stylesheet forbids motion beside a terminal, which is already the most
 * moving thing on the screen.
 */
export const SIGNAL_READINGS: Record<RunSignal, string> = {
  ready: "ready",
  busy: "working",
  idle: "idle",
};

/**
 * What the spill register caught, as an observation.
 *
 * Two facts and the words themselves: that they were typed after this run
 * ended, and that they were held rather than sent. Neither is a guess about the
 * child — this side watched the keys arrive and watched itself not send them,
 * which makes this the one reading on the chrome the app has first-hand
 * knowledge of.
 *
 * It is a line beside the terminal like every other reading here, and for the
 * same reasons: not a modal, because nothing has happened that needs answering
 * and a dismissal is not what the operator wants to spend the moment on; not a
 * toast, because a toast is a fact with a timer on it and these are the
 * operator's own words; and never written into the terminal buffer, where it
 * would be indistinguishable afterwards from something the agent printed.
 *
 * Nothing moves. The count changes as more is typed, and a changing number is a
 * still state at every value it takes — rule 12 asks for a still-state
 * equivalent of anything motion carries, and a reading that never animates
 * never incurs one.
 */
export const SPILL_READING = "typed after this run ended, and held rather than sent";

export function spillSentence(spill: Spill | null): string | null {
  if (spill === null) return null;
  const counted = `${spill.characters} character${spill.characters === 1 ? "" : "s"}`;
  return `${SPILL_READING} · ${counted} — “${spill.text}”`;
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
      /*
       * The dial's `map` detent gives this box no width at all. The node stays
       * where it is — never unmounted, never reparented by a dial move — and a
       * collapse is answered by *forgetting the gesture* rather than by settling
       * whatever the last few frames of the collapse measured: a run handed the
       * window back should find its terminal the size it left it.
       */
      if (collapsed(held.getBoundingClientRect())) {
        gestured.cancel();
        return;
      }
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
  const silence = readout === null ? null : silenceSentence(readout);
  const signal = readout === null || readout.signal === null ? null : readout.signal;
  const spill = spillSentence(useSpill(monitored));

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
   *
   * It is also the one place the caret ever leaves a run. A child that stopped
   * does not move it — that is the parking rule, and this press is the exception
   * the rule is stated against: a person saying they are done reading. The spill
   * register goes the way the terminal does and in the same breath, because what
   * a run held means nothing once the run is gone.
   */
  const end = async (run: number) => {
    await endRun(run);
    terminals.forget(run);
    forgetSpill(run);
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
          {silence === null ? null : (
            <span
              className={
                readout.silence.kind === "wedged" ? styles.wedged : styles.quiet
              }
            >
              {silence}
            </span>
          )}
          {signal === null ? null : (
            <span className={signal === "ready" ? styles.ready : styles.signal}>
              {SIGNAL_READINGS[signal]}
            </span>
          )}
          {sentence === null ? null : (
            <span
              className={readout.ending === "exitedUnresolved" ? styles.unresolved : styles.over}
            >
              {sentence}
            </span>
          )}
          {spill === null ? null : <span className={styles.spill}>{spill}</span>}
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

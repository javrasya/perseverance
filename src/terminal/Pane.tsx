import { useEffect, useRef } from "react";
import { briefSpan } from "../chrome/age";
import { EscReadout } from "../keys/EscReadout.jsx";
import { Temperature } from "../keys/Temperature.jsx";
import { collapsed, gesture, type Occasion } from "../panes/geometry";
import { nameOf } from "../keys/temperature";
import { keyedRun, monitor, readUi, setKeyed, useUi } from "../stores/ui";
import { promptFor } from "./prompts";
import { PromptBlock } from "./PromptBlock";
import { endRun, typedAtRun, type RunReadout, type RunSignal } from "./runs";
import { forgetSpill, offeredTo, useSpill, type Spill } from "./spill";
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
 * Two readings print nothing at all. `nothing` is a child that has exited, or
 * one that printed a moment ago — the first is the ending sentence already
 * beside this, and the second is a run working, which Rust decides with a floor
 * of its own so that no elapsed is compared here; `spent` is a closed ticket,
 * which the same ending sentence already carries. Saying any of it twice in two
 * vocabularies is how the two come to disagree.
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
      // Each wedge prints its own quantity: how long the session has failed to
      // open for one, and the byte silence for the other. They are different
      // facts, and the sentence beside each states the one it is about.
      return silence.why === "awaitingOperator"
        ? `${AWAITING_OPERATOR_READING} · ${briefSpan(silence.unopenedForMs)} — ${AWAITING_OPERATOR_DETAIL}`
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
 * The register is bounded, so this line is too: past `KEPT_CHARACTERS` the words
 * are the recent tail and the sentence says as much, rather than letting a
 * trimmed register read as a whole one. That bound is also what keeps the chrome
 * from growing until it squeezes the terminal underneath it.
 *
 * Nothing moves. The count changes as more is typed, and a changing number is a
 * still state at every value it takes — rule 12 asks for a still-state
 * equivalent of anything motion carries, and a reading that never animates
 * never incurs one.
 *
 * *Held rather than sent* stays exactly true beside the press that offers them:
 * the words are held, and they go nowhere until a hand sends them. The sentence
 * describes the register at the moment it is printed, and never the register's
 * future — a reading that said *these will be sent* would be the chrome making a
 * promise on the operator's behalf.
 */
export const SPILL_READING = "typed after this run ended, and held rather than sent";

export function spillSentence(spill: Spill | null): string | null {
  if (spill === null) return null;
  const counted = `${spill.characters} character${spill.characters === 1 ? "" : "s"}`;
  const held = spill.elided ? `${counted} kept, the most recent` : counted;
  const words = spill.elided ? `…${spill.text}` : spill.text;
  return `${SPILL_READING} · ${held} — “${words}”`;
}

/**
 * Where the words can go, named the way the rest of the app names a run.
 *
 * The destination is printed on the button rather than left to *Send*: this
 * window holds several folders' runs and the operator cannot see, from a pane
 * showing a stopped run, which live agent is about to be spoken to. `nameOf` in
 * `src/keys/temperature.ts` is that naming already written down — the same
 * spelling the temperature line above uses — so the button and the readout name
 * one run one way.
 */
export function offerLabel(work: RunReadout): string {
  return `Send to ${nameOf(work)}`;
}

/**
 * Why there is no press beside the words, as visible text.
 *
 * Printed rather than left blank, and never as a disabled button: a control that
 * cannot be pressed with the reason behind a hover is a reason a keyboard and a
 * screen reader do not have, which is the rule `src/chrome/sockets.ts` states for
 * the rail and this chrome keeps. It says the offer is missing and deliberately
 * says nothing about the words themselves — they are still held, still counted
 * and still printed beside this, and a sentence hinting they were lost would be
 * the pane contradicting the register an inch to its left.
 *
 * **There are two of these, because [`offeredTo`] has two absences.** This one
 * is the counted absence: the folder is known and no live work run is going in
 * it. [`NO_FOLDER_TO_JOIN`] is the other, and the split is the one the node
 * panel draws for its three unlit fields — a fact the harness was never told is
 * form-level distinct from a count that is genuinely nought, so the two may not
 * share a sentence.
 */
export const NOWHERE_TO_OFFER =
  "no work run is going in this folder, so there is nowhere to send these yet";

/**
 * Why there is no press when the window was never told where the run was staked.
 *
 * The other absence, and a different fact about the world. A parked run whose
 * `folder` is `null` is a run this window was never told the folder of, and the
 * join an offer is made on is the folder — so there is no folder here to be
 * empty of live work runs, and printing [`NOWHERE_TO_OFFER`] over it would name
 * a folder the window does not have and report a search that was never run.
 * `src/terminal/fixtures.ts` boots one such run on purpose, so the reading is on
 * screen in `dev:web` rather than only in a test.
 */
export const NO_FOLDER_TO_JOIN =
  "this window was never told which folder this run was staked in, so no offer can be joined";

export function Pane({
  terminals,
  readouts,
}: {
  terminals: Terminals;
  readouts: readonly RunReadout[];
}) {
  const ui = useUi();
  const { monitored, inFront } = ui;
  /* The temperature, read through the store's own derivation and never
     assembled here: there is one answer to *where do the keys go*, and this
     component is not entitled to a second one. */
  const warm = keyedRun(ui);
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
   * The keyboard follows the temperature, and never the other way around.
   *
   * The store is the fact; where the browser happens to have put the caret is
   * its consequence. Before this, the only way to type at a run was that
   * xterm's helper textarea happened to hold focus, which made *which run has
   * the keys* a question only the DOM could answer — unprintable, untestable,
   * and impossible to hold to the rule that the keyed run is on the monitor.
   *
   * Declared after the bind above so it runs after it: focusing a terminal that
   * is still in the stow would put the keyboard inside a node that is not on
   * screen. And it depends on `inFront` as well as on `warm`, because a surface
   * standing in front holds the keys for as long as it is up — which is why
   * dismissing one gives them back from *here* rather than from the shell's
   * dismiss handler, and why there is no second opinion about where they land.
   */
  useEffect(() => {
    if (inFront !== null) return;
    if (warm !== null) {
      terminals.for(warm).focus();
      return;
    }
    /* Nothing warm means the terminal may not keep the keys — but only the
       terminal's. Blurring whatever happens to be focused would take the
       keyboard off a route row or a picker on the map side, which is exactly
       where cold says the keys are. */
    const active = document.activeElement as HTMLElement | null;
    if (active !== null && host.current?.contains(active) === true) active.blur();
  }, [terminals, warm, inFront]);

  /*
   * The other direction, so that the store and the browser can never disagree
   * about who has the keys.
   *
   * A click lands the caret in xterm's helper textarea with nothing in this app
   * having been pressed, and a store still saying *cold* would be printing a
   * readout the keyboard contradicts; a click on the map takes it away again
   * and the same is true in reverse. So the terminal's own focus is watched and
   * written back as temperature.
   *
   * `addEventListener` on the host node rather than React's `onFocus`/`onBlur`:
   * the terminal is **not a child React knows about** — it is appended by
   * `Terminals.bind` — and React's delegated focus events never reach a handler
   * on this element for a node it did not render. That is a landmine, not a
   * style choice; the JSX form silently does nothing. Focus events and never
   * key events: the one key listener in this window is the router's.
   *
   * The state is read at the moment of the event rather than closed over, which
   * is what lets this be installed once for the pane's life. `inFront` matters:
   * a surface standing in front is *expected* to hold the keys, and the run
   * underneath stays warm so dismissing it hands them back rather than putting
   * them down.
   */
  useEffect(() => {
    const held = host.current;
    if (held === null) return;

    const warmed = () => setKeyed(true);
    const cooled = (event: FocusEvent) => {
      // Focus moving *within* the terminal is not the keyboard leaving it.
      const into = event.relatedTarget;
      if (into instanceof Node && held.contains(into)) return;
      /*
       * Answered after the focus has landed, not during it. Mid-`focusout` the
       * document has no focused element at all, so every reading that could
       * tell *the keyboard went to the map* from *the whole window lost focus*
       * says the same thing — and cooling on the second one would put the keys
       * down every time the operator alt-tabbed away, so that coming back left
       * them typing at nobody. A window losing focus moves nobody's keys.
       */
      queueMicrotask(() => {
        if (readUi().inFront !== null) return;
        if (!document.hasFocus()) return;
        if (document.activeElement !== null && held.contains(document.activeElement)) return;
        setKeyed(false);
      });
    };

    held.addEventListener("focusin", warmed);
    held.addEventListener("focusout", cooled);
    return () => {
      held.removeEventListener("focusin", warmed);
      held.removeEventListener("focusout", cooled);
    };
  }, []);

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

    /* Every change to the box, whichever hand moved it: a divider drag, and a
       dock press that takes height off the pane for the node panel. The
       observer cannot tell those apart and does not have to — both are the
       operator's own gesture, and `"drag"` is the occasion that settles into
       exactly one resize. The enumeration is in `src/panes/geometry.ts`. */
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
  const held = useSpill(monitored);
  const spill = spillSentence(held);
  /*
   * Who the words could go to, derived every frame from the readouts this pane
   * already has rather than remembered: the work run beside a parked one can end
   * while its neighbour's chrome is on screen, and a destination kept in state
   * would leave a button offering a run that stopped answering.
   */
  const work = held === null || readout === null ? null : offeredTo(readouts, readout.run);

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

  /*
   * The other press, and the one that moves nothing but the words.
   *
   * It does not re-patch the monitor, does not warm anything and does not end
   * the parked run: the caret is where the operator put it and a hand-off of
   * text is not a decision about where to type next. `typed_at_run` takes any
   * run id, so the sentence lands in the work run's child without the caret ever
   * leaving the run it is parked on — which is the whole reason this can be
   * offered at all under the parking rule.
   *
   * Moving nothing is not something this handler achieves by leaving state
   * alone — the *press* would move the caret on its own. A parked run is warm
   * by the parking rule, so the keys are sitting in xterm's helper textarea; a
   * mouse press that focused the button would take them out of the host node,
   * and the pane's `focusout` watcher above would believe the browser and write
   * that back as cold. So the button refuses the focus (see its `onMouseDown`)
   * and there is nothing to write back: the temperature after the press is the
   * operator's, not the press's.
   *
   * The order is load-bearing in the opposite direction to `end`'s. The register
   * is dropped only after the send has come back, because a register forgotten
   * on a send that threw would be the app losing the sentence it printed a
   * promise about — and the words are unrecoverable at that point, since the
   * child that would have echoed them never got them.
   */
  const offer = async (parked: number, work: number, text: string) => {
    await typedAtRun(work, text);
    forgetSpill(parked);
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
            And where they can go, beside the words themselves. A real button
            for the same reason `End this run` is one — this is a decision and
            the keyboard has to reach it — and in the chrome rather than in the
            host node, which is xterm's. With nobody to offer to there is a
            sentence here instead: never a disabled button, whose reason is
            reachable only by a hover, and never a word about the words being
            gone, which the register beside it would contradict.

            Which sentence is the absence's own. A known folder with no live work
            run in it is a count that came out nought; a run this window was
            never told the folder of is a fact it does not hold, and the two are
            not the same reading — the pick is off `readout.folder` and never off
            `work` alone, which cannot tell them apart.
          */}
          {held === null ? null : work === null ? (
            <span className={styles.unoffered}>
              {readout === null || readout.folder === null ? NO_FOLDER_TO_JOIN : NOWHERE_TO_OFFER}
            </span>
          ) : (
            <button
              type="button"
              className={styles.offer}
              onMouseDown={(event) => {
                /* The press takes the words and not the keys. Focus landing on
                   this button is focus leaving the host node, which the pane
                   reads — correctly — as the keyboard having gone to the map,
                   and a parked run is warm: the offer would cool the very run it
                   was made for, on the one press documented as moving nothing
                   but the words. Defaulting the *press* away is what keeps the
                   caret; the click still fires, and reaching this button by
                   `Tab` still moves the keys, because that one is the operator
                   moving them. */
                event.preventDefault();
              }}
              onClick={() => {
                /* A send that comes back refused leaves the register exactly as
                   it was, and this button beside it: the words are still here to
                   press again, which is the difference between held and lost. */
                offer(readout.run, work.run, held.text).catch(() => {});
              }}
            >
              {offerLabel(work)}
            </button>
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

      {/*
        Where `Esc` goes, beside the terminal and never inside it. One fixed
        line: the sentence changes length as the screen changes, and a strip
        that could wrap would take a row off the terminal's box — a resize
        nobody asked for. #52's ledge at the terminal's edge is where this ends
        up, which is why it is a component of its own and knows nothing about
        this pane. The readouts are the exception and are not pane knowledge
        either: whether the warm run's child has stopped arrives on the poll and
        nowhere else, and it is what keeps this line from naming the agent CLI
        directly above a temperature saying the child is gone. Both lines are
        handed the same array and match the warm run out of it the same way, so
        they answer *is the caret parked* once between them.
      */}
      <EscReadout readouts={readouts} />

      {/*
        And where the keystrokes go, which `Esc` alone stopped being able to
        answer the moment watching and typing became two paths. Beside the Esc
        line and built the same way — one pure function over the router's own
        state — so the two sentences and the key that acts are one reading of
        one fact.
      */}
      <Temperature readouts={readouts} />

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

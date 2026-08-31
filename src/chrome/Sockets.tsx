import { useEffect, useRef, useState } from "react";
import type { FolderReadout } from "../environment/folder";
import type { Frontier, NodeState, Phase } from "../snapshot/model.generated";
import { monitor } from "../stores/ui";
import { recordPrompt } from "../terminal/prompts";
import { monitorRun, type RunReadout } from "../terminal/runs";
import {
  adapterAtPress,
  liveRunOn,
  NO_PICKER,
  picking,
  pressable,
  railAt,
  runningIn,
  sameFrontier,
  type Picking,
  type Press,
  type Socket,
  type SocketId,
  type StartTarget,
} from "./sockets";
import {
  ask,
  composeSpec,
  resumeWorking,
  startWorking,
  type Asked,
  type Composed,
  type Started,
} from "./started";
import styles from "./Sockets.module.css";

interface SocketsProps {
  /** `model.map.frontier`, and the only place the target comes from. */
  frontier: Frontier | null;
  selection: number | null;
  /**
   * What this folder resolved, or `null` while the read is still out. The
   * readout and not its adapters: see `Crossing.environment` for why the
   * difference is the whole point.
   */
  environment: FolderReadout | null;
  folder: string | null;
  /**
   * `model.map.phase` and `model.map.number` — scalars off the model, the way
   * `frontier` is. The rail is chrome and not a view, but it is not handed the
   * snapshot either: what it needs is a named few readings, and a component
   * holding the whole model is one that could go looking for one more.
   */
  phase: Phase | null;
  map: number | null;
  /**
   * The runs this window still shows as going, by id.
   *
   * The one thing the rail needs that the model cannot tell it. A compose takes
   * no assignment and leaves its map on `specReady` for the whole of the run,
   * so the snapshot reads the same during a compose as before one; what a
   * second press would collide with is the run itself, and these ids are the
   * only reading of *still going* this window has. Ids rather than the readouts
   * they came from, for the reason every other prop here is a named scalar: a
   * rail holding the readouts is a rail that could go looking for one more.
   */
  liveRuns: readonly number[];
  /**
   * What the selected node reads on the map, straight off the one derivation.
   * `null` when nothing is selected, and when the selection is not on this map.
   */
  selectionReads: NodeState | null;
  /**
   * Whether the selection is a wayfinder ticket. Beside the state because the
   * derivation reads state alone: an assigned spec node and an assigned
   * unclassified child both read `claimed`, and neither is something to spawn an
   * agent at. See `Crossing.selectionIsTicket`.
   */
  selectionIsTicket: boolean;
  /**
   * Whether the selection is labelled for another machine. The second guard
   * Resume does not inherit, beside the first for the same reason: the
   * derivation reads state alone, so a ticket assigned to the operator and bound
   * elsewhere reads `claimed` here as plainly as any other, and the rail would
   * arm on a press that could only be refused. See `Crossing.selectionBoundElsewhere`.
   */
  selectionBoundElsewhere: boolean;
  /**
   * Every run this window holds, live and finished.
   *
   * Resume reads exactly one thing off them — whether the claim under the hand
   * already has a child running — and it is the run's own `ticket` that makes
   * that join. Nothing is persisted and nothing is reattached: a run that is
   * gone from this list is gone, and Resume spawns a cold one.
   */
  runs: readonly RunReadout[];
  onSelect: (node: number | null) => void;
}

/**
 * What a refusal learned about the frontier, in the one place the two answers
 * have to meet.
 *
 * `Composed` has no `frontier` at all — a compose press was never aimed at a
 * ticket, so there is nothing for one to re-arm on — and *nothing to re-arm on*
 * is exactly what `null` already means to the press. The absence is widened
 * here, on this side of the seam, rather than sent across it as a field that
 * could only ever be null.
 *
 * `Asked` has none for the same reason and one more: an Ask press is aimed at
 * the selection, which no frontier resolver has been through, and the command
 * never asks the map what is takeable. So an Ask refusal re-arms on nothing and
 * its sentence stays under its own socket until the next press answers it. One
 * widening here for every answer that names no frontier, rather than a second
 * helper per verb — the three would only ever say the same thing.
 */
const reArmsOn = (answer: { detail: string; frontier?: Frontier | null }): Frontier | null =>
  answer.frontier ?? null;

/**
 * The crossing, in four sockets.
 *
 * **Chrome, and never a view.** A view is handed `{ model, selected, onSelect }`
 * and nothing else, and this rail needs the folder's environment and a command
 * — so widening that contract to fit it would put the snapshot inside every
 * view's reach for the sake of one rail. It sits beside the Ledger for the same
 * reason and at a fixed address: the four verbs are true of every view.
 *
 * Every word and every fill on screen comes back from `railAt`; the only state
 * here is where the press is and which adapter the hand has picked, and neither
 * survives the window. What this file adds to the derivation is the wiring: two
 * commands, the writes a spawn owes, and the one press that spawns nothing —
 * Resume over a claim this window is already running, which moves the pane.
 *
 * **A press is never silently retargeted.** A refusal prints its sentence and,
 * when it named a frontier, re-arms the button on that number — and then waits.
 * Nothing here retries, and nothing here spawns off the back of a refusal.
 *
 * **And a refusal is retired by the next snapshot that disagrees with it.** The
 * re-arm holds only for as long as the refusal is the newer read; once the
 * poller brings a frontier saying something else, the newer read is the
 * snapshot, and a rail still printing the old number and the old sentence is a
 * screen lying about what is startable. So the incoming prop clears the press.
 */
export function Sockets({
  frontier,
  selection,
  environment,
  folder,
  phase,
  map,
  liveRuns,
  selectionReads,
  selectionIsTicket,
  selectionBoundElsewhere,
  runs,
  onSelect,
}: SocketsProps) {
  const [press, setPress] = useState<Press>({ kind: "idle" });
  const [chosen, setChosen] = useState<string | null>(null);
  /* The compose this window started, kept until the run it names stops being
     one of the live ones — which is the whole of what this side can know about
     a compose being under way, and the same join `Terminals::composing` makes
     in Rust out of the registry and the stakes. The harness is the guard: a
     press made in the beat between the spawn and the readout that first counts
     it is still refused there, in the same sentence this recesses with. */
  const [composed, setComposed] = useState<{ run: number; map: number } | null>(null);
  /* A press outlives the render that made it; an answer landing after this
     rail has gone has nothing left to write to. */
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  /* The retirement. Structural rather than by identity: every poll decodes a
     fresh snapshot, so comparing objects would call every tick a move and drop
     a refusal the map still agrees with — and the immediate re-arm, which lands
     while the prop beside it is still the pre-press read, would not survive its
     own render. A refusal that named no frontier learned nothing to contradict,
     and its sentence stays until the next press answers it. */
  useEffect(() => {
    setPress((current) =>
      current.kind === "refused" &&
      current.frontier !== null &&
      !sameFrontier(current.frontier, frontier)
        ? { kind: "idle" }
        : current,
    );
  }, [frontier]);

  /* The same retirement, on the other thing a press can be aimed at. An Ask
     refusal names no frontier — it was aimed at the selection, which no
     resolver has been through — so the comparison above finds nothing to
     contradict it and leaves it standing. What contradicts it is the selection
     moving off the node the press was about: the sentence answers a press made
     at one node, and under another node it is a sentence about a press nobody
     made. The node the refusal names and not the socket that wears it, because
     an effect can only retire what is already in state: a press still in flight
     when the selection moves writes its refusal after this has run for the last
     time, and no further change is coming to run it again. That one is never
     printed either — `sentenceOn` makes the same comparison at render — and
     this is the half that hands the socket back once the operator moves again.
     The selection is a number, so a tick that reselects the same node is not a
     move and retires nothing. */
  useEffect(() => {
    setPress((current) =>
      current.kind === "refused" && current.node !== null && current.node !== selection
        ? { kind: "idle" }
        : current,
    );
  }, [selection]);

  const composing = composed !== null && liveRuns.includes(composed.run) ? composed.map : null;
  const rail = railAt({
    frontier,
    selection,
    environment,
    folder,
    phase,
    map,
    selectionReads,
    selectionIsTicket,
    selectionBoundElsewhere,
    composing,
    press,
  });
  const adapter = adapterAtPress(rail.adapters, chosen);
  /* Which agent a press goes out with is settled while nothing is going, and
     printed once something is: swapping the adapter under a live run would name
     an agent that is not the one on the pane. The reading is the derivation's;
     this hands it the two facts only the window has. */
  const pick = picking(rail.adapters, chosen, runningIn(runs, liveRuns, folder));

  /* The tail every spawning verb shares, factored so they cannot drift: a spawn
     is a spawn whichever button bought it, and a second copy of these lines is
     a second place for the prompt or the pane binding to go missing from. What
     differs is only the command, what it was aimed at, and which socket wears
     the answer.

     `about` is the node a refusal from this press would be a sentence about,
     read at press time because the selection can move while the command is out
     and the answer belongs to the node the question was asked over. Only the
     verb the selection alone arms names one; the two that re-arm on a fresh
     read pass `null`, because a frontier is what retires those. */
  const spawning = async (
    id: SocketId,
    aim: StartTarget | null,
    about: number | null,
    spawn: () => Promise<Started | Composed | Asked>,
  ) => {
    setPress({ kind: "checking", socket: id });
    const answer = await spawn();
    if (!live.current) return;
    if (answer.kind === "spawned") {
      /* The prompt is told to this side exactly once, on this answer. */
      recordPrompt(answer.run, answer.prompt);
      /* And a compose is remembered by the run it became, so the box that
         spawned it stops offering to spawn another while it is going. One at a
         time is the sub-issue's rule and not the rail's: `wayfinder:spec` is a
         node, and two composes would make it a set. */
      if (aim !== null && aim.kind === "compose") setComposed({ run: answer.run, map: aim.map });
      /* The pane binds what was just started. Rust set its own monitored run
         inside the command, so this is the declaration and not a second one. */
      monitor(answer.run);
      setPress({ kind: "idle" });
      return;
    }
    setPress({
      kind: "refused",
      socket: id,
      detail: answer.detail,
      frontier: reArmsOn(answer),
      node: about,
    });
  };

  /* Which of the two commands the primary socket is was decided by the
     derivation; this presses what it was handed. */
  const start = (aim: StartTarget, at: string, agent: string) => {
    void spawning("start", aim, null, () =>
      aim.kind === "compose" ? composeSpec(at, agent) : startWorking(at, aim.ticket, agent),
    );
  };

  /* Resume reaches a live claim by moving the pane onto it and a stale one by
     spawning — never both, and never a second agent over a child this window is
     already running: one crossing is one pane. The join is the folder and the
     number together, the same pair Rust's `live_run_on` matches on: this window
     holds every folder's runs, and a match on the number alone would move the
     pane onto another repository's agent — silently, because a press that finds
     a live run sends no command and so is never refused. Rust refuses the
     same-folder collision too, for the press that races this one; this is the
     answer that never has to ask for it. */
  const resume = (claim: number, at: string, agent: string) => {
    const already = liveRunOn(runs, claim, at);
    if (already !== null) {
      /* Both sides of the pane, and the harness first. `Runs::frame` emits
         bytes for the one run the harness is monitoring and for no other, so a
         store that moved on its own would bind a terminal nothing is being
         written to — and the ring behind it would go on filling unacknowledged
         until `truncated` flipped and the pane promised a replay that could
         never come. Every other `monitor` on this side is safe because the
         command it followed set Rust's own; this press sends no command, so it
         is the one place the declaration has to be made here. */
      void monitorRun(already).then(() => monitor(already));
      return;
    }
    void spawning("resume", null, null, () => resumeWorking(at, claim, agent));
  };

  const onPress = (socket: Socket) => {
    /* A recessed socket and a socket that is checking both take no press, and
       the second is why this is a guard rather than a `disabled` attribute.
       It is also the only guard: *one command in flight at a time* is a fill
       the derivation computes, so the socket beside the one under the hand is
       recessed with the press named on it rather than left filled and silently
       swallowing the click. To Frontier sends no command and stays pressable. */
    if (!pressable(socket)) return;
    if (socket.id === "toFrontier") {
      if (rail.target !== null) onSelect(rail.target);
      return;
    }
    if (folder === null || adapter === null) return;
    if (socket.id === "start" && rail.start !== null) start(rail.start, folder, adapter);
    if (socket.id === "resume" && rail.claim !== null) resume(rail.claim, folder, adapter);
    /* Aimed at nothing, because `StartTarget` is the primary socket's own
       discrimination — two commands behind one box — and an Ask has none to
       make: one command, over the node the derivation already armed it on. The
       shared tail does the two writes a spawn owes, and its `monitor` is *Ask
       may hold the keys*: Rust bound its own monitored run inside the command,
       so this is the declaration and not a second one. */
    if (socket.id === "ask" && selection !== null) {
      void spawning("ask", null, selection, () => ask(folder, selection, adapter));
    }
  };

  return (
    <div className={styles.rail} role="group" aria-label="what to do at the frontier">
      {rail.sockets.map((socket) => (
        <div
          key={socket.id}
          className={styles.socket}
          data-socket={socket.id}
          data-fill={socket.fill}
        >
          {/*
            `aria-disabled` rather than `disabled`: a recessed socket stays in
            the tab order, because the condition that would fill it is beside it
            and a control nobody can reach is a sentence nobody is read.
          */}
          <button
            type="button"
            className={styles.button}
            aria-disabled={!pressable(socket)}
            aria-busy={socket.fill === "checking"}
            onClick={() => onPress(socket)}
          >
            <span className={styles.verb}>{socket.label}</span>
            {/*
              The number the socket is armed on, spelled on the button itself:
              a re-arm on a frontier that moved is a visible change or it is not
              a re-arm anybody can see.
            */}
            {socket.aimedAt === null ? null : (
              <span className={styles.target}>#{socket.aimedAt}</span>
            )}
          </button>
          {/*
            The condition as visible text, never a `title`. Information behind a
            hover is information a screen and a keyboard cannot have.
          */}
          {socket.condition === null ? null : (
            <p className={styles.condition}>{socket.condition}</p>
          )}
          {socket.note === null ? null : <p className={styles.note}>{socket.note}</p>}
          {socket.id === "start" ? (
            <Picker offered={rail.adapters} picking={pick} onChoose={setChosen} />
          ) : null}
        </div>
      ))}
    </div>
  );
}

/**
 * Which agent this press starts, picked at the crossing.
 *
 * A control when there is a choice, a printed name when there is one adapter
 * and nothing when there is none — the recessed Start Working already says why.
 * Nothing here is persisted: the pick belongs to the press.
 *
 * Exported because the idea box picks an adapter for exactly the same reason
 * and in exactly the same way. A second picker would be a second answer to
 * *which agent* on one screen, in a second shape.
 */
export function Picker({
  offered,
  picking: pick,
  onChoose,
}: {
  offered: readonly string[];
  picking: Picking;
  onChoose: (id: string) => void;
}) {
  if (pick.mode === "none") return null;
  if (pick.mode === "printed") {
    return (
      <div className={styles.adapter} data-picker data-picker-fixed={pick.fixed ?? undefined}>
        <p className={styles.adapterName}>{pick.chosen}</p>
        {/*
          Why it cannot be changed, as visible text under the name and never a
          `title`: a run is up, or this folder resolved only the one CLI. A
          hover is not something a screen reader or a keyboard can have, and the
          palette sends a keyboard here.
        */}
        {pick.fixed === null ? null : <p className={styles.fixed}>{pick.fixed}</p>}
      </div>
    );
  }
  return (
    <label className={styles.adapter}>
      <span className={styles.adapterLabel}>agent</span>
      <select
        className={styles.picker}
        data-picker
        value={pick.chosen ?? ""}
        onChange={(event) => onChoose(event.target.value)}
      >
        {offered.map((id) => (
          <option key={id} value={id}>
            {id}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Put the keyboard on the picker, or say why it cannot go there.
 *
 * The palette's answer to *which agent* is **this** control and never a menu of
 * its own: two pickers on one screen would be two answers to one question, and
 * the one the press actually reads is this one. The hook is a `data-picker`
 * attribute rather than a store field because the picker is rendered wherever
 * the rail is, and the palette is chrome that outlives every one of its
 * positions — a ref threaded through the shell would be a second wiring for the
 * same seam.
 *
 * A picker that has been printed rather than offered carries its reason on the
 * element, so the sentence the palette prints and the sentence on screen are the
 * one sentence. The first *changeable* one wins: the idea box picks an adapter
 * in the same shape and for the same reason, and a keyboard sent to a control
 * that cannot be changed has been sent nowhere.
 *
 * It does *not* clear an `inert` standing over the picker, and it cannot see
 * one: `querySelector` reaches into an inert subtree and `focus()` on a node in
 * one moves nothing while still returning. Whoever put the mark on takes it off
 * before calling this — the shell does, in `reachPicker` — because the element
 * carrying it is the caller's and never this function's to find.
 */
export function focusPicker(): string | null {
  const changeable = document.querySelector<HTMLElement>("[data-picker]:not([data-picker-fixed])");
  if (changeable !== null) {
    changeable.focus();
    return null;
  }
  const printed = document.querySelector<HTMLElement>("[data-picker]");
  return printed?.getAttribute("data-picker-fixed") ?? NO_PICKER;
}

import { useEffect, useRef, useState } from "react";
import type { FolderReadout } from "../environment/folder";
import type { Frontier, Phase } from "../snapshot/model.generated";
import { monitor } from "../stores/ui";
import { recordPrompt } from "../terminal/prompts";
import {
  adapterAtPress,
  pressable,
  railAt,
  sameFrontier,
  type Press,
  type Socket,
  type StartTarget,
} from "./sockets";
import { composeSpec, startWorking } from "./started";
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
 * survives the window. What this file adds to the derivation is the wiring: one
 * command, and the two writes a spawn owes.
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

  const composing = composed !== null && liveRuns.includes(composed.run) ? composed.map : null;
  const rail = railAt({
    frontier,
    selection,
    environment,
    folder,
    phase,
    map,
    composing,
    press,
  });
  const adapter = adapterAtPress(rail.adapters, chosen);

  /* Which of the two commands this is was decided by the derivation; what is
     here is the wiring both of them share, because a spawn owes the same two
     writes whichever button spelled it. */
  const start = async (aim: StartTarget) => {
    if (folder === null || adapter === null) return;
    setPress({ kind: "checking" });
    const answer =
      aim.kind === "compose"
        ? await composeSpec(folder, adapter)
        : await startWorking(folder, aim.ticket, adapter);
    if (!live.current) return;
    if (answer.kind === "spawned") {
      /* The prompt is told to this side exactly once, on this answer. */
      recordPrompt(answer.run, answer.prompt);
      /* And a compose is remembered by the run it became, so the box that
         spawned it stops offering to spawn another while it is going. One at a
         time is the sub-issue's rule and not the rail's: `wayfinder:spec` is a
         node, and two composes would make it a set. */
      if (aim.kind === "compose") setComposed({ run: answer.run, map: aim.map });
      /* The pane binds what was just started. Rust set its own monitored run
         inside the command, so this is the declaration and not a second one. */
      monitor(answer.run);
      setPress({ kind: "idle" });
      return;
    }
    setPress({ kind: "refused", detail: answer.detail, frontier: reArmsOn(answer) });
  };

  const onPress = (socket: Socket) => {
    // A recessed socket and a socket that is checking both take no press, and
    // the second is why this is a guard rather than a `disabled` attribute.
    if (!pressable(socket)) return;
    if (socket.id === "start" && rail.start !== null) void start(rail.start);
    if (socket.id === "toFrontier" && rail.target !== null) onSelect(rail.target);
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
            <Picker offered={rail.adapters} chosen={adapter} onChoose={setChosen} />
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
  chosen,
  onChoose,
}: {
  offered: readonly string[];
  chosen: string | null;
  onChoose: (id: string) => void;
}) {
  if (chosen === null) return null;
  if (offered.length === 1) {
    return <p className={styles.adapter}>{chosen}</p>;
  }
  return (
    <label className={styles.adapter}>
      <span className={styles.adapterLabel}>agent</span>
      <select
        className={styles.picker}
        value={chosen}
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

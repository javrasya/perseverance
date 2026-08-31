import { useEffect, useRef, useState } from "react";
import type { AdapterReading } from "../environment/folder";
import type { Frontier } from "../snapshot/model.generated";
import { monitor } from "../stores/ui";
import { recordPrompt } from "../terminal/prompts";
import {
  adapterAtPress,
  pressable,
  railAt,
  type Press,
  type Socket,
} from "./sockets";
import { startWorking } from "./started";
import styles from "./Sockets.module.css";

/** The two sockets that act on a number, and so print the one they are on. */
function aimed(socket: Socket): boolean {
  return socket.id === "start" || socket.id === "toFrontier";
}

interface SocketsProps {
  /** `model.map.frontier`, and the only place the target comes from. */
  frontier: Frontier | null;
  selection: number | null;
  /** What this folder resolved. Only a resolved reading is offerable. */
  adapters: readonly AdapterReading[];
  folder: string | null;
  onSelect: (node: number | null) => void;
}

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
 */
export function Sockets({ frontier, selection, adapters, folder, onSelect }: SocketsProps) {
  const [press, setPress] = useState<Press>({ kind: "idle" });
  const [chosen, setChosen] = useState<string | null>(null);
  /* A press outlives the render that made it; an answer landing after this
     rail has gone has nothing left to write to. */
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const rail = railAt({ frontier, selection, adapters, folder, press });
  const adapter = adapterAtPress(rail.adapters, chosen);

  const start = async (target: number) => {
    if (folder === null || adapter === null) return;
    setPress({ kind: "checking" });
    const answer = await startWorking(folder, target, adapter);
    if (!live.current) return;
    if (answer.kind === "spawned") {
      /* The prompt is told to this side exactly once, on this answer. */
      recordPrompt(answer.run, answer.prompt);
      /* The pane binds what was just started. Rust set its own monitored run
         inside the command, so this is the declaration and not a second one. */
      monitor(answer.run);
      setPress({ kind: "idle" });
      return;
    }
    setPress({ kind: "refused", detail: answer.detail, frontier: answer.frontier });
  };

  const onPress = (socket: Socket) => {
    // A recessed socket and a socket that is checking both take no press, and
    // the second is why this is a guard rather than a `disabled` attribute.
    if (!pressable(socket) || rail.target === null) return;
    if (socket.id === "start") void start(rail.target);
    if (socket.id === "toFrontier") onSelect(rail.target);
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
            {aimed(socket) && rail.target !== null ? (
              <span className={styles.target}>#{rail.target}</span>
            ) : null}
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
 */
function Picker({
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

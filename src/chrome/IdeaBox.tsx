import { useId, useRef, useState, useEffect } from "react";
import type { FolderReadout } from "../environment/folder";
import type { RunReadout } from "../terminal/runs";
import { monitor } from "../stores/ui";
import { recordPrompt } from "../terminal/prompts";
import { startCharting } from "./charting";
import {
  CHART_LABEL,
  IDEA_LABEL,
  boxAt,
  ideaAtPress,
  pressable,
  type ChartPress,
} from "./idea";
import { adapterAtPress, CHECKING_LABEL } from "./sockets";
/* `Sockets.jsx` and not `Sockets`: on a case-insensitive filesystem the
   extensionless specifier resolves to `sockets.ts`, the derivation. */
import { Picker } from "./Sockets.jsx";
import styles from "./IdeaBox.module.css";

interface IdeaBoxProps {
  /** The folder the run is started in, or `null` when none is open. */
  folder: string | null;
  /**
   * What this folder resolved, or `null` while the read is still out. The
   * readout and not its adapters, for `Charting.environment`'s reason.
   */
  environment: FolderReadout | null;
  /**
   * Every run the harness is reporting, the same array the pane is given. The
   * box reads exactly one bit out of it — whether the run its own press
   * started is over — and `idea.ts` does that reading.
   */
  readouts: readonly RunReadout[];
}

/**
 * Type an idea, get a charting session.
 *
 * It sits inside the map list's *no map in this repository* absence, under the
 * copy that already says a charting session which leaves no map behind is that
 * session working correctly — so the pre-absolution is read before the press
 * rather than offered after a run comes back empty. That placement is the whole
 * argument for the box not being a fifth socket on the rail.
 *
 * The press carries its own adapter, resolved against this folder's readout by
 * the same two functions the rail uses, and nothing here is persisted: the pick
 * belongs to the press.
 *
 * **The press retires itself.** A charting run that leaves no map behind never
 * unmounts this box, so the readouts arrive for one purpose: once the run a
 * press started is over, the box is pressable again and the *already running*
 * sentence goes. Nothing here decides that — the box is handed the runs and
 * `idea.ts` reads them.
 *
 * **Nothing is registered afterwards.** A map the run creates carries the map
 * label and arrives on an ordinary poll, at the cadence the ladder decided, so
 * a successful press invokes `start_charting` and nothing else — no refresh, no
 * registration, and no row added to the list by this side.
 */
export function IdeaBox({ folder, environment, readouts }: IdeaBoxProps) {
  const [idea, setIdea] = useState("");
  const [chosen, setChosen] = useState<string | null>(null);
  const [press, setPress] = useState<ChartPress>({ kind: "idle" });
  const field = useId();
  /* A press outlives the render that made it; an answer landing after this box
     has gone has nothing left to write to. */
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const box = boxAt({ folder, environment, readouts, idea, press });
  const adapter = adapterAtPress(box.adapters, chosen);

  const chart = async () => {
    if (folder === null || adapter === null) return;
    setPress({ kind: "checking" });
    const answer = await startCharting(folder, ideaAtPress(idea), adapter);
    if (!live.current) return;
    if (answer.kind === "spawned") {
      /* The prompt is told to this side exactly once, on this answer, and
         recorded rather than rendered here: the collapsed block belongs to the
         pane that shows the run, and a second renderer would be a second
         account of the text and the count that diagnose a misbehaving run. */
      recordPrompt(answer.run, answer.prompt);
      /* The pane binds what was just started. Rust bound its own monitored run
         inside the command, so this is the declaration and not a second one. */
      monitor(answer.run);
      setPress({ kind: "spawned", run: answer.run });
      return;
    }
    setPress({ kind: "refused", detail: answer.detail });
  };

  return (
    <div className={styles.box} data-fill={box.fill}>
      <label className={styles.label} htmlFor={field}>
        {IDEA_LABEL}
      </label>
      <textarea
        id={field}
        className={styles.idea}
        rows={3}
        value={idea}
        onChange={(event) => setIdea(event.target.value)}
      />
      {/*
        `aria-disabled` rather than `disabled`, exactly as on the rail: a
        recessed control stays in the tab order, because the condition that
        would fill it is beside it and a control nobody can reach is a sentence
        nobody is read. `checking…` is a word and not a movement.
      */}
      <button
        type="button"
        className={styles.button}
        aria-disabled={!pressable(box)}
        aria-busy={box.fill === "checking"}
        onClick={() => {
          if (pressable(box)) void chart();
        }}
      >
        {box.fill === "checking" ? CHECKING_LABEL : CHART_LABEL}
      </button>
      <Picker offered={box.adapters} chosen={adapter} onChoose={setChosen} />
      {/*
        The condition as visible text, never a `title`. Information behind a
        hover is information a screen and a keyboard cannot have.
      */}
      {box.condition === null ? null : (
        <p className={styles.condition}>{box.condition}</p>
      )}
      {/* What the harness said, verbatim and beside the box that said it. */}
      {box.note === null ? null : <p className={styles.note}>{box.note}</p>}
    </div>
  );
}

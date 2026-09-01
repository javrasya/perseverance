import {
  useCallback,
  useEffect,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";
import { watchDroppedFolders } from "../launcher/launcher";
import styles from "./DropRegion.module.css";

/**
 * What the region is, said in the document rather than left to the border.
 *
 * The dashed frame is a shape, and a shape is not a sentence: without this a
 * reader has to drag something to find out what the body does with it.
 */
export const DROP_REGION_HINT =
  "A folder dropped anywhere in here joins the list, the same as one picked through Open a new folder… It is the folder that is dropped, not the maps inside it.";

interface DropRegionProps {
  /** Every folder dropped on the window, in the order the shell reports them. */
  onFoldersDropped: (paths: readonly string[]) => void;
  /**
   * Whether anything else is drawn on the same line as this region.
   *
   * The shell draws the launcher beside the view rather than in place of it,
   * and the two used to grow on equal terms — both `flex: 1` on one line, so
   * the pixels split down the middle however much the view needed and however
   * little the list did. That contradicts `COLUMN_FLOORS`'s own stated
   * priority, where the view is shed *last* because it is the reason the map
   * side exists at all, and it is what left Deep Field standing itself down at
   * every dial position on a 1280px window.
   *
   * So the region asks for a column when it has company and for the whole side
   * when it is alone: with no map open there is nothing beside it and a launcher
   * hemmed into a column would be dead space where the only thing on screen is
   * the list. A column with a basis is not a column that disappeared, which is
   * the whole of what #48 asks of this region.
   */
  beside?: boolean;
  children: ReactNode;
}

/**
 * The body is a drop region.
 *
 * A dropped folder becomes a launcher entry exactly as a picked one does: this
 * is a second door onto *Open a new folder*, not a second feature. The whole
 * body is the target and it says so before anything is dragged, rather than
 * revealing itself only once a drag is already in flight.
 *
 * The shell reports the drop rather than the DOM. A webview swallows a file
 * drop before any `drop` event reaches an element, and the path of a dropped
 * folder is something only the Rust side is ever told — so the arming below
 * comes from Tauri in the app, and the DOM handlers are what is left for
 * `dev:web`, where they stop the browser navigating away to whatever was
 * dropped on it.
 */
export function DropRegion({ onFoldersDropped, beside = false, children }: DropRegionProps) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    let live = true;
    let stop: () => void = () => {};

    watchDroppedFolders({ onArmed: setArmed, onDropped: onFoldersDropped }).then(
      (off) => {
        if (live) {
          stop = off;
        } else {
          off();
        }
      },
    );

    return () => {
      live = false;
      stop();
    };
  }, [onFoldersDropped]);

  const onDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setArmed(true);
  }, []);

  const onDragLeave = useCallback(() => setArmed(false), []);

  const onDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setArmed(false);
  }, []);

  return (
    <div
      className={styles.region}
      data-armed={armed ? "true" : "false"}
      data-beside={beside ? "true" : "false"}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {children}
      <p className={styles.hint}>{DROP_REGION_HINT}</p>
    </div>
  );
}

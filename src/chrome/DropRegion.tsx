import {
  useCallback,
  useEffect,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";
import { watchDroppedFolders } from "../launcher/launcher";
import styles from "./DropRegion.module.css";

interface DropRegionProps {
  /** Every folder dropped on the window, in the order the shell reports them. */
  onFoldersDropped: (paths: readonly string[]) => void;
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
export function DropRegion({ onFoldersDropped, children }: DropRegionProps) {
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
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {children}
    </div>
  );
}

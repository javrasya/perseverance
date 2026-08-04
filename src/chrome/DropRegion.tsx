import { useCallback, useState, type DragEvent, type ReactNode } from "react";
import styles from "./DropRegion.module.css";

interface DropRegionProps {
  children: ReactNode;
}

/**
 * The body is a drop region.
 *
 * Accepting the folder is #30's work; what is settled here is that the whole
 * body is the target and that it says so before anything is dragged, rather
 * than revealing itself only once a drag is already in flight.
 */
export function DropRegion({ children }: DropRegionProps) {
  const [armed, setArmed] = useState(false);

  const onDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setArmed(true);
  }, []);

  const onDragLeave = useCallback(() => setArmed(false), []);

  const onDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setArmed(false);
    // #30 turns a dropped folder into a launcher entry. Until then the region
    // exists and does nothing, which is honest chrome rather than a dead hint.
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

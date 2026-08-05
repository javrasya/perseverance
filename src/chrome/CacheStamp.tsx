import { describeStamp, stampDetail, type MapsView } from "../maps/maps";
import styles from "./CacheStamp.module.css";

interface CacheStampProps {
  view: MapsView;
  /** Epoch seconds, read once per paint rather than by the stamp itself. */
  now: number;
}

/**
 * How old what you are reading is.
 *
 * It lives on chrome that survives every state, because the moment it becomes
 * conditional is the moment a stale screen can look fresh. That is also why it
 * has no empty state: before anything has been read it says so, rather than
 * being absent and leaving the question unasked.
 *
 * A read that did not land ages this stamp and says so beside it. It does not
 * replace the age — a failure that took the age away would stop telling you how
 * stale the screen is at exactly the point that started mattering.
 */
export function CacheStamp({ view, now }: CacheStampProps) {
  const detail = stampDetail(view);

  return (
    <span
      className={styles.stamp}
      data-source={view.provenance.source}
      data-outcome={view.provenance.outcome.kind}
      title={detail ?? undefined}
    >
      {describeStamp(view, now)}
    </span>
  );
}

import type { Provenance } from "../snapshot/model.generated";
import styles from "./CacheStamp.module.css";
import { describeStamp, stampDetail } from "./stamp";

interface CacheStampProps {
  /**
   * What was read. Two stamps sit side by side and can carry the same words —
   * the map list and the model are usually read within moments of each other —
   * so an unnamed stamp is one the reader has to guess the subject of.
   */
  what: string;
  provenance: Provenance;
  /** Epoch seconds, read once per paint rather than by the stamp itself. */
  now: number;
  /**
   * Whether the poller is holding itself back to leave the rate limit alone.
   *
   * Optional, and absent means *no*. Only the map list has a poller behind it,
   * so the model's stamp never passes one — an optional prop is what lets the
   * two stamps stay one component without the model's inventing an answer to a
   * question nothing has asked it.
   */
  yielding?: boolean;
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
 *
 * It takes a `Provenance` and not the thing the provenance came with, so the
 * map list and the derived model are stamped by one component rather than two
 * that could come to disagree. Each thing on screen that was read gets its own,
 * because they are read by different commands and go stale independently.
 */
export function CacheStamp({ what, provenance, now, yielding }: CacheStampProps) {
  const detail = stampDetail(provenance);

  return (
    <span
      className={styles.stamp}
      data-source={provenance.source}
      data-outcome={provenance.outcome.kind}
      title={detail ?? undefined}
    >
      {what} {describeStamp(provenance, now, yielding)}
    </span>
  );
}

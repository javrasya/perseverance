import type { Provenance } from "../snapshot/model.generated";
import styles from "./CacheStamp.module.css";
import { CONDITIONS, REMEDY, describeStamp, stampDetail, stampReason } from "./stamp";

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
 * **A condition renders here and nowhere else in the chrome: no modal, no
 * toast.** A harness read failure is a fact about how old the screen is, and a
 * modal is a thing that interrupts you to be dismissed. So the stamp goes
 * dashed and hatched, the age goes on ageing, and the reason prints as text
 * beside it — as *text*, not only in `title=`, because #28 story 24 asks for a
 * reason that is visible rather than one behind a hover.
 *
 * **Both halves of the reason are text: the condition and the sentence.** The
 * condition is this app's conclusion about whether waiting helps, and it is a
 * class name rather than a diagnosis — `unreachable` covers a dead network, a
 * folder that is not a git repository and a folder whose remotes name nothing
 * on GitHub, and its name in `CONDITIONS` says only that much. Printing only
 * that would put a claim on permanent
 * chrome that is false for most of what it classifies, which is what #28 story
 * 7 asks not to happen. So the refusing crate's own sentence prints beside it,
 * unedited. The `title` keeps the same sentence, for a stamp narrow enough to
 * have wrapped it out of easy reading.
 *
 * It takes a `Provenance` and not the thing the provenance came with, so the
 * map list and the derived model are stamped by one component rather than two
 * that could come to disagree. Each thing on screen that was read gets its own,
 * because they are read by different commands and go stale independently.
 */
export function CacheStamp({ what, provenance, now, yielding }: CacheStampProps) {
  const detail = stampDetail(provenance);
  const degraded = stampReason(provenance);
  const remedy = degraded === null ? null : REMEDY[degraded.reason];

  return (
    <span
      className={styles.stamp}
      data-source={provenance.source}
      data-outcome={provenance.outcome.kind}
      /* The condition, for the vocabulary in the stylesheet to key on. Absent
         rather than empty when the last read landed: there is no condition,
         which is a different thing from a condition with no name. */
      data-degraded={degraded?.reason}
      title={detail ?? undefined}
    >
      {what} {describeStamp(provenance, now, yielding)}
      {degraded === null ? null : (
        <span className={styles.condition}> · {CONDITIONS[degraded.reason]}</span>
      )}
      {/* The sentence the refusing crate wrote, as text and not only in
          `title=`. The condition beside it is this app's conclusion about
          whether waiting helps, and it is short enough to be no more than that:
          four conditions cover eleven refusals between them, and `unreachable`
          alone covers a dead network, a folder that is not a git repository and
          a folder whose remotes name nothing on GitHub. #28 story 7 asks for
          those to be tellable apart, and this line is where they are — a
          condition name is a class, and only the detail says which member. */}
      {detail === null ? null : <span className={styles.detail}> — {detail}</span>}
      {/* Only the auth case has one, and it is the whole point of telling the
          conditions apart: an operator watching a stamp age assumes a flaky
          network, and the fix was one line all along. */}
      {remedy === null ? null : <span className={styles.remedy}> · {remedy}</span>}
    </span>
  );
}

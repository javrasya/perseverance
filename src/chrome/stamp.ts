/**
 * How old what you are reading is, in words.
 *
 * It lives in `chrome/` next to `age.ts` and for the same stated reason: more
 * than one feature needs it, and one phrasing for all of them means *from the
 * last read* cannot come to mean two different things on one screen. The map
 * list has carried a stamp since it existed; the derived model now carries one
 * too, and both are stamped from the same generated [`Provenance`] — so a
 * screen showing a stale map beside a stale model says so the same way twice.
 *
 * Every function here takes the provenance itself rather than whatever is
 * wrapped around it. Nothing about the wording depends on what was read, only
 * on where it came from and whether the last attempt landed.
 */

import type { Provenance } from "../snapshot/model.generated";
import { relativeAge, secondsFromStamp } from "./age";

/**
 * How old what you are reading is, permanently on screen.
 *
 * Three states and no fourth: never read, read from GitHub, read from a copy.
 * A failed read does not get a state of its own here — it ages the stamp of
 * whatever is being shown, which is the copy.
 */
export function stampAge(provenance: Provenance, now?: number): string {
  const at = secondsFromStamp(provenance.fetchedAt);
  if (at === null) return "not read yet";
  return relativeAge(at, now);
}

export function stampSource(provenance: Provenance): string {
  switch (provenance.source) {
    case "github":
      return "read from GitHub";
    case "cache":
      return "from the last read";
    case "fixture":
      return "from a checked-in fixture";
    case "none":
      return "nothing read";
  }
}

/**
 * The whole stamp, as one sentence.
 *
 * A failure keeps saying how old the copy is rather than replacing it, because
 * a stamp that swapped the age for an error would stop reporting staleness at
 * exactly the moment staleness started mattering.
 *
 * What the failure clause may *not* do is assert which step failed. A read that
 * landed and could not be stored, a read that was never attempted because the
 * folder names no GitHub repository, and a read that could not reach anything
 * all arrive here as the same shape — telling them apart is #40's ticket, and a
 * clause that guessed would be wrong in two cases out of three. So the two
 * clauses say only what is true of the thing on screen: a live read that will
 * not survive the session, or a copy that nothing newer has replaced. The
 * reason itself rides beside this, in the words of whoever established it.
 */
export function describeStamp(provenance: Provenance, now?: number): string {
  const failed = provenance.outcome.kind === "failed";

  if (provenance.source === "none") {
    return failed ? "nothing read yet — nothing newer has arrived" : "nothing read yet";
  }

  const said = `${stampSource(provenance)} ${stampAge(provenance, now)}`;
  if (!failed) return said;
  return provenance.source === "github"
    ? `${said} — not stored for next time`
    : `${said} — nothing newer has arrived`;
}

/** The reason a read did not land, in the words of whoever established it. */
export function stampDetail(provenance: Provenance): string | null {
  return provenance.outcome.kind === "failed" ? provenance.outcome.detail : null;
}

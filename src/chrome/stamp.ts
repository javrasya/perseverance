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

import type { Degraded, Provenance } from "../snapshot/model.generated";
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
 * What the failure clause may *not* do is assert which step failed, and that is
 * unchanged now that the condition crosses. A read that landed and could not be
 * stored, a read that was never attempted because the folder names no GitHub
 * repository, and a read that could not reach anything are three different
 * things and all three are `unreachable`: the taxonomy answers *is waiting
 * going to help*, which is a different question from *what went wrong*. So
 * these two clauses go on saying only what is true of the thing on screen — a
 * live read that will not survive the session, or a copy that nothing newer has
 * replaced — and the reason itself is [`stampReason`], rendered beside them
 * with the detail in the words of whoever established it.
 *
 * The first of the two is the **map list's alone**, and by construction rather
 * than by a branch here: a live read whose cache row would not write is the one
 * way `github` and a failure meet, and `Snapshot::aged` downgrades the source
 * on the model's side precisely so a poll that never landed cannot borrow that
 * sentence. Nothing is keyed on which surface is calling — this reads the
 * provenance it is handed — which is what keeps one phrasing across both.
 *
 * `yielding` is the poller slowing itself down to leave the rate limit alone.
 * It is Rust's answer to *is the budget the winning term of the interval's
 * max*, arriving already decided on the map-list payload: there is no reserve
 * on this side to compare against, no `resetAt` to subtract from anything, and
 * no notion of which floor won — so the clause paints a state rather than
 * concluding one.
 *
 * It describes **the state and not the adjustment** (#28 story 109). The
 * interval moves on every poll and a clause carrying the number would narrate
 * every one of them, so it names no duration and no count, and reads the same
 * whether the poller is merely stretched or stopped at the reserve.
 *
 * Which is also why it says *paced against* rather than *waiting for the reset*.
 * The budget wins the max the moment it beats the rung it is over — an hour and
 * a hundred and nineteen points from the reserve, that is a sixty-one-second
 * interval, and a clause announcing a reset there would be describing the far
 * end of the curve from most of the curve. One sentence has to be true at both
 * ends of it. It is additive, exactly as the failure clause is, because a slowed
 * poller is the moment a screen goes quietly old and the age is what says so.
 *
 * A failure wins when both would apply, and by construction rather than by an
 * ordering somebody has to keep: the failed branches return before this clause
 * is reached. Two reasons on one stamp is a sentence nobody parses, and of the
 * two the failure is the one about what is on screen — the budget is about what
 * comes next.
 */
export function describeStamp(
  provenance: Provenance,
  now?: number,
  yielding = false,
): string {
  const failed = provenance.outcome.kind === "failed";

  if (provenance.source === "none") {
    return failed ? "nothing read yet — nothing newer has arrived" : "nothing read yet";
  }

  const said = `${stampSource(provenance)} ${stampAge(provenance, now)}`;
  if (failed) {
    return provenance.source === "github"
      ? `${said} — not stored for next time`
      : `${said} — nothing newer has arrived`;
  }
  return yielding ? `${said} — paced against your rate limit` : said;
}

/** The reason a read did not land, in the words of whoever established it. */
export function stampDetail(provenance: Provenance): string | null {
  return provenance.outcome.kind === "failed" ? provenance.outcome.detail : null;
}

/**
 * What the app concluded about the read, as the structure Rust decided it in.
 *
 * `null` when the last read landed. This is never derived here: which condition
 * a failure is gets decided once, in `perseverance-github`, from a status, a
 * header and GitHub's own error `type` — none of which crosses the seam. What
 * this side does with it is paint.
 */
export function stampReason(provenance: Provenance): Degraded | null {
  return provenance.outcome.kind === "failed" ? provenance.outcome.reason : null;
}

/**
 * How a condition reads on screen, in the app's own words.
 *
 * Short, because it sits beside an age on one line of chrome and the sentence
 * that says what actually happened is rendered next to it — see [`stampDetail`]
 * and the `detail` span in `CacheStamp`.
 *
 * *The read did not land* is deliberately not a diagnosis. `unreachable`
 * classifies five things that never reached a socket as well as a dead network:
 * an unopenable registry, a folder id nothing answers to, a folder with no
 * usable `.git`, a folder whose remotes name nothing on GitHub, and a cache row
 * that could not be written. What all of those share is the only thing this
 * table may claim — that waiting is worth doing — and the earlier wording,
 * *could not reach GitHub*, asserted a network failure over a folder that is
 * simply not a GitHub repository. #28 story 7 asks for an unusable repo to say
 * exactly what is wrong so it can be told apart from *cannot reach GitHub*, and
 * what says it is the refusing crate's own sentence beside this name.
 *
 * The other three name what GitHub itself answered, which is a claim their
 * conditions can carry.
 */
export const CONDITIONS: Record<Degraded["reason"], string> = {
  unreachable: "the read did not land",
  authFailed: "GitHub would not accept this token",
  mapGone: "GitHub says this is not there",
  rateLimited: "GitHub asked for a pause",
};

/**
 * The one command that fixes it, or `null` where there is no command.
 *
 * Only the auth case has one, and it is the whole reason the taxonomy exists:
 * an operator watching a stamp age assumes a flaky network, and the fix was one
 * line all along. Every other condition either fixes itself or needs a decision
 * rather than a command — inventing a remedy for those would be this app
 * telling somebody to do something nobody established would work.
 */
export const REMEDY: Record<Degraded["reason"], string | null> = {
  unreachable: null,
  authFailed: "run gh auth login",
  mapGone: null,
  rateLimited: null,
};

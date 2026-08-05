/**
 * How long ago something happened, in words.
 *
 * It lives in `chrome/` rather than in either of the two features that need it
 * because both do: the launcher says when you were last in a folder, and the
 * cache stamp says how old what you are reading is. One phrasing for both means
 * *2 minutes ago* cannot come to mean two different things on one screen.
 */

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Seconds since the epoch, from the RFC 3339 text Rust stamps everything with.
 *
 * `null` for anything unparseable, which is the same answer as *never stamped*
 * — and a caller that has to handle the absence anyway gains nothing from a
 * second way of spelling it.
 */
export function secondsFromStamp(stamp: string | null): number | null {
  if (stamp === null) return null;
  const parsed = Date.parse(stamp);
  return Number.isNaN(parsed) ? null : Math.floor(parsed / 1000);
}

/**
 * The coarsest unit that is still true.
 *
 * A clock that has gone backwards reads as *just now* rather than as the
 * future, because neither a launcher row nor a cache stamp is the place to
 * argue about time.
 */
export function relativeAge(since: number, now: number = nowSeconds()): string {
  const seconds = Math.max(0, Math.floor(now - since));
  if (seconds < MINUTE) return "just now";
  if (seconds < HOUR) return counted(Math.floor(seconds / MINUTE), "minute");
  if (seconds < DAY) return counted(Math.floor(seconds / HOUR), "hour");
  if (seconds < WEEK) return counted(Math.floor(seconds / DAY), "day");
  if (seconds < 5 * WEEK) return counted(Math.floor(seconds / WEEK), "week");
  if (seconds < 365 * DAY) {
    return counted(Math.min(11, Math.floor(seconds / (30 * DAY))), "month");
  }
  return counted(Math.floor(seconds / (365 * DAY)), "year");
}

function counted(amount: number, unit: string): string {
  return `${amount} ${unit}${amount === 1 ? "" : "s"} ago`;
}

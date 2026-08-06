/**
 * The clock every age on screen is measured against.
 *
 * It exists because *the stamp visibly ages* has to be true of a window nothing
 * is arriving into. Until #40 the ages were re-read incidentally: a failing
 * poller kept emitting, every emit re-rendered, and the stamp advanced as a
 * side effect of the read that failed. Two of #40's conditions stop the poller
 * outright — `AuthFailed` and `MapGone` answer `Floor::Never`, `next_wake`
 * answers `Wake::WhenPoked`, and the loop blocks on the channel — so on exactly
 * the two screens the taxonomy is about, nothing would ever re-render again and
 * the stamp would freeze on *just now* while asserting that freshness for the
 * rest of the session.
 *
 * So the ageing is this side's, not the poller's, and it cannot be switched off
 * by anything Rust decides. One interval for the window rather than one per
 * stamp: two stamps and a folder list all read the same second, and three
 * clocks would be three answers to *how long ago* on one screen.
 */

import { useEffect, useState } from "react";
import { nowSeconds } from "./age";

/**
 * Half of the smallest unit [`relativeAge`] can say.
 *
 * Every bucket that function names is at least a minute wide, so a tick at half
 * that can never skip one, and the words are never more than thirty seconds
 * behind the truth. Faster would re-render the window for a sentence that has
 * not changed; slower would let *just now* outlive its own minute.
 */
const TICK_MS = 30_000;

/** Epoch seconds, re-read on its own, for as long as the window is open. */
export function useNow(): number {
  const [now, setNow] = useState(nowSeconds);

  useEffect(() => {
    const timer = setInterval(() => setNow(nowSeconds()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  return now;
}

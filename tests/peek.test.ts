// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { fractionOf, sides } from "../src/panes/dial";
import {
  CLEARED_ROWS,
  NOTHING_TO_GIVE,
  PROMPT_ROWS,
  REPEAT_GAP,
  RESTING,
  ROW_HEIGHT,
  advance,
  available,
  chordChoices,
  chordFor,
  clearance,
  labelOf,
  matches,
  peekWidth,
  readChord,
  writeChord,
  type Chord,
  type Peek,
  type PeekEvent,
} from "../src/panes/peek";

/**
 * The spring, without a window.
 *
 * The releases are the highest-value claims in this file, and they are the ones
 * a real window will not reproduce on demand: a blur mid-hold, a repeat that
 * stopped arriving, a pointer that wandered off the stud. Written as policy over
 * an event sequence, every one of them is a two-line assertion instead of a
 * focus-stealing test that only fails on someone else's machine.
 */

/** Hold the spring down from a dial that has room to give. */
function held(source: "chord" | "stud" = "chord", at = 1_000): Peek {
  return advance(
    RESTING,
    source === "chord"
      ? { kind: "chord", at, position: fractionOf("split") }
      : { kind: "stud", position: fractionOf("split") },
  );
}

/**
 * The same hold, heard to auto-repeat: a second keydown for a key already down.
 * On platforms that send repeats this is what arms the repeat gap; on macOS,
 * where ⌘-modified keys never repeat, it never arrives.
 */
function repeating(at = 1_000): Peek {
  return advance(held("chord", at), { kind: "chord", at, position: fractionOf("split") });
}

describe("what holds the spring", () => {
  it("peeks from any position that is not already map width", () => {
    expect(held().held).toBe("chord");
    expect(held("stud").held).toBe("stud");
    expect(held().refused).toBeNull();
  });

  it("marks the chord as swallowed, and never the stud", () => {
    expect(held().swallowed).toBe(true);
    expect(held("stud").swallowed).toBe(false);
  });
});

describe("inert at map width, and it says so", () => {
  it("gives no peek and prints why", () => {
    const state = advance(RESTING, {
      kind: "chord",
      at: 1_000,
      position: fractionOf("map"),
    });

    expect(state.held).toBeNull();
    expect(state.refused).toBe(NOTHING_TO_GIVE);
    // Claimed even so: the operator pressed a chord the shell underneath never
    // saw, and *that* is the case the mark exists for.
    expect(state.swallowed).toBe(true);
  });

  it("refuses the stud at map width too, in the same words", () => {
    const state = advance(RESTING, { kind: "stud", position: fractionOf("map") });
    expect(state.held).toBeNull();
    expect(state.refused).toBe(NOTHING_TO_GIVE);
  });

  it("has something to give at every other detent", () => {
    expect(available(fractionOf("terminal"))).toBe(true);
    expect(available(fractionOf("glance"))).toBe(true);
    expect(available(fractionOf("split"))).toBe(true);
    expect(available(fractionOf("map"))).toBe(false);
  });
});

describe("every release, including the ones no keyup ever arrives for", () => {
  const releases: ReadonlyArray<[string, PeekEvent, string]> = [
    ["the key came up", { kind: "chord-up" }, "keyup"],
    ["the window lost focus", { kind: "blur" }, "blur"],
    ["the document went hidden", { kind: "hidden" }, "hidden"],
  ];

  for (const [what, event, why] of releases) {
    it(`releases the chord when ${what}`, () => {
      const state = advance(held(), event);
      expect(state.held).toBeNull();
      expect(state.released).toBe(why);
      expect(state.swallowed).toBe(false);
    });
  }

  it("releases when the auto-repeat stops arriving", () => {
    const down = repeating(1_000);
    expect(down.sawRepeat).toBe(true);
    // Still repeating: a beat inside the gap is not a release.
    expect(advance(down, { kind: "beat", at: 1_000 + REPEAT_GAP - 1 })).toBe(down);
    const gone = advance(down, { kind: "beat", at: 1_000 + REPEAT_GAP });
    expect(gone.held).toBeNull();
    expect(gone.released).toBe("repeat-gap");
  });

  /*
   * The defect this pins: the gap used to be armed by the first keydown, and
   * macOS sends no auto-repeat at all for a ⌘-modified keystroke — which the
   * mac chord ⌘G is. So every mac hold produced one keydown, no repeats, and
   * the spring released itself at 2.5 s with the key still physically down.
   * A silence only means the key is up on a hold that was heard to repeat.
   */
  it("never lets a silence release a hold that has not been heard to repeat", () => {
    const down = held("chord", 1_000);
    expect(down.sawRepeat).toBe(false);
    expect(advance(down, { kind: "beat", at: 1_000 + REPEAT_GAP })).toBe(down);
    expect(advance(down, { kind: "beat", at: 1_000 + REPEAT_GAP * 100 })).toBe(down);
    expect(down.held).toBe("chord");
  });

  it("still brings that hold back on the keyup, the blur and the hidden document", () => {
    for (const [event, why] of [
      [{ kind: "chord-up" } as PeekEvent, "keyup"],
      [{ kind: "blur" } as PeekEvent, "blur"],
      [{ kind: "hidden" } as PeekEvent, "hidden"],
    ] as const) {
      const state = advance(held("chord", 1_000), event);
      expect(state.held).toBeNull();
      expect(state.released).toBe(why);
    }
  });

  it("keeps the gap armed once a repeat has been heard", () => {
    const third = advance(repeating(1_000), {
      kind: "chord",
      at: 1_500,
      position: fractionOf("split"),
    });
    expect(third.sawRepeat).toBe(true);
    expect(advance(third, { kind: "beat", at: 1_500 + REPEAT_GAP }).released).toBe(
      "repeat-gap",
    );
  });

  it("gives a stud hold no repeats to lose, so no beat can take it down", () => {
    const down = held("stud");
    expect(down.sawRepeat).toBe(false);
    expect(advance(down, { kind: "beat", at: 9_999_999 })).toBe(down);
  });

  it("counts the gap from the last repeat rather than from the first press", () => {
    const down = held("chord", 1_000);
    const repeated = advance(down, {
      kind: "chord",
      at: 1_000 + REPEAT_GAP - 1,
      position: fractionOf("split"),
    });
    expect(advance(repeated, { kind: "beat", at: 1_000 + REPEAT_GAP })).toBe(repeated);
    expect(repeated.held).toBe("chord");
  });

  it("releases the stud on up, on cancel and on the pointer leaving it", () => {
    for (const [event, why] of [
      [{ kind: "stud-up" } as PeekEvent, "pointerup"],
      [{ kind: "pointercancel" } as PeekEvent, "pointercancel"],
      [{ kind: "pointerleave" } as PeekEvent, "pointerleave"],
    ] as const) {
      const state = advance(held("stud"), event);
      expect(state.held).toBeNull();
      expect(state.released).toBe(why);
    }
  });

  it("takes a stud down on a blur, whose pointerup would land on nobody", () => {
    expect(advance(held("stud"), { kind: "blur" }).held).toBeNull();
  });

  it("leaves a resting spring alone rather than notifying about nothing", () => {
    for (const event of [
      { kind: "blur" },
      { kind: "hidden" },
      { kind: "stud-up" },
      { kind: "pointerleave" },
      { kind: "beat", at: 9_999_999 },
    ] as PeekEvent[]) {
      expect(advance(RESTING, event)).toBe(RESTING);
    }
  });

  it("clears the refusal when the inert hold ends", () => {
    const refused = advance(RESTING, {
      kind: "chord",
      at: 1_000,
      position: fractionOf("map"),
    });
    expect(advance(refused, { kind: "chord-up" }).refused).toBeNull();
  });

  it("does not let a pointer event release a chord hold", () => {
    const down = held("chord");
    expect(advance(down, { kind: "stud-up" })).toBe(down);
    expect(advance(down, { kind: "pointerleave" })).toBe(down);
  });
});

describe("what the peek is worth", () => {
  it("is the map side at the map detent, dial's column and all", () => {
    // The body less the dial: the same pixels the `map` detent gives, so no
    // view stands down in a glance that the detent would have drawn — and the
    // seam is out of it, because the dial is on screen behind the peek too.
    expect(peekWidth(1_000, 12)).toBe(988);
    expect(peekWidth(1_000, 12)).toBe(sides(fractionOf("map"), 1_000, 12).map);
    expect(peekWidth(0, 12)).toBe(0);
  });

  it("stops short of the cursor's rows, and of the prompt block as well", () => {
    expect(clearance(false)).toBe(CLEARED_ROWS * ROW_HEIGHT);
    expect(clearance(true)).toBe((CLEARED_ROWS + PROMPT_ROWS) * ROW_HEIGHT);
    // Never nothing: an overlay flush to the bottom covers the row the operator
    // is typing into.
    expect(clearance(false)).toBeGreaterThan(0);
  });
});

describe("the summon chord, per platform", () => {
  it("is ⌘G on macOS", () => {
    const mac = chordFor("MacIntel");
    expect(mac).toEqual({ key: "g", meta: true, ctrl: false, alt: false, shift: false });
    expect(labelOf(mac, "MacIntel")).toBe("⌘G");
  });

  it("is never a lone Ctrl elsewhere, because Ctrl+G is BEL", () => {
    for (const platform of ["Win32", "Windows", "Linux x86_64"]) {
      const chord = chordFor(platform);
      expect(chord.alt).toBe(true);
      expect(chord.ctrl && !chord.alt).toBe(false);
      expect(labelOf(chord, platform)).toBe("Alt+G");
      for (const offered of chordChoices(platform)) {
        expect(offered.ctrl && !offered.alt && !offered.meta).toBe(false);
      }
    }
  });

  it("matches the keystroke it names and nothing near it", () => {
    const mac = chordFor("MacIntel");
    const stroke = (over: Partial<Record<string, unknown>>) => ({
      key: "g",
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      ...over,
    });

    expect(matches(mac, stroke({}))).toBe(true);
    expect(matches(mac, stroke({ key: "G", shiftKey: false }))).toBe(true);
    // An extra modifier is a different chord, and belongs to whatever bound it.
    expect(matches(mac, stroke({ shiftKey: true }))).toBe(false);
    expect(matches(mac, stroke({ metaKey: false }))).toBe(false);
    expect(matches(mac, stroke({ key: "h" }))).toBe(false);
    // Esc is never this app's, in any state: it is the interrupt key of every
    // agent CLI.
    expect(matches(mac, stroke({ key: "Escape" }))).toBe(false);
  });
});

describe("the rebind, remembered", () => {
  afterEach(() => writeChord(null));

  /** Something other than this platform's own answer, to bind instead of it. */
  function alternate(platform: string): Chord {
    const [, second] = chordChoices(platform);
    if (second === undefined) throw new Error("no alternative chord is offered");
    return second;
  }

  it("comes back on the next launch and outlives nothing else", () => {
    const wanted = alternate("MacIntel");
    writeChord(wanted);
    expect(readChord("MacIntel")).toEqual(wanted);
  });

  it("goes back to the platform's answer when it is cleared", () => {
    writeChord(alternate("MacIntel"));
    writeChord(null);
    expect(readChord("MacIntel")).toEqual(chordFor("MacIntel"));
  });

  it("refuses a stored chord with no modifier, which would swallow a letter", () => {
    window.localStorage.setItem("perseverance.peek.chord", "g");
    expect(readChord("Win32")).toEqual(chordFor("Win32"));
    window.localStorage.removeItem("perseverance.peek.chord");
  });
});

import { describe, expect, it } from "vitest";
import {
  ENTRIES,
  escDestination,
  labelFor,
  route,
  type Entry,
  type KeyState,
} from "../src/keys/router";
import { chordFor, type KeyboardLike } from "../src/panes/peek";

/**
 * The table, and the routing over it.
 *
 * Everything here is plain objects: `route` is pure, which is the property that
 * lets the window listener and xterm's key handler share one answer to *is this
 * chord claimed* without a window or an emulator anywhere near the assertion.
 */

const MAC = "MacIntel";
const PC = "Win32";

function state(overrides: Partial<KeyState> = {}): KeyState {
  return {
    os: PC,
    summon: chordFor(PC),
    typing: false,
    focusedNode: null,
    dialFocused: false,
    monitored: null,
    selection: null,
    ...overrides,
  };
}

function press(key: string, modifiers: Partial<KeyboardLike> = {}): KeyboardLike {
  return { key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers };
}

describe("the one chord table", () => {
  it("every row says what it does, in a sentence the palette can print", () => {
    for (const entry of ENTRIES) {
      expect(entry.verb.length, entry.id).toBeGreaterThan(0);
      expect(entry.verb, entry.id).toBe(entry.verb.toLowerCase());
      expect(labelFor(entry, state()).length, entry.id).toBeGreaterThan(0);
    }
  });

  it("home is Ctrl+0, and Ctrl+R is left to reverse-i-search", () => {
    expect(route(press("0", { ctrlKey: true }), state())?.id).toBe("home");
    expect(route(press("r", { ctrlKey: true }), state())).toBeNull();
    for (const entry of ENTRIES) {
      const claimed = entry.chords(state());
      expect(claimed.some((chord) => chord.ctrl && chord.key === "r"), entry.id).toBe(false);
    }
  });

  it("a chord of its own crosses, and it is not Esc", () => {
    expect(route(press("e", { altKey: true }), state())?.id).toBe("cross");
    expect(route(press("e", { metaKey: true }), state({ os: MAC, summon: chordFor(MAC) }))?.id).toBe(
      "cross",
    );
    // The per-platform pair is in the table, so the palette prints the right one.
    expect(labelFor(ENTRIES.find((entry) => entry.id === "cross")!, state({ os: MAC }))).toBe("⌘E");
    expect(labelFor(ENTRIES.find((entry) => entry.id === "cross")!, state())).toBe("Alt+E");
  });

  it("Esc is claimed by nothing, in any state", () => {
    const states = [
      state(),
      state({ monitored: 7 }),
      state({ typing: true, monitored: 7 }),
      state({ focusedNode: 3 }),
      state({ dialFocused: true }),
    ];
    for (const each of states) expect(route(press("Escape"), each)).toBeNull();

    // And nothing in the table is even written with it.
    for (const entry of ENTRIES) {
      expect(entry.chords(state()).some((chord) => chord.key === "Escape"), entry.id).toBe(false);
    }
  });

  it("Enter and Space open the row under the keyboard, and only there", () => {
    expect(route(press("Enter"), state({ focusedNode: 12 }))?.id).toBe("open");
    expect(route(press(" "), state({ focusedNode: 12 }))?.id).toBe("open");
    expect(route(press("Enter"), state())).toBeNull();
  });

  it("typing is never hijacked, but a chord the app owns still reaches it", () => {
    const typing = state({ typing: true, focusedNode: 12, monitored: 7 });
    expect(route(press("Enter"), typing)).toBeNull();
    expect(route(press(" "), typing)).toBeNull();
    expect(route(press("a"), typing)).toBeNull();
    expect(route(press("0", { ctrlKey: true }), typing)?.id).toBe("home");
    expect(route(press("g", { altKey: true }), typing)?.id).toBe("peek");
  });

  it("the dial's own keys are the dial's, and only while it has the key", () => {
    const dial = state({ dialFocused: true });
    expect(route(press("ArrowRight"), dial)?.id).toBe("dial-wider");
    expect(route(press("ArrowLeft"), dial)?.id).toBe("dial-narrower");
    expect(route(press("PageUp"), dial)?.id).toBe("dial-next-detent");
    expect(route(press("PageDown"), dial)?.id).toBe("dial-previous-detent");
    expect(route(press("Home"), dial)?.id).toBe("dial-terminal");
    expect(route(press("End"), dial)?.id).toBe("dial-map");
    for (const key of ["ArrowRight", "PageUp", "Home", "End"]) {
      expect(route(press(key), state())).toBeNull();
    }
  });

  it("the peek is the chord #52 settled, and it is held", () => {
    expect(route(press("g", { metaKey: true }), state({ os: MAC, summon: chordFor(MAC) }))?.id).toBe(
      "peek",
    );
    expect(ENTRIES.find((entry) => entry.id === "peek")?.held).toBe(true);
  });
});

describe("the Esc readout is computed from that table", () => {
  it("names the CLI while the terminal holds the keys", () => {
    expect(escDestination(state({ monitored: 4 }))).toBe("reaches the agent CLI");
  });

  it("says so plainly when there is no run to reach", () => {
    expect(escDestination(state())).toContain("nothing is bound to this window");
  });

  it("prints whatever a dismissible row declares, without being edited", () => {
    /*
     * The next slice's palette is one row with `dismisses`, and this is the
     * whole of what it takes for the readout to pick it up: the same table,
     * read the same way. A readout keeping its own list of surfaces would need
     * editing here instead, which is exactly the drift this shape rules out.
     */
    const palette: Entry = {
      id: "home",
      chords: () => [{ key: "Escape", meta: false, ctrl: false, alt: false, shift: false }],
      verb: "put the command palette away",
      when: (each) => each.monitored !== null,
      dismisses: "the command palette",
    };
    const table = [...ENTRIES, palette];

    expect(escDestination(state({ monitored: 4 }), table)).toBe("dismisses the command palette");
    // And the moment that surface is not up, the CLI has the key back.
    expect(escDestination(state(), table)).toContain("nothing is bound to this window");
  });
});

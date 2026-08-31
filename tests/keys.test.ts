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
    warm: null,
    selection: null,
    inFront: null,
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
      /* Trimmed and untrimmed alike: a key that renders as whitespace prints
         as an empty `<kbd>`, which is a row an operator cannot read. */
      const label = labelFor(entry, state());
      expect(label.length, entry.id).toBeGreaterThan(0);
      expect(label.trim(), entry.id).toBe(label);
    }
  });

  it("names the keys that would otherwise print as nothing", () => {
    // `" "` in a `<kbd>` is a blank box: the one row with two ways in would
    // print its second way as nothing at all.
    const open = ENTRIES.find((entry) => entry.id === "open");
    expect(open).toBeDefined();
    expect(labelFor(open as Entry, state())).toBe("Enter or Space");
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

  it("Esc is claimed by nothing while the terminal has the keys", () => {
    /*
     * The ticket's headline guarantee, and the one an operator would notice
     * going wrong first: with nothing standing in front of the terminal, `Esc`
     * is the agent CLI's interrupt and this app does not touch it — in any
     * state, typing included.
     */
    const states = [
      state(),
      state({ monitored: 7 }),
      state({ typing: true, monitored: 7 }),
      state({ focusedNode: 3 }),
      state({ dialFocused: true }),
    ];
    for (const each of states) expect(route(press("Escape"), each)).toBeNull();

    // And every row written with it requires a surface in front, which is what
    // makes the exemption in `route` safe rather than a swallowed interrupt.
    for (const entry of ENTRIES) {
      const escapes = entry.chords(state()).some((chord) => chord.key === "Escape");
      if (escapes) expect(entry.when(state()), entry.id).toBe(false);
    }
  });

  it("the palette is a chord no shell reads, and it is per-platform", () => {
    expect(route(press("k", { altKey: true }), state())?.id).toBe("palette");
    expect(route(press("k", { metaKey: true }), state({ os: MAC, summon: chordFor(MAC) }))?.id).toBe(
      "palette",
    );
    const palette = ENTRIES.find((entry) => entry.id === "palette")!;
    expect(labelFor(palette, state({ os: MAC }))).toBe("⌘K");
    expect(labelFor(palette, state())).toBe("Alt+K");

    // Never a lone Ctrl+letter: the whole readline row is the shell's, and
    // `Ctrl+K` is kill-line in every one of them.
    expect(route(press("k", { ctrlKey: true }), state())).toBeNull();
    for (const entry of ENTRIES) {
      const chords = entry.chords(state({ os: MAC, summon: chordFor(MAC) }));
      const lone = chords.some(
        (chord) => chord.ctrl && !chord.alt && /^[a-z]$/.test(chord.key),
      );
      expect(lone, entry.id).toBe(false);
    }
  });

  it("no other row answers the palette's chord, in any state both apply", () => {
    /* The collision check spelled out rather than argued: every other row is
       asked for the palette's chord in the state that arms it. */
    const armed = [
      state(),
      state({ os: MAC, summon: chordFor(MAC) }),
      state({ focusedNode: 4 }),
      state({ dialFocused: true }),
      state({ typing: true, monitored: 7 }),
    ];
    for (const each of armed) {
      expect(route(press("k", { metaKey: each.os === MAC, altKey: each.os !== MAC }), each)?.id).toBe(
        "palette",
      );
    }
  });

  it("the keys page is a chord no shell reads, and it is per-platform", () => {
    expect(route(press("/", { altKey: true }), state())?.id).toBe("keys");
    expect(route(press("/", { metaKey: true }), state({ os: MAC, summon: chordFor(MAC) }))?.id).toBe(
      "keys",
    );
    const keys = ENTRIES.find((entry) => entry.id === "keys")!;
    expect(labelFor(keys, state({ os: MAC }))).toBe("⌘/");
    expect(labelFor(keys, state())).toBe("Alt+/");

    // Bare it is a character the run underneath is owed, and `Ctrl+/` is the
    // shell's undo — neither is offered to the app.
    expect(route(press("/"), state())).toBeNull();
    expect(route(press("/", { ctrlKey: true }), state())).toBeNull();
  });

  it("no other row answers the keys page's chord, in any state both apply", () => {
    /* The collision check spelled out rather than argued, as it is for the
       palette: every other row is asked for this chord in the state that arms
       it, and the keys page is what answers. */
    const armed = [
      state(),
      state({ os: MAC, summon: chordFor(MAC) }),
      state({ focusedNode: 4 }),
      state({ dialFocused: true }),
      state({ typing: true, monitored: 7 }),
    ];
    for (const each of armed) {
      expect(
        route(press("/", { metaKey: each.os === MAC, altKey: each.os !== MAC }), each)?.id,
      ).toBe("keys");
    }
  });

  it("Esc puts the keys page away, and only while the keys page is in front", () => {
    const up = state({ inFront: "keys", typing: true, monitored: 7 });
    expect(route(press("Escape"), up)?.id).toBe("keys-away");
    // One dismiss row per surface: with the palette in front it is the palette's
    // row that answers, and with nothing in front the run keeps its interrupt.
    expect(route(press("Escape"), state({ inFront: "palette", monitored: 7 }))?.id).toBe(
      "palette-away",
    );
    expect(route(press("Escape"), state({ typing: true, monitored: 7 }))).toBeNull();

    // And neither opening chord applies over a surface already in front.
    expect(route(press("/", { altKey: true }), up)).toBeNull();
    expect(route(press("k", { altKey: true }), up)).toBeNull();
  });

  it("Esc dismisses the surface in front, and only while one is", () => {
    const up = state({ inFront: "palette", typing: true, monitored: 7 });
    /* Typing is true because the palette's filter field has the keyboard — and
       `Esc` is exempt from the typing guard for exactly that reason. Without the
       exemption the palette could not be dismissed from its own input. */
    expect(route(press("Escape"), up)?.id).toBe("palette-away");
    expect(route(press("Escape"), state({ typing: true, monitored: 7 }))).toBeNull();

    // The chord that opens it does not apply over it: one surface in front.
    expect(route(press("k", { altKey: true }), up)).toBeNull();
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
    expect(escDestination(state({ monitored: 4, warm: 4 }))).toBe("reaches the agent CLI");
  });

  it("says so plainly when there is no run to reach", () => {
    expect(escDestination(state())).toContain("nothing is bound to this window");
  });

  it("does not promise the CLI a key it will never see, on a run nobody is typing at", () => {
    /* Watching without typing is one press away, and `Esc` is the interrupt of
       every agent CLI: saying *reaches the agent CLI* over a cold run would be
       promising an interrupt that lands nowhere. */
    expect(escDestination(state({ monitored: 4 }))).toBe(
      "reaches nothing — the keys are on the map",
    );
  });

  it("names the palette while the palette is in front", () => {
    expect(escDestination(state({ inFront: "palette", monitored: 4, warm: 4 }))).toBe(
      "dismisses the command palette",
    );
    // And the run has the key back the moment it is gone.
    expect(escDestination(state({ monitored: 4, warm: 4 }))).toBe("reaches the agent CLI");
  });

  it("names the keys page while the keys page is in front", () => {
    /* The second surface, and the proof the mechanism is a mechanism: the row
       declares `dismisses` and this sentence changes, with `escDestination`
       untouched since the palette landed. */
    expect(escDestination(state({ inFront: "keys", monitored: 4, warm: 4 }))).toBe(
      "dismisses the keys page",
    );
    expect(escDestination(state({ inFront: "palette", monitored: 4, warm: 4 }))).toBe(
      "dismisses the command palette",
    );
    expect(escDestination(state({ monitored: 4, warm: 4 }))).toBe("reaches the agent CLI");
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

    expect(escDestination(state({ monitored: 4, warm: 4 }), table)).toBe(
      "dismisses the command palette",
    );
    // And the moment that surface is not up, the CLI has the key back.
    expect(escDestination(state(), table)).toContain("nothing is bound to this window");
  });
});

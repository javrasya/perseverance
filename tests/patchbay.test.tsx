// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentState, type KeyState } from "../src/keys/router";
import { keysGo } from "../src/keys/temperature";
import { chordFor } from "../src/panes/peek";
import {
  dismiss,
  keyedRun,
  monitor,
  raise,
  readUi,
  setKeyed,
  type Ui,
} from "../src/stores/ui";
import { Pane } from "../src/terminal/Pane";
import type { RunReadout } from "../src/terminal/runs";
import { Terminals, type Terminal } from "../src/terminal/terminals";

/**
 * The patchbay: what you watch and what you type into are two paths.
 *
 * Three claims, and they are the ticket's: the warm run cannot be a run that is
 * not on the monitor — not by assertion, but because there is nowhere to write
 * one down; the keyboard follows the temperature rather than deciding it; and
 * the readout answers *where do my keystrokes go* in every state, including the
 * two where the answer is nobody and the one where the run it names is dead.
 *
 * The emulator is stood in for the way `tests/keys-shell.test.tsx` stands it in:
 * a real, focusable node, because `document.activeElement` has to be able to see
 * the keyboard land. A `focus()` that only recorded a call would pass with the
 * pane's focus effect deleted.
 */

function fake(): Terminal {
  const element = document.createElement("div");
  element.tabIndex = 0;
  element.dataset.standIn = "terminal";
  return {
    element,
    write: () => {},
    reset: () => {},
    resize: () => {},
    measure: () => null,
    onData: () => () => {},
    focus: () => element.focus(),
    dispose: () => {},
  };
}

function state(overrides: Partial<KeyState> = {}): KeyState {
  return {
    os: "Win32",
    summon: chordFor("Win32"),
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

function a(run: number, over = false): RunReadout {
  return {
    run,
    held: 4096,
    dropped: 0,
    through: 4096,
    end: 4096,
    truncated: false,
    desynced: false,
    over,
    code: over ? 130 : null,
    monitored: false,
    silence: { kind: "nothing" },
    signal: null,
    ticket: 128,
    folder: "/work/perseverance",
    ending: over ? "exited" : "live",
    kind: "work",
    opened: 1_785_888_000,
    spoke: 1_785_888_000,
  };
}

describe("the warm run is the run on the monitor, by construction", () => {
  afterEach(() => {
    monitor(null);
  });

  it("has no way to warm a run that is not on the pane", () => {
    /*
     * The whole structural claim in one assertion. There is one run id in the
     * store, so the only run `keyedRun` can answer with is the monitored one —
     * a `warm: number | null` beside `monitored` would have made this test a
     * matter of two mutators agreeing, which is exactly the kind of rule that
     * holds until the third caller.
     */
    const warm: (keyof Ui)[] = Object.keys(readUi()).filter((field) =>
      /warm|keyed/.test(field),
    ) as (keyof Ui)[];
    expect(warm).toEqual(["keyed"]);
    expect(typeof readUi().keyed).toBe("boolean");
  });

  it("refuses to warm with nothing on the monitor", () => {
    setKeyed(true);

    expect(readUi().keyed).toBe(false);
    expect(keyedRun(readUi())).toBeNull();
  });

  it("warms the run on the monitor, and only while it is on it", () => {
    monitor(7);
    setKeyed(true);
    expect(keyedRun(readUi())).toBe(7);

    /* Re-patching the monitor is *select which run the terminal shows without
       moving your keyboard to it* — so it goes cold, and the key line cannot be
       left pointing at a conversation nobody is looking at. */
    monitor(9);
    expect(keyedRun(readUi())).toBeNull();
    expect(readUi().monitored).toBe(9);
  });

  it("is cold with the pane emptied", () => {
    monitor(7);
    setKeyed(true);
    monitor(null);

    expect(keyedRun(readUi())).toBeNull();
  });
});

describe("the readout says where the keystrokes go, in every state", () => {
  it("names the map when nothing is warm", () => {
    // Not an error and not a blank: nothing warm *is* an answer.
    expect(keysGo(state({ monitored: 4 }))).toBe("the map");
    expect(keysGo(state())).toBe("the map");
  });

  it("names the run the way the operator picks it out of a rack", () => {
    expect(keysGo(state({ monitored: 4, warm: 4 }), a(4))).toBe("#128 work, on the monitor");
  });

  it("names the run itself before any readout has arrived for it", () => {
    expect(keysGo(state({ monitored: 4, warm: 4 }))).toBe("run 4, on the monitor");
    // A readout for some other run says nothing about this one.
    expect(keysGo(state({ monitored: 4, warm: 4 }), a(5))).toBe("run 4, on the monitor");
  });

  it("stays honest about a parked caret", () => {
    /* The run is still warm — the caret parks and does not move — so the
       readout may not claim a live agent on the other end of the keyboard. */
    const said = keysGo(state({ monitored: 4, warm: 4 }), a(4, true));

    expect(said).toContain("#128 work");
    expect(said).toContain("its child has stopped");
    expect(said).toContain("spill register");
  });

  it("names the surface in front, off that surface's own dismiss row", () => {
    expect(keysGo(state({ monitored: 4, warm: 4, inFront: "palette" }))).toBe(
      "the command palette",
    );
    expect(keysGo(state({ monitored: 4, warm: 4, inFront: "keys" }))).toBe("the keys page");
  });
});

describe("the keyboard follows the temperature", () => {
  let mounted: { root: ReturnType<typeof createRoot>; host: HTMLElement } | null = null;
  let terminals: Terminals;

  beforeEach(async () => {
    terminals = new Terminals(fake);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted = { root, host };
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    await act(async () => {
      root.render(<Pane terminals={terminals} readouts={[a(3)]} />);
    });
  });

  afterEach(async () => {
    if (mounted !== null) {
      const { root, host } = mounted;
      await act(async () => root.unmount());
      host.remove();
      mounted = null;
    }
    dismiss();
    monitor(null);
  });

  const theTerminal = () => document.querySelector("[data-stand-in='terminal']");

  it("puts the keyboard in the run the store says is warm, and takes it off when it cools", async () => {
    await act(async () => {
      monitor(3);
    });
    // Watching is not typing: bound and cold, the terminal does not take the keys.
    expect(document.activeElement).not.toBe(theTerminal());

    await act(async () => {
      setKeyed(true);
    });
    expect(document.activeElement).toBe(theTerminal());

    await act(async () => {
      setKeyed(false);
    });
    expect(document.activeElement).not.toBe(theTerminal());
  });

  it("keeps the run warm behind a surface, and hands the keys back on dismiss", async () => {
    await act(async () => {
      monitor(3);
      setKeyed(true);
    });
    const elsewhere = document.createElement("input");
    document.body.append(elsewhere);

    await act(async () => {
      raise("palette");
      // What a surface does when it comes up: it takes the keyboard.
      elsewhere.focus();
    });
    /* The run stays warm. A surface holds the keys while it is up, and cooling
       here would mean dismissing it put the keyboard down instead of back. */
    expect(keyedRun(readUi())).toBe(3);
    expect(keysGo(currentState())).toBe("the command palette");

    await act(async () => {
      dismiss();
    });
    expect(document.activeElement).toBe(theTerminal());
    elsewhere.remove();
  });

  it("cools when the keyboard leaves the terminal for something else", async () => {
    /* The two may not disagree. A click on the map takes the caret out of
       xterm's helper textarea, and a store still saying warm would be printing
       a readout the keyboard contradicts. */
    await act(async () => {
      monitor(3);
      setKeyed(true);
    });
    const elsewhere = document.createElement("input");
    document.body.append(elsewhere);

    await act(async () => {
      elsewhere.focus();
    });

    expect(keyedRun(readUi())).toBeNull();
    expect(keysGo(currentState())).toBe("the map");
    elsewhere.remove();
  });

  it("warms when the operator clicks into the terminal", async () => {
    await act(async () => {
      monitor(3);
    });
    expect(keyedRun(readUi())).toBeNull();

    await act(async () => {
      (theTerminal() as HTMLElement).focus();
    });

    expect(keyedRun(readUi())).toBe(3);
    expect(keysGo(currentState(), a(3))).toBe("#128 work, on the monitor");
  });
});

/* jsdom has no `matchMedia`; the pane's chrome asks for one. It matches nothing. */
vi.stubGlobal(
  "matchMedia",
  vi.fn(() => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  })),
);

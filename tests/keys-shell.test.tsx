// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Chord } from "../src/panes/peek";
import type { ActionId } from "../src/keys/router";
import { ENTRIES, claims, currentState } from "../src/keys/router";
import { forgetStow } from "../src/terminal/reparent";
import type { Terminal } from "../src/terminal/terminals";
import { monitor, readUi } from "../src/stores/ui";
import { App } from "../src/App";

/**
 * The two surfaces, in the real shell, through the real window listener.
 *
 * `tests/palette.test.tsx`, `tests/keys-page.test.tsx` and `tests/keys.test.ts`
 * pin the components and the table; nothing until now pinned what the *window*
 * does with them — that a chord dispatched at the window raises a surface, that
 * `Esc` puts it away, and that the keyboard lands back in the warm run rather
 * than inside something no longer on screen. Every keystroke here is a real
 * `KeyboardEvent` dispatched into the app's own capture-phase listener: calling
 * `raise`/`dismiss` would assert the store and skip the wiring under test.
 *
 * The chords are read out of `ENTRIES` rather than written down, so this file
 * is one more proof that the table is the single source — and it stays true on
 * a mac-shaped `navigator`, where every chord in it changes.
 */

/*
 * The registry is built inside `App` (`useState(() => new Terminals(xterm))`),
 * so the module is the only injection point there is. The stand-in is here for
 * one reason: `document.activeElement` has to be able to see the keyboard land
 * in the terminal, and xterm.js's helper textarea does not exist without a
 * layout engine. Its `focus()` really focuses its node — weakening that to a
 * recorded call would pass with the shell's `focus()` deleted.
 */
vi.mock("../src/terminal/xterm", () => ({
  xterm: (): Terminal => {
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
  },
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/* jsdom has no `matchMedia`; the pane's chrome asks for one. It matches nothing. */
if (typeof window.matchMedia !== "function") {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const WARM = 7;

let mounted: { root: ReturnType<typeof createRoot>; host: HTMLElement } | null = null;

async function boot(): Promise<void> {
  window.history.replaceState({}, "", "/?map=awkward-map");

  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted = { root, host };

  await act(async () => {
    root.render(<App />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  /* A warm run: the pane binds its terminal, and `Esc` has somewhere to go. */
  await act(async () => monitor(WARM));
}

afterEach(() => {
  if (mounted !== null) {
    const { root, host } = mounted;
    act(() => root.unmount());
    host.remove();
    mounted = null;
  }
  monitor(null);
  forgetStow();
  window.localStorage.clear();
});

const entryFor = (id: ActionId) =>
  ENTRIES.find((entry) => entry.id === id) ?? expect.fail(`no ${id} row in the table`);

/** The live chord for a row, as the table itself answers it on this platform. */
const chordFor = (id: ActionId): Chord =>
  entryFor(id).chords(currentState())[0] ?? expect.fail(`the ${id} row binds no chord`);

function keydown(pressed: Chord): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key: pressed.key,
    metaKey: pressed.meta,
    ctrlKey: pressed.ctrl,
    altKey: pressed.alt,
    shiftKey: pressed.shift,
    bubbles: true,
    cancelable: true,
  });
}

async function press(id: ActionId): Promise<void> {
  await act(async () => {
    window.dispatchEvent(keydown(chordFor(id)));
  });
}

/** `Esc` where the keyboard actually is, so the state the router reads is real. */
async function escape(at: EventTarget | null = null): Promise<KeyboardEvent> {
  const event = keydown({ key: "Escape", meta: false, ctrl: false, alt: false, shift: false });
  const target = at ?? document.activeElement ?? window;
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
}

const thePalette = () => document.querySelector("[data-palette]");
const theKeysPage = () => document.querySelector("[data-keys]");
const theTerminal = () => document.querySelector("[data-stand-in='terminal']");

describe("the palette, raised and dismissed at the window", () => {
  it("comes up on its chord with the keyboard in its filter field", async () => {
    await boot();
    expect(thePalette()).toBeNull();

    await press("palette");

    expect(thePalette()).not.toBeNull();
    expect(readUi().inFront).toBe("palette");
    expect(document.activeElement).toBe(document.querySelector("[data-palette] input"));
  });

  it("goes away on Esc and hands the keyboard back to the warm run", async () => {
    await boot();
    await press("palette");
    await escape();

    expect(thePalette()).toBeNull();
    expect(readUi().inFront).toBeNull();
    // Inside the run's own terminal — not merely off the surface, which a bare
    // `blur()` would also satisfy.
    expect(document.activeElement).toBe(theTerminal());
  });

  it("leaves the room exactly as it found it", async () => {
    await boot();
    const { view, position, selection, monitored } = readUi();

    await press("palette");
    await escape();

    expect(readUi()).toMatchObject({ view, position, selection, monitored });
  });
});

describe("the keys page, raised and dismissed at the window", () => {
  it("comes up on its chord and goes away on Esc, keyboard back in the run", async () => {
    await boot();

    await press("keys");

    expect(theKeysPage()).not.toBeNull();
    expect(readUi().inFront).toBe("keys");

    await escape();

    expect(theKeysPage()).toBeNull();
    expect(readUi().inFront).toBeNull();
    expect(document.activeElement).toBe(theTerminal());
  });
});

describe("with nothing in front, Esc is not the app's", () => {
  /*
   * The ticket's headline guarantee, and the correction it exists to make:
   * `Esc` had been bound to a room change, which took the interrupt key away
   * from every agent CLI in the pane. Untouched here means untouched — the key
   * is encoded and sent like any other.
   */
  it("leaves an Escape aimed at the warm terminal alone", async () => {
    await boot();
    expect(readUi().inFront).toBeNull();

    const terminal = theTerminal();
    expect(terminal).not.toBeNull();
    const event = await escape(terminal);

    expect(event.defaultPrevented).toBe(false);
    expect(claims(event)).toBe(false);
  });
});

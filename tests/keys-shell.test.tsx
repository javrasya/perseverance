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
import { Picker } from "../src/chrome/Sockets.jsx";
import { RUN_IS_UP, picking } from "../src/chrome/sockets";
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

/**
 * The rail's own picker, drawn where the case under test needs it to be.
 *
 * The real `Picker`, and rendered rather than faked, because the seam the
 * palette's row aims at is a `data-picker` attribute in the document — what the
 * readout pipeline has to do to offer two adapters is `tests/sockets.test.tsx`'s
 * subject, and what is under test here is what the *shell* does to the keyboard
 * around it. `into` says which side of the surface it stands on, which is the
 * whole question for the row that reaches it; `duringRun` draws the printed,
 * unchangeable one instead of the choice.
 */
let railed: { root: ReturnType<typeof createRoot>; host: HTMLElement } | null = null;

async function rail({
  into,
  duringRun = false,
}: { into?: HTMLElement; duringRun?: boolean } = {}): Promise<HTMLElement> {
  const host = document.createElement("div");
  (into ?? document.body).appendChild(host);
  const root = createRoot(host);
  railed = { root, host };
  const offered = ["claude", "codex"] as const;
  await act(async () => {
    root.render(
      <Picker
        offered={offered}
        picking={picking(offered, null, duringRun)}
        onChoose={() => {}}
      />,
    );
  });
  const control = host.querySelector<HTMLElement>(
    duringRun ? "[data-picker]" : "select[data-picker]",
  );
  return control ?? expect.fail("the rail drew no picker");
}


afterEach(() => {
  if (railed !== null) {
    const { root, host } = railed;
    act(() => root.unmount());
    host.remove();
    railed = null;
  }
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

/**
 * The shell itself, named the way the keyboard finds it: the element carrying
 * the `inert` while a surface is up. A class of its own is a CSS-module hash and
 * a `data-` seam for a test only would be a second way to say the same thing.
 */
const theShell = (): HTMLElement =>
  theTerminal()?.closest<HTMLElement>("[inert]") ??
  expect.fail("nothing behind the surface is inert");

/** A row of the palette, pressed the way a mouse presses it. */
async function pressRow(id: string): Promise<void> {
  const button = document.querySelector<HTMLButtonElement>(
    `[data-palette] [data-row="${id}"] button`,
  );
  await act(async () => {
    (button ?? expect.fail(`the palette prints no ${id} row`)).click();
  });
}

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

  it("leaves the keyboard on the picker its agent row focuses", async () => {
    /*
     * The acceptance criterion, at the window: *the palette focuses the adapter
     * picker*. Asserted with no stand-in for the focusing itself, because the
     * bug it guards was entirely in what the shell did **afterwards** — the
     * dismiss that gives the keyboard back is right for every other row and
     * wrong for this one, and a test that stubbed the focus would still have
     * passed with the keyboard taken straight off the select again.
     */
    await boot();
    const picker = await rail();

    await press("palette");
    await act(async () => {
      document
        .querySelector("[data-row='agent'] button")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(thePalette()).toBeNull();
    expect(readUi().inFront).toBeNull();
    // On the picker — not in the warm run, which is where `away` would put it.
    expect(document.activeElement).toBe(picker);
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

  /*
   * And the same guarantee where it is easiest to lose: the crossing chord
   * pressed while the palette is up. Crossing puts the keyboard back in the warm
   * run, so a palette left standing behind it would be a run being typed at with
   * `Esc` still claimed by a dismiss row — the interrupt key stolen from the
   * agent, which is the exact failure this table exists to prevent. ADR 0025's
   * invariant is that no surface stands in front of a terminal being typed at;
   * this is the case that has to make it true rather than assume it.
   */
  it("does not leave Esc claimed when the crossing chord follows the palette", async () => {
    await boot();
    await press("palette");
    expect(readUi().inFront).toBe("palette");

    await press("cross");

    expect(thePalette()).toBeNull();
    expect(readUi().inFront).toBeNull();

    const event = await escape();
    expect(event.defaultPrevented).toBe(false);
    expect(claims(event)).toBe(false);
  });

  /* Home has the milder shape of it: a view swapped under a surface that stayed. */
  it("does not change the view under a palette that is still up", async () => {
    await boot();
    await press("palette");

    await press("home");

    expect(thePalette()).toBeNull();
    expect(readUi().inFront).toBeNull();
  });
});

describe("a surface in front is modal", () => {
  /*
   * ADR 0025's premise, made structural rather than assumed: while a
   * dismissible surface stands in front of the terminal, the CLI is not being
   * typed at. The router decides from the table and not from where the focus
   * is, so the focus is what has to be honest — otherwise a Tab out of the
   * palette lands in the route rows, the dial or xterm's helper textarea, and
   * the operator types at a warm agent CLI while `Esc` is still the surface's
   * dismiss row. A scrim over the window only stops the mouse; `inert` stops
   * the keyboard.
   *
   * jsdom implements no focus semantics for `inert`, so what is asserted here
   * is the mark itself, on the element that carries everything behind the
   * surface — and its absence on the surface, which would otherwise inherit it.
   */
  it("takes the shell behind the palette out of the keyboard's reach", async () => {
    await boot();
    expect(theTerminal()?.closest("[inert]")).toBeNull();

    await press("palette");

    expect(theTerminal()?.closest("[inert]")).not.toBeNull();
    expect(thePalette()?.closest("[inert]")).toBeNull();

    await escape();

    expect(theTerminal()?.closest("[inert]")).toBeNull();
  });

  it("does the same behind the keys page", async () => {
    await boot();

    await press("keys");

    expect(theTerminal()?.closest("[inert]")).not.toBeNull();
    expect(theKeysPage()?.closest("[inert]")).toBeNull();

    /* Put away before the next case: what is in front is the store's, and the
       store outlives a mount. */
    await escape();

    expect(theTerminal()?.closest("[inert]")).toBeNull();
  });
});

describe("home, with nothing in front", () => {
  /*
   * `home` puts whatever is in front away before it changes anything, and
   * putting a surface away hands the keyboard back to the warm run. With no
   * surface up there is nothing to hand back: a press that asks only for the
   * default view at the default detent would otherwise drop the operator's next
   * keystrokes into a running agent CLI they never aimed at — and with no warm
   * run it would blur whatever held them, the focused route row included. The
   * row's verb is the view and the detent, and says nothing about the keyboard.
   */
  it("goes home and leaves the keyboard where it was", async () => {
    await boot();
    /* Focused outside the shell, so the assertion is about the press and not
       about what `inert` does to a control behind a surface. */
    const picker = await rail();
    picker.focus();
    expect(document.activeElement).toBe(picker);

    await press("home");

    expect(readUi().inFront).toBeNull();
    expect(document.activeElement).toBe(picker);
  });
});

describe("the palette's picker row, against the real shell", () => {
  /*
   * The acceptance criterion's first half, end to end. The row aims at a control
   * that is *behind* the palette, and everything behind a surface is `inert` —
   * so the row cannot work unless the mark comes off before the focus and not
   * after it. `querySelector` reaches into an inert subtree either way, which is
   * how this once passed a unit test of its own while focusing nothing at all.
   *
   * jsdom implements no focus semantics for `inert`, so `document.activeElement`
   * alone would agree with the broken order too. What is pinned instead is the
   * fact a browser acts on: whether the picker had an `inert` ancestor *at the
   * moment `focus()` was called*. The landing is asserted beside it.
   */
  it("focuses the picker with the shell's inert lifted, then hands off", async () => {
    await boot();
    await press("palette");

    /* Behind the surface, which is where the rail draws it and the whole of what
       this case is about — nothing can talk the readout pipeline into offering
       two adapters in jsdom. */
    const picker = await rail({ into: theShell() });
    const markWhenFocused: (Element | null)[] = [];
    const focus = picker.focus.bind(picker);
    picker.focus = () => {
      markWhenFocused.push(picker.closest("[inert]"));
      focus();
    };

    await pressRow("agent");

    expect(markWhenFocused).toEqual([null]);
    expect(document.activeElement).toBe(picker);
    /* The hand-off and not `away`: the surface goes, and nothing takes the
       keyboard back off the control the row exists to reach. */
    expect(thePalette()).toBeNull();
    expect(readUi().inFront).toBeNull();
    expect(document.querySelector("[data-refused]")).toBeNull();
  });

  /*
   * The other half of it, and the behaviour the lift must not cost: a picker
   * printed rather than offered refuses, the reason it carries is the sentence
   * the palette prints, and the surface stays up over a shell that goes straight
   * back out of the keyboard's reach. Silence is the one unacceptable answer.
   */
  it("prints the reason and puts the mark back when the picker is fixed", async () => {
    await boot();
    await press("palette");

    const printed = await rail({ into: theShell(), duringRun: true });
    expect(printed.getAttribute("data-picker-fixed")).toBe(RUN_IS_UP);

    await pressRow("agent");

    expect(document.querySelector("[data-refused]")?.textContent).toBe(RUN_IS_UP);
    expect(thePalette()).not.toBeNull();
    expect(readUi().inFront).toBe("palette");
    expect(theTerminal()?.closest("[inert]")).not.toBeNull();
  });
});

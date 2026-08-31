// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Pane } from "../src/terminal/Pane";
import { forgetPrompts } from "../src/terminal/prompts";
import { forgetStow } from "../src/terminal/reparent";
import type {
  RunEnding,
  RunReadout,
  RunSignal,
  RunSilence,
} from "../src/terminal/runs";
import { Terminals, type Terminal } from "../src/terminal/terminals";
import { monitor, readUi } from "../src/stores/ui";

/**
 * The two endings on screen, and the press that ends a spent run.
 *
 * Every claim here is about the pane's *chrome*, so no xterm is instantiated —
 * the stand-in terminal is the one `tests/terminals.test.tsx` uses, with its
 * calls recorded so *a resolution touches no terminal* can be asserted as the
 * absence of every call rather than as the presence of the right one.
 *
 * `endRun` is stubbed rather than left to no-op through `hasRustBehindIt`,
 * because the thing worth pinning is the **order**: the harness closes the
 * session before this side disposes the node.
 */

const journal = vi.hoisted(() => [] as string[]);

vi.mock("../src/terminal/runs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/terminal/runs")>()),
  endRun: vi.fn(async (run: number) => {
    journal.push(`endRun(${run})`);
  }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function aTerminal(): Terminal {
  return {
    element: document.createElement("div"),
    write: () => journal.push("write"),
    reset: () => journal.push("reset"),
    resize: () => journal.push("resize"),
    measure: () => null,
    onData: () => () => {},
    dispose: () => journal.push("dispose"),
  };
}

function readout(ending: RunEnding, code: number | null = null): RunReadout {
  return {
    run: 7,
    held: 4096,
    dropped: 0,
    through: 4096,
    end: 4096,
    truncated: false,
    desynced: false,
    over: ending === "exited" || ending === "exitedUnresolved",
    code,
    monitored: true,
    silence: { kind: "nothing" },
    signal: null,
    ticket: 49,
    folder: "/work/repo",
    ending,
  };
}

function mount(readouts: readonly RunReadout[]): {
  host: HTMLElement;
  unmount: () => void;
} {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(<Pane terminals={new Terminals(aTerminal)} readouts={readouts} />);
  });
  return { host, unmount: () => act(() => root.unmount()) };
}

function chrome(host: HTMLElement): string {
  return host.querySelector("section[aria-label='Terminal']")?.textContent ?? "";
}

function press(host: HTMLElement): HTMLButtonElement | null {
  return host.querySelector("button");
}

afterEach(() => {
  monitor(null);
  forgetPrompts();
  forgetStow();
  journal.length = 0;
  document.body.replaceChildren();
});

describe("the ending, printed", () => {
  it("says nothing at all, and offers no press, while a run is live", () => {
    monitor(7);
    const { host, unmount } = mount([readout("live")]);

    expect(chrome(host)).not.toContain("ended");
    expect(press(host)).toBe(null);

    unmount();
  });

  it("says the ticket closed, and that the output is the operator's to read", () => {
    monitor(7);
    const { host, unmount } = mount([readout("spent")]);

    expect(chrome(host)).toContain("the ticket closed");
    expect(chrome(host)).toContain("for as long as you want");

    unmount();
  });

  it("says a run stopped with its ticket still open and still claimed", () => {
    monitor(7);
    const { host, unmount } = mount([readout("exitedUnresolved")]);

    expect(chrome(host)).toContain("still open and still claimed");

    unmount();
  });

  it("keeps the exit code on the ending that has one", () => {
    monitor(7);
    const { host, unmount } = mount([readout("exited", 130)]);

    expect(chrome(host)).toContain("this run has ended (130)");

    unmount();
  });

  it("prints the ending as visible text and never behind a tooltip", () => {
    monitor(7);
    const { host, unmount } = mount([readout("exitedUnresolved")]);

    for (const element of host.querySelectorAll("*")) {
      expect(element.getAttribute("title")).toBe(null);
    }

    unmount();
  });
});

describe("the press that ends a run", () => {
  it("leaves the bound terminal exactly where it was when a ticket merely closes", () => {
    monitor(7);
    const { host, unmount } = mount([readout("spent")]);

    const pane = host.querySelector("[class*='host']");
    expect(pane?.childElementCount).toBe(1);
    // Not one call to the emulator on a resolution: no session closed, no byte
    // moved, no geometry sent. A ticket closing is a fact about GitHub.
    expect(journal).toEqual([]);
    expect(readUi().monitored).toBe(7);

    unmount();
  });

  it("closes the session first, then lets go of the node, then empties the pane", async () => {
    monitor(7);
    const { host, unmount } = mount([readout("spent")]);

    const button = press(host);
    expect(button).not.toBe(null);
    await act(async () => {
      button?.click();
    });

    expect(journal).toEqual(["endRun(7)", "dispose"]);
    expect(readUi().monitored).toBe(null);
    expect(chrome(host)).toContain("Nothing is running here yet.");

    unmount();
  });

  it("is a keyboard-reachable control, and it sits outside the terminal's node", () => {
    monitor(7);
    const { host, unmount } = mount([readout("exitedUnresolved")]);

    const button = press(host);

    expect(button?.tagName).toBe("BUTTON");
    expect(button?.type).toBe("button");
    expect(button?.closest("[class*='host']")).toBe(null);

    button?.focus();
    expect(document.activeElement).toBe(button);

    unmount();
  });

  it("is offered on every exited reading too, because ending is still a choice", () => {
    monitor(7);
    const { host, unmount } = mount([readout("exited", 0)]);

    expect(press(host)).not.toBe(null);

    unmount();
  });
});

/* --------------------------------------------------------------- shape --- */

/*
 * The other half of a hand-written mirror. `RunReadout` is pinned from the Rust
 * side by `a_run_readout_crosses_in_the_shape_the_frontend_declares`, which
 * counts fifteen keys and asserts these spellings; this is the same count and
 * the same tags read from the type this file consumes. A rename on either side
 * is silent on the other, and two assertions is the whole of the defence.
 *
 * Nothing on screen reads either value yet — a later slice puts them there —
 * so what is pinned is the crossing and not a rendering of it.
 */
describe("the silence reading crosses in the shape Rust writes", () => {
  it("fifteen keys cross, and these fifteen", () => {
    expect(Object.keys(readout("live")).sort()).toEqual([
      "code",
      "desynced",
      "dropped",
      "end",
      "ending",
      "folder",
      "held",
      "monitored",
      "over",
      "run",
      "signal",
      "silence",
      "through",
      "ticket",
      "truncated",
    ]);
  });

  it("carries the elapsed inside the reading rather than a number to compare", () => {
    /*
     * The tagged value is the whole of what this side may read: what an elapsed
     * means is a joint predicate over who is waiting and what the ticket says,
     * and a threshold written here would be a second, worse copy of it.
     */
    const quiet: RunSilence = { kind: "quiet", silentForMs: 90_000 };
    const wedged: RunSilence = {
      kind: "wedged",
      why: "awaitingOperator",
      silentForMs: 11_000,
    };

    expect(quiet.silentForMs).toBe(90_000);
    expect(wedged.why).toBe("awaitingOperator");

    // And the readings with nothing to print carry no elapsed at all, because a
    // spent run is never quiet and an exited one is an ending.
    const spent: RunSilence = { kind: "spent" };
    const nothing: RunSilence = { kind: "nothing" };
    expect(Object.keys(spent)).toEqual(["kind"]);
    expect(Object.keys(nothing)).toEqual(["kind"]);
  });

  it("says nothing has classified a run by having no signal at all", () => {
    const observed: RunSignal[] = ["ready", "busy", "idle"];

    expect(observed).toHaveLength(3);
    expect(readout("live").signal).toBe(null);
  });
});

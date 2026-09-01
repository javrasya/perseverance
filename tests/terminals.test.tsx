// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { forgetStow, reparent, stow } from "../src/terminal/reparent";
import { readDelivery, type Delivery } from "../src/terminal/runs";
import { Terminals, type Terminal } from "../src/terminal/terminals";
import type { Geometry } from "../src/stores/ui";

/**
 * One terminal per run, moved and never remounted.
 *
 * Driven against a stand-in rather than against xterm.js, and the reason is the
 * subject: every claim below is about **identity and lifetime** — that the same
 * object is still there, that it was never reset, that its bytes survived being
 * moved — and none of those has anything to do with a canvas, a font stack or a
 * layout engine. `src/terminal/xterm.ts` is the one file that names the
 * emulator, and `tests/dev-web.test.tsx` is what boots it.
 *
 * The stand-in records rather than renders, which is what lets *the terminal was
 * reset exactly once, on the replay* be an assertion rather than a screenshot.
 */
interface Recorded extends Terminal {
  written: Uint8Array[];
  resets: number;
  resizes: Geometry[];
  disposed: boolean;
}

/**
 * The registry hands back a [`Terminal`], which is the interface everything but
 * the factory sees. Every terminal in this file came out of the factory just
 * above, so what is actually there is the recorder — and one narrowing beside
 * the registry is better than the whole file reaching for the array the factory
 * pushed into.
 */
function recorded(terminals: Terminals, run: number): Recorded {
  return terminals.for(run) as Recorded;
}

function aTerminal(): Recorded {
  const element = document.createElement("div");
  const written: Uint8Array[] = [];
  const resizes: Geometry[] = [];
  let resets = 0;
  let disposed = false;

  return {
    element,
    written,
    resizes,
    get resets() {
      return resets;
    },
    get disposed() {
      return disposed;
    },
    write: (bytes) => void written.push(bytes),
    reset: () => void (resets += 1),
    resize: (geometry) => void resizes.push(geometry),
    measure: () => ({ rows: 24, cols: 80 }),
    onData: () => () => {},
    focus: () => {},
    dispose: () => void (disposed = true),
  };
}

function said(terminal: { written: Uint8Array[] }): string {
  return terminal.written
    .map((bytes) => String.fromCharCode(...bytes))
    .join("");
}

function continues(text: string, through: number): Delivery {
  return {
    kind: "continues",
    truncated: false,
    through,
    bytes: new Uint8Array([...text].map((letter) => letter.charCodeAt(0))),
  };
}

function replay(text: string, through: number, truncated = false): Delivery {
  return {
    kind: "replay",
    truncated,
    through,
    bytes: new Uint8Array([...text].map((letter) => letter.charCodeAt(0))),
  };
}

afterEach(() => {
  forgetStow();
  document.body.replaceChildren();
});

describe("one terminal per run", () => {
  it("makes one instance the first time a run is asked for and never a second", () => {
    const made: Terminal[] = [];
    const terminals = new Terminals(() => {
      const terminal = aTerminal();
      made.push(terminal);
      return terminal;
    });

    const first = terminals.for(1);
    const again = terminals.for(1);
    const other = terminals.for(2);

    expect(again).toBe(first);
    expect(other).not.toBe(first);
    expect(made).toHaveLength(2);
    expect(terminals.size).toBe(2);
  });

  it("opens a new run at the geometry every other live run is already at", () => {
    const opened: Geometry[] = [];
    const terminals = new Terminals(
      (geometry) => {
        opened.push(geometry);
        return aTerminal();
      },
      () => ({ rows: 50, cols: 200 }),
    );

    terminals.for(1);

    // Read, never set. A run that arrived and then *resized itself* to the pane
    // would be an arrival-time reflow, which is what the invariant forbids.
    expect(opened).toEqual([{ rows: 50, cols: 200 }]);
    expect(recorded(terminals, 1).resizes).toEqual([]);
  });
});

describe("binding is a move and never a mount", () => {
  it("moves the same node onto the pane, keeping everything written into it", () => {
    const terminals = new Terminals(aTerminal);
    const pane = document.createElement("div");
    document.body.appendChild(pane);

    const terminal = recorded(terminals, 1);
    terminals.apply(1, continues("hello", 5));
    const node = terminal.element;

    terminals.bind(1, pane);

    // The identical object, in the new parent. Not a copy, not a re-creation.
    expect(pane.firstElementChild).toBe(node);
    expect(recorded(terminals, 1)).toBe(terminal);
    expect(said(terminal)).toBe("hello");
    expect(terminal.resets).toBe(0);
  });

  it("puts a terminal back in the stow rather than throwing it away", () => {
    const terminals = new Terminals(aTerminal);
    const pane = document.createElement("div");
    document.body.appendChild(pane);

    terminals.bind(1, pane);
    const terminal = recorded(terminals, 1);
    terminals.apply(1, continues("one", 3));

    terminals.bind(2, pane);

    // Off the pane and still alive: the run that came off holds every byte it
    // ever held, which is what makes coming back to it a continuation.
    expect(pane.contains(terminal.element)).toBe(false);
    expect(stow().contains(terminal.element)).toBe(true);
    expect(recorded(terminals, 1)).toBe(terminal);
    expect(said(terminal)).toBe("one");
    expect(terminal.disposed).toBe(false);
    expect(terminal.resets).toBe(0);
  });

  it("empties the pane without ending anything", () => {
    const terminals = new Terminals(aTerminal);
    const pane = document.createElement("div");
    document.body.appendChild(pane);
    terminals.bind(1, pane);

    terminals.bind(null, pane);

    expect(pane.childElementCount).toBe(0);
    expect(terminals.size).toBe(1);
    expect(recorded(terminals, 1).disposed).toBe(false);
  });

  it("only forgets a run when it is explicitly forgotten", () => {
    const terminals = new Terminals(aTerminal);
    const terminal = recorded(terminals, 1);

    // A run that has merely finished is not forgotten by anything here: the last
    // thing the agent said is the thing the operator is about to read.
    terminals.forget(1);

    expect(terminal.disposed).toBe(true);
    expect(terminals.has(1)).toBe(false);
  });
});

describe("a delivery is applied on exactly the terms it arrived on", () => {
  it("writes a continuation without resetting anything", () => {
    const terminals = new Terminals(aTerminal);
    const terminal = recorded(terminals, 1);

    terminals.apply(1, continues("one", 3));
    terminals.apply(1, continues("two", 6));

    expect(said(terminal)).toBe("onetwo");
    expect(terminal.resets).toBe(0);
  });

  it("resets before a replay, and only before a replay", () => {
    const terminals = new Terminals(aTerminal);
    const terminal = recorded(terminals, 1);

    terminals.apply(1, continues("stale", 5));
    terminals.apply(1, replay("whole ring", 20, true));
    terminals.apply(1, continues(" more", 25));

    // Reset exactly once, on the one delivery that says to. A reset on a
    // continuation would throw away scrollback the harness cannot give back.
    expect(terminal.resets).toBe(1);
    expect(said(terminal)).toBe("stalewhole ring more");
  });

  it("never writes a fact about the stream into the stream", () => {
    const terminals = new Terminals(aTerminal);
    const terminal = recorded(terminals, 1);

    terminals.apply(1, replay("agent output", 12, true));

    // `truncated` is on the delivery and is rendered by the chrome. A terminal
    // with `scrollback lost` typed into its buffer would be a terminal whose
    // contents are no longer only what the agent said.
    expect(said(terminal)).toBe("agent output");
    expect(said(terminal)).not.toMatch(/truncat|lost|dropped/i);
  });
});

describe("one geometry for every live run", () => {
  it("resizes every terminal there is, with the same pair", () => {
    const terminals = new Terminals(aTerminal);
    const first = recorded(terminals, 1);
    const second = recorded(terminals, 2);

    terminals.resize({ rows: 50, cols: 200 });

    expect(first.resizes).toEqual([{ rows: 50, cols: 200 }]);
    expect(second.resizes).toEqual([{ rows: 50, cols: 200 }]);
  });
});

describe("the reparent primitive", () => {
  it("is a move, so a node's own state and listeners survive it", () => {
    const from = document.createElement("div");
    const to = document.createElement("div");
    document.body.append(from, to);

    const node = document.createElement("div");
    const heard = vi.fn();
    node.addEventListener("click", heard);
    node.append(document.createTextNode("held"));
    from.appendChild(node);

    expect(reparent(node, to)).toBe(true);

    expect(to.firstElementChild).toBe(node);
    expect(from.childElementCount).toBe(0);
    expect(node.textContent).toBe("held");
    node.dispatchEvent(new Event("click"));
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("says nothing moved when the node is already where it belongs", () => {
    const into = document.createElement("div");
    document.body.appendChild(into);
    const node = document.createElement("div");

    expect(reparent(node, into)).toBe(true);
    expect(reparent(node, into)).toBe(false);
  });

  it("stows a node that has nowhere to be, in the document rather than out of it", () => {
    const node = document.createElement("div");

    reparent(node, null);

    // In the document, because a terminal outside it has no box and therefore no
    // measurements — an emulator that could not measure would reflow to
    // something absurd the moment it was shown.
    expect(node.isConnected).toBe(true);
    expect(stow().contains(node)).toBe(true);
    expect(stow().getAttribute("aria-hidden")).toBe("true");
  });
});

describe("reading a framed delivery", () => {
  it("reads the header the Rust side writes", () => {
    const frame = new Uint8Array([1, 1, 0, 0, 0, 0, 0, 0, 0x04, 0xd2, 104, 105]);

    const delivery = readDelivery(frame.buffer as ArrayBuffer);

    expect(delivery).toEqual({
      kind: "replay",
      truncated: true,
      through: 1234,
      bytes: new Uint8Array([104, 105]),
    });
  });

  it("reads a continuation, and an offset past four gigabytes", () => {
    const frame = new Uint8Array(HEADER_AND_NOTHING);
    const view = new DataView(frame.buffer);
    view.setUint8(0, 0);
    view.setUint8(1, 0);
    view.setUint32(2, 3, false);
    view.setUint32(6, 7, false);

    const delivery = readDelivery(frame.buffer as ArrayBuffer);

    expect(delivery?.kind).toBe("continues");
    expect(delivery?.truncated).toBe(false);
    // Two 32-bit halves recombined: a run long enough to need the high word is
    // longer than any ring, but the offset it is confirmed against is absolute.
    expect(delivery?.through).toBe(3 * 0x1_0000_0000 + 7);
    expect(delivery?.bytes).toHaveLength(0);
  });

  it("refuses a frame too short to have a header rather than reading past it", () => {
    expect(readDelivery(new Uint8Array([0, 0, 0]).buffer as ArrayBuffer)).toBeNull();
  });
});

const HEADER_AND_NOTHING = 10;

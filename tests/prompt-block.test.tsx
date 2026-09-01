// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { Rendered } from "../src/chrome/started";
import { Pane } from "../src/terminal/Pane";
import { CUSTOM_BADGE, STOCK_BADGE } from "../src/terminal/PromptBlock";
import { forgetPrompts, recordPrompt } from "../src/terminal/prompts";
import { forgetStow } from "../src/terminal/reparent";
import { Terminals, type Terminal } from "../src/terminal/terminals";
import { monitor } from "../src/stores/ui";

/**
 * What the run was told, on screen.
 *
 * Rendered against the same stand-in terminal `tests/terminals.test.tsx` uses —
 * no xterm is instantiated here, because every claim below is about the pane's
 * *chrome*: the count Rust gave, the badge that says whose prose this was, and
 * the prose itself being reachable without being in the way.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function aTerminal(): Terminal {
  return {
    element: document.createElement("div"),
    write: () => {},
    reset: () => {},
    resize: () => {},
    measure: () => null,
    onData: () => () => {},
    dispose: () => {},
  };
}

const PROSE = "You are working on #48 — the prompt block, and nothing else.";

function rendered(origin: Rendered["origin"]): Rendered {
  // Deliberately not `PROSE.length`: the count crosses from Rust as characters
  // and is printed as given, so the test pins that it is *carried* and never
  // recomputed here.
  return { text: PROSE, characters: 1487, origin };
}

function mount(): { host: HTMLElement; unmount: () => void } {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(<Pane terminals={new Terminals(aTerminal)} readouts={[]} />);
  });
  return { host, unmount: () => act(() => root.unmount()) };
}

function block(host: HTMLElement): HTMLDetailsElement | null {
  return host.querySelector("details");
}

afterEach(() => {
  monitor(null);
  forgetPrompts();
  forgetStow();
  document.body.replaceChildren();
});

describe("the opening prompt, collapsed", () => {
  it("prints the count Rust gave and the badge for an operator's own prose", () => {
    recordPrompt(7, rendered("custom"));
    monitor(7);

    const { host, unmount } = mount();
    const summary = block(host)?.querySelector("summary");

    expect(summary?.textContent).toContain(CUSTOM_BADGE);
    expect(summary?.textContent).toContain("1,487 characters");

    unmount();
  });

  it("says stock when the prose was the harness's own", () => {
    recordPrompt(7, rendered("stock"));
    monitor(7);

    const { host, unmount } = mount();
    const summary = block(host)?.querySelector("summary");

    expect(summary?.textContent).toContain(STOCK_BADGE);
    expect(summary?.textContent).not.toContain(CUSTOM_BADGE);

    unmount();
  });

  it("keeps the prose out of the way until it is unfolded, and never in a tooltip", () => {
    recordPrompt(7, rendered("stock"));
    monitor(7);

    const { host, unmount } = mount();
    const details = block(host);
    const summary = details?.querySelector("summary");

    expect(details?.open).toBe(false);
    expect(summary?.textContent).not.toContain(PROSE);
    expect(summary?.getAttribute("title")).toBe(null);
    // The block is chrome beside the emulator's node and never inside it: a
    // child of the host would be reconciled against children React did not put
    // there.
    expect(details?.closest("[class*='host']")).toBe(null);

    if (details !== null) details.open = true;
    expect(details?.textContent).toContain(PROSE);

    unmount();
  });

  it("renders no block at all for a run this window did not start", () => {
    monitor(7);

    const { host, unmount } = mount();

    expect(block(host)).toBe(null);
    expect(host.querySelector("section[aria-label='Terminal']")).not.toBe(null);

    unmount();
  });
});

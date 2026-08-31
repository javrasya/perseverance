// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
/*
 * `EscReadout.jsx` and not `EscReadout`: macOS and Windows filesystems are
 * case-insensitive, and the extension is what pins the import to the component
 * rather than to a sibling that happens to differ only in case.
 */
import { EscReadout } from "../src/keys/EscReadout.jsx";
import { install } from "../src/keys/router";
import { dismiss, monitor, raise } from "../src/stores/ui";

/**
 * The one key an operator cannot work out by looking, written down.
 *
 * The claims here are the two an operator would notice going wrong: the
 * sentence tracks what is actually on the pane, and `Esc` itself is never
 * swallowed on its way to the run.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let mounted: { root: ReturnType<typeof createRoot>; host: HTMLElement } | null = null;

async function paint(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted = { root, host };
  await act(async () => {
    root.render(<EscReadout />);
  });
  return host;
}

afterEach(async () => {
  if (mounted !== null) {
    const { root, host } = mounted;
    await act(async () => root.unmount());
    host.remove();
    mounted = null;
  }
  monitor(null);
  dismiss();
});

describe("the Esc readout", () => {
  it("names the agent CLI while a run is on the pane, and says so when none is", async () => {
    const host = await paint();
    expect(host.textContent).toContain("nothing is bound to this window");

    await act(async () => {
      monitor(9);
    });
    expect(host.textContent).toContain("reaches the agent CLI");

    await act(async () => {
      monitor(null);
    });
    expect(host.textContent).not.toContain("reaches the agent CLI");
  });

  it("names the surface in front, without this component being edited", async () => {
    /*
     * The palette declares `dismisses` on its own row and this readout picks it
     * up: nothing in `EscReadout.tsx` knows a palette exists. That is the whole
     * design — one table, read by the router and by the sentence beside it.
     */
    const host = await paint();
    await act(async () => {
      monitor(9);
      raise("palette");
    });
    expect(host.textContent).toContain("dismisses the command palette");

    await act(async () => {
      dismiss();
    });
    expect(host.textContent).toContain("reaches the agent CLI");
  });

  it("is one line that cannot become two", async () => {
    // A strip that wrapped would take a row off the terminal's box, and the
    // character-cell count with it, every time the sentence changed length.
    const host = await paint();
    const readout = host.querySelector("[data-esc]");
    expect(readout).not.toBeNull();
    expect(readout?.tagName).toBe("P");
  });

  it("never claims Esc itself, in either state", async () => {
    const claimed: string[] = [];
    const uninstall = install({
      press: (id) => claimed.push(id),
      release: () => {},
    });
    await paint();

    for (const run of [null, 9]) {
      await act(async () => {
        monitor(run);
      });
      const escape = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
      await act(async () => {
        window.dispatchEvent(escape);
      });
      expect(escape.defaultPrevented).toBe(false);
    }

    expect(claimed).toEqual([]);
    uninstall();
  });
});

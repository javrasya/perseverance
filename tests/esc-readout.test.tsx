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
import type { WarmRun } from "../src/keys/temperature";
import { dismiss, monitor, raise, setKeyed } from "../src/stores/ui";

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

/*
 * The readouts are handed in the way the pane hands them in, because one of the
 * four destinations cannot be known without them: whether the warm run's child
 * has stopped arrives on the poll and is nowhere in the UI store. Most of the
 * claims below are about states no readout bears on, and pass none.
 */
async function paint(readouts: readonly WarmRun[] = []): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted = { root, host };
  await act(async () => {
    root.render(<EscReadout readouts={readouts} />);
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

    /* Warm and not merely bound: `Esc` is the CLI's only while the CLI has the
       keys, and a run can be on the pane with the keyboard on the map. */
    await act(async () => {
      monitor(9);
      setKeyed(true);
    });
    expect(host.textContent).toContain("reaches the agent CLI");

    await act(async () => {
      monitor(null);
    });
    expect(host.textContent).not.toContain("reaches the agent CLI");
  });

  it("does not promise the CLI over a run whose child has stopped", async () => {
    /*
     * The caret parks on a dead run and stays warm — ADR 0026 — so the
     * temperature printed directly under this line still names the run and says
     * its keystrokes are being kept in a register. Naming the agent CLI here
     * would promise an interrupt over a sentence that has already said there is
     * nothing left to interrupt.
     */
    const host = await paint([{ run: 9, ticket: 128, kind: "work", over: true }]);
    await act(async () => {
      monitor(9);
      setKeyed(true);
    });

    expect(host.textContent).not.toContain("reaches the agent CLI");
    expect(host.textContent).toContain("child has stopped");

    /* And the surface in front still answers first: `Esc` over a palette takes
       the palette away, whatever is parked underneath it. */
    await act(async () => {
      raise("palette");
    });
    expect(host.textContent).toContain("dismisses the command palette");
  });

  it("names the CLI when the readout it has is for some other run", async () => {
    /* The array is refreshed several times a second and the warm run may have
       changed between two of them, so the parked sentence is owed to the warm
       run's own readout or to no readout at all. */
    const host = await paint([{ run: 4, ticket: 128, kind: "work", over: true }]);
    await act(async () => {
      monitor(9);
      setKeyed(true);
    });

    expect(host.textContent).toContain("reaches the agent CLI");
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
      setKeyed(true);
      raise("palette");
    });
    expect(host.textContent).toContain("dismisses the command palette");

    await act(async () => {
      dismiss();
    });
    expect(host.textContent).toContain("reaches the agent CLI");

    /* The second surface, and the actual proof: the keys page landed as one row
       with `dismisses` on it, and this sentence names it although nothing in
       `EscReadout.tsx` has been touched since the palette. */
    await act(async () => {
      raise("keys");
    });
    expect(host.textContent).toContain("dismisses the keys page");
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
        setKeyed(run !== null);
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

// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Detail } from "../src/detail/Detail.jsx";
import { Dock } from "../src/detail/Dock.jsx";
import { DOCKS } from "../src/detail/docks";
import { FIXTURES } from "../src/snapshot/fixtures";
import type { Map, Model } from "../src/snapshot/model.generated";
import { Route } from "../src/views/route/Route.jsx";
import { VIEW_SURFACES } from "./conformance/support/views";

/**
 * The chrome #54 added, read against the contract without a browser.
 *
 * The encoding contract is checked by a Playwright suite under
 * `tests/conformance/`, and several of its checks are scoped to the **page**
 * rather than to a view root — rule 7's corollary: chrome the contract binds is
 * delivered to the chrome layer, and a check scoped to a view root would pass
 * vacuously over it. The detail panel and the three docks are exactly such
 * chrome, and they are now in every page-scoped rendering that suite drives.
 * That suite cannot run in this checkout — neither `@playwright/test` nor its
 * browsers are installed — so what is pinnable browserlessly is pinned here, in
 * the shape this repo already uses: the selectors the suite declares, exercised
 * in vitest before any browser sees them.
 *
 * Two claims, and no third one pretending to be a browser:
 *
 * - **Rule 4's hooks are the ones the suite declares.** The fog region's text
 *   now goes through the panel's markdown renderer, and the rule-4 check finds
 *   the region by the selectors in `tests/conformance/support/views.ts`. They
 *   are imported here rather than retyped, so a rename in the DOM that the
 *   suite would have caught in WebKit fails in `npm test` instead.
 * - **The new chrome contributes nothing the page-scoped walks look for.**
 *   Rule 5 forbids a progress element anywhere on the page; rule 10 forbids
 *   load-bearing information behind a native `title`.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let mounted: { root: ReturnType<typeof createRoot>; host: HTMLElement } | null = null;

async function paint(element: React.ReactElement): Promise<HTMLElement> {
  if (mounted === null) {
    const host = document.createElement("div");
    document.body.appendChild(host);
    mounted = { root: createRoot(host), host };
  }
  const { root, host } = mounted;

  await act(async () => {
    root.render(element);
  });

  return host;
}

afterEach(async () => {
  if (mounted === null) return;
  const { root, host } = mounted;
  mounted = null;
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

function awkward(): Map {
  const map = FIXTURES["awkward-map"].model.map;
  if (map === null) throw new Error("the awkward fixture has no map");
  return map;
}

const withFog = (fog: Map["fog"]): Model => ({ map: { ...awkward(), fog } });

/** A node to select, so the panel is asserted with a card in it and not only empty. */
function firstNode(): number {
  const node = awkward().nodes[0];
  if (node === undefined) throw new Error("the awkward fixture has nodes");
  return node.number;
}

describe("the fog region answers to the selectors the conformance suite declares", () => {
  const surface = VIEW_SURFACES.route;
  const fog = surface.fog;
  if (fog === null) throw new Error("The Route declares a fog surface");

  const region = async (model: Model) => {
    const host = await paint(<Route model={model} selected={null} onSelect={() => {}} />);
    expect(host.querySelector(surface.root)).not.toBeNull();
    return host.querySelector(fog.region);
  };

  it("stands the unsurveyed absence in a slot of its own, with no numeral anywhere in it", async () => {
    const unsurveyed = await region(withFog({ fog: "unsurveyed" }));

    expect(unsurveyed).not.toBeNull();
    expect(unsurveyed?.querySelector(fog.unsurveyed)).not.toBeNull();
    expect(unsurveyed?.querySelector(fog.count)).toBeNull();
    /*
     * Rule 4 in one line: a region nobody surveyed may not print a digit, and
     * the reading has no section text to have carried one in.
     */
    expect(unsurveyed?.textContent ?? "").not.toMatch(/[0-9]/);
  });

  it("puts the surveyed count in the numeral slot and the section's text beside it", async () => {
    const surveyed = await region(
      withFog({ fog: "surveyed", region: { count: 2, text: "- one\n- two" } }),
    );

    expect(surveyed?.querySelector(fog.count)?.textContent).toBe("2");
    expect(surveyed?.querySelector(fog.unsurveyed)).toBeNull();
    /* The section beside the numeral is the text itself, verbatim: ADR 0016's
       region is one unmodified text node and the panel's subset renderer is
       not pointed at it. */
    expect(surveyed?.querySelector("pre")?.textContent).toBe("- one\n- two");
  });
});

describe("the panel and the docks put nothing on the page the contract forbids", () => {
  /** Rule 5's own selector, and rule 10's, as the page-scoped checks spell them. */
  const PROGRESS = "progress, meter, [role=progressbar], [aria-valuenow]";
  const HOVER_DISCLOSURE = "[title]";

  /**
   * The chrome, all of it at once.
   *
   * `Dock` appends the pass to its host by `reparent` and renders nothing
   * inside it, so a dock mounted without the shell around it is the dock's own
   * frame — which is the DOM under test here. One dock holds a pass it borrowed
   * and two do not, so all three of a dock's sentences are on screen.
   */
  function Chrome({ model, selection }: { model: Model; selection: number | null }) {
    const host = useRef<HTMLDivElement>(null);
    return (
      <>
        <Detail model={model} selection={selection} />
        {DOCKS.map((dock) => (
          <Dock
            key={dock}
            dock={dock}
            occupant="spine"
            chosen="runBar"
            hostRef={host}
            onChoose={() => {}}
          />
        ))}
      </>
    );
  }

  const states: readonly (readonly [Model, number | null])[] = [
    [FIXTURES["awkward-map"].model, null],
    [FIXTURES["awkward-map"].model, firstNode()],
    [{ map: null }, null],
  ];

  it("draws no progress bar, meter or valued widget in any state", async () => {
    for (const [model, selection] of states) {
      const host = await paint(<Chrome model={model} selection={selection} />);

      expect(host.querySelectorAll(PROGRESS)).toHaveLength(0);
    }
  });

  it("hides nothing behind a native title, in any state", async () => {
    /*
     * `title=` does appear in `src/detail/Detail.tsx` — as a prop on the local
     * `Absent` component, which prints it as a paragraph. This is the assertion
     * that it never becomes a DOM attribute, which is the only form rule 10
     * cares about.
     */
    for (const [model, selection] of states) {
      const host = await paint(<Chrome model={model} selection={selection} />);

      expect(host.querySelectorAll(HOVER_DISCLOSURE)).toHaveLength(0);
    }
  });
});

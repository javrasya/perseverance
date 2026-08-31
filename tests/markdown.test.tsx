// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Markdown, blocksOf, inlinesOf } from "../src/detail/markdown";

/**
 * The markdown subset, and the sanitisation that is not a filter.
 *
 * The claim under test is structural: nothing in the renderer can produce
 * markup out of source text, so hostile input has to land as characters. That
 * is asserted the only way it can be — by feeding it the attacks and counting
 * the elements that came out — and `tests/no-raw-html.test.ts` holds the other
 * half, that no route from string to markup exists anywhere under `src/`.
 */

/* Same reason as `tests/route-view.test.tsx`: a suite that always warns is a
   suite whose warnings nobody reads. */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let mounted: { root: ReturnType<typeof createRoot>; host: HTMLElement } | null = null;

async function paint(source: string): Promise<HTMLElement> {
  if (mounted === null) {
    const host = document.createElement("div");
    document.body.appendChild(host);
    mounted = { root: createRoot(host), host };
  }
  const { root, host } = mounted;

  await act(async () => {
    root.render(<Markdown source={source} />);
  });

  return host;
}

afterEach(async () => {
  if (mounted === null) return;
  const { root, host } = mounted;
  mounted = null;
  await act(async () => root.unmount());
  host.remove();
});

describe("raw HTML in an issue body is text and can never be anything else", () => {
  it("renders an image tag with a handler as the characters somebody typed", async () => {
    const attack = `<img src=x onerror=alert(1)>`;
    const host = await paint(attack);

    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toBe(attack);
    // Nothing carries an attribute the source asked for, because no attribute
    // was ever parsed: only elements this renderer names exist.
    expect(
      [...host.querySelectorAll("*")].every((el) => el.getAttribute("onerror") === null),
    ).toBe(true);
  });

  it("renders a script tag, and its contents, as text", async () => {
    const host = await paint(`<script>alert(document.cookie)</script>`);

    expect(host.querySelector("script")).toBeNull();
    expect(host.textContent).toContain("alert(document.cookie)");
  });

  it("renders raw attributes and a style block as text", async () => {
    const host = await paint(`<div style="position:fixed" onclick="steal()">gone</div>`);

    expect(host.querySelector("div [style]")).toBeNull();
    expect(host.querySelectorAll("div")).toHaveLength(1); // the renderer's own wrapper
    expect(host.textContent).toContain(`onclick="steal()"`);
  });

  it("never makes an anchor, so a javascript: URL has nothing to hang on", async () => {
    const host = await paint(`[press me](javascript:alert(1))`);

    expect(host.querySelector("a")).toBeNull();
    // Both halves on screen: the words and where they claimed to point, so the
    // two can be compared by eye.
    expect(host.textContent).toContain("press me");
    expect(host.textContent).toContain("javascript:alert(1)");
  });

  it("adds no event handler to anything it does build", async () => {
    const host = await paint(`**bold** and \`code\` and #12`);
    const handlers = [...host.querySelectorAll("*")].flatMap((el) =>
      [...el.attributes].map((attribute) => attribute.name),
    );

    expect(handlers.filter((name) => name.startsWith("on"))).toEqual([]);
  });
});

describe("the subset renders, and everything outside it stays literal", () => {
  it("marks up emphasis, strong, inline code and a fence", async () => {
    const host = await paint("*soft* and **hard** and `literal`\n\n```\nfenced\n```");

    expect(host.querySelector("em")?.textContent).toBe("soft");
    expect(host.querySelector("strong")?.textContent).toBe("hard");
    expect(host.querySelector("p code")?.textContent).toBe("literal");
    expect(host.querySelector("pre code")?.textContent).toBe("fenced");
  });

  it("keeps a fence verbatim, markup and all", async () => {
    const host = await paint("```\n<b>not bold</b>\n```");

    expect(host.querySelector("b")).toBeNull();
    expect(host.querySelector("pre")?.textContent).toBe("<b>not bold</b>");
  });

  it("draws a bullet list and keeps a paragraph's own line breaks", async () => {
    const host = await paint("- one\n- two\n\nfirst\nsecond");

    expect([...host.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "one",
      "two",
    ]);
    expect(host.querySelectorAll("p br")).toHaveLength(1);
  });

  it("names an issue reference without linking it", async () => {
    const host = await paint("blocked by #54, not by ##54");

    expect(host.querySelector("a")).toBeNull();
    expect(host.textContent).toBe("blocked by #54, not by ##54");
  });

  it("prints what it does not know as itself, and drops nothing", async () => {
    const outside = "# heading\n\n> quote\n\n| a | b |\n\n1. first";
    const host = await paint(outside);

    expect(host.querySelector("h1")).toBeNull();
    expect(host.querySelector("blockquote")).toBeNull();
    expect(host.querySelector("table")).toBeNull();
    expect(host.querySelector("ol")).toBeNull();
    for (const line of outside.split("\n\n")) {
      expect(host.textContent).toContain(line);
    }
  });

  it("leaves an unmatched marker alone", () => {
    // A pair of markers is emphasis wherever it lands, arithmetic included —
    // the subset is deliberately naive about that, and prose is what arrives.
    expect(inlinesOf("2 * 3 * 4")).toEqual([
      { kind: "text", text: "2 " },
      { kind: "emphasis", children: [{ kind: "text", text: " 3 " }] },
      { kind: "text", text: " 4" },
    ]);
    expect(inlinesOf("a lone * marker")).toEqual([{ kind: "text", text: "a lone * marker" }]);
    expect(inlinesOf("`unclosed")).toEqual([{ kind: "text", text: "`unclosed" }]);
  });

  it("runs an unterminated fence to the end rather than reverting to prose", () => {
    expect(blocksOf("```\nstill code")).toEqual([{ kind: "code", text: "still code" }]);
  });

  it("has nothing to say about empty source, and says it without a box", async () => {
    const host = await paint("   \n\n  ");

    expect(host.textContent).toBe("");
    expect(blocksOf("")).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { findMarkupSinks, format } from "./support/checks";
import { collect } from "./support/sources";

/**
 * Text never becomes markup in this app.
 *
 * The detail panel prints a string that was typed into a GitHub issue by
 * whoever holds the map — a cut reason — so it can carry `<script>`, an
 * `onerror`, or anything else a body can hold. The panel neither sanitises it
 * nor asks GitHub to render it: it builds React elements out of a parsed
 * subset, and React escapes every string it is given.
 *
 * That argument is only worth anything while the escape hatch is absent from
 * the whole of `src/`. One `innerHTML` in an unrelated component and the
 * property stops being structural — it becomes a convention, and a convention
 * is what the next person reaching for the fast way to draw a table does not
 * know about. So the check runs over every source file rather than over the
 * renderer, and it is proven against known-bad input first, because a check
 * nobody has seen fail is indistinguishable from one that cannot.
 */
describe("no source file turns a string into markup", () => {
  it("the check catches every route from text to DOM", () => {
    expect(findMarkupSinks(`<div dangerouslySetInnerHTML={{ __html: body }} />`)).toHaveLength(1);
    expect(findMarkupSinks(`node.innerHTML = reason;`)).toHaveLength(1);
    // `+=` is the same route: appending markup parses it exactly as assigning
    // it does, and a pattern anchored on `=` alone would pass this file clean.
    expect(findMarkupSinks(`node.innerHTML += reason;`)).toHaveLength(1);
    expect(findMarkupSinks(`el.outerHTML = rendered`)).toHaveLength(1);
    expect(findMarkupSinks(`el.outerHTML += rendered`)).toHaveLength(1);
    expect(findMarkupSinks(`host.insertAdjacentHTML("beforeend", text)`)).toHaveLength(1);
    // The two ways to reach a parser without ever naming `innerHTML`.
    expect(findMarkupSinks(`host.setHTMLUnsafe(text)`)).toHaveLength(1);
    expect(findMarkupSinks(`range.createContextualFragment(text)`)).toHaveLength(1);
    expect(findMarkupSinks(`const doc = new DOMParser().parseFromString(text, "text/html")`))
      .toHaveLength(1);
    expect(findMarkupSinks(`const doc = Document.parseHTMLUnsafe(text)`)).toHaveLength(1);
    expect(findMarkupSinks(`document.write(text)`)).toHaveLength(1);
  });

  it("the check does not fire on reading the DOM or on ordinary code", () => {
    expect(findMarkupSinks(`expect(host.innerHTML).toContain("x")`)).toEqual([]);
    expect(findMarkupSinks(`const text = element.textContent ?? "";`)).toEqual([]);
    expect(findMarkupSinks(`root.render(<Markdown source={reason} />)`)).toEqual([]);
  });

  it("nothing under src/ holds one", () => {
    const offences = collect([".ts", ".tsx"])
      .map((file) => format(file.path, findMarkupSinks(file.text)))
      .filter((report) => report.length > 0);

    expect(offences.join("\n")).toBe("");
  });
});

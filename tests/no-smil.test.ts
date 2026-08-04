import { describe, expect, it } from "vitest";
import { findSmil, format } from "./support/checks";
import { collectMarkupAndStyles } from "./support/sources";

describe("SMIL is rejected by a check, not by convention", () => {
  it("the check catches every SMIL element, written or constructed", () => {
    expect(findSmil(`<circle><animate attributeName="r" /></circle>`)).toHaveLength(1);
    expect(findSmil(`<animateTransform type="rotate"/>`)).toHaveLength(1);
    expect(findSmil(`<animateMotion dur="2s"/>`)).toHaveLength(1);
    expect(findSmil(`<set attributeName="fill" to="red"/>`)).toHaveLength(1);
    expect(findSmil(`<mpath href="#p"/>`)).toHaveLength(1);
    expect(
      findSmil(`el.appendChild(document.createElementNS(NS, "animate"))`),
    ).toHaveLength(1);
  });

  it("the check does not fire on ordinary TypeScript or CSS", () => {
    expect(findSmil(`const seen = new Set<string>();`)).toEqual([]);
    expect(findSmil(`if (a < settings.max) return;`)).toEqual([]);
    expect(findSmil(`type Rows = Map<Set<number>, string>;`)).toEqual([]);
    expect(findSmil(`animation: pulse 1s var(--s-motion-ease);`)).toEqual([]);
    expect(findSmil(`<animated />`)).toEqual([]);
  });

  it("no source file animates with SMIL", () => {
    const offences = collectMarkupAndStyles()
      .map((file) => format(file.path, findSmil(file.text)))
      .filter((report) => report.length > 0);

    expect(offences.join("\n")).toBe("");
  });
});

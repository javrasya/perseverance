import { describe, expect, it } from "vitest";
import {
  DEFAULT_DOCK,
  DOCKS,
  DOCK_NAMES,
  DOCK_PRESSES,
  TERMINAL_DOCK_FLOOR,
  borrowedBecause,
  dockedElsewhere,
  effectiveDock,
  onTerminalSide,
  type Dock,
} from "../src/detail/docks";

/**
 * Where the boarding pass is, as arithmetic.
 *
 * No DOM anywhere below, which is the point of the module: every claim the
 * shell makes about which dock holds the panel is checkable without mounting
 * anything, exactly the way `tests/dial.test.ts` checks the dial.
 */

describe("the spine is the dock no dial position can take away", () => {
  it("is the one the pass starts at", () => {
    expect(DEFAULT_DOCK).toBe("spine");
  });

  it("keeps the pass at any width, including none", () => {
    for (const width of [0, 1, TERMINAL_DOCK_FLOOR - 1, 4000]) {
      expect(effectiveDock("spine", width)).toBe("spine");
    }
  });

  it("is the only dock that does not ride on the terminal side", () => {
    expect(DOCKS.filter((dock) => !onTerminalSide(dock))).toEqual(["spine"]);
  });
});

describe("a dock on the terminal side is borrowed from, never rewritten", () => {
  const collapsing: readonly Dock[] = ["runBar", "rack"];

  it("holds the pass while the terminal side is wide enough to read it in", () => {
    for (const dock of collapsing) {
      expect(effectiveDock(dock, TERMINAL_DOCK_FLOOR)).toBe(dock);
      expect(effectiveDock(dock, TERMINAL_DOCK_FLOOR + 1)).toBe(dock);
    }
  });

  it("lends the pass to the spine the moment it cannot be seen there", () => {
    for (const dock of collapsing) {
      // The `map` detent: the terminal side is worth nothing at all, and it
      // clips its own overflow — a pass docked there would not be narrow, it
      // would be invisible with nothing said, which is the blank rectangle the
      // panel's five never-empty states exist to forbid.
      expect(effectiveDock(dock, 0)).toBe("spine");
      expect(effectiveDock(dock, TERMINAL_DOCK_FLOOR - 1)).toBe("spine");
    }
  });

  it("springs back, because the choice is what was kept", () => {
    // The same value, read twice at two widths. Nothing here remembers the
    // borrowing, which is what makes widening the dial enough to undo it.
    expect(effectiveDock("rack", 0)).toBe("spine");
    expect(effectiveDock("rack", 1200)).toBe("rack");
  });
});

describe("no dock is ever silent", () => {
  it("names the occupant, in words, wherever it is", () => {
    for (const dock of DOCKS) {
      expect(dockedElsewhere(dock)).toContain(DOCK_NAMES[dock]);
    }
  });

  it("says why it is holding a pass it was not sent, and how to send it back", () => {
    const said = borrowedBecause("rack", "spine");
    expect(said).toContain(DOCK_NAMES.rack);
    expect(said).toContain("Widen");
  });

  it("says nothing of the kind when the pass is where it was sent", () => {
    for (const dock of DOCKS) {
      expect(borrowedBecause(dock, dock)).toBeNull();
    }
  });

  it("offers a press for every dock", () => {
    for (const dock of DOCKS) {
      expect(DOCK_PRESSES[dock].length).toBeGreaterThan(0);
    }
  });
});

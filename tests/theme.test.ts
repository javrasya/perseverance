// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyThemePreference,
  readThemePreference,
  writeThemePreference,
} from "../src/theme/theme";

describe("theme follows the OS, with an explicit override persisted globally", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  it("follows the OS until told otherwise", () => {
    expect(readThemePreference()).toBe("system");

    applyThemePreference("system");

    // No attribute means no override, which is how the stylesheet's
    // prefers-color-scheme branch stays in charge.
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("an explicit override survives a restart", () => {
    writeThemePreference("dark");

    // A fresh boot reads the same store the last session wrote.
    expect(readThemePreference()).toBe("dark");
  });

  it("returning to OS clears the override rather than pinning the current look", () => {
    writeThemePreference("light");
    writeThemePreference("system");

    expect(readThemePreference()).toBe("system");
    expect(window.localStorage.getItem("perseverance.theme")).toBeNull();
  });

  it("the override is one attribute on the root, in both directions", () => {
    applyThemePreference("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    applyThemePreference("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");

    applyThemePreference("system");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("a stored value that is not a preference is ignored", () => {
    window.localStorage.setItem("perseverance.theme", "sepia");

    expect(readThemePreference()).toBe("system");
  });
});

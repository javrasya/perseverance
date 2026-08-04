import { describe, expect, it } from "vitest";
import {
  definedTokens,
  findTierViolations,
  format,
  type TierContext,
} from "./support/checks";
import { collectStylesheets } from "./support/sources";

const PRIMITIVE_PATH = "src/styles/tokens/primitive.css";
const SEMANTIC_PATH = "src/styles/tokens/semantic.css";

function context(): TierContext {
  const stylesheets = collectStylesheets();
  const semantic = stylesheets.find((file) => file.path === SEMANTIC_PATH);
  if (!semantic) throw new Error(`missing ${SEMANTIC_PATH}`);
  return {
    primitivePath: PRIMITIVE_PATH,
    semanticPath: SEMANTIC_PATH,
    semanticTokens: definedTokens(semantic.text, "s"),
  };
}

describe("three token tiers, and the middle one is the rule", () => {
  it("the tiers exist and are not empty", () => {
    const stylesheets = collectStylesheets();
    const primitive = stylesheets.find((f) => f.path === PRIMITIVE_PATH);
    const semantic = stylesheets.find((f) => f.path === SEMANTIC_PATH);

    expect(definedTokens(primitive!.text, "p").size).toBeGreaterThan(0);
    expect(definedTokens(semantic!.text, "s").size).toBeGreaterThan(0);
    expect(definedTokens(semantic!.text, "p").size).toBe(0);
  });

  it("the check catches each way the middle tier stops being the rule", () => {
    const ctx: TierContext = {
      primitivePath: PRIMITIVE_PATH,
      semanticPath: SEMANTIC_PATH,
      semanticTokens: new Set(["--s-ink-primary"]),
    };
    const check = (text: string) =>
      findTierViolations({ path: "src/views/route/Route.module.css", text }, ctx);

    expect(check(`.node { color: var(--p-gray-900); }`)).toHaveLength(1);
    expect(check(`.node { --p-local: 4px; }`)).toHaveLength(1);
    expect(check(`.node { color: var(--s-ink-primaryy); }`)).toHaveLength(1);
    expect(check(`.node { color: var(--c-never-defined); }`)).toHaveLength(1);
    expect(check(`.node { color: #ff0000; }`)).toHaveLength(1);
    expect(check(`.node { background: rgb(0 0 0 / 50%); }`)).toHaveLength(1);
  });

  it("the check passes legitimate tier-2 and tier-3 use", () => {
    const ctx: TierContext = {
      primitivePath: PRIMITIVE_PATH,
      semanticPath: SEMANTIC_PATH,
      semanticTokens: new Set(["--s-ink-primary"]),
    };

    expect(
      findTierViolations(
        {
          path: "src/views/route/Route.module.css",
          text: `.node {\n  --c-node-ink: var(--s-ink-primary);\n  color: var(--c-node-ink);\n  background: transparent;\n}`,
        },
        ctx,
      ),
    ).toEqual([]);
  });

  it("no stylesheet reaches past the semantic tier", () => {
    const ctx = context();
    const offences = collectStylesheets()
      .map((file) => format(file.path, findTierViolations(file, ctx)))
      .filter((report) => report.length > 0);

    expect(offences.join("\n")).toBe("");
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RULES, ruleById } from "../src/contract/rules";
import { VIEWS } from "../src/views/views";
import { MATRIX_PATH, readDeclaration } from "./support/contract";
import { declarationStatus, enforcedBy, renderMatrix } from "./support/matrix";
import { REPO_ROOT } from "./support/sources";

/**
 * The matrix is an instrument, so the only thing asserted about it is that it
 * is current.
 *
 * Nothing here may assert conformance. A test that read a cell and went red
 * would make the artifact the contract, and then a rule would be kept by
 * whoever last regenerated a file — which is the failure this whole ticket is
 * about. Conformance is settled by the constructions, by #43's assertions, and
 * by the declarations; this page only shows where each of those stands.
 */

const declarations = VIEWS.map((view) => readDeclaration(view));

describe("the rendered matrix", () => {
  it("is up to date with the registry and the declarations", () => {
    const rendered = renderMatrix(RULES, declarations);
    const onDisk = readFileSync(join(REPO_ROOT, MATRIX_PATH), "utf8");

    expect(onDisk, `stale — run \`npm run contract:matrix\``).toBe(rendered);
  });

  it("puts one row per rule and no row per rendered state", () => {
    const rendered = renderMatrix(RULES, declarations);
    const rows = rendered
      .split("\n")
      .filter((line) => /^\| \d+ \| /.test(line));

    expect(rows).toHaveLength(RULES.length);
  });

  it("says where each rule is enforced without inventing an appeal", () => {
    expect(enforcedBy(ruleById(7))).toContain("src/views/views.ts");
    expect(enforcedBy(ruleById(5))).toMatch(/#43/);
    expect(enforcedBy(ruleById(11))).toMatch(/declaration only/);

    for (const view of declarations) {
      expect(declarationStatus(ruleById(1), view)).toBe("no slot");
      expect(declarationStatus(ruleById(9), view)).toBe("no slot");
      expect(declarationStatus(ruleById(13), view)).toMatch(/^declared/);
    }
  });
});

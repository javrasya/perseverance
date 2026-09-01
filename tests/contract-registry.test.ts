import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEVIATION,
  RULES,
  type Rule,
  type RuleId,
  deviationFor,
  renderBoundRules,
  ruleById,
} from "../src/contract/rules";
import { viewPropsFields } from "./support/checks";
import { REPO_ROOT, collect } from "./support/sources";

/**
 * The registry is the contract's own record, so what is asserted here is that
 * it is complete, that it classifies, and — the case that matters — that the
 * mechanisms it names are still in the tree.
 *
 * A registry entry is a pointer at a construction somewhere else. Left
 * unchecked it is a claim about the day it was written: the prop type widens,
 * the schema grows a column, and rule 7 goes on saying *structural* in a file
 * nobody re-reads. The structural cases below are the registry reading its own
 * pointers.
 */

const REGISTRY = "src/contract/rules.ts";
const STRUCTURAL: readonly RuleId[] = [1, 7, 8];

function registrySource(): string {
  const file = collect([".ts"]).find((source) => source.path === REGISTRY);
  if (!file) throw new Error(`missing ${REGISTRY}`);
  return file.text;
}

describe("thirteen rules, each classified", () => {
  it("holds every rule once, 1 through 13", () => {
    expect(RULES).toHaveLength(13);
    expect(RULES.map((rule) => rule.id)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
    ]);
    expect(RULES.map((rule) => rule.name)).toEqual([
      ...new Set(RULES.map((rule) => rule.name)),
    ]);
    expect(ruleById(9).id).toBe(9);
  });

  it("declares a subject, a tier and a check for each", () => {
    for (const rule of RULES) {
      expect(["codebase", "rendering", "reading"]).toContain(rule.subject);
      expect(["structural", "asserted", "judged"]).toContain(rule.tier);

      // A check that names no mechanism is a tier assignment with nothing under
      // it, and the shortest way to write one is to restate the rule. A judged
      // rule's check is allowed to be one line because it points at the floor
      // and the residue, so the three are weighed together.
      const prose = [rule.check, rule.assertedFloor, rule.judgedResidue]
        .filter((part) => part !== undefined)
        .join(" ");
      expect(prose.length).toBeGreaterThan(120);
      expect(rule.check.length).toBeGreaterThan(0);
      expect(rule.check).not.toBe(rule.text);
      expect(rule.text.length).toBeGreaterThan(0);
    }
  });

  it("says which rules need a rendering without naming a single cell", () => {
    // #43 fans out over these; the fixture space is `src/snapshot/fixtures.ts`
    // and stays there. Render-boundness is where the check runs, not how weak
    // the automation is: a structural rule never needs a rendering, but the
    // converse does not hold — rule 9 is asserted and still settled against
    // stylesheet text, so the two must stay separable.
    const renderBound = renderBoundRules().map((rule) => rule.id);
    expect(renderBound).toHaveLength(9);
    expect(renderBound).not.toContain(9);
    for (const id of STRUCTURAL) expect(ruleById(id).renderBound).toBe(false);

    const source = registrySource();
    expect(source).not.toMatch(/\bimport\b/);
    expect(source).not.toMatch(/FIXTURE|fixtureNamed|DEFAULT_VIEW|prefers-color-scheme/);
  });
});

describe("deviation is a function of tier, and only judged has a route", () => {
  it("gives every rule the one route its tier carries", () => {
    for (const rule of RULES) {
      // Identity, not equality: a per-rule copy of the policy is a place for
      // one rule to quietly acquire an appeal the tier does not grant.
      expect(deviationFor(rule)).toBe(DEVIATION[rule.tier]);
    }

    expect(DEVIATION.structural.declarable).toBe(false);
    expect(DEVIATION.asserted.declarable).toBe(false);
    expect(DEVIATION.judged.declarable).toBe(true);
  });

  it("leaves rules 1, 7 and 8 with nothing to declare", () => {
    for (const id of STRUCTURAL) {
      const rule = ruleById(id);
      expect(rule.tier).toBe("structural");
      expect(deviationFor(rule).declarable).toBe(false);
      expect(rule.assertedFloor).toBeUndefined();
      expect(rule.judgedResidue).toBeUndefined();
      expect(rule.mechanismPath).toBeDefined();
    }
  });

  it("keeps the human remainder on three rules and the whole claim on two", () => {
    const residues = RULES.filter((rule) => rule.judgedResidue !== undefined);
    for (const rule of residues) expect(rule.tier).toBe("judged");
    expect(residues.map((rule) => rule.id)).toEqual([4, 12, 13]);

    // Wholly judged: 10 has a floor under it, 11 has none, and neither has a
    // remainder because neither has an asserted half for one to be left over
    // from.
    expect(ruleById(10).judgedResidue).toBeUndefined();
    expect(ruleById(11).judgedResidue).toBeUndefined();
    expect(ruleById(11).assertedFloor).toBeUndefined();
  });
});

describe("the two restatements, and the enumeration", () => {
  it("registers rule 5 in the positive", () => {
    const rule = ruleById(5);
    expect(rule.text).toContain("No progress bar");
    expect(rule.restatement).toMatch(/^Progress is exactly three numerals/);
    expect(rule.restatement).not.toMatch(/\bno progress bar\b/i);
    expect(rule.check).toMatch(/positive form/);
  });

  it("registers rule 7 as prop narrowing rather than an assertion per view", () => {
    const rule = ruleById(7);
    expect(rule.restatement).toMatch(/ViewProps/);
    expect(rule.check).toContain("src/views/views.ts");
  });

  it("registers rule 9 as an enumeration over the stylesheets, settlement and all", () => {
    const rule = ruleById(9);
    expect(rule.tier).toBe("asserted");
    expect(rule.check).toMatch(/stylesheet/i);
    expect(rule.check).toMatch(/animation/);
    expect(rule.check).toMatch(/no-smil/);

    // The Route's animation rides on *claimed*, not on running-vs-stale,
    // and an asserted rule has no deviation route to file that under. #43
    // settled it in the entry rather than deferring it, so the reasoning lives
    // in `settlement` and not in `tension` — the matrix files the two under
    // separate headings, and leaving it under the open one would make the page
    // read as owing work that is done.
    expect(rule.settlement).toBeDefined();
    expect(rule.settlement).toMatch(/markClaimed/);
    expect(rule.tension).toBeUndefined();
    expect(deviationFor(rule).declarable).toBe(false);
  });
});

describe("the structural mechanisms are still where the registry points", () => {
  it("finds each named file", () => {
    for (const id of STRUCTURAL) {
      const path = ruleById(id).mechanismPath!;
      expect(existsSync(join(REPO_ROOT, path))).toBe(true);
    }
  });

  it("still hands a view the model and nothing the record rides on (rule 7)", () => {
    const contract = collect([".ts"]).find(
      (file) => file.path === ruleById(7).mechanismPath,
    );
    const fields = viewPropsFields(contract?.text ?? "");
    if (fields === null) throw new Error("src/views/views.ts declares no ViewProps");

    expect(fields).toContain("model: Model");
    expect(fields.join(";")).not.toMatch(/snapshot/i);
    expect(fields.join(";")).not.toMatch(/\bledger\b/i);
  });

  it("catches a prop type that widened to the snapshot", () => {
    const widened = `export interface ViewProps {
      model: Model;
      snapshot: Snapshot;
    }`;

    expect(viewPropsFields(widened)).toEqual(["model: Model", "snapshot: Snapshot"]);
    expect(viewPropsFields("export interface Other { model: Model }")).toBeNull();
  });

  it("stores no node position anywhere (rule 8)", () => {
    const schema = readFileSync(join(REPO_ROOT, "crates/store/src/schema.rs"), "utf8");
    // Down to the test module and no further, the way `crates/app` reads this
    // same file: that crate's own tests write tables nobody ships.
    const shipped = schema.split("#[cfg(test)]")[0] ?? "";

    /*
     * `map_view` exists now — #52 gave the dial a durable home — so the check
     * is the table's columns rather than its absence. What it holds is where
     * the *dial* was: one seam per map, a fact about a window.
     */
    expect(shipped).toMatch(/CREATE TABLE map_view/);
    const body = (shipped.split("CREATE TABLE map_view (")[1] ?? "").split("PRIMARY KEY")[0] ?? "";
    const columns = body
      .split("\n")
      .map((line) => line.trim().split(/\s+/)[0])
      .filter((name) => name !== "");
    expect(columns).toEqual(["folder_id", "map_number", "layout_json"]);

    /*
     * And the column itself proves nothing: `layout_json` is `TEXT`, and
     * `{"nodes":…}` is a string SQLite would take without a migration. So the
     * narrowing that actually holds rule 8 is one level up — the only writer of
     * that column, whose whole payload is one number, and the envelope struct
     * whose only named field is the dial. Deep Field's plate arrives as a field
     * here, and that is the moment rule 8's entry stops being structural.
     */
    const seam = readFileSync(join(REPO_ROOT, ruleById(8).mechanismPath!), "utf8");
    const writer = /fn remember_map_position\(([^)]*)\)/.exec(seam);
    if (writer === null) throw new Error("crates/app/src/lib.rs writes no map position");
    expect(writer[1]!.replace(/\s+/g, " ").trim()).toBe(
      "registry: State<'_, Registry>, folder_id: i64, map: u64, position: f64",
    );

    const envelope = /struct MapLayout \{([\s\S]*?)\n\}/.exec(seam);
    if (envelope === null) throw new Error("crates/app/src/lib.rs declares no MapLayout");
    const fields = [...envelope[1]!.matchAll(/^\s{4}(\w+):/gm)].map((match) => match[1]);
    expect(fields).toEqual(["dial", "rest"]);
  });

  it("receives the model generated rather than deriving it here (rule 1)", () => {
    const model = readFileSync(join(REPO_ROOT, ruleById(1).mechanismPath!), "utf8");
    expect(model.split("\n")[0]).toMatch(/generated by \[ts-rs\]/);
  });
});

describe("the registry says nothing about geometry", () => {
  it("carries the meta-rule and no per-view measurement", () => {
    const source = registrySource();

    // A pixel figure in the registry would be one view's fix promoted to a rule
    // every view has to meet — the exact move the meta-rule refuses.
    expect(source).not.toMatch(/\b\d+px\b/);

    const measured = RULES.filter((rule: Rule) => /\b\d+px\b/.test(rule.check));
    expect(measured).toEqual([]);
  });
});

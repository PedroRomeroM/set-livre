import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  inspectPlaywrightSource,
  inspectScenarioCoverage,
} from "../../scripts/playwright-source-contracts.mjs";

describe("Playwright source contracts", () => {
  it("reads executable scenarios without accepting comments as evidence", () => {
    const inspection = inspectPlaywrightSource(`
      // test("SL-F999-E2E-001 comentario nao executavel", async () => {});
      /* page.waitForTimeout(1000); test.skip("SL-F999-E2E-002 comentario", () => {}); */
      test("SL-F009-E2E-001 cenario real", async ({ page }) => {
        await page.getByRole("button").click();
      });
      test.skip("SL-F009-E2E-002 proibido", async () => {});
      test.describe.only("suite focada", () => {});
      page.waitForTimeout(1000);
      skip();
      only();
      helper.skip();
    `);

    expect(inspection.scenarios).toEqual(["SL-F009-E2E-001"]);
    expect(inspection.prohibited).toEqual([".skip", ".only", "waitForTimeout"]);
  });

  it("keeps the static guard over every implementation root", () => {
    const docsCheck = readFileSync(
      new URL("../../scripts/docs-check.mjs", import.meta.url),
      "utf8",
    );

    expect(docsCheck).toContain('walk(resolve(repositoryRoot, "tests/e2e"))');
    expect(docsCheck).toContain("inspectPlaywrightSource(contents, path)");
    expect(docsCheck).toContain("for (const path of playwrightFiles)");
    for (const root of [
      ".github",
      "apps",
      "ops",
      "packages",
      "scripts",
      "src",
      "supabase",
      "tests",
    ]) {
      expect(docsCheck).toContain(`"${root}"`);
    }
    expect(docsCheck).toContain('".py"');
    for (const extension of [".conf", ".path", ".service"]) {
      expect(docsCheck).toContain(`"${extension}"`);
    }
    expect(docsCheck).toContain('${"TO" + "DO"}|${"FIX" + "ME"}');
    expect(docsCheck).toContain("for (const path of implementationFiles)");
  });

  it("binds every planned scenario to one of the specs declared by its feature", () => {
    const coverage = inspectScenarioCoverage({
      declaredSpecs: new Set(["tests/e2e/critical/feat-009.spec.ts"]),
      implementedScenarioOwner: new Map([
        ["SL-F009-E2E-001", "tests/e2e/critical/feat-009.spec.ts"],
        ["SL-F009-E2E-002", "tests/e2e/regression/unrelated.spec.ts"],
        ["SL-F009-E2E-004", "tests/e2e/critical/feat-009.spec.ts"],
      ]),
      plannedScenarios: ["SL-F009-E2E-001", "SL-F009-E2E-002", "SL-F009-E2E-003"],
      prefix: "SL-F009-",
    });

    expect(coverage).toEqual({
      misplaced: [
        {
          path: "tests/e2e/regression/unrelated.spec.ts",
          scenario: "SL-F009-E2E-002",
        },
      ],
      missing: ["SL-F009-E2E-003"],
      unplanned: ["SL-F009-E2E-004"],
    });
  });
});

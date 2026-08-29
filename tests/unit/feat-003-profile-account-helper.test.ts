import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { cnpjSchema, cpfSchema } from "@set-livre/contracts";
import { describe, expect, it } from "vitest";

import {
  createFeat003ProfileSecrets,
  createFeat003QaIdentity,
  formatFeat003PhoneForDisplay,
  isFeat003SensitiveControlName,
  maskedFeat003AdditionalDocument,
  verifyFeat003CleanupWithDependencies,
  type Feat003CleanupPool,
} from "../helpers/feat-003-profile-account";

const identity = {
  email: "qa_f003_helper@example.test",
  userId: "10000000-0000-4000-8000-000000000003",
} as const;

function cleanupPool(
  evidence: Readonly<{
    auth_user_exists: boolean;
    preference_exists: boolean;
    profile_exists: boolean;
  }>,
  calls: Array<Readonly<{ text: string; values: readonly [string, string] }>>,
): Feat003CleanupPool {
  return {
    end: async () => undefined,
    query: async (text, values) => {
      calls.push({ text, values });
      return { rows: [evidence] };
    },
  };
}

describe("FEAT-003 Playwright helpers", () => {
  it("creates a namespaced identity without putting secrets in the test title", () => {
    const qaIdentity = createFeat003QaIdentity(
      { project: { name: "critical-chromium" } },
      "001 pessoa física",
    );

    expect(qaIdentity.email).toMatch(/^qa_f003_001_pessoa_f_sica_critical_chromium_/u);
    expect(qaIdentity.email).toMatch(/@example\.test$/u);
    expect(qaIdentity.password.length).toBeGreaterThanOrEqual(31);
    expect(qaIdentity.emails).toEqual([]);
  });

  it("generates structurally valid synthetic CPF and alphanumeric CNPJ", () => {
    const individual = createFeat003ProfileSecrets("individual");
    const company = createFeat003ProfileSecrets("company");

    expect(cpfSchema.safeParse(individual.taxId).success).toBe(true);
    expect(cnpjSchema.safeParse(company.taxId).success).toBe(true);
    expect(company.taxId.slice(0, 12)).toMatch(/[A-Z]/u);
    expect(individual.additionalDocument).toMatch(/^QA-DOC-[A-F0-9]{12}$/u);
    expect(company.additionalDocument).toMatch(/^QA-DOC-[A-F0-9]{12}$/u);
  });

  it("keeps the staging allowlist closed and derives only the masked document", () => {
    expect(isFeat003SensitiveControlName("taxId")).toBe(true);
    expect(isFeat003SensitiveControlName("additionalDocument")).toBe(true);
    expect(isFeat003SensitiveControlName("userId")).toBe(false);
    expect(maskedFeat003AdditionalDocument("QA-DOC-1234")).toBe("*********34");
    expect(formatFeat003PhoneForDisplay("+5541999991009")).toBe("+55 (41) 99999-1009");
    expect(formatFeat003PhoneForDisplay("+55 (41) 99999-10090")).toBe("+55 (41) 99999-10090");
    expect(formatFeat003PhoneForDisplay("+54 9 2222-2222")).toBe("+54922222222");
    expect(formatFeat003PhoneForDisplay("+55 (41) A3333-1234")).toBe("+55 (41) A3333-1234");
    expect(formatFeat003PhoneForDisplay("554133331234")).toBe("+55 (41) 3333-1234");
    expect(formatFeat003PhoneForDisplay("994133331234")).toBe("(99) 41333-31234");
  });

  it("keeps the same-page session switch in a static redacted evaluate step", () => {
    const helper = readFileSync(
      resolve(process.cwd(), "tests/helpers/feat-003-profile-account.ts"),
      "utf8",
    );
    const switchSource = helper.slice(
      helper.indexOf("export async function switchFeat003SessionWithoutNavigation"),
      helper.indexOf("export function assertFeat003SafeProfileResult"),
    );
    const criticalSpec = readFileSync(
      resolve(process.cwd(), "tests/e2e/critical/feat-003-profile-account.spec.ts"),
      "utf8",
    );
    const playwrightConfig = readFileSync(resolve(process.cwd(), "playwright.config.ts"), "utf8");

    expect(switchSource).toContain("response = await page.evaluate(");
    expect(switchSource).toContain("password: identity.password");
    expect(switchSource.match(/identity\.password/gu)).toHaveLength(1);
    expect(switchSource).toContain(".safeParse(response.payload)");
    expect(switchSource).not.toContain(".parse(response.payload)");
    expect(switchSource).not.toContain("throw error");
    expect(switchSource).not.toContain("console.");
    expect(criticalSpec).not.toContain('test.use({ screenshot: "off"');
    expect(playwrightConfig).toContain('screenshot: "only-on-failure"');
    expect(playwrightConfig).toContain('trace: "retain-on-failure"');
    expect(playwrightConfig).toContain('video: "retain-on-failure"');
  });

  it("fills phone controls through a redacted native input event instead of report titles", () => {
    const helper = readFileSync(
      resolve(process.cwd(), "tests/helpers/feat-003-profile-account.ts"),
      "utf8",
    );
    const phoneHelper = helper.slice(
      helper.indexOf("export async function fillFeat003PhoneWithoutReportValue"),
      helper.indexOf("export async function assertFeat003SecretsAbsentFromDom"),
    );
    const criticalSpec = readFileSync(
      resolve(process.cwd(), "tests/e2e/critical/feat-003-profile-account.spec.ts"),
      "utf8",
    );
    const regressionSpec = readFileSync(
      resolve(process.cwd(), "tests/e2e/regression/feat-003-profile-account.spec.ts"),
      "utf8",
    );
    const serializedPhoneAction =
      /getByRole\("textbox",\s*\{\s*name: "Telefone"\s*\}\)\.(?:fill|pressSequentially|type)\(/u;

    expect(phoneHelper).toContain("control.evaluate((element, phoneValue)");
    expect(phoneHelper).toContain('element.name !== "phone"');
    expect(phoneHelper).toContain(
      'Object.getOwnPropertyDescriptor(inputConstructor.prototype, "value")',
    );
    expect(phoneHelper).toContain('new inputEventConstructor("input"');
    expect(phoneHelper).toContain("valueSetter.call(element, phoneValue)");
    expect(phoneHelper).not.toContain("control.fill(");
    expect(phoneHelper).not.toContain("control.pressSequentially(");
    expect(phoneHelper).not.toContain("control.type(");
    expect(helper).not.toMatch(serializedPhoneAction);
    expect(criticalSpec).not.toMatch(serializedPhoneAction);
    expect(regressionSpec).not.toMatch(serializedPhoneAction);
    expect(regressionSpec).not.toMatch(/phoneControl\.(?:fill|pressSequentially|type)\(/u);
  });

  it("proves exact cleanup with parameterized identity and profile lookups", async () => {
    const calls: Array<Readonly<{ text: string; values: readonly [string, string] }>> = [];
    await verifyFeat003CleanupWithDependencies(
      identity,
      cleanupPool(
        {
          auth_user_exists: false,
          preference_exists: false,
          profile_exists: false,
        },
        calls,
      ),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.values).toEqual([identity.userId, identity.email]);
    expect(calls[0]?.text).toContain("auth_user.id = $1::uuid");
    expect(calls[0]?.text).toContain("auth_user.email = $2");
    expect(calls[0]?.text).toContain("profile.id = $1::uuid");
    expect(calls[0]?.text).toContain("preference.user_id = $1::uuid");
    expect(calls[0]?.text).not.toContain(identity.email);
    expect(calls[0]?.text).not.toContain(identity.userId);
  });

  it("fails closed when one exact profile row remains", async () => {
    const calls: Array<Readonly<{ text: string; values: readonly [string, string] }>> = [];
    await expect(
      verifyFeat003CleanupWithDependencies(
        identity,
        cleanupPool(
          {
            auth_user_exists: false,
            preference_exists: true,
            profile_exists: false,
          },
          calls,
        ),
      ),
    ).rejects.toThrow("A limpeza exata da identidade FEAT-003 deixou linhas residuais.");
  });
});

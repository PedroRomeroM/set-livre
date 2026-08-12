import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertFeat004SafeOwnerActivation,
  assertFeat004SafeOwnerRecipient,
  createFeat004QaIdentity,
  verifyFeat004CleanupWithDependencies,
  type Feat004CleanupPool,
} from "../helpers/feat-004-owner-onboarding-recipient";

const identity = {
  email: "qa_f004_helper@example.test",
  userId: "10000000-0000-4000-8000-000000000004",
} as const;

const cleanEvidence = {
  audit_event_exists: false,
  auth_user_exists: false,
  owner_profile_exists: false,
  owner_recipient_exists: false,
  private_operation_exists: false,
  profile_exists: false,
  terms_acceptance_exists: false,
};

function cleanupPool(
  evidence: typeof cleanEvidence,
  calls: Array<Readonly<{ text: string; values: readonly string[] }>>,
): Feat004CleanupPool {
  return {
    end: async () => undefined,
    query: async (text, values) => {
      calls.push({ text, values });
      return { rows: [evidence] };
    },
  };
}

describe("FEAT-004 Playwright helper", () => {
  it("accepts the compact recipient projection without mistaking state versions for legal fields", () => {
    const result = assertFeat004SafeOwnerRecipient({
      acceptedOwnerContractVersionId: null,
      nextAction: "activate_owner",
      ownerContract: {
        effectiveAt: "2026-08-12T00:00:00.000Z",
        id: "40000000-0000-4000-8000-000000000004",
        source: "local_fixture",
      },
      ownerContractAccepted: false,
      ownerStatus: "inactive",
      ownerVersion: 0,
      profileVersion: 1,
      profileVersionSynced: null,
      projection: "recipient",
      providerMode: "local",
      recipientStatus: "not_started",
      recipientVersion: 0,
      requirements: [],
      reservationsEligible: false,
      scope: "10000000-0000-4000-8000-000000000004",
    });

    expect(result.projection).toBe("recipient");
    expect(result.ownerVersion).toBe(0);
    expect(result.profileVersion).toBe(1);
    expect(result.recipientVersion).toBe(0);
  });

  it("creates a dedicated namespace and keeps the report sentinel out of titles", () => {
    const qaIdentity = createFeat004QaIdentity(
      { project: { name: "critical-chromium" } },
      "001 activation",
    );

    expect(qaIdentity.email).toMatch(/^qa_f004_001_activation_critical_chromium_/u);
    expect(qaIdentity.email).toMatch(/@example\.test$/u);
    expect(qaIdentity.password.length).toBeGreaterThanOrEqual(31);
    expect(qaIdentity.emails).toEqual([]);
  });

  it("rejects private provider fields and references from the public projection", () => {
    const privateReference = "local-test-fixture:unavailable";
    expect(() =>
      assertFeat004SafeOwnerRecipient({
        providerReference: privateReference,
      }),
    ).toThrow();
    expect(() =>
      assertFeat004SafeOwnerActivation({
        providerReference: privateReference,
      }),
    ).toThrow();

    const helper = readFileSync(
      resolve(process.cwd(), "tests/helpers/feat-004-owner-onboarding-recipient.ts"),
      "utf8",
    );
    expect(helper).toContain("local-recipient:");
    expect(helper).toContain("local-test-fixture:");
    expect(helper).toContain("provider_reference");
    expect(helper).toContain("provider_payload");
    expect(helper).toContain("bank_account");
    expect(helper).toContain("routing_number");
    expect(helper).toContain('querySelectorAll<HTMLElement>("a, button, input, select, textarea")');
    expect(helper).toContain(
      "A projeção de recebimentos expôs documento jurídico ou campo privado.",
    );
    expect(helper).toContain("A projeção de ativação expôs um campo privado do provider.");
    expect(helper).not.toMatch(/delete from public\.terms_acceptances/iu);
    expect(helper).toMatch(/actor_user_id = \$1::uuid\s+or target_id = \$1::uuid/iu);
  });

  it("proves exact cleanup across every FEAT-004 dependency", async () => {
    const calls: Array<Readonly<{ text: string; values: readonly string[] }>> = [];

    await verifyFeat004CleanupWithDependencies(identity, cleanupPool(cleanEvidence, calls));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.values).toEqual([identity.userId, identity.email]);
    expect(calls[0]?.text).toContain("owner_user_id = $1::uuid");
    expect(calls[0]?.text).toContain("user_id = $1::uuid");
    expect(calls[0]?.text).toContain("actor_user_id = $1::uuid");
    expect(calls[0]?.text).toContain("target_id = $1::uuid");
    expect(calls[0]?.text).not.toContain(identity.email);
    expect(calls[0]?.text).not.toContain(identity.userId);
  });

  it("fails closed if an audit target remains after the actor FK is nulled", async () => {
    const calls: Array<Readonly<{ text: string; values: readonly string[] }>> = [];

    await expect(
      verifyFeat004CleanupWithDependencies(
        identity,
        cleanupPool({ ...cleanEvidence, audit_event_exists: true }, calls),
      ),
    ).rejects.toThrow("A limpeza exata da FEAT-004 deixou linhas residuais.");
  });
});

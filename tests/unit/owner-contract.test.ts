import {
  ownerActivationResultSchema,
  ownerActivateCommandSchema,
  ownerCommandSchema,
  ownerRecipientResultSchema,
  ownerRecipientStatusSchema,
  recipientOnboardingRefreshCommandSchema,
  recipientOnboardingStartCommandSchema,
} from "@set-livre/contracts";
import { describe, expect, it } from "vitest";

const scope = "11111111-1111-4111-8111-111111111111";
const idempotencyKey = "22222222-2222-4222-8222-222222222222";
const ownerContractVersionId = "33333333-3333-4333-8333-333333333333";

const ownerContract = {
  bodyMarkdown: "# Contrato local do dono",
  contentHash: "a".repeat(64),
  effectiveAt: "2026-08-12T00:00:00.000Z",
  id: ownerContractVersionId,
  kind: "owner_contract",
  source: "local_fixture",
  title: "Contrato do dono",
  version: "local-1",
} as const;

describe("owner and recipient contracts", () => {
  it("accepts only the strict owner activation intent", () => {
    const command = {
      action: "owner.activate",
      expectedScope: scope,
      idempotencyKey,
      payload: { acceptOwnerContract: true, ownerContractVersionId },
    } as const;
    expect(ownerActivateCommandSchema.parse(command)).toEqual(command);
    expect(ownerCommandSchema.parse(command)).toEqual(command);

    for (const invalid of [
      { ...command, ownerUserId: scope },
      { ...command, status: "active" },
      { ...command, provider: "local" },
      { ...command, ownerActivationCapability: "available" },
      { ...command, idempotencyKey: "not-a-uuid" },
      { ...command, payload: { ...command.payload, acceptOwnerContract: false } },
      { ...command, payload: { ...command.payload, ownerActivationCapability: "available" } },
      { ...command, payload: { ...command.payload, ownerStatus: "active" } },
    ]) {
      expect(ownerActivateCommandSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it.each([
    ["start", recipientOnboardingStartCommandSchema, "recipient.onboarding.start"],
    ["refresh", recipientOnboardingRefreshCommandSchema, "recipient.onboarding.refresh"],
  ] as const)(
    "keeps recipient %s free from browser-controlled provider state",
    (_name, schema, action) => {
      const command = { action, expectedScope: scope, idempotencyKey, payload: {} };
      expect(schema.parse(command)).toEqual(command);
      expect(ownerCommandSchema.parse(command)).toEqual(command);

      for (const invalid of [
        { ...command, ownerUserId: scope },
        { ...command, recipientOnboardingCapability: "local_adapter" },
        { ...command, payload: { status: "active" } },
        { ...command, payload: { recipientOnboardingCapability: "local_adapter" } },
        { ...command, payload: { providerReference: "recipient-secret" } },
        { ...command, idempotencyKey: undefined },
      ]) {
        expect(schema.safeParse(invalid).success).toBe(false);
      }
    },
  );

  it("accepts the safe complete projection without PII or provider identifiers", () => {
    const result = {
      acceptedOwnerContractVersionId: ownerContractVersionId,
      nextAction: "none",
      ownerActivationCapability: "available",
      ownerContract,
      ownerContractAccepted: true,
      ownerStatus: "active",
      ownerVersion: 1,
      profileVersion: 4,
      profileVersionSynced: 4,
      projection: "activation",
      providerMode: "local",
      recipientOnboardingCapability: "local_adapter",
      recipientStatus: "active",
      recipientVersion: 2,
      requirements: [],
      reservationsEligible: true,
      scope,
    } as const;
    expect(ownerRecipientResultSchema.parse(result)).toEqual(result);
    expect(
      ownerRecipientResultSchema.safeParse({ ...result, providerRecipientId: "secret" }).success,
    ).toBe(false);
    expect(ownerRecipientResultSchema.safeParse({ ...result, name: "Pessoa" }).success).toBe(false);
    expect(
      ownerRecipientResultSchema.safeParse({ ...result, ownerStatus: "blocked" }).success,
    ).toBe(false);
  });

  it("discriminates the full activation document from the compact recipient projection", () => {
    const state = {
      acceptedOwnerContractVersionId: null,
      nextAction: "activate_owner",
      ownerContractAccepted: false,
      ownerStatus: "inactive",
      ownerVersion: 0,
      profileVersion: 4,
      profileVersionSynced: null,
      providerMode: "local",
      recipientOnboardingCapability: "local_adapter",
      recipientStatus: "not_started",
      recipientVersion: 0,
      requirements: [],
      reservationsEligible: false,
      scope,
    } as const;
    const activation = {
      ...state,
      ownerActivationCapability: "available",
      ownerContract,
      projection: "activation",
    } as const;
    const recipient = {
      ...state,
      ownerContract: {
        effectiveAt: ownerContract.effectiveAt,
        id: ownerContract.id,
        source: ownerContract.source,
      },
      projection: "recipient",
    } as const;

    expect(ownerActivationResultSchema.safeParse(activation).success).toBe(true);
    expect(ownerRecipientStatusSchema.safeParse(recipient).success).toBe(true);
    expect(ownerRecipientResultSchema.safeParse(activation).success).toBe(true);
    expect(ownerRecipientResultSchema.safeParse(recipient).success).toBe(true);
    expect(ownerRecipientStatusSchema.safeParse(activation).success).toBe(false);
    expect(ownerActivationResultSchema.safeParse(recipient).success).toBe(false);
    expect(
      ownerRecipientStatusSchema.safeParse({
        ...recipient,
        ownerActivationCapability: "available",
      }).success,
    ).toBe(false);
    expect(
      ownerRecipientStatusSchema.safeParse({
        ...recipient,
        ownerContract: { ...recipient.ownerContract, bodyMarkdown: "# não permitido" },
      }).success,
    ).toBe(false);
    expect(
      ownerRecipientResultSchema.safeParse({ ...activation, projection: "recipient" }).success,
    ).toBe(false);
  });

  it("fails closed on raw requirements, provider mode drift and inconsistent primitives", () => {
    const base = {
      acceptedOwnerContractVersionId: null,
      nextAction: "activate_owner",
      ownerActivationCapability: "available",
      ownerContract,
      ownerContractAccepted: false,
      ownerStatus: "inactive",
      ownerVersion: 0,
      profileVersion: 0,
      profileVersionSynced: null,
      projection: "activation",
      providerMode: "local",
      recipientOnboardingCapability: "local_adapter",
      recipientStatus: "not_started",
      recipientVersion: 0,
      requirements: [],
      reservationsEligible: false,
      scope,
    } as const;
    expect(ownerRecipientResultSchema.safeParse(base).success).toBe(true);
    expect(
      ownerRecipientResultSchema.safeParse({
        ...base,
        ownerActivationCapability: "unavailable",
      }).success,
    ).toBe(true);
    expect(
      ownerRecipientResultSchema.safeParse({
        ...base,
        ownerActivationCapability: "browser_enabled",
      }).success,
    ).toBe(false);
    expect(
      ownerRecipientResultSchema.safeParse({
        ...base,
        ownerActivationCapability: undefined,
      }).success,
    ).toBe(false);
    expect(
      ownerRecipientResultSchema.safeParse({
        ...base,
        recipientOnboardingCapability: "unavailable",
      }).success,
    ).toBe(true);
    expect(
      ownerRecipientResultSchema.safeParse({
        ...base,
        requirements: ["identity_review", "identity_review"],
      }).success,
    ).toBe(false);
    expect(ownerRecipientResultSchema.safeParse({ ...base, providerMode: "pagarme" }).success).toBe(
      false,
    );
    expect(
      ownerRecipientResultSchema.safeParse({
        ...base,
        recipientOnboardingCapability: "browser_enabled",
      }).success,
    ).toBe(false);
    expect(
      ownerRecipientResultSchema.safeParse({
        ...base,
        recipientOnboardingCapability: undefined,
      }).success,
    ).toBe(false);
    expect(ownerRecipientResultSchema.safeParse({ ...base, ownerVersion: "0" }).success).toBe(
      false,
    );
  });

  it("rejects relational states that the owner SQL projection cannot produce", () => {
    const initial = {
      acceptedOwnerContractVersionId: null,
      nextAction: "activate_owner",
      ownerActivationCapability: "available",
      ownerContract,
      ownerContractAccepted: false,
      ownerStatus: "inactive",
      ownerVersion: 0,
      profileVersion: 4,
      profileVersionSynced: null,
      projection: "activation",
      providerMode: "local",
      recipientOnboardingCapability: "local_adapter",
      recipientStatus: "not_started",
      recipientVersion: 0,
      requirements: [],
      reservationsEligible: false,
      scope,
    } as const;
    const pending = {
      ...initial,
      acceptedOwnerContractVersionId: ownerContractVersionId,
      nextAction: "refresh_status",
      ownerContractAccepted: true,
      ownerStatus: "active",
      ownerVersion: 1,
      profileVersionSynced: 4,
      recipientStatus: "pending",
      recipientVersion: 1,
      requirements: ["identity_review"],
    } as const;
    const active = {
      ...pending,
      nextAction: "none",
      recipientStatus: "active",
      requirements: [],
      reservationsEligible: true,
    } as const;

    expect(ownerRecipientResultSchema.safeParse(initial).success).toBe(true);
    expect(ownerRecipientResultSchema.safeParse(pending).success).toBe(true);
    expect(ownerRecipientResultSchema.safeParse(active).success).toBe(true);

    for (const impossible of [
      { ...initial, acceptedOwnerContractVersionId: ownerContractVersionId },
      { ...initial, ownerStatus: "active" },
      { ...initial, ownerVersion: 1 },
      {
        ...initial,
        nextAction: "none",
        ownerStatus: "blocked",
        profileVersionSynced: 4,
        recipientStatus: "pending",
        recipientVersion: 1,
        requirements: ["identity_review"],
      },
      { ...pending, acceptedOwnerContractVersionId: null, ownerContractAccepted: false },
      { ...pending, ownerStatus: "inactive" },
      { ...pending, profileVersionSynced: null },
      { ...pending, recipientVersion: 0 },
      {
        ...pending,
        nextAction: "start_onboarding",
        profileVersionSynced: null,
        recipientStatus: "not_started",
        recipientVersion: 0,
      },
      { ...active, requirements: ["provider_contact"] },
    ]) {
      expect(ownerRecipientResultSchema.safeParse(impossible).success).toBe(false);
    }

    expect(
      ownerRecipientResultSchema.safeParse({
        ...pending,
        nextAction: "none",
        ownerStatus: "blocked",
      }).success,
    ).toBe(true);
  });

  it("derives eligibility and next action fail-closed from the canonical status tuple", () => {
    const active = {
      acceptedOwnerContractVersionId: ownerContractVersionId,
      nextAction: "none",
      ownerActivationCapability: "available",
      ownerContract,
      ownerContractAccepted: true,
      ownerStatus: "active",
      ownerVersion: 1,
      profileVersion: 4,
      profileVersionSynced: 4,
      projection: "activation",
      providerMode: "local",
      recipientOnboardingCapability: "local_adapter",
      recipientStatus: "active",
      recipientVersion: 2,
      requirements: [],
      reservationsEligible: true,
      scope,
    } as const;
    expect(ownerRecipientResultSchema.safeParse(active).success).toBe(true);
    for (const inconsistent of [
      { ...active, ownerStatus: "inactive" },
      { ...active, ownerContractAccepted: false },
      { ...active, recipientStatus: "pending" },
      { ...active, profileVersionSynced: 3 },
      { ...active, nextAction: "refresh_status" },
      { ...active, reservationsEligible: false },
      {
        ...active,
        acceptedOwnerContractVersionId: "44444444-4444-4444-8444-444444444444",
      },
      { ...active, ownerContractAccepted: false, reservationsEligible: false },
    ]) {
      expect(ownerRecipientResultSchema.safeParse(inconsistent).success).toBe(false);
    }
  });

  it("allows an old accepted contract while requiring activation of the current version", () => {
    expect(
      ownerRecipientResultSchema.safeParse({
        acceptedOwnerContractVersionId: "44444444-4444-4444-8444-444444444444",
        nextAction: "activate_owner",
        ownerActivationCapability: "available",
        ownerContract,
        ownerContractAccepted: false,
        ownerStatus: "active",
        ownerVersion: 2,
        profileVersion: 4,
        profileVersionSynced: 4,
        projection: "activation",
        providerMode: "local",
        recipientOnboardingCapability: "local_adapter",
        recipientStatus: "active",
        recipientVersion: 2,
        requirements: [],
        reservationsEligible: false,
        scope,
      }).success,
    ).toBe(true);
  });

  it("rejects a false acceptance flag when the accepted ID is the current contract", () => {
    const result = ownerRecipientResultSchema.safeParse({
      acceptedOwnerContractVersionId: ownerContractVersionId,
      nextAction: "activate_owner",
      ownerActivationCapability: "available",
      ownerContract,
      ownerContractAccepted: false,
      ownerStatus: "active",
      ownerVersion: 2,
      profileVersion: 4,
      profileVersionSynced: 4,
      projection: "activation",
      providerMode: "local",
      recipientOnboardingCapability: "local_adapter",
      recipientStatus: "active",
      recipientVersion: 2,
      requirements: [],
      reservationsEligible: false,
      scope,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: ["ownerContractAccepted"] })]),
      );
    }
  });

  it.each([
    [{ ownerStatus: "blocked", recipientStatus: "active" }, "none"],
    [{ ownerStatus: "active", recipientStatus: "blocked" }, "none"],
    [{ ownerStatus: "inactive", recipientStatus: "not_started" }, "activate_owner"],
    [{ ownerStatus: "active", recipientStatus: "refused" }, "start_onboarding"],
    [{ ownerStatus: "active", recipientStatus: "suspended" }, "refresh_status"],
  ] as const)("accepts the coherent next action for %o", (states, nextAction) => {
    const ownerContractAccepted = states.ownerStatus !== "inactive";
    expect(
      ownerRecipientResultSchema.safeParse({
        acceptedOwnerContractVersionId: ownerContractAccepted ? ownerContractVersionId : null,
        nextAction,
        ownerActivationCapability: "available",
        ownerContract,
        ownerContractAccepted,
        ownerStatus: states.ownerStatus,
        ownerVersion: ownerContractAccepted ? 1 : 0,
        profileVersion: 4,
        profileVersionSynced: states.recipientStatus === "not_started" ? null : 4,
        projection: "activation",
        providerMode: "local",
        recipientOnboardingCapability: "local_adapter",
        recipientStatus: states.recipientStatus,
        recipientVersion: states.recipientStatus === "not_started" ? 0 : 1,
        requirements: [],
        reservationsEligible: false,
        scope,
      }).success,
    ).toBe(true);
  });
});

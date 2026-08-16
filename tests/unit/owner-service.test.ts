import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  activateOwnerProfile: vi.fn(),
  applyOwnerRecipientOperation: vi.fn(),
  createProvider: vi.fn(),
  getOwnerRecipientStatusForUser: vi.fn(),
  prepareOwnerRecipientOperation: vi.fn(),
  providerExecute: vi.fn(),
}));

import { createOwnerService } from "../../src/domains/owners/server/owner-service";
import { readOwnerActivationCapability } from "../../src/domains/owners/server/owner-runtime";
import { readRecipientOnboardingCapability } from "../../src/domains/owners/server/recipient-provider";

const userId = "11111111-1111-4111-8111-111111111111";
const idempotencyKey = "22222222-2222-4222-8222-222222222222";
const contractId = "33333333-3333-4333-8333-333333333333";
const operationId = "44444444-4444-4444-8444-444444444444";
const userAgent = "test-user-agent/private-value";
const unavailableRecipientOperationCases = (["start", "refresh"] as const).flatMap((operation) =>
  (["development", "production", "preview", undefined] as const).map(
    (environment) => [operation, environment] as const,
  ),
);

const currentRow = {
  accepted_owner_contract_version_id: null,
  next_action: "activate_owner",
  owner_contract_accepted: false,
  owner_contract_body_markdown: "# Contrato local",
  owner_contract_content_hash: "a".repeat(64),
  owner_contract_effective_at: "2026-08-12T00:00:00.000Z",
  owner_contract_id: contractId,
  owner_contract_kind: "owner_contract",
  owner_contract_source: "local_fixture",
  owner_contract_title: "Contrato do dono",
  owner_contract_version: "local-1",
  owner_status: "inactive",
  owner_version: 0,
  profile_version: 4,
  profile_version_synced: null,
  provider_mode: "local",
  recipient_status: "not_started",
  recipient_version: 0,
  requirements: [],
  reservations_eligible: false,
  scope: userId,
} as const;
const currentStatusRow = {
  accepted_owner_contract_version_id: currentRow.accepted_owner_contract_version_id,
  next_action: currentRow.next_action,
  owner_contract_accepted: currentRow.owner_contract_accepted,
  owner_contract_effective_at: currentRow.owner_contract_effective_at,
  owner_contract_id: currentRow.owner_contract_id,
  owner_contract_source: currentRow.owner_contract_source,
  owner_status: currentRow.owner_status,
  owner_version: currentRow.owner_version,
  profile_version: currentRow.profile_version,
  profile_version_synced: currentRow.profile_version_synced,
  provider_mode: currentRow.provider_mode,
  recipient_status: currentRow.recipient_status,
  recipient_version: currentRow.recipient_version,
  requirements: currentRow.requirements,
  reservations_eligible: currentRow.reservations_eligible,
  scope: currentRow.scope,
} as const;

const activeOwnerRow = {
  ...currentRow,
  accepted_owner_contract_version_id: contractId,
  next_action: "start_onboarding",
  owner_contract_accepted: true,
  owner_status: "active",
  owner_version: 1,
} as const;

const activeOwnerStatusRow = {
  ...currentStatusRow,
  accepted_owner_contract_version_id: contractId,
  next_action: "start_onboarding",
  owner_contract_accepted: true,
  owner_status: "active",
  owner_version: 1,
} as const;

const pendingRecipientRow = {
  ...activeOwnerStatusRow,
  next_action: "refresh_status",
  profile_version_synced: 4,
  recipient_status: "pending",
  recipient_version: 1,
  requirements: ["identity_review"],
} as const;

const context = {
  requestId: "55555555-5555-4555-8555-555555555555",
  session: {
    authenticated: true,
    email: "owner@example.test",
    personType: "individual",
    profileCompleted: true,
    status: "active",
    userId,
  },
  userAgent,
} as const;

function service(providerDeadlineMs = 2_000) {
  return createOwnerService({
    activateOwnerProfile: mocks.activateOwnerProfile,
    applyOwnerRecipientOperation: mocks.applyOwnerRecipientOperation,
    createProvider: mocks.createProvider,
    getOwnerRecipientStatusForUser: mocks.getOwnerRecipientStatusForUser,
    prepareOwnerRecipientOperation: mocks.prepareOwnerRecipientOperation,
    providerDeadlineMs,
    readOwnerActivationCapability,
    readRecipientOnboardingCapability,
  });
}

describe("owner service", () => {
  beforeEach(async () => {
    process.env.APP_ENV = "test";
    vi.useRealTimers();
    vi.clearAllMocks();
    mocks.createProvider.mockReturnValue({ execute: mocks.providerExecute });
    mocks.getOwnerRecipientStatusForUser.mockResolvedValue(currentStatusRow);
    mocks.activateOwnerProfile.mockResolvedValue(activeOwnerRow);
    mocks.prepareOwnerRecipientOperation.mockResolvedValue({
      alreadyApplied: false,
      operation: "start",
      operationId,
      operationSequence: 1,
      profileVersion: 4,
      providerReference: null,
    });
    mocks.providerExecute.mockResolvedValue({
      providerReference: `local-recipient:${operationId}`,
      requirements: ["identity_review"],
      status: "pending",
    });
    mocks.applyOwnerRecipientOperation.mockResolvedValue(pendingRecipientRow);
    const { resetIdentityRateLimitForTests } = await import("../../src/lib/server/rate-limit");
    resetIdentityRateLimitForTests();
  });

  it.each(["local", "test"] as const)(
    "activates a local fixture in APP_ENV=%s with only a server-side user-agent hash",
    async (environment) => {
      process.env.APP_ENV = environment;
      await expect(
        service().activateOwner(
          {
            action: "owner.activate",
            expectedScope: userId,
            idempotencyKey,
            payload: { acceptOwnerContract: true, ownerContractVersionId: contractId },
          },
          context,
        ),
      ).resolves.toMatchObject({
        ownerActivationCapability: "available",
        ownerStatus: "active",
        ownerVersion: 1,
        scope: userId,
      });

      expect(mocks.activateOwnerProfile).toHaveBeenCalledWith({
        idempotencyKey,
        ownerContractVersionId: contractId,
        requestId: context.requestId,
        userAgentHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        userId,
      });
      expect(JSON.stringify(mocks.activateOwnerProfile.mock.calls)).not.toContain(userAgent);
    },
  );

  it.each(unavailableRecipientOperationCases)(
    "refuses recipient onboarding %s in APP_ENV=%s before reserving an operation",
    async (operation, environment) => {
      if (environment === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = environment;

      const ownerService = service();
      await expect(
        operation === "start"
          ? ownerService.startRecipientOnboarding(
              {
                action: "recipient.onboarding.start",
                expectedScope: userId,
                idempotencyKey,
                payload: {},
              },
              context,
            )
          : ownerService.refreshRecipientOnboarding(
              {
                action: "recipient.onboarding.refresh",
                expectedScope: userId,
                idempotencyKey,
                payload: {},
              },
              context,
            ),
      ).rejects.toMatchObject({ code: "PAYMENT_PROVIDER_UNAVAILABLE", status: 503 });
      expect(mocks.prepareOwnerRecipientOperation).not.toHaveBeenCalled();
      expect(mocks.createProvider).not.toHaveBeenCalled();
      expect(mocks.providerExecute).not.toHaveBeenCalled();
      expect(mocks.applyOwnerRecipientOperation).not.toHaveBeenCalled();
    },
  );

  it.each(["development", "production", "preview", undefined] as const)(
    "refuses a local fixture contract in APP_ENV=%s before the activation write",
    async (environment) => {
      if (environment === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = environment;
      await expect(
        service().activateOwner(
          {
            action: "owner.activate",
            expectedScope: userId,
            idempotencyKey,
            payload: { acceptOwnerContract: true, ownerContractVersionId: contractId },
          },
          context,
        ),
      ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE", status: 503 });
      expect(mocks.activateOwnerProfile).not.toHaveBeenCalled();
      expect(mocks.prepareOwnerRecipientOperation).not.toHaveBeenCalled();
      expect(mocks.createProvider).not.toHaveBeenCalled();
    },
  );

  it.each(["production", "preview", undefined] as const)(
    "allows an approved contract in APP_ENV=%s without turning an active owner into a no-op",
    async (environment) => {
      if (environment === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = environment;
      mocks.getOwnerRecipientStatusForUser.mockResolvedValueOnce({
        ...activeOwnerStatusRow,
        accepted_owner_contract_version_id: "66666666-6666-4666-8666-666666666666",
        next_action: "activate_owner",
        owner_contract_accepted: false,
        owner_contract_source: "approved",
      });
      mocks.activateOwnerProfile.mockResolvedValueOnce({
        ...activeOwnerRow,
        owner_contract_source: "approved",
      });
      await expect(
        service().activateOwner(
          {
            action: "owner.activate",
            expectedScope: userId,
            idempotencyKey,
            payload: { acceptOwnerContract: true, ownerContractVersionId: contractId },
          },
          context,
        ),
      ).resolves.toMatchObject({
        ownerActivationCapability: "available",
        recipientOnboardingCapability: "unavailable",
      });
      expect(mocks.activateOwnerProfile).toHaveBeenCalledOnce();
    },
  );

  it("executes prepare, provider and conditional apply in order with server-owned data", async () => {
    const calls: string[] = [];
    mocks.prepareOwnerRecipientOperation.mockImplementationOnce(async () => {
      calls.push("prepare");
      return {
        alreadyApplied: false,
        operation: "start",
        operationId,
        operationSequence: 1,
        profileVersion: 4,
        providerReference: null,
      };
    });
    mocks.createProvider.mockImplementationOnce(() => {
      calls.push("providerFactory");
      return { execute: mocks.providerExecute };
    });
    mocks.providerExecute.mockImplementationOnce(async () => {
      calls.push("provider");
      return {
        providerReference: `local-recipient:${operationId}`,
        requirements: ["identity_review"],
        status: "pending",
      };
    });
    mocks.applyOwnerRecipientOperation.mockImplementationOnce(async () => {
      calls.push("apply");
      return pendingRecipientRow;
    });

    await service().startRecipientOnboarding(
      {
        action: "recipient.onboarding.start",
        expectedScope: userId,
        idempotencyKey,
        payload: {},
      },
      context,
    );

    expect(calls).toEqual(["prepare", "providerFactory", "provider", "apply"]);
    expect(mocks.providerExecute).toHaveBeenCalledWith({
      deadlineAt: expect.any(Number),
      operation: "start",
      operationId,
      providerReference: null,
      signal: expect.any(AbortSignal),
    });
    expect(mocks.applyOwnerRecipientOperation).toHaveBeenCalledWith({
      operationId,
      provider: "local",
      providerReference: `local-recipient:${operationId}`,
      requestId: context.requestId,
      requirements: ["identity_review"],
      status: "pending",
      userId,
    });
  });

  it("returns authoritative state for an applied idempotency replay without provider/apply", async () => {
    mocks.prepareOwnerRecipientOperation.mockResolvedValueOnce({
      alreadyApplied: true,
      operation: "start",
      operationId,
      operationSequence: 1,
      profileVersion: 4,
      providerReference: `local-recipient:${operationId}`,
    });
    mocks.getOwnerRecipientStatusForUser.mockResolvedValueOnce(pendingRecipientRow);

    await expect(
      service().startRecipientOnboarding(
        {
          action: "recipient.onboarding.start",
          expectedScope: userId,
          idempotencyKey,
          payload: {},
        },
        context,
      ),
    ).resolves.toMatchObject({ recipientStatus: "pending", recipientVersion: 1 });
    expect(mocks.providerExecute).not.toHaveBeenCalled();
    expect(mocks.applyOwnerRecipientOperation).not.toHaveBeenCalled();
  });

  it("maps a missing authoritative replay row without retrying provider/apply", async () => {
    mocks.prepareOwnerRecipientOperation.mockResolvedValueOnce({
      alreadyApplied: true,
      operation: "start",
      operationId,
      operationSequence: 1,
      profileVersion: 4,
      providerReference: `local-recipient:${operationId}`,
    });
    mocks.getOwnerRecipientStatusForUser.mockRejectedValueOnce({ code: "P0002" });

    await expect(
      service().startRecipientOnboarding(
        {
          action: "recipient.onboarding.start",
          expectedScope: userId,
          idempotencyKey,
          payload: {},
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
    expect(mocks.providerExecute).not.toHaveBeenCalled();
    expect(mocks.applyOwnerRecipientOperation).not.toHaveBeenCalled();
  });

  it("times out a non-cooperative provider and never applies a late resolution", async () => {
    vi.useFakeTimers();
    let resolveProvider: ((value: unknown) => void) | undefined;
    mocks.providerExecute.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveProvider = resolve;
      }),
    );
    const outcome = service(25)
      .startRecipientOnboarding(
        {
          action: "recipient.onboarding.start",
          expectedScope: userId,
          idempotencyKey,
          payload: {},
        },
        context,
      )
      .catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(25);
    await expect(outcome).resolves.toMatchObject({
      code: "PAYMENT_PROVIDER_UNAVAILABLE",
      status: 503,
    });
    resolveProvider?.({
      providerReference: "late-private-reference",
      requirements: [],
      status: "active",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.applyOwnerRecipientOperation).not.toHaveBeenCalled();
  });

  it("maps provider unavailability without exposing its error", async () => {
    mocks.providerExecute.mockRejectedValueOnce(
      new Error("https://provider.invalid/private-recipient-secret"),
    );
    const outcome = service()
      .refreshRecipientOnboarding(
        {
          action: "recipient.onboarding.refresh",
          expectedScope: userId,
          idempotencyKey,
          payload: {},
        },
        context,
      )
      .catch((error: unknown) => error);
    await expect(outcome).resolves.toMatchObject({
      code: "PAYMENT_PROVIDER_UNAVAILABLE",
      status: 503,
    });
    expect(String(await outcome)).not.toContain("private-recipient-secret");
    expect(mocks.applyOwnerRecipientOperation).not.toHaveBeenCalled();
  });

  it.each([
    ["22023", "invalid_recipient_operation", 422, "VALIDATION_FAILED"],
    ["23514", "recipient_start_transition_invalid", 409, "CONFLICT"],
    ["40001", "recipient_operation_superseded", 409, "CONFLICT"],
    ["42501", "owner_contract_not_current", 409, "CONFLICT"],
    ["42501", "owner_blocked", 403, "FORBIDDEN"],
    ["42501", "recipient_blocked", 403, "FORBIDDEN"],
    ["P0002", "recipient_state_missing", 409, "CONFLICT"],
  ] as const)(
    "maps SQLSTATE %s (%s) to a safe public error",
    async (sqlState, databaseMessage, status, code) => {
      mocks.prepareOwnerRecipientOperation.mockRejectedValueOnce({
        code: sqlState,
        detail: "provider-private-reference",
        message: databaseMessage,
      });
      const error = await service()
        .startRecipientOnboarding(
          {
            action: "recipient.onboarding.start",
            expectedScope: userId,
            idempotencyKey,
            payload: {},
          },
          context,
        )
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code, status });
      expect(String(error)).not.toContain("provider-private-reference");
      expect(String(error)).not.toContain(databaseMessage);
    },
  );
});

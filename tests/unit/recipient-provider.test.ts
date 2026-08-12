import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  createLocalRecipientOnboardingProvider,
  localRecipientTestFixtureReferences,
  mapLocalRecipientSnapshot,
} from "../../src/domains/owners/server/recipient-provider";

const operationId = "11111111-1111-4111-8111-111111111111";

describe("local recipient onboarding provider", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.stubEnv("APP_ENV", "test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("maps only allowlisted status and requirement codes", () => {
    expect(
      mapLocalRecipientSnapshot({
        reference: "private-ref",
        requirementCodes: ["ADDITIONAL_INFORMATION", "PROVIDER_CONTACT"],
        statusCode: "REFUSED",
      }),
    ).toEqual({
      providerReference: "private-ref",
      requirements: ["additional_information", "provider_contact"],
      status: "refused",
    });

    for (const raw of [
      { reference: "private-ref", requirementCodes: [], statusCode: "APPROVED_BY_EMAIL" },
      { reference: "private-ref", requirementCodes: ["BANK_PASSWORD"], statusCode: "PENDING" },
      {
        reference: "private-ref",
        requirementCodes: ["IDENTITY_REVIEW", "IDENTITY_REVIEW"],
        statusCode: "PENDING",
      },
      {
        reference: "private-ref",
        requirementCodes: [],
        statusCode: "ACTIVE",
        redirectUrl: "https://provider.invalid/secret",
      },
    ]) {
      expect(() => mapLocalRecipientSnapshot(raw)).toThrow();
    }
  });

  it("is deterministic: start becomes pending and refresh becomes active", async () => {
    const provider = createLocalRecipientOnboardingProvider();
    const startController = new AbortController();
    await expect(
      provider.execute({
        deadlineAt: Date.now() + 1_000,
        operation: "start",
        operationId,
        providerReference: null,
        signal: startController.signal,
      }),
    ).resolves.toEqual({
      providerReference: `local-recipient:${operationId}`,
      requirements: ["identity_review"],
      status: "pending",
    });

    const refreshController = new AbortController();
    await expect(
      provider.execute({
        deadlineAt: Date.now() + 1_000,
        operation: "refresh",
        operationId,
        providerReference: "existing-private-reference",
        signal: refreshController.signal,
      }),
    ).resolves.toEqual({
      providerReference: "existing-private-reference",
      requirements: [],
      status: "active",
    });
  });

  it.each(["development", "production", undefined])(
    "refuses the local adapter in APP_ENV=%s",
    (environment) => {
      vi.stubEnv("APP_ENV", environment);
      expect(() => createLocalRecipientOnboardingProvider()).toThrow("proibido");
    },
  );

  it("honors both an already aborted signal and an elapsed absolute deadline", async () => {
    vi.stubEnv("APP_ENV", "local");
    const provider = createLocalRecipientOnboardingProvider();
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      provider.execute({
        deadlineAt: Date.now() + 1_000,
        operation: "start",
        operationId,
        providerReference: null,
        signal: aborted.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    await expect(
      provider.execute({
        deadlineAt: Date.now() - 1,
        operation: "start",
        operationId,
        providerReference: null,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("requires a server-owned private reference for refresh", async () => {
    const provider = createLocalRecipientOnboardingProvider();
    await expect(
      provider.execute({
        deadlineAt: Date.now() + 1_000,
        operation: "refresh",
        operationId,
        providerReference: null,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("referência privada");
  });

  it.each([
    [
      localRecipientTestFixtureReferences.refused,
      { requirements: ["additional_information"], status: "refused" },
    ],
    [
      localRecipientTestFixtureReferences.suspended,
      { requirements: ["provider_contact"], status: "suspended" },
    ],
    [
      localRecipientTestFixtureReferences.blocked,
      { requirements: ["provider_contact"], status: "blocked" },
    ],
  ] as const)("maps the exact private test fixture %s", async (providerReference, expected) => {
    const provider = createLocalRecipientOnboardingProvider();
    await expect(
      provider.execute({
        deadlineAt: Date.now() + 1_000,
        operation: "refresh",
        operationId,
        providerReference,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ providerReference, ...expected });
  });

  it("supports unavailable and timeout fixtures only through a private test reference", async () => {
    const provider = createLocalRecipientOnboardingProvider();
    await expect(
      provider.execute({
        deadlineAt: Date.now() + 1_000,
        operation: "refresh",
        operationId,
        providerReference: localRecipientTestFixtureReferences.unavailable,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("indisponibilidade");

    const controller = new AbortController();
    const timeout = provider.execute({
      deadlineAt: Date.now() + 1_000,
      operation: "refresh",
      operationId,
      providerReference: localRecipientTestFixtureReferences.timeout,
      signal: controller.signal,
    });
    controller.abort();
    await expect(timeout).rejects.toMatchObject({ name: "AbortError" });
  });

  it.each(["local", "production"])(
    "refuses every reserved fixture reference in APP_ENV=%s",
    async (environment) => {
      vi.stubEnv("APP_ENV", environment);
      if (environment === "production") {
        expect(() => createLocalRecipientOnboardingProvider()).toThrow("proibido");
        return;
      }
      const provider = createLocalRecipientOnboardingProvider();
      await expect(
        provider.execute({
          deadlineAt: Date.now() + 1_000,
          operation: "refresh",
          operationId,
          providerReference: localRecipientTestFixtureReferences.refused,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("fora de teste");
    },
  );

  it("rejects a fixture-like reference outside the exact allowlist", async () => {
    const provider = createLocalRecipientOnboardingProvider();
    await expect(
      provider.execute({
        deadlineAt: Date.now() + 1_000,
        operation: "refresh",
        operationId,
        providerReference: "local-test-fixture:active-by-email",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("allowlist");
  });

  it("never changes nominal results based on an operation UUID", async () => {
    const provider = createLocalRecipientOnboardingProvider();
    for (const candidateOperationId of [
      operationId,
      "22222222-2222-4222-8222-222222222222",
      "ffffffff-ffff-4fff-8fff-ffffffffffff",
    ]) {
      await expect(
        provider.execute({
          deadlineAt: Date.now() + 1_000,
          operation: "refresh",
          operationId: candidateOperationId,
          providerReference: "ordinary-private-reference",
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({ requirements: [], status: "active" });
    }
  });
});

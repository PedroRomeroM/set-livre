import type { OwnerActivationResult, OwnerRecipientStatus } from "@set-livre/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  activateOwner,
  OwnerApiError,
  readOwnerActivation,
  readOwnerRecipient,
  refreshRecipientOnboarding,
  startRecipientOnboarding,
} from "../../src/domains/owners/components/owner-api";

const requestId = "11111111-1111-4111-8111-111111111111";
const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const idempotencyKey = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ownerContractVersionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ownerResult = {
  acceptedOwnerContractVersionId: null,
  nextAction: "activate_owner",
  ownerContract: {
    bodyMarkdown: "# Contrato local\n\nConteúdo de teste.",
    contentHash: "a".repeat(64),
    effectiveAt: "2026-08-12T00:00:00.000Z",
    id: ownerContractVersionId,
    kind: "owner_contract",
    source: "local_fixture",
    title: "Contrato do dono — fixture local",
    version: "local-2026-08-12",
  },
  ownerContractAccepted: false,
  ownerStatus: "inactive",
  ownerVersion: 0,
  profileVersion: 1,
  profileVersionSynced: null,
  projection: "activation",
  providerMode: "local",
  recipientOnboardingCapability: "local_adapter",
  recipientStatus: "not_started",
  recipientVersion: 0,
  requirements: [],
  reservationsEligible: false,
  scope: userId,
} satisfies OwnerActivationResult;
const recipientResult = {
  acceptedOwnerContractVersionId: ownerResult.acceptedOwnerContractVersionId,
  nextAction: ownerResult.nextAction,
  ownerContract: {
    effectiveAt: ownerResult.ownerContract.effectiveAt,
    id: ownerResult.ownerContract.id,
    source: ownerResult.ownerContract.source,
  },
  ownerContractAccepted: ownerResult.ownerContractAccepted,
  ownerStatus: ownerResult.ownerStatus,
  ownerVersion: ownerResult.ownerVersion,
  profileVersion: ownerResult.profileVersion,
  profileVersionSynced: ownerResult.profileVersionSynced,
  projection: "recipient",
  providerMode: ownerResult.providerMode,
  recipientOnboardingCapability: ownerResult.recipientOnboardingCapability,
  recipientStatus: ownerResult.recipientStatus,
  recipientVersion: ownerResult.recipientVersion,
  requirements: ownerResult.requirements,
  reservationsEligible: ownerResult.reservationsEligible,
  scope: ownerResult.scope,
} satisfies OwnerRecipientStatus;

describe("owner browser API", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reads only the strict scoped recipient projection", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ data: recipientResult, requestId }, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { clearTimeout, setTimeout });

    await expect(readOwnerRecipient()).resolves.toEqual(recipientResult);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/owner/recipient",
      expect.objectContaining({ cache: "no-store", credentials: "same-origin" }),
    );
  });

  it("reads the full legal document only from the activation endpoint", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ data: ownerResult, requestId }, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { clearTimeout, setTimeout });

    await expect(readOwnerActivation()).resolves.toEqual(ownerResult);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/owner/activation",
      expect.objectContaining({ cache: "no-store", credentials: "same-origin" }),
    );
  });

  it("rejects provider identifiers and raw payload fields in a successful response", async () => {
    const privateProviderId = "recipient_private_provider_reference";
    const fetchMock = vi.fn(async () =>
      Response.json(
        {
          data: { ...recipientResult, providerRecipientId: privateProviderId },
          requestId,
        },
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { clearTimeout, setTimeout });

    const error = await readOwnerRecipient().catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: "RESPONSE_INVALID" });
    expect(JSON.stringify(error)).not.toContain(privateProviderId);
  });

  it("fails closed when a recipient response omits the server-derived capability", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json(
        {
          data: { ...recipientResult, recipientOnboardingCapability: undefined },
          requestId,
        },
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { clearTimeout, setTimeout });

    await expect(readOwnerRecipient()).rejects.toMatchObject({ code: "RESPONSE_INVALID" });
  });

  it.each([
    [
      "owner.activate",
      () => activateOwner(userId, idempotencyKey, ownerContractVersionId),
      {
        action: "owner.activate",
        expectedScope: userId,
        idempotencyKey,
        payload: { acceptOwnerContract: true, ownerContractVersionId },
      },
      ownerResult,
    ],
    [
      "recipient.onboarding.start",
      () => startRecipientOnboarding(userId, idempotencyKey),
      {
        action: "recipient.onboarding.start",
        expectedScope: userId,
        idempotencyKey,
        payload: {},
      },
      recipientResult,
    ],
    [
      "recipient.onboarding.refresh",
      () => refreshRecipientOnboarding(userId, idempotencyKey),
      {
        action: "recipient.onboarding.refresh",
        expectedScope: userId,
        idempotencyKey,
        payload: {},
      },
      recipientResult,
    ],
  ] as const)(
    "serializes strict %s command envelopes",
    async (_name, execute, expectedBody, responseData) => {
      const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
        async () => Response.json({ data: responseData, requestId }, { status: 200 }),
      );
      vi.stubGlobal("fetch", fetchMock);
      vi.stubGlobal("window", { clearTimeout, setTimeout });

      await expect(execute()).resolves.toEqual(responseData);
      const call = fetchMock.mock.calls[0];
      expect(JSON.parse(String(call?.[1]?.body))).toEqual(expectedBody);
    },
  );

  it("maps timeout to a redacted verification-first error", async () => {
    vi.useFakeTimers();
    const rawProviderDetail = "raw-provider-timeout-payload";
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException(rawProviderDetail, "AbortError")),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { clearTimeout, setTimeout });

    const outcome = startRecipientOnboarding(userId, idempotencyKey).catch(
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(10_000);
    const error = await outcome;

    expect(error).toBeInstanceOf(OwnerApiError);
    expect(error).toMatchObject({ code: "REQUEST_TIMEOUT" });
    expect(JSON.stringify(error)).not.toContain(rawProviderDetail);
  });

  it("verifies an ambiguous provider failure with one GET and never repeats the POST", async () => {
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        Response.json(
          {
            error: {
              code: "PAYMENT_PROVIDER_UNAVAILABLE",
              message: "Consulte o estado atual antes de tentar novamente.",
              requestId,
            },
          },
          { status: 503 },
        ),
      )
      .mockResolvedValueOnce(Response.json({ data: recipientResult, requestId }, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { clearTimeout, setTimeout });

    await expect(startRecipientOnboarding(userId, idempotencyKey)).rejects.toMatchObject({
      code: "PAYMENT_PROVIDER_UNAVAILABLE",
    });
    await expect(readOwnerRecipient()).resolves.toEqual(recipientResult);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/owner/recipient");
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBeUndefined();
  });
});

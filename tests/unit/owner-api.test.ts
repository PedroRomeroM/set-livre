import type { OwnerRecipientResult } from "@set-livre/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  activateOwner,
  OwnerApiError,
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
  providerMode: "local",
  recipientStatus: "not_started",
  recipientVersion: 0,
  requirements: [],
  reservationsEligible: false,
  scope: userId,
} satisfies OwnerRecipientResult;

describe("owner browser API", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reads only the strict scoped recipient projection", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ data: ownerResult, requestId }, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { clearTimeout, setTimeout });

    await expect(readOwnerRecipient()).resolves.toEqual(ownerResult);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/owner/recipient",
      expect.objectContaining({ cache: "no-store", credentials: "same-origin" }),
    );
  });

  it("rejects provider identifiers and raw payload fields in a successful response", async () => {
    const privateProviderId = "recipient_private_provider_reference";
    const fetchMock = vi.fn(async () =>
      Response.json(
        {
          data: { ...ownerResult, providerRecipientId: privateProviderId },
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
    ],
  ] as const)("serializes strict %s command envelopes", async (_name, execute, expectedBody) => {
    const fetchMock = vi.fn(async () =>
      Response.json({ data: ownerResult, requestId }, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { clearTimeout, setTimeout });

    await expect(execute()).resolves.toEqual(ownerResult);
    const call = fetchMock.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit?];
    expect(JSON.parse(String(call[1]?.body))).toEqual(expectedBody);
  });

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
      .mockResolvedValueOnce(Response.json({ data: ownerResult, requestId }, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { clearTimeout, setTimeout });

    await expect(startRecipientOnboarding(userId, idempotencyKey)).rejects.toMatchObject({
      code: "PAYMENT_PROVIDER_UNAVAILABLE",
    });
    await expect(readOwnerRecipient()).resolves.toEqual(ownerResult);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/owner/recipient");
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBeUndefined();
  });
});

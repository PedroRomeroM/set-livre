import type {
  MyProfileResult,
  ProfileCompletePayload,
  ProfileUpdatePayload,
} from "@set-livre/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ProfileApiError,
  completeOwnProfile,
  readOwnProfile,
  updateOwnProfile,
} from "../../src/domains/identity/components/profile-api";

const requestId = "11111111-1111-4111-8111-111111111111";
const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const profileResult = {
  profile: {
    additionalDocumentMasked: "*********-6",
    colorScheme: "system",
    completed: true,
    name: "Pessoa Exemplo",
    personType: "individual",
    phone: "+5541999991234",
    preferencesVersion: 0,
    profileVersion: 1,
    status: "active",
    taxIdMasked: "***.***.***-25",
  },
  scope: userId,
} satisfies MyProfileResult;

const completePayload = {
  additionalDocument: "RG 12.345-6",
  expectedProfileVersion: 0,
  name: "Pessoa Exemplo",
  personType: "individual",
  phone: "+5541999991234",
  taxId: "52998224725",
} satisfies ProfileCompletePayload;
const updatePayload = {
  colorScheme: "dark",
  expectedPreferencesVersion: 0,
  section: "appearance",
} satisfies ProfileUpdatePayload;

describe("profile browser API", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reads the private profile without accepting unvalidated response fields", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ data: profileResult, requestId }, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { clearTimeout, setTimeout });

    await expect(readOwnProfile()).resolves.toEqual(profileResult);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/account/profile",
      expect.objectContaining({
        cache: "no-store",
        credentials: "same-origin",
      }),
    );
  });

  it("rejects a response that tries to return a raw tax identifier", async () => {
    const rawTaxId = completePayload.taxId;
    const fetchMock = vi.fn(async () =>
      Response.json(
        {
          data: {
            ...profileResult,
            profile: { ...profileResult.profile, taxId: rawTaxId },
          },
          requestId,
        },
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { clearTimeout, setTimeout });

    const error = await readOwnProfile().catch((cause: unknown) => cause);
    expect(error).toMatchObject({
      code: "RESPONSE_INVALID",
      message: "O servidor enviou uma resposta inesperada. Tente novamente.",
    });
    expect(JSON.stringify(error)).not.toContain(rawTaxId);
  });

  it("maps a version conflict to a recoverable redacted error", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      void _input;
      void _init;
      return Response.json(
        {
          error: {
            code: "CONFLICT",
            message: "O perfil foi alterado. Carregue a versão atual.",
            requestId,
          },
        },
        { status: 409 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { clearTimeout, setTimeout });

    await expect(completeOwnProfile(userId, completePayload)).rejects.toMatchObject({
      code: "CONFLICT",
      message: "O perfil foi alterado. Carregue a versão atual.",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      action: "profile.complete",
      expectedScope: userId,
      payload: completePayload,
    });
  });

  it("serializes the SSR scope assertion for profile updates", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      void _input;
      void _init;
      return Response.json({ data: profileResult, requestId }, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { clearTimeout, setTimeout });

    await expect(updateOwnProfile(userId, updatePayload)).resolves.toEqual(profileResult);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      action: "profile.update",
      expectedScope: userId,
      payload: updatePayload,
    });
  });

  it("aborts a pending command without retaining raw documents in the error", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("raw-provider-detail", "AbortError")),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { clearTimeout, setTimeout });

    const outcome = completeOwnProfile(userId, completePayload).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    const error = await outcome;

    expect(error).toBeInstanceOf(ProfileApiError);
    expect(error).toMatchObject({
      code: "REQUEST_TIMEOUT",
      message: "A solicitação demorou mais que o esperado. Tente novamente.",
    });
    const serialized = JSON.stringify(error);
    expect(serialized).not.toContain(completePayload.taxId);
    expect(serialized).not.toContain(completePayload.additionalDocument ?? "");
    expect(serialized).not.toContain("raw-provider-detail");
  });
});

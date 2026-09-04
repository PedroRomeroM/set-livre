import { type Database } from "@set-livre/contracts";
import { createClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BackofficeAuthContext } from "../../apps/backoffice/src/domains/backoffice/server/auth-context";
import type * as BackofficeDalModule from "../../apps/backoffice/src/domains/backoffice/server/backoffice-dal";
import type { RequiredRouteBackofficeSession } from "../../apps/backoffice/src/domains/backoffice/server/backoffice-session";
import type { BackofficeApiError } from "../../apps/backoffice/src/lib/server/api-route";
import {
  backofficeStudioReviewDetailRecordFixture,
  backofficeStudioReviewPreviewPath,
  studioTestIds,
} from "./studio-test-fixture";

vi.mock("server-only", () => ({}));

const dalMocks = vi.hoisted(() => ({
  getBackofficeStudioReview: vi.fn(),
  listBackofficeStudioReviews: vi.fn(),
  listBackofficeUsers: vi.fn(),
}));

vi.mock("../../apps/backoffice/src/lib/server/dal-pool", () => ({
  backofficeDalPool: () => ({ query: vi.fn() }),
}));
vi.mock("../../apps/backoffice/src/lib/supabase/config", () => ({
  readBackofficeSupabaseEnvironment: () => ({
    anonKey: "backoffice-anon-key",
    supabaseOrigin: "http://supabase.test",
  }),
}));
vi.mock(
  "../../apps/backoffice/src/domains/backoffice/server/backoffice-dal",
  async (importOriginal) => {
    const actual = await importOriginal<typeof BackofficeDalModule>();
    return {
      ...actual,
      getBackofficeStudioReview: dalMocks.getBackofficeStudioReview,
      listBackofficeStudioReviews: dalMocks.listBackofficeStudioReviews,
      listBackofficeUsers: dalMocks.listBackofficeUsers,
    };
  },
);
vi.mock("../../apps/backoffice/src/domains/backoffice/server/runtime-unlock", () => ({
  requireBackofficeRuntimeUnlock: vi.fn(),
}));

import { BackofficeCursorError } from "../../apps/backoffice/src/domains/backoffice/server/backoffice-dal";
import {
  backofficeStudioPreviewSigningDeadlineMs,
  readBackofficeStudioReview,
  readBackofficeStudioReviews,
  readBackofficeUserAccess,
  readBackofficeUsers,
} from "../../apps/backoffice/src/domains/backoffice/server/backoffice-service";

const auth = {
  authExpiresAt: "2026-09-01T22:00:00.000Z",
  authSessionId: "a1000000-0000-4000-8000-000000000010",
  email: "reviewer@example.com",
  userId: "a1000000-0000-4000-8000-000000000011",
} satisfies BackofficeAuthContext;
const previewPath = backofficeStudioReviewPreviewPath;
const reviewRecord = backofficeStudioReviewDetailRecordFixture({
  publicationVersion: 1,
  scope: auth.userId,
});

function signingClient() {
  return {
    auth: {
      getSession: vi.fn(async () => ({
        data: { session: { access_token: "reviewer-access-token" } },
        error: null,
      })),
    },
  };
}

function signingClientFactory(client = signingClient()) {
  return async () => client;
}

function requiredRoute(): RequiredRouteBackofficeSession {
  return {
    auth,
    client: createClient<Database>("http://supabase.test", "backoffice-anon-key", {
      auth: { autoRefreshToken: false, persistSession: false },
    }),
    responseHeaders: new Headers({ "x-session-refresh": "preserved" }),
    session: {
      authenticated: true,
      authorizationVersion: 1,
      authSessionId: auth.authSessionId,
      email: auth.email,
      expiresAt: auth.authExpiresAt,
      roles: ["admin"],
      scope: auth.userId,
      strongAuthenticationExpiresAt: "2026-09-01T21:30:00.000Z",
    },
  };
}

function signedStorageResponse() {
  return Response.json([
    {
      error: null,
      path: previewPath,
      signedURL: `/object/sign/studio-media/${previewPath}?token=signed-preview`,
    },
  ]);
}

function requireAbortSignal(signal: AbortSignal | null) {
  if (signal === null) throw new Error("O fetch não recebeu AbortSignal.");
  return signal;
}

describe("FEAT-030 backoffice review service boundaries", () => {
  beforeEach(() => {
    dalMocks.getBackofficeStudioReview.mockReset().mockResolvedValue(reviewRecord);
    dalMocks.listBackofficeStudioReviews.mockReset();
    dalMocks.listBackofficeUsers.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("signs with the authenticated token, propagates a signal and anchors expiry at signing start", async () => {
    vi.useFakeTimers();
    const signingStartedAt = new Date("2026-09-01T20:00:00.000Z");
    vi.setSystemTime(signingStartedAt);
    let observedSignal: AbortSignal | null = null;
    const storageFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const headers = new Headers(init?.headers);
      observedSignal = init?.signal ?? null;
      expect(headers.get("apikey")).toBe("backoffice-anon-key");
      expect(headers.get("authorization")).toBe("Bearer reviewer-access-token");
      vi.setSystemTime(new Date(signingStartedAt.getTime() + 750));
      return signedStorageResponse();
    });

    const detail = await readBackofficeStudioReview({
      activity: "passive",
      auth,
      createSigningClient: signingClientFactory(),
      studioId: studioTestIds.studioId,
    });

    expect(dalMocks.getBackofficeStudioReview).toHaveBeenCalledWith({
      auth,
      studioId: studioTestIds.studioId,
      touchActivity: false,
    });
    expect(storageFetch).toHaveBeenCalledOnce();
    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect(requireAbortSignal(observedSignal).aborted).toBe(false);
    expect(detail.previewExpiresAt).toBe("2026-09-01T20:05:00.000Z");
    expect(detail.candidateRevision.media[0]?.previewUrl).toContain("token=signed-preview");
  });

  it.each([
    ["scope", { ...reviewRecord, scope: studioTestIds.otherUserId }],
    ["studio", { ...reviewRecord, studioId: studioTestIds.otherStudioId }],
  ])(
    "rejects a divergent %s boundary before requesting a Storage token",
    async (_boundary, record) => {
      dalMocks.getBackofficeStudioReview.mockResolvedValueOnce(record);
      const client = signingClient();
      const storageFetch = vi.spyOn(globalThis, "fetch");

      await expect(
        readBackofficeStudioReview({
          activity: "interactive",
          auth,
          createSigningClient: signingClientFactory(client),
          studioId: studioTestIds.studioId,
        }),
      ).rejects.toThrow("backoffice_studio_response_boundary_violation");

      expect(client.auth.getSession).not.toHaveBeenCalled();
      expect(storageFetch).not.toHaveBeenCalled();
    },
  );

  it("canonicalizes an uppercase route UUID before the DAL and response boundary", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(signedStorageResponse());

    const detail = await readBackofficeStudioReview({
      activity: "interactive",
      auth,
      createSigningClient: signingClientFactory(),
      studioId: studioTestIds.studioId.toUpperCase(),
    });

    expect(dalMocks.getBackofficeStudioReview).toHaveBeenCalledWith({
      auth,
      studioId: studioTestIds.studioId,
      touchActivity: true,
    });
    expect(detail.studioId).toBe(studioTestIds.studioId);
  });

  it("cancels the Storage fetch when the incoming request is aborted", async () => {
    const requestController = new AbortController();
    let fetchStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      fetchStarted = resolve;
    });
    let observedSignal: AbortSignal | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          observedSignal = init?.signal ?? null;
          fetchStarted?.();
          observedSignal?.addEventListener("abort", () => reject(observedSignal?.reason), {
            once: true,
          });
        }),
    );

    const operation = readBackofficeStudioReview({
      activity: "interactive",
      auth,
      createSigningClient: signingClientFactory(),
      signal: requestController.signal,
      studioId: studioTestIds.studioId,
    });
    const rejection = expect(operation).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      status: 503,
    });
    await started;
    requestController.abort(new DOMException("Cliente desconectado.", "AbortError"));

    await rejection;
    expect(requireAbortSignal(observedSignal).aborted).toBe(true);
  });

  it("aborts a Storage request that exceeds the server-side signing deadline", async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | null = null;
    let markFetchStarted: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          observedSignal = init?.signal ?? null;
          markFetchStarted?.();
          observedSignal?.addEventListener("abort", () => reject(observedSignal?.reason), {
            once: true,
          });
        }),
    );

    const operation = readBackofficeStudioReview({
      activity: "interactive",
      auth,
      createSigningClient: signingClientFactory(),
      studioId: studioTestIds.studioId,
    });
    const rejection = expect(operation).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      status: 503,
    });
    await fetchStarted;
    await vi.advanceTimersByTimeAsync(backofficeStudioPreviewSigningDeadlineMs);

    await rejection;
    expect(requireAbortSignal(observedSignal).aborted).toBe(true);
  });

  it("bounds session retrieval inside the same server-side signing deadline", async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | null = null;
    let markSessionStarted: (() => void) | undefined;
    const sessionStarted = new Promise<void>((resolve) => {
      markSessionStarted = resolve;
    });
    const operation = readBackofficeStudioReview({
      activity: "interactive",
      auth,
      createSigningClient: (signal) => {
        observedSignal = signal;
        return {
          auth: {
            getSession: () =>
              new Promise((_resolve, reject) => {
                markSessionStarted?.();
                signal.addEventListener("abort", () => reject(signal.reason), { once: true });
              }),
          },
        };
      },
      studioId: studioTestIds.studioId,
    });
    const rejection = expect(operation).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      status: 503,
    });

    await sessionStarted;
    await vi.advanceTimersByTimeAsync(backofficeStudioPreviewSigningDeadlineMs);

    await rejection;
    expect(requireAbortSignal(observedSignal).aborted).toBe(true);
  });

  it("maps malformed user and studio cursors to typed 422 responses", async () => {
    dalMocks.listBackofficeUsers.mockRejectedValueOnce(new BackofficeCursorError());
    dalMocks.listBackofficeStudioReviews.mockRejectedValueOnce(new BackofficeCursorError());

    await expect(readBackofficeUsers(requiredRoute(), { cursor: "invalid" })).rejects.toMatchObject(
      {
        code: "VALIDATION_FAILED",
        fieldErrors: { cursor: expect.any(String) },
        status: 422,
      },
    );
    await expect(
      readBackofficeStudioReviews(requiredRoute(), { cursor: "invalid" }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      fieldErrors: { cursor: expect.any(String) },
      status: 422,
    });
  });

  it("raises typed cursor errors before any database query without leaking a discriminator", async () => {
    const actualDal = await vi.importActual<typeof BackofficeDalModule>(
      "../../apps/backoffice/src/domains/backoffice/server/backoffice-dal",
    );
    const userOperation = actualDal.listBackofficeUsers({ auth, cursor: "%" });

    await expect(userOperation).rejects.toMatchObject({
      name: "BackofficeCursorError",
    });
    await expect(userOperation).rejects.not.toHaveProperty("boundary");
    const studioOperation = actualDal.listBackofficeStudioReviews({
      auth,
      query: { cursor: "%" },
    });
    await expect(studioOperation).rejects.toMatchObject({
      name: "BackofficeCursorError",
    });
    await expect(studioOperation).rejects.not.toHaveProperty("boundary");
  });

  it("rejects malformed route UUIDs as safe 404 responses before reaching the DAL", async () => {
    await expect(
      readBackofficeStudioReview({
        activity: "interactive",
        auth,
        createSigningClient: signingClientFactory(),
        studioId: "not-a-uuid",
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<BackofficeApiError>>({ code: "NOT_FOUND", status: 404 }),
    );
    await expect(readBackofficeUserAccess({ auth, userId: "not-a-uuid" })).rejects.toEqual(
      expect.objectContaining<Partial<BackofficeApiError>>({ code: "NOT_FOUND", status: 404 }),
    );
    expect(dalMocks.getBackofficeStudioReview).not.toHaveBeenCalled();
  });
});

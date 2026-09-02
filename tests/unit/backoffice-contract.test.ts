import {
  backofficeCommandSchema,
  backofficeRuntimeUnlockPayloadSchema,
  backofficeSessionSchema,
  backofficeStudioReadActivityHeader,
  backofficeTaxonomyItemSchema,
  backofficeUserListSchema,
  backofficeUserSummarySchema,
  platformRolesSchema,
} from "@set-livre/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BackofficeClientError,
  executeBackofficeStudioCommand,
  isAmbiguousBackofficeError,
  isStaleBackofficeError,
  listBackofficeStudioReviewsClient,
  readBackofficeStudioReviewClient,
} from "../../apps/backoffice/src/domains/backoffice/components/backoffice-api";
import { useBackofficeHydrated } from "../../apps/backoffice/src/domains/backoffice/components/use-backoffice-hydrated";
import { backofficeAuthNetworkRateLimitOptions } from "../../apps/backoffice/src/lib/server/auth-rate-limit-profile";
import {
  backofficeStudioReviewDetailFixture,
  backofficeStudioReviewTestIds,
  studioTestIds,
} from "./studio-test-fixture";

const actorId = "10000000-0000-4000-8000-000000000001";
const targetId = "10000000-0000-4000-8000-000000000002";
const idempotencyKey = "10000000-0000-4000-8000-000000000003";
const revisionId = "10000000-0000-4000-8000-000000000004";

function installAbortAwareFetch() {
  const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted === true) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function BackofficeHydrationProbe() {
  return createElement("span", null, useBackofficeHydrated() ? "open" : "closed");
}

describe("backoffice contracts", () => {
  it("exposes a closed server snapshot for backoffice hydration boundaries", () => {
    expect(renderToStaticMarkup(createElement(BackofficeHydrationProbe))).toBe(
      "<span>closed</span>",
    );
  });

  it("accepts only the canonical runtime unlock key format", () => {
    const runtimeKey = "A".repeat(43);
    expect(backofficeRuntimeUnlockPayloadSchema.parse({ key: runtimeKey })).toEqual({
      key: runtimeKey,
    });
    expect(backofficeRuntimeUnlockPayloadSchema.safeParse({ key: "short" }).success).toBe(false);
    expect(
      backofficeRuntimeUnlockPayloadSchema.safeParse({
        key: `${"A".repeat(42)}!`,
      }).success,
    ).toBe(false);
  });

  it("expands only the E2E network bucket while preserving production auth limits", () => {
    expect(backofficeAuthNetworkRateLimitOptions("production")).toEqual({
      limit: 30,
      windowMs: 15 * 60_000,
    });
    expect(backofficeAuthNetworkRateLimitOptions("local")).toEqual({
      limit: 30,
      windowMs: 15 * 60_000,
    });
    expect(backofficeAuthNetworkRateLimitOptions("test")).toEqual({
      limit: 10_000,
      windowMs: 15 * 60_000,
    });
  });

  it("preserves only transport-ambiguous attempts for idempotent replay", () => {
    expect(isAmbiguousBackofficeError(new TypeError("network"))).toBe(true);
    expect(
      isAmbiguousBackofficeError(
        new BackofficeClientError({
          code: "RESPONSE_INVALID",
          message: "invalid",
          status: 200,
        }),
      ),
    ).toBe(true);
    expect(
      isAmbiguousBackofficeError(
        new BackofficeClientError({ code: "SERVICE_UNAVAILABLE", message: "down", status: 503 }),
      ),
    ).toBe(true);
    expect(
      isAmbiguousBackofficeError(
        new BackofficeClientError({ code: "CONFLICT", message: "stale", status: 409 }),
      ),
    ).toBe(false);
  });

  it("limits the ambiguous deadline to studio commands and preserves their exact key", async () => {
    vi.useFakeTimers();
    const fetchMock = installAbortAwareFetch();
    const command = {
      action: "backoffice.studio.approve",
      expectedScope: actorId,
      idempotencyKey,
      payload: {
        expectedPublicationVersion: 1,
        expectedRevisionId: revisionId,
        studioId: targetId,
      },
    } as const;

    const outcome = executeBackofficeStudioCommand(command).catch((error: unknown) => error);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(outcome).resolves.toMatchObject({
      code: "REQUEST_TIMEOUT",
      status: 504,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body))).toMatchObject({ idempotencyKey });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not impose the command deadline on cancellable studio reads", async () => {
    vi.useFakeTimers();
    const fetchMock = installAbortAwareFetch();
    const requestController = new AbortController();

    const outcome = readBackofficeStudioReviewClient(
      { activity: "passive", expectedScope: actorId, studioId: targetId },
      requestController.signal,
    ).catch((error: unknown) => error);
    expect(vi.getTimerCount()).toBe(0);
    const request = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(request?.headers).get(backofficeStudioReadActivityHeader)).toBe("passive");

    requestController.abort(new DOMException("Leitura substituída.", "AbortError"));
    await expect(outcome).resolves.toMatchObject({ name: "AbortError" });
  });

  it("rejects late studio reads before another private scope or record reaches the cache", async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });
    vi.stubGlobal("BroadcastChannel", undefined);
    const response = (data: unknown) =>
      new Response(JSON.stringify({ data, requestId: "10000000-0000-4000-8000-000000000099" }), {
        headers: { "content-type": "application/json" },
        status: 200,
      });

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          response({
            items: [],
            nextCursor: null,
            scope: backofficeStudioReviewTestIds.reviewerId,
          }),
        )
        .mockResolvedValueOnce(response(backofficeStudioReviewDetailFixture()))
        .mockResolvedValueOnce(response(backofficeStudioReviewDetailFixture())),
    );

    await expect(
      listBackofficeStudioReviewsClient({ expectedScope: actorId, query: {} }),
    ).rejects.toMatchObject({ code: "RESPONSE_INVALID", status: 200 });
    await expect(
      readBackofficeStudioReviewClient({
        activity: "interactive",
        expectedScope: actorId,
        studioId: studioTestIds.studioId,
      }),
    ).rejects.toMatchObject({ code: "RESPONSE_INVALID", status: 200 });
    await expect(
      readBackofficeStudioReviewClient({
        activity: "interactive",
        expectedScope: backofficeStudioReviewTestIds.reviewerId,
        studioId: studioTestIds.otherStudioId,
      }),
    ).rejects.toMatchObject({ code: "RESPONSE_INVALID", status: 200 });
    expect(dispatchEvent).toHaveBeenCalledTimes(3);
  });

  it("accepts only the operational roles delivered by FEAT-031 and FEAT-030", () => {
    expect(platformRolesSchema.parse(["support", "reviewer", "admin"])).toEqual([
      "support",
      "reviewer",
      "admin",
    ]);
    expect(platformRolesSchema.safeParse(["finance"]).success).toBe(false);
    expect(platformRolesSchema.safeParse(["admin", "admin"]).success).toBe(false);
  });

  it("keeps administrative commands strict and scoped", () => {
    expect(
      backofficeCommandSchema.parse({
        action: "backoffice.user.suspend",
        expectedScope: actorId,
        idempotencyKey,
        payload: { expectedAccountVersion: 2, userId: targetId },
      }),
    ).toMatchObject({ action: "backoffice.user.suspend", expectedScope: actorId });

    expect(
      backofficeCommandSchema.parse({
        action: "backoffice.user.restore",
        expectedScope: actorId,
        idempotencyKey,
        payload: { expectedAccountVersion: 3, userId: targetId },
      }),
    ).toMatchObject({ action: "backoffice.user.restore", expectedScope: actorId });

    expect(
      backofficeCommandSchema.safeParse({
        action: "backoffice.user.suspend",
        expectedScope: actorId,
        idempotencyKey,
        payload: { expectedAccountVersion: 2, status: "suspended", userId: targetId },
        trustedByClient: true,
      }).success,
    ).toBe(false);
  });

  it("rejects future roles and malformed taxonomy values at the boundary", () => {
    expect(
      backofficeCommandSchema.safeParse({
        action: "backoffice.access.grantSupport",
        expectedScope: actorId,
        idempotencyKey,
        payload: { expectedAccountVersion: 0, role: "finance", userId: targetId },
      }).success,
    ).toBe(false);

    expect(
      backofficeCommandSchema.safeParse({
        action: "backoffice.taxonomy.upsert",
        expectedScope: actorId,
        idempotencyKey,
        payload: {
          kind: "tag",
          name: " Podcast ",
          slug: "Podcast improvisado",
          sortOrder: -1,
        },
      }).success,
    ).toBe(false);
  });

  it("caps user pages and validates their private scope", () => {
    const item = {
      createdAt: "2026-08-29T00:00:00.000Z",
      accountVersion: 0,
      emailMasked: "p***@example.test",
      id: targetId,
      status: "active",
    } as const;
    expect(
      backofficeUserListSchema.parse({ items: [item], nextCursor: null, scope: actorId }),
    ).toMatchObject({ scope: actorId });
    expect(
      backofficeUserListSchema.safeParse({
        items: [{ ...item, name: "Pessoa QA" }],
        nextCursor: null,
        scope: actorId,
      }).success,
    ).toBe(false);
    expect(
      backofficeUserListSchema.safeParse({
        items: Array.from({ length: 51 }, () => item),
        nextCursor: null,
        scope: actorId,
      }).success,
    ).toBe(false);
  });

  it("keeps administrative role claims out of browser response contracts", () => {
    const session = {
      authenticated: true,
      authorizationVersion: 3,
      email: "operator@example.test",
      expiresAt: "2026-08-29T01:00:00.000Z",
      runtimeUnlockExpiresAt: null,
      scope: actorId,
      strongAuthenticationExpiresAt: "2026-08-29T00:05:00.000Z",
    } as const;
    expect(backofficeSessionSchema.parse(session)).toEqual(session);
    expect(backofficeSessionSchema.safeParse({ ...session, roles: ["admin"] }).success).toBe(false);
    expect(
      backofficeUserSummarySchema.safeParse({
        accountVersion: 1,
        createdAt: "2026-08-29T00:00:00.000Z",
        emailMasked: "p***@example.test",
        id: targetId,
        roles: ["support"],
        status: "active",
      }).success,
    ).toBe(false);
  });

  it("distinguishes stale state from transport ambiguity", () => {
    const stale = new BackofficeClientError({
      code: "STALE_STATE",
      message: "stale",
      status: 409,
    });
    expect(isStaleBackofficeError(stale)).toBe(true);
    expect(isAmbiguousBackofficeError(stale)).toBe(false);
    expect(
      isStaleBackofficeError(
        new BackofficeClientError({ code: "CONFLICT", message: "guardrail", status: 409 }),
      ),
    ).toBe(false);
  });

  it("accepts an archived taxonomy item without erasing its impact", () => {
    expect(
      backofficeTaxonomyItemSchema.parse({
        active: false,
        id: targetId,
        kind: "amenity",
        name: "Camarim",
        slug: "camarim",
        sortOrder: 4,
        updatedAt: "2026-08-29T00:00:00.000Z",
        usageCount: 7,
        version: 3,
      }),
    ).toMatchObject({ active: false, usageCount: 7, version: 3 });
  });

  it("requires controlled evidence for sensitive reads and optimistic writes", () => {
    expect(
      backofficeCommandSchema.safeParse({
        action: "backoffice.user.revealPii",
        expectedScope: actorId,
        idempotencyKey,
        payload: { reason: "support_case", userId: targetId },
      }).success,
    ).toBe(true);
    expect(
      backofficeCommandSchema.safeParse({
        action: "backoffice.user.revealPii",
        expectedScope: actorId,
        idempotencyKey,
        payload: { reason: "curiosity", userId: targetId },
      }).success,
    ).toBe(false);
    expect(
      backofficeCommandSchema.safeParse({
        action: "backoffice.taxonomy.setActive",
        expectedScope: actorId,
        idempotencyKey,
        payload: { active: false, expectedVersion: 2, id: targetId, kind: "tag" },
      }).success,
    ).toBe(false);
    expect(
      backofficeCommandSchema.parse({
        action: "backoffice.taxonomy.archive",
        expectedScope: actorId,
        idempotencyKey,
        payload: { expectedVersion: 2, id: targetId, kind: "tag" },
      }),
    ).toMatchObject({ action: "backoffice.taxonomy.archive" });
    expect(
      backofficeCommandSchema.parse({
        action: "backoffice.taxonomy.reactivate",
        expectedScope: actorId,
        idempotencyKey,
        payload: { expectedVersion: 3, id: targetId, kind: "tag" },
      }),
    ).toMatchObject({ action: "backoffice.taxonomy.reactivate" });
    expect(
      backofficeCommandSchema.safeParse({
        action: "backoffice.taxonomy.archive",
        expectedScope: actorId,
        idempotencyKey,
        payload: { active: false, expectedVersion: 2, id: targetId, kind: "tag" },
      }).success,
    ).toBe(false);
    expect(
      backofficeCommandSchema.safeParse({
        action: "backoffice.taxonomy.upsert",
        expectedScope: actorId,
        idempotencyKey,
        payload: {
          id: targetId,
          kind: "tag",
          name: "Podcast",
          slug: "podcast",
          sortOrder: 1,
        },
      }).success,
    ).toBe(false);
  });
});

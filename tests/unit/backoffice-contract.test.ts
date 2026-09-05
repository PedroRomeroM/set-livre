import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  backofficeCommandSchema,
  backofficeRuntimeUnlockPayloadSchema,
  backofficeSessionSchema,
  backofficeStudioReadActivityHeader,
  backofficeTaxonomyItemSchema,
  backofficeUserListSchema,
  backofficeUserSummarySchema,
  platformRolesSchema,
  type BackofficeTaxonomyStatusCommand,
  type BackofficeTaxonomyUpsertCommand,
} from "@set-livre/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BackofficeClientError,
  executeBackofficeStudioCommand,
  executeBackofficeTaxonomyCommand,
  executeBackofficeUserCommand,
  isAmbiguousBackofficeError,
  isStaleBackofficeError,
  listBackofficeStudioReviewsClient,
  listBackofficeTaxonomiesClient,
  listBackofficeUsersClient,
  loginBackofficeClient,
  logoutBackofficeClient,
  readBackofficeSessionClient,
  readBackofficeStudioReviewClient,
  revealBackofficePiiWithoutCaching,
  unlockBackofficeRuntimeClient,
} from "../../apps/backoffice/src/domains/backoffice/components/backoffice-api";
import { useBackofficeHydrated } from "../../apps/backoffice/src/domains/backoffice/components/use-backoffice-hydrated";
import { subscribeToBackofficeActivity } from "../../apps/backoffice/src/domains/backoffice/components/session-events";
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

function successResponse(data: unknown) {
  return new Response(JSON.stringify({ data, requestId: idempotencyKey }), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function BackofficeHydrationProbe() {
  return createElement("span", null, useBackofficeHydrated() ? "open" : "closed");
}

describe("backoffice contracts", () => {
  it("keeps the focused skip link inside the viewport safe areas", () => {
    const styles = readFileSync(
      resolve(
        process.cwd(),
        "apps/backoffice/src/domains/backoffice/components/backoffice.module.css",
      ),
      "utf8",
    );
    const skipLinkRules = styles.match(/\.skipLink\s*\{(?<rules>[^}]*)\}/)?.groups?.rules;

    expect(skipLinkRules).toBeDefined();
    expect(skipLinkRules).toContain("env(safe-area-inset-top)");
    expect(skipLinkRules).toContain("env(safe-area-inset-right)");
    expect(skipLinkRules).toContain("env(safe-area-inset-left)");
    expect(skipLinkRules).toContain("var(--sl-skip-link-inset-top)");
    expect(skipLinkRules).toContain("var(--sl-skip-link-inset-right)");
    expect(skipLinkRules).toContain("var(--sl-skip-link-inset-left)");
  });

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

  it("bounds every auth and administrative mutation while preserving idempotent payloads", async () => {
    vi.useFakeTimers();
    const fetchMock = installAbortAwareFetch();
    const studioCommand = {
      action: "backoffice.studio.approve",
      expectedScope: actorId,
      idempotencyKey,
      payload: {
        expectedPublicationVersion: 1,
        expectedRevisionId: revisionId,
        studioId: targetId,
      },
    } as const;
    const userCommand = {
      action: "backoffice.user.suspend",
      expectedScope: actorId,
      idempotencyKey,
      payload: { expectedAccountVersion: 0, userId: targetId },
    } as const;
    const taxonomyCommand = {
      action: "backoffice.taxonomy.upsert",
      expectedScope: actorId,
      idempotencyKey,
      payload: { kind: "tag", name: "Podcast", slug: "podcast", sortOrder: 1 },
    } as const;
    const piiCommand = {
      action: "backoffice.user.revealPii",
      expectedScope: actorId,
      idempotencyKey,
      payload: { reason: "support_case", userId: targetId },
    } as const;

    const outcomes = [
      loginBackofficeClient({ email: "admin@example.com", password: "not-persisted" }),
      logoutBackofficeClient(actorId),
      unlockBackofficeRuntimeClient({ key: "A".repeat(43) }),
      executeBackofficeStudioCommand(studioCommand),
      executeBackofficeUserCommand(userCommand),
      executeBackofficeTaxonomyCommand(taxonomyCommand),
      revealBackofficePiiWithoutCaching(piiCommand, () => undefined),
    ].map((outcome) => outcome.catch((error: unknown) => error));
    expect(vi.getTimerCount()).toBe(outcomes.length);
    await vi.advanceTimersByTimeAsync(10_000);

    const errors = await Promise.all(outcomes);
    expect(errors).toHaveLength(7);
    for (const error of errors) {
      expect(error).toMatchObject({ code: "REQUEST_TIMEOUT", status: 504 });
    }
    expect(fetchMock).toHaveBeenCalledTimes(outcomes.length);
    const idempotencyKeys = fetchMock.mock.calls
      .map((call) => JSON.parse(String(call[1]?.body)) as Record<string, unknown>)
      .flatMap((body) => (typeof body.idempotencyKey === "string" ? [body.idempotencyKey] : []));
    expect(idempotencyKeys).toEqual([
      idempotencyKey,
      idempotencyKey,
      idempotencyKey,
      idempotencyKey,
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["headers", "body"] as const)("bounds all private reads through %s", async (phase) => {
    vi.useFakeTimers();
    const fetchMock = installAbortAwareFetch();
    if (phase === "body") {
      fetchMock.mockImplementation((_input, init) =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                init?.signal?.addEventListener(
                  "abort",
                  () => controller.error(init.signal?.reason),
                  { once: true },
                );
              },
            }),
          ),
        ),
      );
    }
    const outcomes = [
      readBackofficeSessionClient(),
      listBackofficeUsersClient({ expectedScope: actorId, query: {} }),
      listBackofficeTaxonomiesClient(actorId),
      listBackofficeStudioReviewsClient({ expectedScope: actorId, query: {} }),
      readBackofficeStudioReviewClient({
        activity: "passive",
        expectedScope: actorId,
        studioId: targetId,
      }),
    ].map((outcome) => outcome.catch((error: unknown) => error));

    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetchMock.mock.calls.every((call) => call[1]?.signal?.aborted === false)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    for (const error of await Promise.all(outcomes)) {
      expect(error).toMatchObject({ code: "REQUEST_TIMEOUT", status: 504 });
    }
    expect(fetchMock.mock.calls.every((call) => call[1]?.signal?.aborted === true)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves caller cancellation and passive activity on deadline-bound reads", async () => {
    vi.useFakeTimers();
    const fetchMock = installAbortAwareFetch();
    const requestController = new AbortController();

    const outcome = readBackofficeStudioReviewClient(
      { activity: "passive", expectedScope: actorId, studioId: targetId },
      requestController.signal,
    ).catch((error: unknown) => error);
    expect(vi.getTimerCount()).toBe(1);
    const request = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(request?.headers).get(backofficeStudioReadActivityHeader)).toBe("passive");

    const reason = new DOMException("Leitura substituída.", "AbortError");
    requestController.abort(reason);
    await expect(outcome).resolves.toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves cancellation during body consumption instead of reporting an invalid response", async () => {
    vi.useFakeTimers();
    const requestController = new AbortController();
    const reason = new DOMException("Leitura substituída.", "AbortError");
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                init?.signal?.addEventListener(
                  "abort",
                  () => controller.error(init.signal?.reason),
                  { once: true },
                );
              },
            }),
          ),
        ),
      ),
    );
    const outcome = listBackofficeUsersClient(
      { expectedScope: actorId, query: {} },
      requestController.signal,
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1);
    requestController.abort(reason);
    await expect(outcome).resolves.toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears a completed read deadline and honors an already-cancelled caller", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(successResponse({ items: [], scope: actorId })),
    );
    await expect(listBackofficeTaxonomiesClient(actorId)).resolves.toEqual({
      items: [],
      scope: actorId,
    });
    expect(vi.getTimerCount()).toBe(0);

    const fetchMock = installAbortAwareFetch();
    const reason = new DOMException("Leitura cancelada.", "AbortError");
    await expect(listBackofficeTaxonomiesClient(actorId, AbortSignal.abort(reason))).rejects.toBe(
      reason,
    );
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    "backoffice.user.suspend",
    "backoffice.user.restore",
    "backoffice.access.grantAdmin",
    "backoffice.access.grantReviewer",
    "backoffice.access.grantSupport",
    "backoffice.access.revokeAdmin",
    "backoffice.access.revokeReviewer",
    "backoffice.access.revokeSupport",
  ] as const)("binds %s results to the requested user before accepting success", async (action) => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });
    vi.stubGlobal("BroadcastChannel", undefined);
    const user = {
      accountVersion: 1,
      createdAt: "2026-09-04T10:00:00.000Z",
      emailMasked: "t***@example.test",
      id: targetId,
      status: "active",
    };
    const command = {
      action,
      expectedScope: actorId,
      idempotencyKey,
      payload: { userId: targetId, expectedAccountVersion: 0 },
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(successResponse({ ...user, id: actorId }))
        .mockResolvedValueOnce(successResponse(user)),
    );

    const mismatch = await executeBackofficeUserCommand(command).catch((error: unknown) => error);
    expect(mismatch).toMatchObject({ code: "RESPONSE_INVALID", status: 200 });
    expect(isAmbiguousBackofficeError(mismatch)).toBe(true);
    expect(dispatchEvent).toHaveBeenCalledOnce();
    await expect(executeBackofficeUserCommand(command)).resolves.toEqual(user);
    expect(dispatchEvent).toHaveBeenCalledOnce();
  });

  it.each(["create", "update", "archive", "reactivate"] as const)(
    "binds taxonomy %s results to the requested kind and existing id",
    async (action) => {
      const dispatchEvent = vi.fn();
      vi.stubGlobal("window", { dispatchEvent });
      vi.stubGlobal("BroadcastChannel", undefined);
      const command: BackofficeTaxonomyStatusCommand | BackofficeTaxonomyUpsertCommand =
        action === "create" || action === "update"
          ? {
              action: "backoffice.taxonomy.upsert",
              expectedScope: actorId,
              idempotencyKey,
              payload: {
                kind: "tag",
                name: action === "create" ? " Podcast " : "Podcast",
                slug: action === "create" ? " podcast " : "podcast",
                sortOrder: 1,
                ...(action === "update" ? { id: targetId, expectedVersion: 1 } : {}),
              },
            }
          : {
              action:
                action === "archive"
                  ? "backoffice.taxonomy.archive"
                  : "backoffice.taxonomy.reactivate",
              expectedScope: actorId,
              idempotencyKey,
              payload: { kind: "tag", id: targetId, expectedVersion: 1 },
            };
      const item = {
        active: action !== "archive",
        id: targetId,
        kind: "tag",
        name: "Podcast",
        slug: "podcast",
        sortOrder: 1,
        updatedAt: "2026-09-04T10:00:00.000Z",
        usageCount: 0,
        version: 2,
      };
      const mismatches = [
        { ...item, kind: "amenity" },
        ...(action === "create"
          ? [
              { ...item, name: "Outra taxonomia" },
              { ...item, slug: "outro-slug" },
              { ...item, sortOrder: 2 },
              { ...item, active: false },
            ]
          : [{ ...item, id: actorId }]),
      ];
      for (const response of mismatches) {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(successResponse(response)));
        const mismatch = await executeBackofficeTaxonomyCommand(command).catch(
          (error: unknown) => error,
        );
        expect(mismatch).toMatchObject({ code: "RESPONSE_INVALID", status: 200 });
        expect(isAmbiguousBackofficeError(mismatch)).toBe(true);
      }
      expect(dispatchEvent).toHaveBeenCalledTimes(mismatches.length);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(successResponse(item)));
      await expect(executeBackofficeTaxonomyCommand(command)).resolves.toEqual(item);
      expect(dispatchEvent).toHaveBeenCalledTimes(mismatches.length);
    },
  );

  it("publishes operational activity after reads and commands, but never from passive polling", async () => {
    const activity = vi.fn();
    const unsubscribe = subscribeToBackofficeActivity(activity);
    const detail = backofficeStudioReviewDetailFixture();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      fetchMock.mockResolvedValueOnce(
        successResponse({ items: [], nextCursor: null, scope: actorId }),
      );
      await listBackofficeUsersClient({ expectedScope: actorId, query: {} });
      expect(activity).toHaveBeenCalledTimes(1);

      fetchMock.mockResolvedValueOnce(successResponse({ items: [], scope: actorId }));
      await listBackofficeTaxonomiesClient(actorId);
      expect(activity).toHaveBeenCalledTimes(2);

      fetchMock.mockResolvedValueOnce(successResponse(detail));
      await readBackofficeStudioReviewClient({
        activity: "interactive",
        expectedScope: detail.scope,
        studioId: detail.studioId,
      });
      expect(activity).toHaveBeenCalledTimes(3);

      fetchMock.mockResolvedValueOnce(
        successResponse({
          accountVersion: 1,
          createdAt: "2026-09-04T10:00:00.000Z",
          emailMasked: "t***@example.test",
          id: targetId,
          status: "active",
        }),
      );
      await executeBackofficeUserCommand({
        action: "backoffice.access.grantSupport",
        expectedScope: actorId,
        idempotencyKey,
        payload: { expectedAccountVersion: 0, userId: targetId },
      });
      expect(activity).toHaveBeenCalledTimes(4);

      fetchMock.mockResolvedValueOnce(successResponse(detail));
      await readBackofficeStudioReviewClient({
        activity: "passive",
        expectedScope: detail.scope,
        studioId: detail.studioId,
      });
      fetchMock.mockResolvedValueOnce(successResponse({ authenticated: false }));
      await readBackofficeSessionClient();
      expect(activity).toHaveBeenCalledTimes(4);
    } finally {
      unsubscribe();
    }
    fetchMock.mockResolvedValueOnce(successResponse({ items: [], scope: actorId }));
    await listBackofficeTaxonomiesClient(actorId);
    expect(activity).toHaveBeenCalledTimes(4);
  });

  it("rejects late private reads before another scope or record reaches the cache", async () => {
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
        .mockResolvedValueOnce(
          response({ items: [], scope: backofficeStudioReviewTestIds.reviewerId }),
        )
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
      listBackofficeUsersClient({ expectedScope: actorId, query: {} }),
    ).rejects.toMatchObject({ code: "RESPONSE_INVALID", status: 200 });
    await expect(listBackofficeTaxonomiesClient(actorId)).rejects.toMatchObject({
      code: "RESPONSE_INVALID",
      status: 200,
    });
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
    expect(dispatchEvent).toHaveBeenCalledTimes(5);
  });

  it.each([
    {
      label: "another session scope",
      scope: backofficeStudioReviewTestIds.reviewerId,
      userId: targetId,
    },
    {
      label: "another requested user",
      scope: actorId,
      userId: studioTestIds.otherStudioId,
    },
  ])("rejects revealed PII for $label before consumption", async ({ scope, userId }) => {
    const dispatchEvent = vi.fn();
    const consume = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });
    vi.stubGlobal("BroadcastChannel", undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: {
              additionalDocument: null,
              email: "target@example.test",
              name: "Usuário alvo",
              phoneE164: null,
              scope,
              taxId: null,
              userId,
            },
            requestId: "10000000-0000-4000-8000-000000000099",
          }),
          { headers: { "content-type": "application/json" }, status: 200 },
        ),
      ),
    );

    await expect(
      revealBackofficePiiWithoutCaching(
        {
          action: "backoffice.user.revealPii",
          expectedScope: actorId,
          idempotencyKey,
          payload: { reason: "support_case", userId: targetId },
        },
        consume,
      ),
    ).rejects.toMatchObject({ code: "RESPONSE_INVALID", status: 200 });
    expect(consume).not.toHaveBeenCalled();
    expect(dispatchEvent).toHaveBeenCalledOnce();
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

import {
  backofficeCommandSchema,
  backofficeRuntimeUnlockPayloadSchema,
  backofficeSessionSchema,
  backofficeTaxonomyItemSchema,
  backofficeUserListSchema,
  backofficeUserSummarySchema,
  platformRolesSchema,
} from "@set-livre/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  BackofficeClientError,
  isAmbiguousBackofficeError,
  isStaleBackofficeError,
} from "../../apps/backoffice/src/domains/backoffice/components/backoffice-api";
import { useBackofficeHydrated } from "../../apps/backoffice/src/domains/backoffice/components/use-backoffice-hydrated";
import { backofficeAuthNetworkRateLimitOptions } from "../../apps/backoffice/src/lib/server/auth-rate-limit-profile";

const actorId = "10000000-0000-4000-8000-000000000001";
const targetId = "10000000-0000-4000-8000-000000000002";
const idempotencyKey = "10000000-0000-4000-8000-000000000003";

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

  it("accepts only the roles delivered by FEAT-031", () => {
    expect(platformRolesSchema.parse(["support", "admin"])).toEqual(["support", "admin"]);
    expect(platformRolesSchema.safeParse(["reviewer"]).success).toBe(false);
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

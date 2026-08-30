import {
  backofficeCommandSchema,
  backofficeTaxonomyItemSchema,
  backofficeUserListSchema,
  platformRolesSchema,
} from "@set-livre/contracts";
import { describe, expect, it } from "vitest";

import {
  BackofficeClientError,
  isAmbiguousBackofficeError,
} from "../../apps/backoffice/src/domains/backoffice/components/backoffice-api";

const actorId = "10000000-0000-4000-8000-000000000001";
const targetId = "10000000-0000-4000-8000-000000000002";
const idempotencyKey = "10000000-0000-4000-8000-000000000003";

describe("backoffice contracts", () => {
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
        action: "backoffice.user.setStatus",
        expectedScope: actorId,
        idempotencyKey,
        payload: { expectedAccountVersion: 2, status: "suspended", userId: targetId },
      }),
    ).toMatchObject({ action: "backoffice.user.setStatus", expectedScope: actorId });

    expect(
      backofficeCommandSchema.safeParse({
        action: "backoffice.user.setStatus",
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
        action: "backoffice.access.setRole",
        expectedScope: actorId,
        idempotencyKey,
        payload: { enabled: true, expectedRoles: [], role: "finance", userId: targetId },
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
      name: "Pessoa QA",
      roles: ["support"],
      status: "active",
    } as const;
    expect(
      backofficeUserListSchema.parse({ items: [item], nextCursor: null, scope: actorId }),
    ).toMatchObject({ scope: actorId });
    expect(
      backofficeUserListSchema.safeParse({
        items: Array.from({ length: 51 }, () => item),
        nextCursor: null,
        scope: actorId,
      }).success,
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
        payload: { active: false, id: targetId, kind: "tag" },
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

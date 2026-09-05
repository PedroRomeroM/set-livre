import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackofficeAuthContext } from "../../apps/backoffice/src/domains/backoffice/server/auth-context";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../apps/backoffice/src/lib/server/dal-pool", () => ({
  backofficeDalPool: () => ({ query: mocks.query }),
}));

import {
  executeBackofficeStudioCommand,
  setBackofficeUserRole,
  setBackofficeUserStatus,
  transitionBackofficeTaxonomy,
  upsertBackofficeTaxonomy,
} from "../../apps/backoffice/src/domains/backoffice/server/backoffice-dal";

const actorId = "a1000000-0000-4000-8000-000000000001";
const targetId = "a1000000-0000-4000-8000-000000000002";
const idempotencyKey = "a1000000-0000-4000-8000-000000000003";
const otherId = "a1000000-0000-4000-8000-000000000099";
const requestId = "a1000000-0000-4000-8000-000000000004";
const revisionId = "a1000000-0000-4000-8000-000000000005";
const auth: BackofficeAuthContext = {
  userId: actorId,
  authSessionId: "a1000000-0000-4000-8000-000000000010",
  authExpiresAt: "2026-09-05T20:00:00.000Z",
  email: "qa-attempt@example.test",
};
const attempt = { expectedScope: actorId, idempotencyKey };
const echo = { scope: actorId, idempotencyKey };
const user = {
  accountVersion: 1,
  createdAt: "2026-09-05T10:00:00.000Z",
  emailMasked: "q***@example.test",
  id: targetId,
  status: "active",
};
const taxonomy = {
  active: true,
  id: targetId,
  kind: "tag",
  name: "Tentativa QA",
  slug: "qa-attempt",
  sortOrder: 1,
  usageCount: 0,
  version: 1,
  updatedAt: "2026-09-05T10:00:00.000Z",
};
const scenarios = [
  {
    name: "status",
    invoke: (binding = auth, key = idempotencyKey) =>
      setBackofficeUserStatus({
        auth: binding,
        requestId,
        command: {
          ...attempt,
          idempotencyKey: key,
          action: "backoffice.user.suspend",
          payload: { expectedAccountVersion: 0, userId: targetId },
        },
      }),
    result: { ...user, ...echo, action: "backoffice.user.suspend", status: "suspended" },
  },
  {
    name: "access role",
    invoke: (binding = auth, key = idempotencyKey) =>
      setBackofficeUserRole({
        auth: binding,
        requestId,
        command: {
          ...attempt,
          idempotencyKey: key,
          action: "backoffice.access.grantSupport",
          payload: { expectedAccountVersion: 0, userId: targetId },
        },
      }),
    result: { ...user, ...echo, action: "backoffice.access.grantSupport" },
  },
  {
    name: "taxonomy upsert",
    invoke: (binding = auth, key = idempotencyKey) =>
      upsertBackofficeTaxonomy({
        auth: binding,
        requestId,
        command: {
          ...attempt,
          idempotencyKey: key,
          action: "backoffice.taxonomy.upsert",
          payload: {
            kind: "tag",
            id: targetId,
            expectedVersion: 0,
            name: taxonomy.name,
            slug: taxonomy.slug,
            sortOrder: 1,
          },
        },
      }),
    result: { ...taxonomy, ...echo, action: "backoffice.taxonomy.upsert" },
  },
  {
    name: "taxonomy transition",
    invoke: (binding = auth, key = idempotencyKey) =>
      transitionBackofficeTaxonomy({
        auth: binding,
        requestId,
        command: {
          ...attempt,
          idempotencyKey: key,
          action: "backoffice.taxonomy.archive",
          payload: { kind: "tag", id: targetId, expectedVersion: 0 },
        },
      }),
    result: { ...taxonomy, ...echo, active: false, action: "backoffice.taxonomy.archive" },
  },
  {
    name: "studio rejection",
    invoke: (binding = auth, key = idempotencyKey) =>
      executeBackofficeStudioCommand({
        auth: binding,
        requestId,
        command: {
          ...attempt,
          idempotencyKey: key,
          action: "backoffice.studio.reject",
          payload: {
            studioId: targetId,
            expectedPublicationVersion: 0,
            expectedRevisionId: revisionId,
            reason: "Confirme os dados da candidata QA.",
          },
        },
      }),
    result: {
      ...echo,
      action: "backoffice.studio.reject",
      studioId: targetId,
      publicationVersion: 1,
      revisionId,
      draftRevisionId: otherId,
      publishedRevisionId: null,
      disabledFromStatus: null,
      studioStatus: "rejected",
    },
  },
];

describe.each(scenarios)("ledger attempt validation: $name", ({ invoke, result }) => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("BACKOFFICE_RUNTIME_UNLOCK_KEY", "A".repeat(43));
    vi.stubEnv("DATABASE_URL_APP_DAL", "postgresql://dal:secret@127.0.0.1:54322/postgres");
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each([idempotencyKey, idempotencyKey.toUpperCase()])(
    "preserves the lowercase ledger identity and replay bytes for key %s",
    async (key) => {
      mocks.query.mockResolvedValue({ rows: [{ result }] });
      expect(await invoke(auth, key)).toEqual(result);
      expect(await invoke(auth, key)).toEqual(result);
      expect(mocks.query.mock.calls[1]).toEqual(mocks.query.mock.calls[0]);
      expect(mocks.query.mock.calls[0]?.[1]).toContain(key);
    },
  );

  it.each(["action", "idempotencyKey", "scope"])(
    "rejects missing %s rather than manufacturing it",
    async (field) => {
      const incomplete = Object.fromEntries(
        Object.entries(result).filter(([key]) => key !== field),
      );
      mocks.query.mockResolvedValue({ rows: [{ result: incomplete }] });
      await expect(invoke()).rejects.toMatchObject({ name: "ZodError" });
    },
  );

  it.each([idempotencyKey, idempotencyKey.toUpperCase()])(
    "rejects a different persisted attempt for submitted key %s",
    async (key) => {
      for (const invalidKey of [otherId, idempotencyKey.toUpperCase()]) {
        mocks.query.mockResolvedValue({
          rows: [{ result: { ...result, idempotencyKey: invalidKey } }],
        });
        await expect(invoke(auth, key)).rejects.toMatchObject({ name: "ZodError" });
      }
    },
  );

  it("uses the authenticated actor rather than the client scope as authority", async () => {
    mocks.query.mockResolvedValue({ rows: [{ result }] });
    await expect(invoke({ ...auth, userId: otherId })).rejects.toMatchObject({ name: "ZodError" });
  });
});

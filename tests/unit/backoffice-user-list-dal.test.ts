import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BackofficeAuthContext } from "../../apps/backoffice/src/domains/backoffice/server/auth-context";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../../apps/backoffice/src/lib/server/dal-pool", () => ({
  backofficeDalPool: () => ({ query: mocks.query }),
}));

import { listBackofficeUsers } from "../../apps/backoffice/src/domains/backoffice/server/backoffice-dal";
import { backofficeFilterFingerprint } from "../../apps/backoffice/src/domains/backoffice/components/query-keys";

const auth = {
  authExpiresAt: "2026-09-03T20:00:00.000Z",
  authSessionId: "a1000000-0000-4000-8000-000000000010",
  email: "admin@example.test",
  userId: "a1000000-0000-4000-8000-000000000011",
} satisfies BackofficeAuthContext;

function fixtureUuid(value: number) {
  return `10000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
}

function userRow(value: number) {
  return {
    account_version: "1",
    created_at: "2026-09-03T18:00:00.000Z",
    cursor_created_at: `2026-09-03T18:00:${value.toString().padStart(2, "0")}.000000Z`,
    email_masked: `u${value}***@example.test`,
    id: fixtureUuid(value),
    status: "active",
  };
}

describe("backoffice user list cursor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("BACKOFFICE_RUNTIME_UNLOCK_KEY", "A".repeat(43));
    vi.stubEnv("DATABASE_URL_APP_DAL", "postgresql://dal:secret@127.0.0.1:54322/postgres");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("round-trips only with the issuing session and normalized filter", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: Array.from({ length: 51 }, (_, index) => userRow(index)) })
      .mockResolvedValueOnce({ rows: [userRow(51)] });

    const firstPage = await listBackofficeUsers({ auth, query: "  AnA  " });
    expect(firstPage.nextCursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u);
    expect(mocks.query.mock.calls[0]?.[1]?.[3]).toBe("ana");
    expect(mocks.query.mock.calls[0]?.[0]).toMatch(
      /select\s+listed\.account_version, listed\.created_at, listed\.email_masked, listed\.id, listed\.status,/u,
    );
    expect(await backofficeFilterFingerprint("  AnA  ")).toBe(
      await backofficeFilterFingerprint("ana"),
    );

    await listBackofficeUsers({ auth, cursor: firstPage.nextCursor, query: "ana" });
    expect(mocks.query).toHaveBeenNthCalledWith(2, expect.stringContaining("$5::timestamptz"), [
      auth.userId,
      auth.authSessionId,
      auth.authExpiresAt,
      "ana",
      "2026-09-03T18:00:49.000000Z",
      fixtureUuid(49),
      51,
    ]);
  });

  it.each([undefined, "", "   "])(
    "canonicalizes the empty filter %j for SQL and cursor reuse",
    async (query) => {
      mocks.query
        .mockResolvedValueOnce({ rows: Array.from({ length: 51 }, (_, index) => userRow(index)) })
        .mockResolvedValueOnce({ rows: [] });
      const firstPage = await listBackofficeUsers({ auth, query });
      await listBackofficeUsers({ auth, cursor: firstPage.nextCursor });
      expect(mocks.query.mock.calls.map((call) => call[1]?.[3])).toEqual([null, null]);
    },
  );

  it("rejects transplanting an issued cursor to another filter before querying", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: Array.from({ length: 51 }, (_, index) => userRow(index)),
    });
    const firstPage = await listBackofficeUsers({ auth, query: "ana" });
    mocks.query.mockClear();

    const operation = listBackofficeUsers({
      auth,
      cursor: firstPage.nextCursor,
      query: "beatriz",
    });

    await expect(operation).rejects.toMatchObject({ name: "BackofficeCursorError" });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("rejects a forged canonical base64url payload before querying", async () => {
    const forgedPayload = Buffer.from(
      JSON.stringify({
        createdAt: "2026-09-03T18:00:00.000Z",
        id: fixtureUuid(1),
        kind: "users",
        version: 1,
      }),
      "utf8",
    ).toString("base64url");

    const operation = listBackofficeUsers({
      auth,
      cursor: `${forgedPayload}.${"A".repeat(43)}`,
      query: "ana",
    });

    await expect(operation).rejects.toMatchObject({ name: "BackofficeCursorError" });
    expect(mocks.query).not.toHaveBeenCalled();
  });
});

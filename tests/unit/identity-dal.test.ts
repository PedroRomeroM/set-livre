import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  poolOn: vi.fn(),
  query: vi.fn(),
}));

vi.mock("pg", () => ({
  Pool: class Pool {
    on = mocks.poolOn;
    query = mocks.query;
  },
}));

import { inspectIdentityRecoverySession } from "../../src/domains/identity/server/identity-dal";

const inspectionInput = {
  authExpiresAt: "2100-01-01T00:00:00.000Z",
  authSessionId: "11111111-1111-4111-8111-111111111111",
  sessionScope: "22222222-2222-4222-8222-222222222222",
  token: "33333333-3333-4333-8333-333333333333",
  userId: "44444444-4444-4444-8444-444444444444",
};

describe("identity recovery DAL cardinality", () => {
  beforeAll(() => {
    process.env.DATABASE_URL_APP_DAL =
      "postgresql://app_runtime:local-password@127.0.0.1:54322/postgres?options=-c%20role%3Dapp_dal";
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses undefined only for the canonical zero-row absence", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });

    await expect(inspectIdentityRecoverySession(inspectionInput)).resolves.toBeUndefined();
  });

  it("throws instead of reclassifying a malformed binding row as an ordinary session", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [{ active: true, grant_allowed: true, session_scope: "malformed" }],
    });

    await expect(inspectIdentityRecoverySession(inspectionInput)).rejects.toThrow();
  });

  it("throws on impossible multiple binding rows", async () => {
    const row = {
      active: true,
      grant_allowed: true,
      session_scope: "22222222-2222-4222-8222-222222222222",
    };
    mocks.query.mockResolvedValueOnce({ rows: [row, row] });

    await expect(inspectIdentityRecoverySession(inspectionInput)).rejects.toThrow(
      "cardinalidade inesperada",
    );
  });
});

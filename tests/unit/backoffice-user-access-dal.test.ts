import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BackofficeAuthContext } from "../../apps/backoffice/src/domains/backoffice/server/auth-context";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../../apps/backoffice/src/lib/server/dal-pool", () => ({
  backofficeDalPool: () => ({ query: mocks.query }),
}));

import { getBackofficeUserAccess } from "../../apps/backoffice/src/domains/backoffice/server/backoffice-dal";

const auth = {
  authExpiresAt: "2026-09-03T07:00:00.000Z",
  authSessionId: "a1000000-0000-4000-8000-000000000010",
  email: "admin@example.test",
  userId: "a1000000-0000-4000-8000-000000000011",
} satisfies BackofficeAuthContext;

function accessRow(profileCompleted: boolean) {
  return {
    account_version: "3",
    created_at: "2026-09-03T06:00:00.000Z",
    email_masked: "u***@example.test",
    id: "a1000000-0000-4000-8000-000000000012",
    profile_completed: profileCompleted,
    roles: [],
    status: "active",
  };
}

describe("backoffice user access DAL", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preserves profile eligibility from the private server-only read model", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [accessRow(false)] });

    await expect(
      getBackofficeUserAccess({ auth, userId: "a1000000-0000-4000-8000-000000000012" }),
    ).resolves.toMatchObject({ account_version: 3, profile_completed: false, roles: [] });
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringMatching(
        /^select account_version, created_at, email_masked, id, status, profile_completed, roles\s+from private\.get_backoffice_user_access/u,
      ),
      [auth.userId, auth.authSessionId, auth.authExpiresAt, "a1000000-0000-4000-8000-000000000012"],
    );
  });

  it("fails closed when the eligibility field is absent", async () => {
    const malformed: Record<string, unknown> = { ...accessRow(true) };
    delete malformed.profile_completed;
    mocks.query.mockResolvedValueOnce({ rows: [malformed] });

    await expect(
      getBackofficeUserAccess({ auth, userId: "a1000000-0000-4000-8000-000000000012" }),
    ).rejects.toThrow();
  });
});

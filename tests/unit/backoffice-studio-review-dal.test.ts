import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BackofficeAuthContext } from "../../apps/backoffice/src/domains/backoffice/server/auth-context";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../../apps/backoffice/src/lib/server/dal-pool", () => ({
  backofficeDalPool: () => ({ query: mocks.query }),
}));

import { listBackofficeStudioReviews } from "../../apps/backoffice/src/domains/backoffice/server/backoffice-dal";

const auth = {
  authExpiresAt: "2026-09-01T22:00:00.000Z",
  authSessionId: "a1000000-0000-4000-8000-000000000010",
  email: "reviewer@example.com",
  userId: "a1000000-0000-4000-8000-000000000011",
} satisfies BackofficeAuthContext;

function fixtureUuid(prefix: "1" | "2", value: number) {
  return `${prefix}0000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
}

function queueRow(value: number, sequence: number) {
  return {
    disabled_from_status: null,
    has_published: false,
    name: `Estúdio ${value}`,
    publication_version: "1",
    review_state: "reviewPending",
    revision_id: fixtureUuid("2", value),
    sort_sequence: sequence.toString(),
    studio_id: fixtureUuid("1", value),
    studio_status: "pending_review",
    submitted_at: "2026-09-01T18:00:00.000Z",
  };
}

describe("backoffice studio review DAL", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("BACKOFFICE_RUNTIME_UNLOCK_KEY", "A".repeat(43));
    vi.stubEnv("DATABASE_URL_APP_DAL", "postgresql://dal:secret@127.0.0.1:54322/postgres");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("round-trips the opaque keyset cursor through the controlled pool query", async () => {
    const firstRows = Array.from({ length: 51 }, (_, index) => queueRow(index + 1, 101 - index));
    const secondRows = [queueRow(51, 51), queueRow(52, 50)];
    mocks.query
      .mockResolvedValueOnce({ rows: firstRows })
      .mockResolvedValueOnce({ rows: secondRows });

    const firstPage = await listBackofficeStudioReviews({ auth, query: {} });

    expect(firstPage.items).toHaveLength(50);
    expect(firstPage.nextCursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u);
    expect(firstPage.nextCursor).not.toContain(fixtureUuid("1", 50));
    expect(mocks.query).toHaveBeenNthCalledWith(1, expect.stringContaining("$4::bigint"), [
      auth.userId,
      auth.authSessionId,
      auth.authExpiresAt,
      null,
      null,
      51,
    ]);

    const secondPage = await listBackofficeStudioReviews({
      auth,
      query: { cursor: firstPage.nextCursor },
    });

    expect(mocks.query).toHaveBeenNthCalledWith(2, expect.stringContaining("$5::uuid"), [
      auth.userId,
      auth.authSessionId,
      auth.authExpiresAt,
      52,
      fixtureUuid("1", 50),
      51,
    ]);
    expect(secondPage).toMatchObject({
      items: [{ studioId: fixtureUuid("1", 51) }, { studioId: fixtureUuid("1", 52) }],
      nextCursor: null,
      scope: auth.userId,
    });
    expect(
      firstPage.items.some((item) =>
        secondPage.items.some((next) => next.studioId === item.studioId),
      ),
    ).toBe(false);
  });

  it("rejects malformed cursors before querying without exposing a list discriminator", async () => {
    const operation = listBackofficeStudioReviews({ auth, query: { cursor: "%" } });

    await expect(operation).rejects.toMatchObject({
      message: "O cursor informado não foi emitido por esta listagem.",
      name: "BackofficeCursorError",
    });
    await expect(operation).rejects.not.toHaveProperty("boundary");
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("rejects a valid cursor when it is replayed by another backoffice session", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: Array.from({ length: 51 }, (_, index) => queueRow(index + 1, 101 - index)),
    });
    const firstPage = await listBackofficeStudioReviews({ auth, query: {} });
    mocks.query.mockClear();

    const operation = listBackofficeStudioReviews({
      auth: { ...auth, authSessionId: "a1000000-0000-4000-8000-000000000099" },
      query: { cursor: firstPage.nextCursor },
    });

    await expect(operation).rejects.toBeInstanceOf(Error);
    await expect(operation).rejects.toMatchObject({ name: "BackofficeCursorError" });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("rejects a canonical-looking cursor whose payload was not issued by the list", async () => {
    const forgedPayload = Buffer.from(
      JSON.stringify({
        kind: "studio-reviews",
        sequence: 42,
        studioId: fixtureUuid("1", 42),
        version: 1,
      }),
      "utf8",
    ).toString("base64url");

    const operation = listBackofficeStudioReviews({
      auth,
      query: { cursor: `${forgedPayload}.${"A".repeat(43)}` },
    });

    await expect(operation).rejects.toMatchObject({ name: "BackofficeCursorError" });
    expect(mocks.query).not.toHaveBeenCalled();
  });
});

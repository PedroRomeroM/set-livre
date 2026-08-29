import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({ enforceIdentityRateLimit: vi.fn() }));
vi.mock("@/lib/server/rate-limit", () => ({
  enforceIdentityRateLimit: mocks.enforceIdentityRateLimit,
}));

import { createStudioService } from "../../src/domains/studios/server/studio-service";
import { studioCoreFixture, studioEditorFixture, studioTestIds } from "./studio-test-fixture";

const dependencies = {
  createStudioDraft: vi.fn(),
  discardStudioDraft: vi.fn(),
  updateStudioRevisionCore: vi.fn(),
};
const context = {
  requestId: studioTestIds.requestId,
  session: {
    authenticated: true as const,
    email: "owner@example.test",
    personType: "individual" as const,
    profileCompleted: true,
    status: "active" as const,
    userId: studioTestIds.userId,
  },
  userAgent: "private-agent",
};
const createCommand = {
  action: "studio.create",
  expectedScope: studioTestIds.userId,
  idempotencyKey: studioTestIds.idempotencyKey,
  payload: studioCoreFixture,
} as const;

describe("studio service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dependencies.createStudioDraft.mockResolvedValue(studioEditorFixture);
    dependencies.updateStudioRevisionCore.mockResolvedValue(studioEditorFixture);
    dependencies.discardStudioDraft.mockResolvedValue({
      scope: studioTestIds.userId,
      studioDeleted: true,
      studioId: studioTestIds.studioId,
    });
  });

  it("derives user and request identities only from the authenticated context", async () => {
    await expect(createStudioService(dependencies).create(createCommand, context)).resolves.toEqual(
      studioEditorFixture,
    );
    expect(dependencies.createStudioDraft).toHaveBeenCalledWith({
      core: studioCoreFixture,
      idempotencyKey: studioTestIds.idempotencyKey,
      requestId: studioTestIds.requestId,
      userId: studioTestIds.userId,
    });
    expect(mocks.enforceIdentityRateLimit).toHaveBeenCalledOnce();
  });

  it.each([
    ["suspended", true, "ACCOUNT_SUSPENDED", 403],
    ["active", false, "CONFLICT", 409],
  ] as const)(
    "blocks status=%s profileCompleted=%s before touching the DAL",
    async (status, profileCompleted, code, httpStatus) => {
      await expect(
        createStudioService(dependencies).create(createCommand, {
          ...context,
          session: { ...context.session, profileCompleted, status },
        }),
      ).rejects.toMatchObject({ code, status: httpStatus });
      expect(dependencies.createStudioDraft).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["P0002", "NOT_FOUND", 404],
    ["42501", "FORBIDDEN", 403],
    ["22023", "VALIDATION_FAILED", 422],
    ["23505", "CONFLICT", 409],
    ["23514", "CONFLICT", 409],
    ["40001", "CONFLICT", 409],
  ] as const)("maps SQLSTATE %s to the safe API contract", async (sqlstate, code, status) => {
    dependencies.createStudioDraft.mockRejectedValueOnce({
      code: sqlstate,
      message: "private database detail",
    });
    await expect(
      createStudioService(dependencies).create(createCommand, context),
    ).rejects.toMatchObject({
      code,
      status,
    });
  });

  it("turns a stale owner contract into an explicit reload fence", async () => {
    dependencies.createStudioDraft.mockRejectedValueOnce({
      code: "42501",
      message: "owner_contract_not_current",
    });
    await expect(
      createStudioService(dependencies).create(createCommand, context),
    ).rejects.toMatchObject({ code: "OWNER_CONTRACT_CHANGED", status: 409 });
  });

  it("maps an archived studio type to the recoverable taxonomy contract", async () => {
    dependencies.createStudioDraft.mockRejectedValueOnce({
      code: "23514",
      message: "studio_type_inactive",
    });
    await expect(
      createStudioService(dependencies).create(createCommand, context),
    ).rejects.toMatchObject({
      code: "STUDIO_TYPE_UNAVAILABLE",
      message: "O tipo de estúdio foi arquivado. Atualize as opções e escolha um tipo ativo.",
      status: 409,
    });
  });

  it("does not mask an unknown infrastructure failure", async () => {
    const failure = new Error("pool unavailable");
    dependencies.createStudioDraft.mockRejectedValueOnce(failure);
    await expect(createStudioService(dependencies).create(createCommand, context)).rejects.toBe(
      failure,
    );
  });
});

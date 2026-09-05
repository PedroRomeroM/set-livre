import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BackofficeUserRevealPiiCommand } from "@set-livre/contracts";
import type { BackofficeAuthContext } from "../../apps/backoffice/src/domains/backoffice/server/auth-context";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../apps/backoffice/src/lib/server/dal-pool", () => ({
  backofficeDalPool: () => ({ query: mocks.query }),
}));

import { revealBackofficeUserPii } from "../../apps/backoffice/src/domains/backoffice/server/backoffice-dal";

const auth = {
  authExpiresAt: "2026-09-05T15:00:00.000Z",
  authSessionId: "a1000000-0000-4000-8000-000000000010",
  email: "qa-support@example.test",
  userId: "a1000000-0000-4000-8000-000000000011",
} satisfies BackofficeAuthContext;
const command = {
  action: "backoffice.user.revealPii",
  expectedScope: auth.userId,
  idempotencyKey: "a1000000-0000-4000-8000-000000000012",
  payload: { reason: "support_case", userId: "a1000000-0000-4000-8000-000000000013" },
} satisfies BackofficeUserRevealPiiCommand;
const requestId = "a1000000-0000-4000-8000-000000000014";
const pii = {
  action: command.action,
  additionalDocument: null,
  email: "qa-target@example.test",
  idempotencyKey: command.idempotencyKey,
  name: "QA PII",
  phoneE164: null,
  reason: command.payload.reason,
  scope: auth.userId,
  taxId: null,
  userId: command.payload.userId,
};

describe("backoffice PII audited-attempt DAL", () => {
  beforeEach(() => vi.clearAllMocks());

  it("preserves the SQL attempt identity independently of HTTP correlation", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ result: pii }] });
    const result = await revealBackofficeUserPii({ auth, command, requestId });
    expect(result.action).toBe(command.action);
    expect(result.idempotencyKey).toBe(command.idempotencyKey);
    expect(result.reason).toBe(command.payload.reason);
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("private.reveal_backoffice_user_pii("),
      [
        auth.userId,
        auth.authSessionId,
        auth.authExpiresAt,
        command.payload.userId,
        command.payload.reason,
        command.idempotencyKey,
        requestId,
      ],
    );
  });

  it.each([
    { action: undefined },
    { idempotencyKey: undefined },
    { reason: undefined },
    { action: "backoffice.user.restore" },
    { idempotencyKey: requestId },
    { reason: "legal_request" },
    { scope: requestId },
    { userId: requestId },
  ])("rejects missing or mismatched identity without manufacturing an echo (%#)", async (patch) => {
    mocks.query.mockResolvedValueOnce({ rows: [{ result: { ...pii, ...patch } }] });
    const error: unknown = await revealBackofficeUserPii({ auth, command, requestId }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    expect(JSON.stringify(error)).not.toContain(pii.email);
  });
});

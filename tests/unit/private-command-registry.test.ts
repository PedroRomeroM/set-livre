import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  completeProfile: vi.fn(),
  executeOwnerCommand: vi.fn(),
  updateProfile: vi.fn(),
}));

vi.mock("../../src/domains/identity/server/profile-service", () => ({
  completeProfile: mocks.completeProfile,
  updateProfile: mocks.updateProfile,
}));

import {
  createPrivateCommandRegistry,
  privateCommandSchema,
} from "../../src/domains/commands/server/private-command-registry";

const userId = "11111111-1111-4111-8111-111111111111";
const idempotencyKey = "22222222-2222-4222-8222-222222222222";
const context = {
  requestId: "33333333-3333-4333-8333-333333333333",
  session: {
    authenticated: true,
    email: "owner@example.test",
    personType: "individual",
    profileCompleted: true,
    status: "active",
    userId,
  },
  userAgent: null,
} as const;

describe("modular private command registry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.executeOwnerCommand.mockResolvedValue({ scope: userId });
  });

  it("parses and delegates every owner command to the owner domain handler", async () => {
    const execute = createPrivateCommandRegistry({
      executeOwnerCommand: mocks.executeOwnerCommand,
    });
    const commands = [
      {
        action: "owner.activate",
        expectedScope: userId,
        idempotencyKey,
        payload: {
          acceptOwnerContract: true,
          ownerContractVersionId: "44444444-4444-4444-8444-444444444444",
        },
      },
      {
        action: "recipient.onboarding.start",
        expectedScope: userId,
        idempotencyKey,
        payload: {},
      },
      {
        action: "recipient.onboarding.refresh",
        expectedScope: userId,
        idempotencyKey,
        payload: {},
      },
    ] as const;

    for (const raw of commands) {
      const command = privateCommandSchema.parse(raw);
      await expect(execute(command, context)).resolves.toEqual({ scope: userId });
      expect(mocks.executeOwnerCommand).toHaveBeenLastCalledWith(command, context);
    }
    expect(mocks.executeOwnerCommand).toHaveBeenCalledTimes(3);
  });

  it("does not turn the registry into browser-controlled generic dispatch", () => {
    for (const command of [
      { action: "admin.user.suspend", expectedScope: userId, idempotencyKey, payload: {} },
      {
        action: "recipient.onboarding.start",
        expectedScope: userId,
        handler: "arbitrary-module",
        idempotencyKey,
        payload: {},
      },
    ]) {
      expect(privateCommandSchema.safeParse(command).success).toBe(false);
    }
  });
});

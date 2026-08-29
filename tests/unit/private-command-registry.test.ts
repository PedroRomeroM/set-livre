import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  completeProfile: vi.fn(),
  executeOwnerCommand: vi.fn(),
  executeStudioCommand: vi.fn(),
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
    mocks.executeStudioCommand.mockResolvedValue({ scope: userId });
  });

  it("parses and delegates every owner command to the owner domain handler", async () => {
    const execute = createPrivateCommandRegistry({
      executeOwnerCommand: mocks.executeOwnerCommand,
      executeStudioCommand: mocks.executeStudioCommand,
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

  it("parses and delegates the studio core commands without generic browser dispatch", async () => {
    const execute = createPrivateCommandRegistry({
      executeOwnerCommand: mocks.executeOwnerCommand,
      executeStudioCommand: mocks.executeStudioCommand,
    });
    const core = {
      addressComplement: null,
      capacity: 8,
      city: "Curitiba",
      description: "Estúdio preparado para ensaios e gravações.",
      name: "Estúdio Aurora",
      neighborhood: "Centro",
      postalCode: "80010000",
      state: "PR",
      street: "Rua das Flores",
      streetNumber: "100",
      studioTypeId: "60000000-0000-4000-8000-000000000001",
    } as const;
    const commands = [
      {
        action: "studio.create",
        expectedScope: userId,
        idempotencyKey,
        payload: core,
      },
      {
        action: "studio.revision.updateCore",
        expectedScope: userId,
        idempotencyKey,
        payload: {
          ...core,
          expectedRevisionId: "55555555-5555-4555-8555-555555555555",
          expectedRevisionVersion: 1,
          studioId: "44444444-4444-4444-8444-444444444444",
        },
      },
      {
        action: "studio.draft.discard",
        expectedScope: userId,
        idempotencyKey,
        payload: {
          expectedRevisionId: "55555555-5555-4555-8555-555555555555",
          expectedRevisionVersion: 1,
          studioId: "44444444-4444-4444-8444-444444444444",
        },
      },
      {
        action: "studio.revision.updateTaxonomy",
        expectedScope: userId,
        idempotencyKey,
        payload: {
          amenityIds: ["63000000-0000-4000-8000-000000000001"],
          expectedRevisionId: "55555555-5555-4555-8555-555555555555",
          expectedRevisionVersion: 1,
          studioId: "44444444-4444-4444-8444-444444444444",
          tagIds: ["62000000-0000-4000-8000-000000000001"],
        },
      },
      {
        action: "studio.revision.updateContent",
        expectedScope: userId,
        idempotencyKey,
        payload: {
          expectedRevisionId: "55555555-5555-4555-8555-555555555555",
          expectedRevisionVersion: 1,
          faqs: [],
          studioId: "44444444-4444-4444-8444-444444444444",
          usageRules: "",
          youtubeVideoId: null,
        },
      },
    ] as const;

    for (const raw of commands) {
      const command = privateCommandSchema.parse(raw);
      await expect(execute(command, context)).resolves.toEqual({ scope: userId });
      expect(mocks.executeStudioCommand).toHaveBeenLastCalledWith(command, context);
    }
    expect(mocks.executeStudioCommand).toHaveBeenCalledTimes(5);
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

import { describe, expect, it } from "vitest";

import {
  formatStudioPostalCode,
  studioCommandSchema,
  studioCorePayloadSchema,
  studioEditorSchema,
} from "../../packages/contracts/src";
import { studioCoreFixture, studioEditorFixture, studioTestIds } from "./studio-test-fixture";

describe("studio contracts", () => {
  it("normalizes bounded core content without accepting client authority", () => {
    expect(
      studioCorePayloadSchema.parse({
        ...studioCoreFixture,
        addressComplement: "   ",
        description: `  ${studioCoreFixture.description}  `,
        name: "  Estúdio Aurora  ",
        postalCode: "80010-000",
      }),
    ).toEqual({
      ...studioCoreFixture,
      addressComplement: null,
    });

    for (const invalid of [
      { ...studioCoreFixture, city: "São Paulo" },
      { ...studioCoreFixture, state: "SC" },
      { ...studioCoreFixture, capacity: 0 },
      { ...studioCoreFixture, ownerUserId: studioTestIds.userId },
    ]) {
      expect(studioCorePayloadSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("formats valid CEP input but preserves invalid or excessive input for validation", () => {
    expect(formatStudioPostalCode("80010000")).toBe("80010-000");
    expect(formatStudioPostalCode("80010-000")).toBe("80010-000");
    expect(formatStudioPostalCode("80010A000")).toBe("80010A000");
    expect(formatStudioPostalCode("800100000")).toBe("800100000");
    expect(
      studioCorePayloadSchema.safeParse({ ...studioCoreFixture, postalCode: "80010A000" }).success,
    ).toBe(false);
  });

  it("requires coherent canonical pointers in the private editor DTO", () => {
    expect(studioEditorSchema.parse(studioEditorFixture)).toEqual(studioEditorFixture);
    expect(
      studioEditorSchema.safeParse({ ...studioEditorFixture, draftRevisionId: null }).success,
    ).toBe(false);
    expect(
      studioEditorSchema.safeParse({
        ...studioEditorFixture,
        studioType: { ...studioEditorFixture.studioType, id: studioTestIds.otherStudioId },
      }).success,
    ).toBe(false);
    expect(
      studioEditorSchema.safeParse({ ...studioEditorFixture, privateAddress: "não permitido" })
        .success,
    ).toBe(false);
  });

  it("keeps all three command envelopes strict, scoped and idempotent", () => {
    const createCommand = {
      action: "studio.create",
      expectedScope: studioTestIds.userId,
      idempotencyKey: studioTestIds.idempotencyKey,
      payload: studioCoreFixture,
    } as const;
    expect(studioCommandSchema.parse(createCommand)).toEqual(createCommand);
    expect(
      studioCommandSchema.safeParse({ ...createCommand, idempotencyKey: undefined }).success,
    ).toBe(false);
    expect(studioCommandSchema.safeParse({ ...createCommand, status: "published" }).success).toBe(
      false,
    );

    expect(
      studioCommandSchema.safeParse({
        action: "studio.revision.updateCore",
        expectedScope: studioTestIds.userId,
        idempotencyKey: studioTestIds.idempotencyKey,
        payload: {
          ...studioCoreFixture,
          expectedRevisionId: studioTestIds.revisionId,
          expectedRevisionVersion: 1,
          studioId: studioTestIds.studioId,
        },
      }).success,
    ).toBe(true);
    expect(
      studioCommandSchema.safeParse({
        action: "studio.draft.discard",
        expectedScope: studioTestIds.userId,
        idempotencyKey: studioTestIds.idempotencyKey,
        payload: {
          expectedRevisionId: studioTestIds.revisionId,
          expectedRevisionVersion: 1,
          studioId: studioTestIds.studioId,
        },
      }).success,
    ).toBe(true);
  });
});

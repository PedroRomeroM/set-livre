import {
  ownerStudioEditorExpectedScopeHeader,
  ownerStudioEditorExpectedScopeSchema,
  ownerStudioEditorResultSchema,
  studioCommandSchema,
  studioCoreInputSchema,
  studioCreateCommandSchema,
  studioDraftDiscardCommandSchema,
  studioDraftDiscardResultSchema,
  studioRevisionUpdateCoreCommandSchema,
  studioTypeOptionSchema,
} from "@set-livre/contracts";
import { describe, expect, it } from "vitest";

const scope = "11111111-1111-4111-8111-111111111111";
const idempotencyKey = "22222222-2222-4222-8222-222222222222";
const studioId = "33333333-3333-4333-8333-333333333333";
const studioTypeId = "44444444-4444-4444-8444-444444444444";

const core = {
  address: {
    complement: null,
    neighborhood: "Centro",
    postalCode: "80010000",
    street: "Rua das Câmeras",
    streetNumber: "120",
  },
  capacity: 12,
  description: "Estúdio preparado para produções audiovisuais profissionais.",
  name: "Estúdio QA F006",
  studioTypeId,
} as const;

const editor = {
  mode: "edit",
  projection: "studio_editor",
  scope,
  studio: {
    draft: {
      core: {
        ...core,
        city: "Curitiba",
        state: "PR",
        studioTypeName: "Fotografia",
      },
      revisionNumber: 1,
    },
    editVersion: 1,
    id: studioId,
    published: null,
    status: "draft",
  },
  studioTypes: [{ id: studioTypeId, name: "Fotografia" }],
} as const;

describe("studio core contracts", () => {
  it("defines one required UUID scope header for private editor reads", () => {
    expect(ownerStudioEditorExpectedScopeHeader).toBe("x-set-livre-expected-scope");
    expect(ownerStudioEditorExpectedScopeSchema.parse(scope)).toBe(scope);
    for (const invalid of [undefined, null, "", "not-a-uuid"]) {
      expect(ownerStudioEditorExpectedScopeSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("normalizes safe text and keeps Curitiba/PR outside browser input", () => {
    expect(
      studioCoreInputSchema.parse({
        ...core,
        address: { ...core.address, street: "  Rua   das Câmeras  " },
        name: "  Estúdio   QA F006  ",
      }),
    ).toEqual({
      ...core,
      address: { ...core.address, street: "Rua das Câmeras" },
      name: "Estúdio QA F006",
    });

    for (const invalid of [
      { ...core, city: "Curitiba" },
      { ...core, state: "PR" },
      { ...core, timezone: "America/Sao_Paulo" },
      { ...core, capacity: 0 },
      { ...core, capacity: 1.5 },
      { ...core, address: { ...core.address, postalCode: "80010-000" } },
      { ...core, address: { ...core.address, complement: "" } },
      { ...core, description: "curta" },
      { ...core, name: "Studio\u0000" },
    ]) {
      expect(studioCoreInputSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("keeps taxonomy names aligned with the database 2..80 character invariant", () => {
    expect(studioTypeOptionSchema.parse({ id: studioTypeId, name: "  Foto  e vídeo  " })).toEqual({
      id: studioTypeId,
      name: "Foto e vídeo",
    });
    expect(studioTypeOptionSchema.safeParse({ id: studioTypeId, name: "A" }).success).toBe(false);
    expect(
      studioTypeOptionSchema.safeParse({ id: studioTypeId, name: "A".repeat(81) }).success,
    ).toBe(false);
    expect(
      ownerStudioEditorResultSchema.safeParse({
        ...editor,
        studio: {
          ...editor.studio,
          draft: {
            ...editor.studio.draft,
            core: { ...editor.studio.draft.core, studioTypeName: "A" },
          },
        },
      }).success,
    ).toBe(false);
  });

  it("accepts only the three strict intents without browser-owned authority fields", () => {
    const commands = [
      {
        action: "studio.create",
        expectedScope: scope,
        idempotencyKey,
        payload: { core, studioId },
      },
      {
        action: "studio.revision.updateCore",
        expectedScope: scope,
        idempotencyKey,
        payload: { core, expectedEditVersion: 1, studioId },
      },
      {
        action: "studio.draft.discard",
        expectedScope: scope,
        idempotencyKey,
        payload: { expectedEditVersion: 1, studioId },
      },
    ] as const;

    expect(studioCreateCommandSchema.parse(commands[0])).toEqual(commands[0]);
    expect(studioRevisionUpdateCoreCommandSchema.parse(commands[1])).toEqual(commands[1]);
    expect(studioDraftDiscardCommandSchema.parse(commands[2])).toEqual(commands[2]);
    for (const command of commands) {
      expect(studioCommandSchema.parse(command)).toEqual(command);
    }

    for (const invalid of [
      { ...commands[0], payload: { ...commands[0].payload, ownerUserId: scope } },
      { ...commands[0], payload: { ...commands[0].payload, revisionNumber: 1 } },
      { ...commands[0], payload: { ...commands[0].payload, status: "published" } },
      { ...commands[1], payload: { ...commands[1].payload, editVersion: 2 } },
      { ...commands[1], payload: { ...commands[1].payload, expectedEditVersion: 0 } },
      { ...commands[1], payload: { ...commands[1].payload, revisionId: studioId } },
      { ...commands[2], payload: { ...commands[2].payload, outcome: "studio_removed" } },
    ]) {
      expect(studioCommandSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("accepts only JavaScript-safe edit and revision counters", () => {
    const maximumSafeInteger = Number.MAX_SAFE_INTEGER;
    const updateAtTheLimit = {
      action: "studio.revision.updateCore",
      expectedScope: scope,
      idempotencyKey,
      payload: { core, expectedEditVersion: maximumSafeInteger, studioId },
    } as const;

    expect(studioRevisionUpdateCoreCommandSchema.parse(updateAtTheLimit)).toEqual(updateAtTheLimit);
    expect(
      studioDraftDiscardCommandSchema.safeParse({
        action: "studio.draft.discard",
        expectedScope: scope,
        idempotencyKey,
        payload: { expectedEditVersion: maximumSafeInteger + 1, studioId },
      }).success,
    ).toBe(false);

    expect(
      ownerStudioEditorResultSchema.parse({
        ...editor,
        studio: {
          ...editor.studio,
          draft: { ...editor.studio.draft, revisionNumber: maximumSafeInteger },
          editVersion: maximumSafeInteger,
        },
      }),
    ).toMatchObject({
      studio: {
        draft: { revisionNumber: maximumSafeInteger },
        editVersion: maximumSafeInteger,
      },
    });
    for (const invalid of [
      {
        ...editor,
        studio: { ...editor.studio, editVersion: maximumSafeInteger + 1 },
      },
      {
        ...editor,
        studio: {
          ...editor.studio,
          draft: { ...editor.studio.draft, revisionNumber: maximumSafeInteger + 1 },
        },
      },
    ]) {
      expect(ownerStudioEditorResultSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("validates strict create/edit projections and discard outcomes", () => {
    expect(ownerStudioEditorResultSchema.parse(editor)).toEqual(editor);
    expect(
      ownerStudioEditorResultSchema.parse({
        mode: "create",
        projection: "studio_editor",
        scope,
        studio: null,
        studioTypes: editor.studioTypes,
      }),
    ).toMatchObject({ mode: "create", studio: null });

    expect(
      studioDraftDiscardResultSchema.parse({
        editor: { ...editor, studio: { ...editor.studio, draft: null } },
        outcome: "draft_removed",
        projection: "studio_draft_discard",
        scope,
        studioId,
      }),
    ).toMatchObject({ outcome: "draft_removed", studioId });
    expect(
      studioDraftDiscardResultSchema.parse({
        outcome: "studio_removed",
        projection: "studio_draft_discard",
        scope,
        studioId,
      }),
    ).toMatchObject({ outcome: "studio_removed", studioId });

    for (const invalid of [
      { ...editor, ownerUserId: scope },
      { ...editor, studio: { ...editor.studio, ownerUserId: scope } },
      { ...editor, studio: { ...editor.studio, editVersion: "1" } },
      { ...editor, studio: { ...editor.studio, status: "paused" } },
      {
        ...editor,
        studio: {
          ...editor.studio,
          draft: { ...editor.studio.draft, revisionNumber: 0 },
        },
      },
      { ...editor, studioTypes: [...editor.studioTypes, editor.studioTypes[0]] },
    ]) {
      expect(ownerStudioEditorResultSchema.safeParse(invalid).success).toBe(false);
    }
  });
});

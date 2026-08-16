import { beforeEach, describe, expect, it, vi } from "vitest";

import { ownerStudioEditorEditResultSchema } from "@set-livre/contracts";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  createStudioDraft: vi.fn(),
  discardStudioDraftInDatabase: vi.fn(),
  readActiveStudioTypes: vi.fn(),
  readOwnerStudioEditor: vi.fn(),
  updateStudioDraftCore: vi.fn(),
}));

import {
  mapOwnerStudioEditorDalRow,
  parseOwnerStudioEditorDalRow,
} from "../../src/domains/studios/server/studio-dal";
import { createStudioService } from "../../src/domains/studios/server/studio-service";
import { ApiRouteError } from "../../src/lib/server/api-route";

const userId = "11111111-1111-4111-8111-111111111111";
const otherUserId = "77777777-7777-4777-8777-777777777777";
const studioId = "22222222-2222-4222-8222-222222222222";
const otherStudioId = "88888888-8888-4888-8888-888888888888";
const revisionId = "33333333-3333-4333-8333-333333333333";
const studioTypeId = "44444444-4444-4444-8444-444444444444";
const idempotencyKey = "55555555-5555-4555-8555-555555555555";
const studioTypes = [{ id: studioTypeId, name: "Fotografia" }] as const;
const core = {
  address: {
    complement: null,
    neighborhood: "Batel",
    postalCode: "80420090",
    street: "Rua Exemplo",
    streetNumber: "120 A",
  },
  capacity: 12,
  description: "Um estúdio completo para ensaios profissionais.",
  name: "Estúdio Luz",
  studioTypeId,
} as const;
const parsedRow = parseOwnerStudioEditorDalRow({
  draft_address_complement: null,
  draft_capacity: 12,
  draft_city: "Curitiba",
  draft_description: core.description,
  draft_name: core.name,
  draft_neighborhood: core.address.neighborhood,
  draft_postal_code: core.address.postalCode,
  draft_revision_id: revisionId,
  draft_revision_number: "1",
  draft_state: "PR",
  draft_street: core.address.street,
  draft_street_number: core.address.streetNumber,
  draft_studio_type_id: studioTypeId,
  draft_studio_type_name: "Fotografia",
  edit_version: "1",
  published_address_complement: null,
  published_capacity: null,
  published_city: null,
  published_description: null,
  published_name: null,
  published_neighborhood: null,
  published_postal_code: null,
  published_revision_id: null,
  published_revision_number: null,
  published_state: null,
  published_street: null,
  published_street_number: null,
  published_studio_type_id: null,
  published_studio_type_name: null,
  scope: userId,
  studio_id: studioId,
  studio_status: "draft",
});
const editor = mapOwnerStudioEditorDalRow(parsedRow, userId, studioTypes);
const publishedEditor = ownerStudioEditorEditResultSchema.parse({
  mode: "edit",
  projection: "studio_editor",
  scope: userId,
  studio: {
    draft: {
      core: {
        ...core,
        city: "Curitiba",
        state: "PR",
        studioTypeName: "Fotografia",
      },
      revisionNumber: 2,
    },
    editVersion: 1,
    id: studioId,
    published: {
      core: {
        ...core,
        city: "Curitiba",
        name: "Estúdio Luz publicado",
        state: "PR",
        studioTypeName: "Fotografia",
      },
      revisionNumber: 1,
    },
    status: "published",
  },
  studioTypes,
});
const context = {
  requestId: "66666666-6666-4666-8666-666666666666",
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
const createCommand = {
  action: "studio.create",
  expectedScope: userId,
  idempotencyKey,
  payload: { core, studioId },
} as const;
const updateCommand = {
  action: "studio.revision.updateCore",
  expectedScope: userId,
  idempotencyKey,
  payload: { core, expectedEditVersion: 1, studioId },
} as const;
const discardCommand = {
  action: "studio.draft.discard",
  expectedScope: userId,
  idempotencyKey,
  payload: { expectedEditVersion: 1, studioId },
} as const;

function service() {
  return createStudioService({
    createStudioDraft: mocks.createStudioDraft,
    discardStudioDraftInDatabase: mocks.discardStudioDraftInDatabase,
    readActiveStudioTypes: mocks.readActiveStudioTypes,
    readOwnerStudioEditor: mocks.readOwnerStudioEditor,
    updateStudioDraftCore: mocks.updateStudioDraftCore,
  });
}

describe("studio service", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.createStudioDraft.mockResolvedValue(parsedRow);
    mocks.updateStudioDraftCore.mockResolvedValue(parsedRow);
    mocks.readActiveStudioTypes.mockResolvedValue(studioTypes);
    mocks.readOwnerStudioEditor.mockResolvedValue(publishedEditor);
    mocks.discardStudioDraftInDatabase.mockResolvedValue({
      draft_discarded: true,
      edit_version: 2,
      scope: userId,
      studio_deleted: false,
      studio_id: studioId,
    });
    const { resetIdentityRateLimitForTests } = await import("../../src/lib/server/rate-limit");
    resetIdentityRateLimitForTests();
  });

  it("creates from the authenticated owner and composes the authoritative type read model", async () => {
    await expect(service().createStudio(createCommand, context)).resolves.toEqual(editor);
    expect(mocks.createStudioDraft).toHaveBeenCalledWith({
      core,
      idempotencyKey,
      requestId: context.requestId,
      studioId,
      userId,
    });
    expect(mocks.readActiveStudioTypes).toHaveBeenCalledOnce();
  });

  it("shares the studio edits quota across actions while isolating each owner", async () => {
    const studioService = service();
    const acceptedMutations = Array.from({ length: 20 }, () => [
      studioService.createStudio(createCommand, context),
      studioService.updateStudioCore(updateCommand, context),
      studioService.discardStudioDraft(discardCommand, context),
    ]).flat();

    await expect(Promise.all(acceptedMutations)).resolves.toHaveLength(60);
    expect(mocks.createStudioDraft).toHaveBeenCalledTimes(20);
    expect(mocks.updateStudioDraftCore).toHaveBeenCalledTimes(20);
    expect(mocks.discardStudioDraftInDatabase).toHaveBeenCalledTimes(20);
    expect(mocks.readActiveStudioTypes).toHaveBeenCalledTimes(40);
    expect(mocks.readOwnerStudioEditor).toHaveBeenCalledTimes(20);

    vi.clearAllMocks();
    await expect(studioService.updateStudioCore(updateCommand, context)).rejects.toMatchObject({
      code: "RATE_LIMITED",
      message: "Muitas tentativas. Aguarde alguns minutos e tente novamente.",
      status: 429,
    });
    expect(mocks.createStudioDraft).not.toHaveBeenCalled();
    expect(mocks.updateStudioDraftCore).not.toHaveBeenCalled();
    expect(mocks.discardStudioDraftInDatabase).not.toHaveBeenCalled();
    expect(mocks.readActiveStudioTypes).not.toHaveBeenCalled();
    expect(mocks.readOwnerStudioEditor).not.toHaveBeenCalled();

    const otherUserCommand = {
      ...createCommand,
      expectedScope: otherUserId,
      payload: { ...createCommand.payload, studioId: otherStudioId },
    };
    const otherUserContext = {
      ...context,
      session: {
        ...context.session,
        email: "other-owner@example.test",
        userId: otherUserId,
      },
    };
    mocks.createStudioDraft.mockResolvedValueOnce({
      ...parsedRow,
      scope: otherUserId,
      studio_id: otherStudioId,
    });

    await expect(
      studioService.createStudio(otherUserCommand, otherUserContext),
    ).resolves.toMatchObject({
      scope: otherUserId,
      studio: { id: otherStudioId },
    });
    expect(mocks.readActiveStudioTypes).toHaveBeenCalledOnce();
    expect(mocks.createStudioDraft).toHaveBeenCalledWith({
      core,
      idempotencyKey,
      requestId: context.requestId,
      studioId: otherStudioId,
      userId: otherUserId,
    });
  });

  it.each([
    ["create", () => service().createStudio(createCommand, context), mocks.createStudioDraft],
    [
      "update",
      () => service().updateStudioCore(updateCommand, context),
      mocks.updateStudioDraftCore,
    ],
  ])("finishes the active type read before the %s DAL write", async (_label, run, dalWrite) => {
    let resolveTypes: ((value: typeof studioTypes) => void) | undefined;
    mocks.readActiveStudioTypes.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveTypes = resolve;
      }),
    );
    mocks.readActiveStudioTypes.mockRejectedValue(
      new Error("a post-write type read must not happen"),
    );

    const outcome = run();
    await vi.waitFor(() => expect(mocks.readActiveStudioTypes).toHaveBeenCalledOnce());
    expect(dalWrite).not.toHaveBeenCalled();

    resolveTypes?.(studioTypes);
    await expect(outcome).resolves.toEqual(editor);
    expect(mocks.readActiveStudioTypes.mock.invocationCallOrder[0]).toBeLessThan(
      dalWrite.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(mocks.readActiveStudioTypes).toHaveBeenCalledOnce();
  });

  it.each([
    ["create", () => service().createStudio(createCommand, context), mocks.createStudioDraft],
    [
      "update",
      () => service().updateStudioCore(updateCommand, context),
      mocks.updateStudioDraftCore,
    ],
  ])(
    "does not call the %s DAL when the prerequisite type read fails",
    async (_label, run, dalWrite) => {
      const readFailure = new Error("type read unavailable");
      mocks.readActiveStudioTypes.mockRejectedValueOnce(readFailure);

      await expect(run()).rejects.toBe(readFailure);
      expect(dalWrite).not.toHaveBeenCalled();
    },
  );

  it("updates only with expectedEditVersion and never accepts a revision identifier", async () => {
    await expect(service().updateStudioCore(updateCommand, context)).resolves.toEqual(editor);
    expect(mocks.updateStudioDraftCore).toHaveBeenCalledWith({
      core,
      expectedEditVersion: 1,
      idempotencyKey,
      requestId: context.requestId,
      studioId,
      userId,
    });
    expect(JSON.stringify(mocks.updateStudioDraftCore.mock.calls)).not.toContain(revisionId);
  });

  it("returns each authoritative discard outcome", async () => {
    await expect(service().discardStudioDraft(discardCommand, context)).resolves.toEqual({
      editor: {
        ...publishedEditor,
        studio: {
          ...publishedEditor.studio,
          draft: null,
          editVersion: 2,
        },
      },
      outcome: "draft_removed",
      projection: "studio_draft_discard",
      scope: userId,
      studioId,
    });
    expect(mocks.readOwnerStudioEditor).toHaveBeenCalledWith(userId, studioId);
    expect(mocks.discardStudioDraftInDatabase).toHaveBeenCalledWith({
      expectedEditVersion: 1,
      idempotencyKey,
      requestId: context.requestId,
      studioId,
      userId,
    });

    mocks.discardStudioDraftInDatabase.mockResolvedValueOnce({
      draft_discarded: false,
      edit_version: null,
      scope: userId,
      studio_deleted: true,
      studio_id: studioId,
    });
    await expect(service().discardStudioDraft(discardCommand, context)).resolves.toEqual({
      outcome: "studio_removed",
      projection: "studio_draft_discard",
      scope: userId,
      studioId,
    });
  });

  it("finishes the editor pre-read before discard and performs no remote read after the write", async () => {
    let resolveEditor: ((value: typeof publishedEditor) => void) | undefined;
    let resolveDiscard:
      | ((value: {
          draft_discarded: boolean;
          edit_version: number;
          scope: string;
          studio_deleted: boolean;
          studio_id: string;
        }) => void)
      | undefined;
    mocks.readOwnerStudioEditor.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveEditor = resolve;
      }),
    );
    mocks.readOwnerStudioEditor.mockRejectedValue(
      new Error("a post-write editor read must not happen"),
    );
    mocks.discardStudioDraftInDatabase.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveDiscard = resolve;
      }),
    );

    const outcome = service().discardStudioDraft(discardCommand, context);
    await vi.waitFor(() => expect(mocks.readOwnerStudioEditor).toHaveBeenCalledOnce());
    expect(mocks.discardStudioDraftInDatabase).not.toHaveBeenCalled();

    resolveEditor?.(publishedEditor);
    await vi.waitFor(() => expect(mocks.discardStudioDraftInDatabase).toHaveBeenCalledOnce());
    expect(mocks.readOwnerStudioEditor).toHaveBeenCalledOnce();
    expect(mocks.readOwnerStudioEditor.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.discardStudioDraftInDatabase.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );

    resolveDiscard?.({
      draft_discarded: true,
      edit_version: 2,
      scope: userId,
      studio_deleted: false,
      studio_id: studioId,
    });
    await expect(outcome).resolves.toMatchObject({ outcome: "draft_removed" });
    expect(mocks.readOwnerStudioEditor).toHaveBeenCalledOnce();
  });

  it.each([
    ["timeout", new DOMException("editor read timed out", "AbortError")],
    ["forbidden", new ApiRouteError(403, "FORBIDDEN", "owner inactive")],
    ["unknown", new Error("editor read unavailable")],
  ])(
    "does not call the discard DAL when its prerequisite read fails with %s",
    async (_label, readFailure) => {
      mocks.readOwnerStudioEditor.mockRejectedValueOnce(readFailure);

      await expect(service().discardStudioDraft(discardCommand, context)).rejects.toBe(readFailure);
      expect(mocks.discardStudioDraftInDatabase).not.toHaveBeenCalled();
    },
  );

  it("replays an already committed shell deletion through the SQL tombstone", async () => {
    mocks.readOwnerStudioEditor.mockRejectedValueOnce(
      new ApiRouteError(404, "NOT_FOUND", "studio missing after the committed response was lost"),
    );
    mocks.discardStudioDraftInDatabase.mockResolvedValueOnce({
      draft_discarded: false,
      edit_version: null,
      scope: userId,
      studio_deleted: true,
      studio_id: studioId,
    });

    await expect(service().discardStudioDraft(discardCommand, context)).resolves.toEqual({
      outcome: "studio_removed",
      projection: "studio_draft_discard",
      scope: userId,
      studioId,
    });
    expect(mocks.discardStudioDraftInDatabase).toHaveBeenCalledOnce();
    expect(mocks.readOwnerStudioEditor).toHaveBeenCalledOnce();
  });

  it("fails closed when a not-found pre-read is followed by a retained studio result", async () => {
    mocks.readOwnerStudioEditor.mockRejectedValueOnce(
      new ApiRouteError(404, "NOT_FOUND", "studio missing before discard"),
    );

    await expect(service().discardStudioDraft(discardCommand, context)).rejects.toThrow(
      "O descarte retido não possui um editor anterior válido.",
    );
    expect(mocks.discardStudioDraftInDatabase).toHaveBeenCalledOnce();
    expect(mocks.readOwnerStudioEditor).toHaveBeenCalledOnce();
  });

  it("keeps a new missing or cross-owner studio uniformly not found after the replay probe", async () => {
    mocks.readOwnerStudioEditor.mockRejectedValueOnce(
      new ApiRouteError(404, "NOT_FOUND", "studio not visible to this owner"),
    );
    mocks.discardStudioDraftInDatabase.mockRejectedValueOnce({
      code: "P0002",
      message: "studio_not_found",
    });

    await expect(service().discardStudioDraft(discardCommand, context)).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
    expect(mocks.discardStudioDraftInDatabase).toHaveBeenCalledOnce();
    expect(mocks.readOwnerStudioEditor).toHaveBeenCalledOnce();
  });

  it("returns the unchanged current editor when replaying a retained discard", async () => {
    const editorAfterDiscard = ownerStudioEditorEditResultSchema.parse({
      ...publishedEditor,
      studio: {
        ...publishedEditor.studio,
        draft: null,
        editVersion: 2,
      },
    });
    mocks.readOwnerStudioEditor.mockResolvedValueOnce(editorAfterDiscard);

    await expect(service().discardStudioDraft(discardCommand, context)).resolves.toMatchObject({
      editor: editorAfterDiscard,
      outcome: "draft_removed",
    });
    expect(mocks.readOwnerStudioEditor).toHaveBeenCalledOnce();
    expect(mocks.discardStudioDraftInDatabase).toHaveBeenCalledOnce();
  });

  it("does not fabricate an editor from a retained discard result older than the pre-read", async () => {
    mocks.readOwnerStudioEditor.mockResolvedValueOnce(
      ownerStudioEditorEditResultSchema.parse({
        ...publishedEditor,
        studio: {
          ...publishedEditor.studio,
          editVersion: 3,
        },
      }),
    );

    await expect(service().discardStudioDraft(discardCommand, context)).rejects.toThrow(
      "O resultado do descarte não corresponde ao editor atual.",
    );
    expect(mocks.readOwnerStudioEditor).toHaveBeenCalledOnce();
    expect(mocks.discardStudioDraftInDatabase).toHaveBeenCalledOnce();
  });

  it("does not perform unsafe arithmetic at the maximum edit version", async () => {
    const commandAtTheLimit = {
      ...discardCommand,
      payload: { ...discardCommand.payload, expectedEditVersion: Number.MAX_SAFE_INTEGER },
    };
    mocks.readOwnerStudioEditor.mockResolvedValueOnce(
      ownerStudioEditorEditResultSchema.parse({
        ...publishedEditor,
        studio: { ...publishedEditor.studio, editVersion: Number.MAX_SAFE_INTEGER },
      }),
    );
    mocks.discardStudioDraftInDatabase.mockResolvedValueOnce({
      draft_discarded: true,
      edit_version: Number.MAX_SAFE_INTEGER,
      scope: userId,
      studio_deleted: false,
      studio_id: studioId,
    });

    await expect(service().discardStudioDraft(commandAtTheLimit, context)).rejects.toThrow(
      "O resultado do descarte não corresponde ao editor atual.",
    );
  });

  it("maps a stale retained discard replay to a recoverable conflict", async () => {
    mocks.discardStudioDraftInDatabase.mockRejectedValueOnce({
      code: "40001",
      message: "studio_result_no_longer_available",
    });

    await expect(service().discardStudioDraft(discardCommand, context)).rejects.toMatchObject({
      code: "CONFLICT",
      status: 409,
    });
    expect(mocks.readOwnerStudioEditor).toHaveBeenCalledOnce();
    expect(mocks.discardStudioDraftInDatabase).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "create mode",
      {
        mode: "create",
        projection: "studio_editor",
        scope: userId,
        studio: null,
        studioTypes,
      },
    ],
    ["another owner scope", { ...publishedEditor, scope: otherUserId }],
    [
      "another studio identifier",
      {
        ...publishedEditor,
        studio: { ...publishedEditor.studio, id: otherStudioId },
      },
    ],
  ])("rejects a %s pre-read before the discard DAL", async (_label, editorBeforeDiscard) => {
    mocks.readOwnerStudioEditor.mockResolvedValueOnce(editorBeforeDiscard);

    await expect(service().discardStudioDraft(discardCommand, context)).rejects.toThrow(
      "O editor anterior ao descarte retornou um escopo inesperado.",
    );
    expect(mocks.discardStudioDraftInDatabase).not.toHaveBeenCalled();
  });

  it.each([
    [
      { code: "P0002", message: "studio_not_found" },
      { code: "NOT_FOUND", status: 404 },
    ],
    [
      { code: "42501", message: "owner_authority_required" },
      { code: "FORBIDDEN", status: 403 },
    ],
    [
      { code: "42501", message: "owner_profile_inactive" },
      { code: "FORBIDDEN", status: 403 },
    ],
    [
      { code: "42501", message: "owner_blocked" },
      { code: "FORBIDDEN", status: 403 },
    ],
    [
      { code: "40001", message: "studio_edit_version_conflict" },
      { code: "CONFLICT", status: 409 },
    ],
    [
      { code: "40001", message: "studio_idempotency_conflict" },
      { code: "CONFLICT", status: 409 },
    ],
    [
      { code: "40001", message: "studio_identifier_unavailable" },
      { code: "CONFLICT", status: 409 },
    ],
    [
      { code: "40001", message: "studio_result_no_longer_available" },
      { code: "CONFLICT", status: 409 },
    ],
    [
      { code: "23514", message: "studio_draft_missing" },
      { code: "CONFLICT", status: 409 },
    ],
    [
      { code: "22003", message: "studio_edit_version_exhausted" },
      {
        code: "CONFLICT",
        message:
          "O estúdio atingiu o limite de versões suportado e não pode receber novas alterações.",
        status: 409,
      },
    ],
    [
      { code: "22003", message: "studio_revision_number_exhausted" },
      {
        code: "CONFLICT",
        message:
          "O estúdio atingiu o limite de versões suportado e não pode receber novas alterações.",
        status: 409,
      },
    ],
    [
      { code: "23514", message: "studio_type_unavailable" },
      { code: "VALIDATION_FAILED", status: 422 },
    ],
    [
      { code: "22023", message: "studio_core_invalid" },
      { code: "VALIDATION_FAILED", status: 422 },
    ],
  ])("maps a database failure to its safe public error", async (databaseError, publicError) => {
    mocks.updateStudioDraftCore.mockRejectedValueOnce(databaseError);
    await expect(service().updateStudioCore(updateCommand, context)).rejects.toMatchObject(
      publicError,
    );
  });

  it.each([
    { code: "42501", message: "permission denied for function update_studio_revision_core" },
    { code: "40001", message: "unexpected_serialization_failure" },
    { code: "P0001", message: "studio_revision_is_immutable" },
    { code: "P0001", message: "studio_revision_pointer_invalid" },
    { code: "23514", message: "studio_revision_number_invalid" },
    { code: "23503", message: "studio_parent_missing" },
    { code: "22023", message: "unexpected_input_failure" },
    { code: "22003", message: "unexpected_numeric_failure" },
  ])("does not mask an internal database failure: $code/$message", async (databaseError) => {
    mocks.updateStudioDraftCore.mockRejectedValueOnce(databaseError);
    const error = await service()
      .updateStudioCore(updateCommand, context)
      .catch((cause: unknown) => cause);
    expect(error).toBe(databaseError);
  });

  it("fails closed before the DAL for suspended or incomplete accounts", async () => {
    await expect(
      service().createStudio(createCommand, {
        ...context,
        session: { ...context.session, status: "suspended" },
      }),
    ).rejects.toMatchObject({ code: "ACCOUNT_SUSPENDED", status: 403 });
    await expect(
      service().createStudio(createCommand, {
        ...context,
        session: { ...context.session, profileCompleted: false },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
    expect(mocks.createStudioDraft).not.toHaveBeenCalled();
  });

  it("fails closed when a command result changes scope or studio", async () => {
    mocks.discardStudioDraftInDatabase.mockResolvedValueOnce({
      draft_discarded: true,
      edit_version: 2,
      scope: "77777777-7777-4777-8777-777777777777",
      studio_deleted: false,
      studio_id: studioId,
    });
    await expect(service().discardStudioDraft(discardCommand, context)).rejects.toThrow();
    expect(mocks.readOwnerStudioEditor).toHaveBeenCalledOnce();
  });
});

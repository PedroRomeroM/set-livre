import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../../src/lib/server/dal-pool", () => ({
  commandDalPool: () => ({ query: mocks.query }),
}));

import {
  createStudioDraft,
  discardStudioDraft,
  mapOwnerStudioEditorDalRow,
  parseDiscardStudioDraftDalRow,
  parseOwnerStudioEditorDalRow,
  updateStudioDraftCore,
} from "../../src/domains/studios/server/studio-dal";

const userId = "11111111-1111-4111-8111-111111111111";
const studioId = "22222222-2222-4222-8222-222222222222";
const revisionId = "33333333-3333-4333-8333-333333333333";
const studioTypeId = "44444444-4444-4444-8444-444444444444";
const idempotencyKey = "55555555-5555-4555-8555-555555555555";
const requestId = "66666666-6666-4666-8666-666666666666";
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
const row = {
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
} as const;

describe("studio DAL", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockResolvedValue({ rows: [row] });
  });

  it("calls the exact create signature without accepting city or state parameters", async () => {
    await createStudioDraft({ core, idempotencyKey, requestId, studioId, userId });

    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("private.create_studio("), [
      userId,
      studioId,
      idempotencyKey,
      requestId,
      core.name,
      core.description,
      core.address.street,
      core.address.streetNumber,
      core.address.complement,
      core.address.neighborhood,
      core.address.postalCode,
      core.capacity,
      core.studioTypeId,
    ]);
    const parameters = mocks.query.mock.calls[0]?.[1];
    expect(parameters).toHaveLength(13);
    expect(parameters).not.toContain("Curitiba");
    expect(parameters).not.toContain("PR");
  });

  it("calls update and discard with the monotonic edit version in the exact position", async () => {
    await updateStudioDraftCore({
      core,
      expectedEditVersion: 7,
      idempotencyKey,
      requestId,
      studioId,
      userId,
    });
    expect(mocks.query).toHaveBeenLastCalledWith(
      expect.stringContaining("private.update_studio_revision_core("),
      [
        userId,
        studioId,
        7,
        idempotencyKey,
        requestId,
        core.name,
        core.description,
        core.address.street,
        core.address.streetNumber,
        core.address.complement,
        core.address.neighborhood,
        core.address.postalCode,
        core.capacity,
        core.studioTypeId,
      ],
    );

    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          draft_discarded: true,
          edit_version: "8",
          scope: userId,
          studio_deleted: false,
          studio_id: studioId,
        },
      ],
    });
    await expect(
      discardStudioDraft({
        expectedEditVersion: 7,
        idempotencyKey,
        requestId,
        studioId,
        userId,
      }),
    ).resolves.toMatchObject({ draft_discarded: true, edit_version: 8 });
    expect(mocks.query).toHaveBeenLastCalledWith(
      expect.stringContaining("private.discard_studio_draft("),
      [userId, studioId, 7, idempotencyKey, requestId],
    );
  });

  it("maps only the private editor DTO and rejects scope or row drift", () => {
    const parsed = parseOwnerStudioEditorDalRow(row);
    const editor = mapOwnerStudioEditorDalRow(parsed, userId, [
      { id: studioTypeId, name: "Fotografia" },
    ]);
    expect(editor).toMatchObject({
      mode: "edit",
      scope: userId,
      studio: {
        draft: { core: { city: "Curitiba", state: "PR" }, revisionNumber: 1 },
        editVersion: 1,
        id: studioId,
        status: "draft",
      },
    });
    expect(JSON.stringify(editor)).not.toContain(revisionId);
    expect(() =>
      mapOwnerStudioEditorDalRow(parsed, "66666666-6666-4666-8666-666666666666", []),
    ).toThrow("não corresponde");
    expect(() => parseOwnerStudioEditorDalRow({ ...row, owner_user_id: userId })).toThrow();
    expect(() => parseOwnerStudioEditorDalRow({ ...row, draft_city: "São Paulo" })).toThrow();
  });

  it("parses bigint counters only through the JavaScript-safe integer boundary", () => {
    const maximumSafeInteger = String(Number.MAX_SAFE_INTEGER);
    const firstUnsafeInteger = String(Number.MAX_SAFE_INTEGER + 1);

    expect(
      parseOwnerStudioEditorDalRow({
        ...row,
        draft_revision_number: maximumSafeInteger,
        edit_version: maximumSafeInteger,
      }),
    ).toMatchObject({
      draft_revision_number: Number.MAX_SAFE_INTEGER,
      edit_version: Number.MAX_SAFE_INTEGER,
    });
    expect(() =>
      parseOwnerStudioEditorDalRow({ ...row, edit_version: firstUnsafeInteger }),
    ).toThrow();
    expect(() =>
      parseOwnerStudioEditorDalRow({
        ...row,
        draft_revision_number: firstUnsafeInteger,
      }),
    ).toThrow();

    expect(
      parseDiscardStudioDraftDalRow({
        draft_discarded: true,
        edit_version: maximumSafeInteger,
        scope: userId,
        studio_deleted: false,
        studio_id: studioId,
      }),
    ).toMatchObject({ edit_version: Number.MAX_SAFE_INTEGER });
    expect(() =>
      parseDiscardStudioDraftDalRow({
        draft_discarded: true,
        edit_version: firstUnsafeInteger,
        scope: userId,
        studio_deleted: false,
        studio_id: studioId,
      }),
    ).toThrow();
  });

  it("accepts a null deleted-studio edit version and requires it for a retained studio", () => {
    expect(
      parseDiscardStudioDraftDalRow({
        draft_discarded: false,
        edit_version: null,
        scope: userId,
        studio_deleted: true,
        studio_id: studioId,
      }),
    ).toMatchObject({ edit_version: null, studio_deleted: true });
    expect(() =>
      parseDiscardStudioDraftDalRow({
        draft_discarded: true,
        edit_version: null,
        scope: userId,
        studio_deleted: false,
        studio_id: studioId,
      }),
    ).toThrow();
    expect(() =>
      parseDiscardStudioDraftDalRow({
        draft_discarded: false,
        edit_version: "8",
        scope: userId,
        studio_deleted: true,
        studio_id: studioId,
      }),
    ).toThrow();
  });

  it("fails closed on zero or multiple command rows", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await expect(
      createStudioDraft({ core, idempotencyKey, requestId, studioId, userId }),
    ).rejects.toThrow("cardinalidade");
    mocks.query.mockResolvedValueOnce({ rows: [row, row] });
    await expect(
      createStudioDraft({ core, idempotencyKey, requestId, studioId, userId }),
    ).rejects.toThrow("cardinalidade");
  });

  it("rejects an invalid request correlation before opening the database", async () => {
    await expect(
      createStudioDraft({
        core,
        idempotencyKey,
        requestId: "invalid-request-id",
        studioId,
        userId,
      }),
    ).rejects.toThrow();
    expect(mocks.query).not.toHaveBeenCalled();
  });
});

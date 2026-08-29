import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({ abortSignal: vi.fn(), maybeSingle: vi.fn(), rpc: vi.fn() }));
const client = { rpc: mocks.rpc };

vi.mock("../../src/lib/supabase/server", () => ({
  createComponentSupabaseClient: async () => client,
}));

import {
  readActiveStudioTaxonomiesWithClient,
  readActiveStudioTypesWithClient,
  readOwnerStudioEditorWithClient,
  StudioNotFoundError,
} from "../../src/domains/studios/server/studio-read-model";
import { studioCoreFixture, studioEditorFixture, studioTestIds } from "./studio-test-fixture";

const editorRow = {
  address_complement: studioCoreFixture.addressComplement,
  amenities: studioEditorFixture.revision.amenities,
  capacity: studioCoreFixture.capacity,
  city: studioCoreFixture.city,
  description: studioCoreFixture.description,
  draft_revision_id: studioTestIds.revisionId,
  faqs: studioEditorFixture.revision.faqs,
  has_draft: true,
  name: studioCoreFixture.name,
  neighborhood: studioCoreFixture.neighborhood,
  postal_code: studioCoreFixture.postalCode,
  published_revision_id: null,
  revision_id: studioTestIds.revisionId,
  revision_number: "1",
  revision_status: "draft",
  revision_version: "1",
  scope: studioTestIds.userId,
  state: studioCoreFixture.state,
  street: studioCoreFixture.street,
  street_number: studioCoreFixture.streetNumber,
  studio_id: studioTestIds.studioId,
  studio_status: "draft",
  studio_type_id: studioTestIds.studioTypeId,
  studio_type_name: studioEditorFixture.studioType.name,
  tags: studioEditorFixture.revision.tags,
  usage_rules: studioEditorFixture.revision.usageRules,
  youtube_video_id: studioEditorFixture.revision.youtubeVideoId,
};

describe("studio read model", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.abortSignal.mockReturnValue({ maybeSingle: mocks.maybeSingle });
    mocks.rpc.mockReturnValue({ abortSignal: mocks.abortSignal });
    mocks.maybeSingle.mockResolvedValue({ data: editorRow, error: null });
  });

  it("maps the strict authenticated editor row and validates its scope", async () => {
    await expect(
      readOwnerStudioEditorWithClient(
        client as never,
        studioTestIds.userId,
        studioTestIds.studioId,
      ),
    ).resolves.toEqual(studioEditorFixture);
    expect(mocks.rpc).toHaveBeenCalledWith("get_owner_studio_editor", {
      p_studio_id: studioTestIds.studioId,
    });
    expect(mocks.abortSignal).toHaveBeenCalledWith(expect.any(AbortSignal));
  });

  it("returns not-found without exposing ownership and rejects DTO drift", async () => {
    mocks.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    await expect(
      readOwnerStudioEditorWithClient(
        client as never,
        studioTestIds.userId,
        studioTestIds.studioId,
      ),
    ).rejects.toBeInstanceOf(StudioNotFoundError);

    mocks.maybeSingle.mockResolvedValueOnce({
      data: { ...editorRow, scope: studioTestIds.otherUserId },
      error: null,
    });
    await expect(
      readOwnerStudioEditorWithClient(
        client as never,
        studioTestIds.userId,
        studioTestIds.studioId,
      ),
    ).rejects.toThrow("escopo diferente");

    mocks.maybeSingle.mockResolvedValueOnce({
      data: { ...editorRow, private_owner_tax_id: "52998224725" },
      error: null,
    });
    await expect(
      readOwnerStudioEditorWithClient(
        client as never,
        studioTestIds.userId,
        studioTestIds.studioId,
      ),
    ).rejects.toThrow();
  });

  it("maps only the ordered active taxonomy projection", async () => {
    const rows = [
      { id: studioTestIds.studioTypeId, name: "Audiovisual", sort_order: 10 },
      { id: studioTestIds.otherStudioId, name: "Fotográfico", sort_order: 20 },
    ];
    mocks.abortSignal.mockResolvedValueOnce({ data: rows, error: null });
    await expect(readActiveStudioTypesWithClient(client as never)).resolves.toEqual([
      { id: rows[0]?.id, name: "Audiovisual", sortOrder: 10 },
      { id: rows[1]?.id, name: "Fotográfico", sortOrder: 20 },
    ]);
    expect(mocks.rpc).toHaveBeenCalledWith("list_active_studio_types");
  });

  it("maps the ordered active tags and amenities projection", async () => {
    const taxonomies = {
      amenities: [{ id: studioTestIds.amenityId, name: "Wi-Fi", sortOrder: 10 }],
      tags: [{ id: studioTestIds.tagId, name: "Podcast", sortOrder: 10 }],
    };
    mocks.maybeSingle.mockResolvedValueOnce({ data: taxonomies, error: null });
    await expect(readActiveStudioTaxonomiesWithClient(client as never)).resolves.toEqual(
      taxonomies,
    );
    expect(mocks.rpc).toHaveBeenCalledWith("list_active_studio_taxonomies");
  });
});

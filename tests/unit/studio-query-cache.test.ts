import type { StudioEditor } from "@set-livre/contracts";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { clearIdentityAndAccountQueryCache } from "../../src/domains/identity/components/account-query-keys";
import {
  publishStudioEditor,
  publishStudioMediaGallery,
  preserveNewestStudioMediaGallery,
  removeStudioMediaGallery,
  studioEditorCanRender,
  studioMediaOrderMatchesIntent,
  StudioScopeChangedError,
  StudioMediaScopeChangedError,
  studioQueryKeys,
} from "../../src/domains/studios/components/studio-query-keys";
import { studioCorePanelInternals } from "../../src/domains/studios/components/studio-core-panel";
import { studioEditorPanelsInternals } from "../../src/domains/studios/components/studio-editor-panels";
import { studioEditorFixture, studioTestIds } from "./studio-test-fixture";

function editorFor(scope: string, studioId: string, revisionId: string): StudioEditor {
  return {
    ...studioEditorFixture,
    draftRevisionId: revisionId,
    revision: { ...studioEditorFixture.revision, id: revisionId },
    scope,
    studioId,
  };
}

describe("studio private query cache", () => {
  it("impede replay de mídia antigo de regredir a revisão já publicada no cache", () => {
    const queryClient = new QueryClient();
    const queryKey = studioQueryKeys.media(studioTestIds.userId, studioTestIds.studioId);
    const current = {
      items: [],
      previewExpiresAt: "2026-08-31T12:05:00.000Z",
      revisionId: studioTestIds.revisionId,
      revisionNumber: 2,
      revisionVersion: 5,
      scope: studioTestIds.userId,
      studioId: studioTestIds.studioId,
    };
    queryClient.setQueryData(queryKey, current);

    expect(
      publishStudioMediaGallery(
        queryClient,
        { ...current, revisionVersion: 4 },
        studioTestIds.userId,
        studioTestIds.studioId,
      ),
    ).toEqual(current);
    expect(queryClient.getQueryData(queryKey)).toEqual(current);
    expect(
      preserveNewestStudioMediaGallery(
        current,
        { ...current, revisionVersion: 6 },
        studioTestIds.userId,
        studioTestIds.studioId,
      ).revisionVersion,
    ).toBe(6);
    expect(() =>
      preserveNewestStudioMediaGallery(
        current,
        { ...current, scope: studioTestIds.otherUserId },
        studioTestIds.userId,
        studioTestIds.studioId,
      ),
    ).toThrow(StudioMediaScopeChangedError);
    expect(
      preserveNewestStudioMediaGallery(
        current,
        { ...current, previewExpiresAt: "2026-08-31T12:04:00.000Z" },
        studioTestIds.userId,
        studioTestIds.studioId,
      ),
    ).toEqual(current);
    expect(
      preserveNewestStudioMediaGallery(
        current,
        { ...current, previewExpiresAt: "2026-08-31T09:06:00.000-03:00" },
        studioTestIds.userId,
        studioTestIds.studioId,
      ).previewExpiresAt,
    ).toBe("2026-08-31T09:06:00.000-03:00");

    const newerRevision = {
      ...current,
      revisionId: "77777777-7777-4777-8777-777777777777",
      revisionNumber: 3,
      revisionVersion: 1,
    };
    expect(
      preserveNewestStudioMediaGallery(
        newerRevision,
        current,
        studioTestIds.userId,
        studioTestIds.studioId,
      ),
    ).toEqual(newerRevision);
    expect(
      preserveNewestStudioMediaGallery(
        current,
        newerRevision,
        studioTestIds.userId,
        studioTestIds.studioId,
      ),
    ).toEqual(newerRevision);
    expect(() =>
      preserveNewestStudioMediaGallery(
        current,
        { ...current, revisionId: newerRevision.revisionId },
        studioTestIds.userId,
        studioTestIds.studioId,
      ),
    ).toThrow(StudioMediaScopeChangedError);
  });

  it("remove somente a galeria do estúdio quando um descarte volta à revisão publicada", async () => {
    const queryClient = new QueryClient();
    const discarded = studioQueryKeys.media(studioTestIds.userId, studioTestIds.studioId);
    const sibling = studioQueryKeys.media(studioTestIds.userId, studioTestIds.otherStudioId);
    queryClient.setQueryData(discarded, { revisionNumber: 2 });
    queryClient.setQueryData(sibling, { revisionNumber: 7 });

    await removeStudioMediaGallery(queryClient, studioTestIds.userId, studioTestIds.studioId);

    expect(queryClient.getQueryData(discarded)).toBeUndefined();
    expect(queryClient.getQueryData(sibling)).toEqual({ revisionNumber: 7 });
  });

  it("confirma uma ordem somente quando cardinalidade e sequência são exatas", () => {
    const items = [{ id: "a" }, { id: "b" }];
    expect(studioMediaOrderMatchesIntent(items, ["a", "b"])).toBe(true);
    expect(studioMediaOrderMatchesIntent(items.slice(0, 1), ["a", "b"])).toBe(false);
    expect(studioMediaOrderMatchesIntent(items, ["b", "a"])).toBe(false);
  });

  it("publishes only over an existing boundary and preserves another studio from the same owner", () => {
    const queryClient = new QueryClient();
    const otherRevisionId = "88888888-8888-4888-8888-888888888888";
    const otherEditor = editorFor(
      studioTestIds.userId,
      studioTestIds.otherStudioId,
      otherRevisionId,
    );
    const foreignEditor = editorFor(
      studioTestIds.otherUserId,
      studioTestIds.otherStudioId,
      otherRevisionId,
    );
    queryClient.setQueryData(
      studioQueryKeys.editor(studioTestIds.userId, studioTestIds.studioId),
      studioEditorFixture,
    );
    queryClient.setQueryData(
      studioQueryKeys.editor(studioTestIds.userId, studioTestIds.otherStudioId),
      otherEditor,
    );
    queryClient.setQueryData(
      studioQueryKeys.editor(studioTestIds.otherUserId, studioTestIds.otherStudioId),
      foreignEditor,
    );
    const updated = {
      ...studioEditorFixture,
      revision: { ...studioEditorFixture.revision, version: 2 },
    };

    expect(
      publishStudioEditor(queryClient, updated, studioTestIds.userId, studioTestIds.studioId),
    ).toEqual(updated);
    expect(
      queryClient.getQueryData(
        studioQueryKeys.editor(studioTestIds.userId, studioTestIds.otherStudioId),
      ),
    ).toEqual(otherEditor);
    expect(
      queryClient.getQueryData(
        studioQueryKeys.editor(studioTestIds.otherUserId, studioTestIds.otherStudioId),
      ),
    ).toBeUndefined();
  });

  it("rejects a late mutation after session cleanup and removes all private studio data", () => {
    const queryClient = new QueryClient();
    const currentTaxonomies = studioQueryKeys.taxonomies(studioTestIds.userId);
    const foreignTaxonomies = studioQueryKeys.taxonomies(studioTestIds.otherUserId);
    const currentTypes = studioQueryKeys.types(studioTestIds.userId);
    const currentMedia = studioQueryKeys.media(studioTestIds.userId, studioTestIds.studioId);
    const foreignMedia = studioQueryKeys.media(
      studioTestIds.otherUserId,
      studioTestIds.otherStudioId,
    );
    expect(currentTaxonomies).not.toEqual(foreignTaxonomies);
    expect(() =>
      publishStudioEditor(
        queryClient,
        studioEditorFixture,
        studioTestIds.userId,
        studioTestIds.studioId,
      ),
    ).toThrow(StudioScopeChangedError);

    queryClient.setQueryData(
      studioQueryKeys.editor(studioTestIds.userId, studioTestIds.studioId),
      studioEditorFixture,
    );
    queryClient.setQueryData(currentTaxonomies, { tags: ["current"] });
    queryClient.setQueryData(foreignTaxonomies, { tags: ["foreign"] });
    queryClient.setQueryData(currentTypes, [{ id: "private-type" }]);
    queryClient.setQueryData(currentMedia, { items: [{ previewUrl: "current-private" }] });
    queryClient.setQueryData(foreignMedia, { items: [{ previewUrl: "foreign-private" }] });
    clearIdentityAndAccountQueryCache(queryClient);
    expect(
      queryClient.getQueryData(
        studioQueryKeys.editor(studioTestIds.userId, studioTestIds.studioId),
      ),
    ).toBeUndefined();
    expect(queryClient.getQueryData(currentTaxonomies)).toBeUndefined();
    expect(queryClient.getQueryData(foreignTaxonomies)).toBeUndefined();
    expect(queryClient.getQueryData(currentTypes)).toBeUndefined();
    expect(queryClient.getQueryData(currentMedia)).toBeUndefined();
    expect(queryClient.getQueryData(foreignMedia)).toBeUndefined();
  });

  it("keeps SSR private values hidden until an authoritative scoped read succeeds", () => {
    expect(
      studioEditorCanRender(
        studioEditorFixture,
        studioTestIds.userId,
        studioTestIds.studioId,
        "fetching",
        false,
      ),
    ).toBe(false);
    expect(
      studioEditorCanRender(
        studioEditorFixture,
        studioTestIds.userId,
        studioTestIds.studioId,
        "idle",
        true,
      ),
    ).toBe(false);
    expect(
      studioEditorCanRender(
        studioEditorFixture,
        studioTestIds.otherUserId,
        studioTestIds.studioId,
        "idle",
        false,
      ),
    ).toBe(false);
    expect(
      studioEditorCanRender(
        studioEditorFixture,
        studioTestIds.userId,
        studioTestIds.studioId,
        "idle",
        false,
      ),
    ).toBe(true);
  });

  it("parses form scalars and exposes only changed conflict rows", () => {
    const local = studioCorePanelInternals.editorFormState(studioEditorFixture);
    const parsed = studioCorePanelInternals.parseCoreForm({
      ...local,
      capacity: "24",
      postalCode: "80010-000",
    });
    expect(parsed.success && parsed.data).toMatchObject({ capacity: 24, postalCode: "80010000" });

    expect(
      studioCorePanelInternals.conflictRows(
        local,
        {
          ...local,
          name: "Nome remoto",
          streetNumber: "200",
        },
        [],
      ),
    ).toEqual([
      { field: "name", label: "Nome", local: local.name, remote: "Nome remoto" },
      { field: "streetNumber", label: "Número", local: local.streetNumber, remote: "200" },
    ]);

    expect(
      studioCorePanelInternals.includeCurrentStudioType([], studioEditorFixture.studioType),
    ).toEqual([{ ...studioEditorFixture.studioType, sortOrder: 0 }]);
  });

  it("keeps stale sibling form tokens bound to their visible values", () => {
    const revision1 = { id: studioTestIds.revisionId, number: 1, version: 1 };
    const revision2 = { ...revision1, version: 2 };
    const revision3 = { ...revision1, version: 3 };
    const synchronized = studioEditorPanelsInternals.advanceEditorRevisions(
      {
        content: revision1,
        core: revision1,
        discard: revision1,
        taxonomy: revision1,
      },
      "core",
      revision2,
    );
    expect(synchronized).toEqual({
      content: revision2,
      core: revision2,
      discard: revision2,
      taxonomy: revision2,
    });

    expect(
      studioEditorPanelsInternals.advanceEditorRevisions(
        {
          content: revision1,
          core: revision2,
          discard: revision2,
          taxonomy: revision1,
        },
        "core",
        revision3,
      ),
    ).toEqual({
      content: revision1,
      core: revision3,
      discard: revision3,
      taxonomy: revision1,
    });
  });

  it("renders active and historical studio type descriptors instead of UUIDs in conflicts", () => {
    const local = studioCorePanelInternals.editorFormState(studioEditorFixture);
    const remoteType = {
      id: "60000000-0000-4000-8000-000000000002",
      name: "Estúdio fotográfico",
      sortOrder: 20,
    };

    expect(
      studioCorePanelInternals.conflictRows(local, { ...local, studioTypeId: remoteType.id }, [
        { ...studioEditorFixture.studioType, sortOrder: 10 },
        remoteType,
      ]),
    ).toEqual([
      {
        field: "studioTypeId",
        label: "Tipo de estúdio",
        local: studioEditorFixture.studioType.name,
        remote: remoteType.name,
      },
    ]);
  });
});

import type { StudioEditor } from "@set-livre/contracts";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { clearIdentityAndAccountQueryCache } from "../../src/domains/identity/components/account-query-keys";
import {
  publishStudioEditor,
  studioEditorCanRender,
  StudioScopeChangedError,
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
    clearIdentityAndAccountQueryCache(queryClient);
    expect(
      queryClient.getQueryData(
        studioQueryKeys.editor(studioTestIds.userId, studioTestIds.studioId),
      ),
    ).toBeUndefined();
    expect(queryClient.getQueryData(currentTaxonomies)).toBeUndefined();
    expect(queryClient.getQueryData(foreignTaxonomies)).toBeUndefined();
    expect(queryClient.getQueryData(currentTypes)).toBeUndefined();
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

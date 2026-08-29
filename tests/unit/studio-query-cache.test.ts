import type { StudioEditor } from "@set-livre/contracts";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { clearIdentityAndAccountQueryCache } from "../../src/domains/identity/components/account-query-keys";
import {
  publishStudioEditor,
  StudioScopeChangedError,
  studioQueryKeys,
} from "../../src/domains/studios/components/studio-query-keys";
import { studioCorePanelInternals } from "../../src/domains/studios/components/studio-core-panel";
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
    clearIdentityAndAccountQueryCache(queryClient);
    expect(
      queryClient.getQueryData(
        studioQueryKeys.editor(studioTestIds.userId, studioTestIds.studioId),
      ),
    ).toBeUndefined();
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
      studioCorePanelInternals.conflictRows(local, {
        ...local,
        name: "Nome remoto",
        streetNumber: "200",
      }),
    ).toEqual([
      { field: "name", label: "Nome", local: local.name, remote: "Nome remoto" },
      { field: "streetNumber", label: "Número", local: local.streetNumber, remote: "200" },
    ]);
  });
});

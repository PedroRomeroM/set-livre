import type { StudioEditor } from "@set-livre/contracts";
import type { QueryClient } from "@tanstack/react-query";

const studioPrivateRoot = ["owner", "private", "studio-editor"] as const;

export const studioQueryKeys = {
  editor: (userId: string, studioId: string) => [...studioPrivateRoot, userId, studioId] as const,
  privateEditors: studioPrivateRoot,
  types: ["studio", "taxonomies", "types"] as const,
};

export class StudioScopeChangedError extends Error {
  constructor() {
    super("O editor retornado não corresponde ao usuário ou ao estúdio esperados.");
    this.name = "StudioScopeChangedError";
  }
}

function assertStudioEditorBoundary(
  editor: StudioEditor,
  expectedUserId: string,
  expectedStudioId: string,
) {
  if (editor.scope !== expectedUserId || editor.studioId !== expectedStudioId) {
    throw new StudioScopeChangedError();
  }
  return editor;
}

export function publishStudioEditor(
  queryClient: QueryClient,
  editor: StudioEditor,
  expectedUserId: string,
  expectedStudioId: string,
) {
  const scoped = assertStudioEditorBoundary(editor, expectedUserId, expectedStudioId);
  const queryKey = studioQueryKeys.editor(expectedUserId, expectedStudioId);
  const current = queryClient.getQueryData<StudioEditor>(queryKey);
  if (current === undefined) throw new StudioScopeChangedError();
  assertStudioEditorBoundary(current, expectedUserId, expectedStudioId);
  queryClient.removeQueries({
    predicate: (query) => {
      const key = query.queryKey;
      return (
        key.length === 5 &&
        key[0] === studioPrivateRoot[0] &&
        key[1] === studioPrivateRoot[1] &&
        key[2] === studioPrivateRoot[2] &&
        key[3] !== expectedUserId
      );
    },
  });
  queryClient.setQueryData(queryKey, scoped);
  return scoped;
}

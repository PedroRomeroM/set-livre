import type { OwnerStudioEditorResult } from "@set-livre/contracts";
import type { QueryClient } from "@tanstack/react-query";

type StudioFetchStatus = "fetching" | "idle" | "paused";

const studioEditorQueryRoot = ["owner", "private", "studio-editor"] as const;

export class StudioEditorScopeChangedError extends Error {
  constructor() {
    super("O editor privado do estúdio mudou de escopo.");
    this.name = "StudioEditorScopeChangedError";
  }
}

export const ownerStudioQueryKeys = {
  editor: (userId: string, studioId?: string) =>
    [...studioEditorQueryRoot, userId, studioId ?? "new"] as const,
  editors: studioEditorQueryRoot,
};

export function studioEditorQueryScope(queryKey: readonly unknown[]): string | undefined {
  if (
    queryKey.length !== 5 ||
    queryKey[0] !== studioEditorQueryRoot[0] ||
    queryKey[1] !== studioEditorQueryRoot[1] ||
    queryKey[2] !== studioEditorQueryRoot[2] ||
    typeof queryKey[3] !== "string" ||
    typeof queryKey[4] !== "string"
  ) {
    return undefined;
  }
  return queryKey[3];
}

export function studioEditorMatchesBoundary(
  result: OwnerStudioEditorResult,
  expectedUserId: string,
  expectedStudioId?: string,
) {
  if (result.scope !== expectedUserId || result.projection !== "studio_editor") return false;
  return expectedStudioId === undefined
    ? result.mode === "create" && result.studio === null
    : result.mode === "edit" && result.studio.id === expectedStudioId;
}

export function studioEditorForBoundary(
  result: OwnerStudioEditorResult,
  expectedUserId: string,
  expectedStudioId?: string,
) {
  if (!studioEditorMatchesBoundary(result, expectedUserId, expectedStudioId)) {
    throw new StudioEditorScopeChangedError();
  }
  return result;
}

export function newestStudioEditorResult(
  current: OwnerStudioEditorResult | undefined,
  candidate: OwnerStudioEditorResult,
  expectedUserId: string,
  expectedStudioId?: string,
) {
  const scopedCandidate = studioEditorForBoundary(candidate, expectedUserId, expectedStudioId);
  if (current === undefined) return scopedCandidate;
  studioEditorForBoundary(current, expectedUserId, expectedStudioId);
  if (
    current.mode === "edit" &&
    candidate.mode === "edit" &&
    candidate.studio.editVersion < current.studio.editVersion
  ) {
    return current;
  }
  return scopedCandidate;
}

export function newestStudioEditorMutationResult(
  current: OwnerStudioEditorResult | undefined,
  candidate: OwnerStudioEditorResult,
  expectedUserId: string,
  expectedStudioId: string,
) {
  if (current === undefined) throw new StudioEditorScopeChangedError();
  return newestStudioEditorResult(current, candidate, expectedUserId, expectedStudioId);
}

export async function readNewestStudioEditorResult(
  queryClient: QueryClient,
  expectedUserId: string,
  expectedStudioId: string | undefined,
  readResult: () => Promise<OwnerStudioEditorResult>,
) {
  const candidate = studioEditorForBoundary(await readResult(), expectedUserId, expectedStudioId);
  return newestStudioEditorResult(
    queryClient.getQueryData<OwnerStudioEditorResult>(
      ownerStudioQueryKeys.editor(expectedUserId, expectedStudioId),
    ),
    candidate,
    expectedUserId,
    expectedStudioId,
  );
}

export function studioEditorCanRender(
  result: OwnerStudioEditorResult,
  expectedUserId: string,
  expectedStudioId: string | undefined,
  fetchStatus: StudioFetchStatus,
) {
  return (
    fetchStatus === "idle" && studioEditorMatchesBoundary(result, expectedUserId, expectedStudioId)
  );
}

export function seedAuthoritativeStudioEditor(
  queryClient: QueryClient,
  expectedUserId: string,
  expectedStudioId: string | undefined,
  result: OwnerStudioEditorResult,
) {
  const scopedResult = studioEditorForBoundary(result, expectedUserId, expectedStudioId);
  queryClient.getMutationCache().clear();
  queryClient.removeQueries({ queryKey: ownerStudioQueryKeys.editors });
  queryClient.setQueryData(
    ownerStudioQueryKeys.editor(expectedUserId, expectedStudioId),
    scopedResult,
  );
}

export function publishNewestStudioEditorMutationResult(
  queryClient: QueryClient,
  expectedUserId: string,
  expectedStudioId: string,
  candidate: OwnerStudioEditorResult,
) {
  const queryKey = ownerStudioQueryKeys.editor(expectedUserId, expectedStudioId);
  const current = queryClient.getQueryData<OwnerStudioEditorResult>(queryKey);
  const next = newestStudioEditorMutationResult(
    current,
    candidate,
    expectedUserId,
    expectedStudioId,
  );
  if (next !== candidate) {
    queryClient.getMutationCache().clear();
    void queryClient.invalidateQueries({ queryKey });
    return false;
  }
  queryClient.getMutationCache().clear();
  queryClient.removeQueries({
    predicate: (query) => studioEditorQueryScope(query.queryKey) !== expectedUserId,
    queryKey: ownerStudioQueryKeys.editors,
  });
  queryClient.setQueryData(queryKey, next);
  return true;
}

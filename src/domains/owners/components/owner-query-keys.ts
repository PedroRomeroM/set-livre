import type { OwnerRecipientResult } from "@set-livre/contracts";
import type { QueryClient } from "@tanstack/react-query";

type OwnerFetchStatus = "fetching" | "idle" | "paused";

const ownerRecipientQueryRoot = ["owner", "recipient", "status"] as const;

export class OwnerRecipientScopeChangedError extends Error {
  constructor() {
    super("O cadastro de recebimentos mudou de escopo.");
    this.name = "OwnerRecipientScopeChangedError";
  }
}

export const ownerQueryKeys = {
  recipientStatus: (userId: string) => [...ownerRecipientQueryRoot, userId] as const,
  recipientStatuses: ownerRecipientQueryRoot,
};

export function ownerRecipientQueryScope(queryKey: readonly unknown[]): string | undefined {
  if (
    queryKey.length !== 4 ||
    queryKey[0] !== ownerRecipientQueryRoot[0] ||
    queryKey[1] !== ownerRecipientQueryRoot[1] ||
    queryKey[2] !== ownerRecipientQueryRoot[2] ||
    typeof queryKey[3] !== "string"
  ) {
    return undefined;
  }
  return queryKey[3];
}

export function ownerRecipientMatchesScope(result: OwnerRecipientResult, expectedUserId: string) {
  return result.scope === expectedUserId;
}

export function ownerRecipientForScope(result: OwnerRecipientResult, expectedUserId: string) {
  if (!ownerRecipientMatchesScope(result, expectedUserId)) {
    throw new OwnerRecipientScopeChangedError();
  }
  return result;
}

function ownerContractTimestamp(result: OwnerRecipientResult) {
  return new Date(result.ownerContract.effectiveAt).getTime();
}

export function newestOwnerRecipientResult(
  current: OwnerRecipientResult | undefined,
  candidate: OwnerRecipientResult,
  expectedUserId: string,
) {
  const scopedCandidate = ownerRecipientForScope(candidate, expectedUserId);
  if (current === undefined) return scopedCandidate;
  if (!ownerRecipientMatchesScope(current, expectedUserId)) {
    throw new OwnerRecipientScopeChangedError();
  }
  if (
    candidate.ownerVersion < current.ownerVersion ||
    candidate.profileVersion < current.profileVersion ||
    candidate.recipientVersion < current.recipientVersion ||
    ownerContractTimestamp(candidate) < ownerContractTimestamp(current)
  ) {
    return current;
  }
  return scopedCandidate;
}

export function newestOwnerRecipientMutationResult(
  current: OwnerRecipientResult | undefined,
  candidate: OwnerRecipientResult,
  expectedUserId: string,
) {
  if (current === undefined) {
    throw new OwnerRecipientScopeChangedError();
  }
  return newestOwnerRecipientResult(current, candidate, expectedUserId);
}

export async function readNewestOwnerRecipientResult(
  queryClient: QueryClient,
  expectedUserId: string,
  readRecipient: () => Promise<OwnerRecipientResult>,
) {
  const candidate = ownerRecipientForScope(await readRecipient(), expectedUserId);
  return newestOwnerRecipientResult(
    queryClient.getQueryData<OwnerRecipientResult>(ownerQueryKeys.recipientStatus(expectedUserId)),
    candidate,
    expectedUserId,
  );
}

export function ownerRecipientCanRender(
  result: OwnerRecipientResult,
  expectedUserId: string,
  fetchStatus: OwnerFetchStatus,
) {
  return fetchStatus === "idle" && ownerRecipientMatchesScope(result, expectedUserId);
}

export function seedAuthoritativeOwnerRecipient(
  queryClient: QueryClient,
  expectedUserId: string,
  result: OwnerRecipientResult,
) {
  const scopedResult = ownerRecipientForScope(result, expectedUserId);
  queryClient.getMutationCache().clear();
  queryClient.removeQueries({ queryKey: ownerQueryKeys.recipientStatuses });
  queryClient.setQueryData(ownerQueryKeys.recipientStatus(expectedUserId), scopedResult);
}

export function publishNewestOwnerRecipientMutationResult(
  queryClient: QueryClient,
  expectedUserId: string,
  candidate: OwnerRecipientResult,
) {
  const queryKey = ownerQueryKeys.recipientStatus(expectedUserId);
  const current = queryClient.getQueryData<OwnerRecipientResult>(queryKey);
  const next = newestOwnerRecipientMutationResult(current, candidate, expectedUserId);
  if (next !== candidate) {
    queryClient.getMutationCache().clear();
    void queryClient.invalidateQueries({ queryKey });
    return false;
  }
  queryClient.getMutationCache().clear();
  queryClient.removeQueries({
    predicate: (query) => ownerRecipientQueryScope(query.queryKey) !== expectedUserId,
    queryKey: ownerQueryKeys.recipientStatuses,
  });
  queryClient.setQueryData(queryKey, next);
  return true;
}

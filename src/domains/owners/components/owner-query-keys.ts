import type { OwnerRecipientResult } from "@set-livre/contracts";
import type { QueryClient } from "@tanstack/react-query";

type OwnerFetchStatus = "fetching" | "idle" | "paused";
type OwnerProjection = OwnerRecipientResult["projection"];

const ownerPrivateQueryRoot = ["owner", "private"] as const;
const ownerActivationQueryRoot = [...ownerPrivateQueryRoot, "activation"] as const;
const ownerRecipientQueryRoot = [...ownerPrivateQueryRoot, "recipient"] as const;

export class OwnerPrivateScopeChangedError extends Error {
  constructor() {
    super("O estado privado da área do dono mudou de escopo ou projeção.");
    this.name = "OwnerPrivateScopeChangedError";
  }
}

export const ownerQueryKeys = {
  activationStatus: (userId: string) => [...ownerActivationQueryRoot, userId] as const,
  privateResults: ownerPrivateQueryRoot,
  recipientStatus: (userId: string) => [...ownerRecipientQueryRoot, userId] as const,
};

export function ownerPrivateQueryScope(queryKey: readonly unknown[]): string | undefined {
  if (
    queryKey.length !== 4 ||
    queryKey[0] !== ownerPrivateQueryRoot[0] ||
    queryKey[1] !== ownerPrivateQueryRoot[1] ||
    (queryKey[2] !== "activation" && queryKey[2] !== "recipient") ||
    typeof queryKey[3] !== "string"
  ) {
    return undefined;
  }
  return queryKey[3];
}

export function ownerQueryKey(projection: OwnerProjection, userId: string) {
  return projection === "activation"
    ? ownerQueryKeys.activationStatus(userId)
    : ownerQueryKeys.recipientStatus(userId);
}

export function ownerPrivateMatchesBoundary(
  result: OwnerRecipientResult,
  expectedUserId: string,
  expectedProjection: OwnerProjection,
) {
  return result.scope === expectedUserId && result.projection === expectedProjection;
}

export function ownerPrivateForBoundary(
  result: OwnerRecipientResult,
  expectedUserId: string,
  expectedProjection: OwnerProjection,
) {
  if (!ownerPrivateMatchesBoundary(result, expectedUserId, expectedProjection)) {
    throw new OwnerPrivateScopeChangedError();
  }
  return result;
}

function ownerContractTimestamp(result: OwnerRecipientResult) {
  return new Date(result.ownerContract.effectiveAt).getTime();
}

export function newestOwnerPrivateResult(
  current: OwnerRecipientResult | undefined,
  candidate: OwnerRecipientResult,
  expectedUserId: string,
  expectedProjection: OwnerProjection,
) {
  const scopedCandidate = ownerPrivateForBoundary(candidate, expectedUserId, expectedProjection);
  if (current === undefined) return scopedCandidate;
  if (!ownerPrivateMatchesBoundary(current, expectedUserId, expectedProjection)) {
    throw new OwnerPrivateScopeChangedError();
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

export function newestOwnerPrivateMutationResult(
  current: OwnerRecipientResult | undefined,
  candidate: OwnerRecipientResult,
  expectedUserId: string,
  expectedProjection: OwnerProjection,
) {
  if (current === undefined) {
    throw new OwnerPrivateScopeChangedError();
  }
  return newestOwnerPrivateResult(current, candidate, expectedUserId, expectedProjection);
}

export async function readNewestOwnerPrivateResult(
  queryClient: QueryClient,
  expectedUserId: string,
  expectedProjection: OwnerProjection,
  readResult: () => Promise<OwnerRecipientResult>,
) {
  const candidate = ownerPrivateForBoundary(await readResult(), expectedUserId, expectedProjection);
  return newestOwnerPrivateResult(
    queryClient.getQueryData<OwnerRecipientResult>(
      ownerQueryKey(expectedProjection, expectedUserId),
    ),
    candidate,
    expectedUserId,
    expectedProjection,
  );
}

export function ownerPrivateCanRender(
  result: OwnerRecipientResult,
  expectedUserId: string,
  expectedProjection: OwnerProjection,
  fetchStatus: OwnerFetchStatus,
) {
  return (
    fetchStatus === "idle" &&
    ownerPrivateMatchesBoundary(result, expectedUserId, expectedProjection)
  );
}

export function seedAuthoritativeOwnerPrivate(
  queryClient: QueryClient,
  expectedUserId: string,
  expectedProjection: OwnerProjection,
  result: OwnerRecipientResult,
) {
  const scopedResult = ownerPrivateForBoundary(result, expectedUserId, expectedProjection);
  queryClient.getMutationCache().clear();
  queryClient.removeQueries({ queryKey: ownerQueryKeys.privateResults });
  queryClient.setQueryData(ownerQueryKey(expectedProjection, expectedUserId), scopedResult);
}

export function publishNewestOwnerPrivateMutationResult(
  queryClient: QueryClient,
  expectedUserId: string,
  expectedProjection: OwnerProjection,
  candidate: OwnerRecipientResult,
) {
  const queryKey = ownerQueryKey(expectedProjection, expectedUserId);
  const current = queryClient.getQueryData<OwnerRecipientResult>(queryKey);
  const next = newestOwnerPrivateMutationResult(
    current,
    candidate,
    expectedUserId,
    expectedProjection,
  );
  if (next !== candidate) {
    queryClient.getMutationCache().clear();
    void queryClient.invalidateQueries({ queryKey });
    return false;
  }
  queryClient.getMutationCache().clear();
  queryClient.removeQueries({
    predicate: (query) => ownerPrivateQueryScope(query.queryKey) !== expectedUserId,
    queryKey: ownerQueryKeys.privateResults,
  });
  queryClient.setQueryData(queryKey, next);
  return true;
}

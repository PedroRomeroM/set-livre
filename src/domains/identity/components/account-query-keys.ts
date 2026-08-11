import type { MyProfileResult } from "@set-livre/contracts";
import type { QueryClient } from "@tanstack/react-query";

import { identityQueryKeys } from "./identity-query-keys";

type AccountFetchStatus = "fetching" | "idle" | "paused";

const accountProfileQueryRoot = ["account", "profile"] as const;

export class AccountProfileScopeChangedError extends Error {
  constructor() {
    super("O perfil autoritativo mudou de escopo.");
    this.name = "AccountProfileScopeChangedError";
  }
}

export const accountQueryKeys = {
  profile: (userId: string) => [...accountProfileQueryRoot, userId] as const,
  profiles: accountProfileQueryRoot,
};

export function accountProfileQueryScope(queryKey: readonly unknown[]): string | undefined {
  if (
    queryKey.length !== 3 ||
    queryKey[0] !== accountProfileQueryRoot[0] ||
    queryKey[1] !== accountProfileQueryRoot[1] ||
    typeof queryKey[2] !== "string"
  ) {
    return undefined;
  }
  return queryKey[2];
}

export function accountProfileMatchesScope(profile: MyProfileResult, expectedUserId: string) {
  return profile.scope === expectedUserId;
}

export function accountProfileForScope(profile: MyProfileResult, expectedUserId: string) {
  if (!accountProfileMatchesScope(profile, expectedUserId)) {
    throw new AccountProfileScopeChangedError();
  }
  return profile;
}

export function newestAccountProfileResult(
  current: MyProfileResult | undefined,
  candidate: MyProfileResult,
  expectedUserId: string,
) {
  const scopedCandidate = accountProfileForScope(candidate, expectedUserId);
  if (current === undefined) return scopedCandidate;
  if (!accountProfileMatchesScope(current, expectedUserId)) {
    throw new AccountProfileScopeChangedError();
  }
  if (
    candidate.profile.profileVersion < current.profile.profileVersion ||
    candidate.profile.preferencesVersion < current.profile.preferencesVersion
  ) {
    return current;
  }
  return scopedCandidate;
}

export async function readNewestAccountProfileResult(
  queryClient: QueryClient,
  expectedUserId: string,
  readProfile: () => Promise<MyProfileResult>,
) {
  const candidate = accountProfileForScope(await readProfile(), expectedUserId);
  return newestAccountProfileResult(
    queryClient.getQueryData<MyProfileResult>(accountQueryKeys.profile(expectedUserId)),
    candidate,
    expectedUserId,
  );
}

export function accountProfileCanRender(
  profile: MyProfileResult,
  expectedUserId: string,
  fetchStatus: AccountFetchStatus,
) {
  return fetchStatus === "idle" && accountProfileMatchesScope(profile, expectedUserId);
}

export function clearIdentityAndAccountQueryCache(queryClient: QueryClient) {
  queryClient.getMutationCache().clear();
  queryClient.removeQueries({ queryKey: accountQueryKeys.profiles });
  queryClient.removeQueries({ queryKey: identityQueryKeys.sessions });
}

import type { IdentitySession, MyProfileResult } from "@set-livre/contracts";
import type { QueryClient } from "@tanstack/react-query";

import {
  ownerPrivateQueryScope,
  ownerQueryKeys,
} from "@/domains/owners/components/owner-query-keys";
import { ownerStudioQueryKeys } from "@/domains/studios/components/studio-query-keys";

import {
  identityQueryKeys,
  identitySessionQueryScope,
  identitySessionScope,
} from "./identity-query-keys";

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

export function newestAccountProfileMutationResult(
  current: MyProfileResult | undefined,
  candidate: MyProfileResult,
  expectedUserId: string,
) {
  if (current === undefined) {
    throw new AccountProfileScopeChangedError();
  }
  return newestAccountProfileResult(current, candidate, expectedUserId);
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
  queryClient.removeQueries({ queryKey: ownerQueryKeys.privateResults });
  queryClient.removeQueries({ queryKey: ownerStudioQueryKeys.editors });
}

export function seedAuthoritativeAccountProfile(
  queryClient: QueryClient,
  expectedUserId: string,
  profile: MyProfileResult,
) {
  const scopedProfile = accountProfileForScope(profile, expectedUserId);
  clearIdentityAndAccountQueryCache(queryClient);
  queryClient.setQueryData(accountQueryKeys.profile(expectedUserId), scopedProfile);
}

export function publishAuthoritativeAccountProfile(
  queryClient: QueryClient,
  expectedUserId: string,
  profile: MyProfileResult,
  session?: IdentitySession | undefined,
) {
  const scopedProfile = accountProfileForScope(profile, expectedUserId);
  if (session !== undefined && identitySessionScope(session) !== expectedUserId) {
    throw new AccountProfileScopeChangedError();
  }
  queryClient.getMutationCache().clear();
  queryClient.removeQueries({
    predicate: (query) => accountProfileQueryScope(query.queryKey) !== expectedUserId,
    queryKey: accountQueryKeys.profiles,
  });
  queryClient.removeQueries({
    predicate: (query) =>
      session === undefined || identitySessionQueryScope(query.queryKey) !== expectedUserId,
    queryKey: identityQueryKeys.sessions,
  });
  queryClient.setQueryData(accountQueryKeys.profile(expectedUserId), scopedProfile);
  if (session !== undefined) {
    queryClient.setQueryData(identityQueryKeys.session(expectedUserId), session);
  }
}

export function publishNewestAccountProfileMutationResult(
  queryClient: QueryClient,
  expectedUserId: string,
  candidate: MyProfileResult,
) {
  const queryKey = accountQueryKeys.profile(expectedUserId);
  const current = queryClient.getQueryData<MyProfileResult>(queryKey);
  const next = newestAccountProfileMutationResult(current, candidate, expectedUserId);
  if (next !== candidate) {
    queryClient.getMutationCache().clear();
    void queryClient.invalidateQueries({ queryKey });
    return false;
  }
  const currentSession = queryClient.getQueryData<IdentitySession>(
    identityQueryKeys.session(expectedUserId),
  );
  let synchronizedSession: Extract<IdentitySession, { authenticated: true }> | undefined;
  if (currentSession?.authenticated === true && currentSession.userId === expectedUserId) {
    synchronizedSession = {
      ...currentSession,
      personType: candidate.profile.personType,
      profileCompleted: candidate.profile.completed,
      status: candidate.profile.status,
    } satisfies Extract<IdentitySession, { authenticated: true }>;
  }
  publishAuthoritativeAccountProfile(queryClient, expectedUserId, candidate, synchronizedSession);
  void queryClient.invalidateQueries({
    predicate: (query) => ownerPrivateQueryScope(query.queryKey) === expectedUserId,
    queryKey: ownerQueryKeys.privateResults,
  });
  return true;
}

export function seedAuthoritativeIdentitySession(
  queryClient: QueryClient,
  session: IdentitySession,
) {
  clearIdentityAndAccountQueryCache(queryClient);
  queryClient.setQueryData(identityQueryKeys.session(identitySessionScope(session)), session);
}

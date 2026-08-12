import type { MyProfileResult } from "@set-livre/contracts";
import { MutationObserver, onlineManager, QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import {
  accountProfileCanRender,
  accountProfileForScope,
  accountProfileQueryScope,
  accountQueryKeys,
  clearIdentityAndAccountQueryCache,
  newestAccountProfileMutationResult,
  newestAccountProfileResult,
  publishAuthoritativeAccountProfile,
  publishNewestAccountProfileMutationResult,
  readNewestAccountProfileResult,
  seedAuthoritativeAccountProfile,
  seedAuthoritativeIdentitySession,
} from "../../src/domains/identity/components/account-query-keys";
import { identityQueryKeys } from "../../src/domains/identity/components/identity-query-keys";
import { ownerQueryKeys } from "../../src/domains/owners/components/owner-query-keys";

const userA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const userB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const profileA = {
  profile: {
    additionalDocumentMasked: "*********-6",
    colorScheme: "system",
    completed: true,
    name: "Pessoa A",
    personType: "individual",
    phone: "+5541999991234",
    preferencesVersion: 0,
    profileVersion: 1,
    status: "active",
    taxIdMasked: "***.***.***-25",
  },
  scope: userA,
} satisfies MyProfileResult;
const profileB = {
  ...profileA,
  profile: { ...profileA.profile, name: "Pessoa B" },
  scope: userB,
} satisfies MyProfileResult;
const sessionB = {
  authenticated: true as const,
  email: "qa-profile-b@example.test",
  personType: "individual" as const,
  profileCompleted: true,
  status: "active" as const,
  userId: userB,
};
const sessionA = { ...sessionB, email: "qa-profile-a@example.test", userId: userA };

describe("account profile cache", () => {
  it("scopes keys only by the authenticated UUID", () => {
    const keyA = accountQueryKeys.profile(userA);
    const keyB = accountQueryKeys.profile(userB);

    expect(keyA).toEqual(["account", "profile", userA]);
    expect(keyB).toEqual(["account", "profile", userB]);
    expect(keyA).not.toEqual(keyB);
    expect(JSON.stringify([keyA, keyB])).not.toContain(profileA.profile.name);
    expect(accountProfileQueryScope(keyA)).toBe(userA);
    expect(accountProfileQueryScope(["account", "profile"])).toBeUndefined();
  });

  it("rejects a divergent scope before another profile reaches the cache", async () => {
    const queryClient = new QueryClient();
    const keyA = accountQueryKeys.profile(userA);
    queryClient.setQueryData(keyA, profileA);

    await expect(
      queryClient.fetchQuery({
        queryFn: async () => accountProfileForScope(profileB, userA),
        queryKey: keyA,
        staleTime: 0,
      }),
    ).rejects.toThrow("O perfil autoritativo mudou de escopo.");

    expect(queryClient.getQueryData(keyA)).toEqual(profileA);
    expect(queryClient.getQueryData(keyA)).not.toEqual(profileB);
  });

  it("hides the entire profile while a refetch is fetching or paused", async () => {
    const queryClient = new QueryClient();
    queryClient.mount();
    const keyA = accountQueryKeys.profile(userA);
    queryClient.setQueryData(keyA, profileA);
    const observer = new QueryObserver<MyProfileResult>(queryClient, {
      queryFn: async () => profileA,
      queryKey: keyA,
      staleTime: 30_000,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    onlineManager.setOnline(false);
    const pendingRefetch = observer.refetch();

    try {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      const paused = observer.getCurrentResult();
      expect(paused).toMatchObject({ data: profileA, fetchStatus: "paused" });
      expect(accountProfileCanRender(profileA, userA, paused.fetchStatus)).toBe(false);
      expect(accountProfileCanRender(profileA, userA, "fetching")).toBe(false);
      expect(accountProfileCanRender(profileA, userA, "idle")).toBe(true);
    } finally {
      onlineManager.setOnline(true);
      await pendingRefetch;
      unsubscribe();
      queryClient.unmount();
    }
  });

  it("never replaces a newer profile or preference version with a late response", () => {
    const newest = {
      ...profileA,
      profile: {
        ...profileA.profile,
        colorScheme: "dark",
        name: "Pessoa atual",
        preferencesVersion: 3,
        profileVersion: 4,
      },
    } satisfies MyProfileResult;
    const lateIdentity = {
      ...newest,
      profile: { ...newest.profile, name: "Pessoa antiga", profileVersion: 3 },
    } satisfies MyProfileResult;
    const lateAppearance = {
      ...newest,
      profile: { ...newest.profile, colorScheme: "light", preferencesVersion: 2 },
    } satisfies MyProfileResult;

    expect(newestAccountProfileResult(newest, lateIdentity, userA)).toBe(newest);
    expect(newestAccountProfileResult(newest, lateAppearance, userA)).toBe(newest);
    expect(newestAccountProfileResult(profileA, newest, userA)).toBe(newest);
    expect(() => newestAccountProfileResult(profileB, newest, userA)).toThrow(
      "O perfil autoritativo mudou de escopo.",
    );
    expect(() => newestAccountProfileMutationResult(undefined, newest, userA)).toThrow(
      "O perfil autoritativo mudou de escopo.",
    );
  });

  it("reads the cache after an in-flight request resolves", async () => {
    const queryClient = new QueryClient();
    const key = accountQueryKeys.profile(userA);
    queryClient.setQueryData(key, profileA);
    let resolveRead: ((profile: MyProfileResult) => void) | undefined;
    const read = new Promise<MyProfileResult>((resolve) => {
      resolveRead = resolve;
    });
    const pending = readNewestAccountProfileResult(queryClient, userA, async () => read);
    const newer = {
      ...profileA,
      profile: { ...profileA.profile, name: "Pessoa atual", profileVersion: 2 },
    } satisfies MyProfileResult;

    queryClient.setQueryData(key, newer);
    resolveRead?.(profileA);

    await expect(pending).resolves.toStrictEqual(newer);
  });

  it("clears profile/session families and every mutation without deleting public cache", async () => {
    const queryClient = new QueryClient();
    const profileKey = accountQueryKeys.profile(userA);
    const sessionKey = identityQueryKeys.session(userA);
    const publicKey = ["public", "legal"] as const;
    queryClient.setQueryData(profileKey, profileA);
    queryClient.setQueryData(sessionKey, { authenticated: true });
    queryClient.setQueryData(ownerQueryKeys.activationStatus(userA), { privateOwner: "full" });
    queryClient.setQueryData(ownerQueryKeys.recipientStatus(userA), { privateOwner: true });
    queryClient.setQueryData(publicKey, { published: true });
    const mutation = queryClient.getMutationCache().build(queryClient, {
      mutationFn: async () => profileB,
    });
    await mutation.execute(undefined);
    expect(queryClient.getMutationCache().getAll()).toHaveLength(1);

    clearIdentityAndAccountQueryCache(queryClient);

    expect(queryClient.getQueryData(profileKey)).toBeUndefined();
    expect(queryClient.getQueryData(sessionKey)).toBeUndefined();
    expect(queryClient.getQueryData(ownerQueryKeys.activationStatus(userA))).toBeUndefined();
    expect(queryClient.getQueryData(ownerQueryKeys.recipientStatus(userA))).toBeUndefined();
    expect(queryClient.getQueryData(publicKey)).toEqual({ published: true });
    expect(queryClient.getMutationCache().getAll()).toEqual([]);
  });

  it("clears mutations and both private families before every authoritative reseed", async () => {
    const queryClient = new QueryClient();
    const publicKey = ["public", "legal"] as const;
    queryClient.setQueryData(publicKey, { published: true });
    queryClient.setQueryData(accountQueryKeys.profile(userA), profileA);
    queryClient.setQueryData(identityQueryKeys.session(userA), { authenticated: true });
    const firstMutation = queryClient.getMutationCache().build(queryClient, {
      mutationFn: async () => profileA,
    });
    await firstMutation.execute(undefined);

    seedAuthoritativeAccountProfile(queryClient, userB, profileB);

    expect(queryClient.getMutationCache().getAll()).toEqual([]);
    expect(queryClient.getQueryData(accountQueryKeys.profile(userA))).toBeUndefined();
    expect(queryClient.getQueryData(identityQueryKeys.session(userA))).toBeUndefined();
    expect(queryClient.getQueryData(accountQueryKeys.profile(userB))).toEqual(profileB);
    expect(queryClient.getQueryData(publicKey)).toEqual({ published: true });

    const secondMutation = queryClient.getMutationCache().build(queryClient, {
      mutationFn: async () => sessionB,
    });
    await secondMutation.execute(undefined);
    queryClient.setQueryData(accountQueryKeys.profile(userA), profileA);

    seedAuthoritativeIdentitySession(queryClient, sessionB);

    expect(queryClient.getMutationCache().getAll()).toEqual([]);
    expect(queryClient.getQueryData(accountQueryKeys.profile(userA))).toBeUndefined();
    expect(queryClient.getQueryData(accountQueryKeys.profile(userB))).toBeUndefined();
    expect(queryClient.getQueryData(identityQueryKeys.session(userB))).toEqual(sessionB);
    expect(queryClient.getQueryData(publicKey)).toEqual({ published: true });
  });

  it("publishes a mutation result through the active profile query without detaching its observer", async () => {
    const queryClient = new QueryClient();
    const key = accountQueryKeys.profile(userA);
    const publicKey = ["public", "legal"] as const;
    queryClient.setQueryData(key, profileA);
    queryClient.setQueryData(identityQueryKeys.session(userA), sessionA);
    queryClient.setQueryData(publicKey, { published: true });
    const mutation = queryClient.getMutationCache().build(queryClient, {
      mutationFn: async () => profileA,
    });
    await mutation.execute(undefined);
    const observer = new QueryObserver<MyProfileResult>(queryClient, {
      queryFn: async () => profileA,
      queryKey: key,
      staleTime: 30_000,
    });
    const observed: MyProfileResult[] = [];
    const unsubscribe = observer.subscribe((result) => {
      if (result.data !== undefined) observed.push(result.data);
    });
    const updated = {
      ...profileA,
      profile: { ...profileA.profile, name: "Pessoa A atual", profileVersion: 2 },
    } satisfies MyProfileResult;

    publishAuthoritativeAccountProfile(queryClient, userA, updated, sessionA);

    expect(observer.getCurrentResult().data).toEqual(updated);
    expect(observed.at(-1)).toEqual(updated);
    expect(queryClient.getMutationCache().getAll()).toEqual([]);
    expect(queryClient.getQueryData(identityQueryKeys.session(userA))).toEqual(sessionA);
    expect(queryClient.getQueryData(publicKey)).toEqual({ published: true });
    unsubscribe();
  });

  it("does not republish A when an in-flight mutation resolves after authoritative reseed B", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(accountQueryKeys.profile(userA), profileA);
    let resolveMutation: ((profile: MyProfileResult) => void) | undefined;
    const remoteResult = new Promise<MyProfileResult>((resolve) => {
      resolveMutation = resolve;
    });
    let transitionStarted = false;
    const mutationObserver = new MutationObserver(queryClient, {
      mutationFn: async () => remoteResult,
      networkMode: "always",
      onSuccess: (result) => {
        try {
          publishNewestAccountProfileMutationResult(queryClient, userA, result);
        } catch {
          transitionStarted = true;
        }
      },
    });

    const pending = mutationObserver.mutate(undefined);
    expect(queryClient.getMutationCache().getAll()).toHaveLength(1);

    seedAuthoritativeAccountProfile(queryClient, userB, profileB);
    expect(queryClient.getMutationCache().getAll()).toEqual([]);
    expect(queryClient.getQueryData(accountQueryKeys.profile(userA))).toBeUndefined();
    expect(queryClient.getQueryData(accountQueryKeys.profile(userB))).toEqual(profileB);

    resolveMutation?.(profileA);
    await expect(pending).resolves.toEqual(profileA);

    expect(transitionStarted).toBe(true);
    expect(queryClient.getQueryData(accountQueryKeys.profile(userA))).toBeUndefined();
    expect(queryClient.getQueryData(accountQueryKeys.profile(userB))).toEqual(profileB);
  });
});

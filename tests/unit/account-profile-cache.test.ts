import type { MyProfileResult } from "@set-livre/contracts";
import { onlineManager, QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import {
  accountProfileCanRender,
  accountProfileForScope,
  accountProfileQueryScope,
  accountQueryKeys,
  clearIdentityAndAccountQueryCache,
  newestAccountProfileResult,
  readNewestAccountProfileResult,
} from "../../src/domains/identity/components/account-query-keys";
import { identityQueryKeys } from "../../src/domains/identity/components/identity-query-keys";

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
    queryClient.setQueryData(publicKey, { published: true });
    const mutation = queryClient.getMutationCache().build(queryClient, {
      mutationFn: async () => profileB,
    });
    await mutation.execute(undefined);
    expect(queryClient.getMutationCache().getAll()).toHaveLength(1);

    clearIdentityAndAccountQueryCache(queryClient);

    expect(queryClient.getQueryData(profileKey)).toBeUndefined();
    expect(queryClient.getQueryData(sessionKey)).toBeUndefined();
    expect(queryClient.getQueryData(publicKey)).toEqual({ published: true });
    expect(queryClient.getMutationCache().getAll()).toEqual([]);
  });
});

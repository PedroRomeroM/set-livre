import type { IdentitySession } from "@set-livre/contracts";
import { onlineManager, QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import {
  identityQueryKeys,
  identitySessionCanRender,
  identitySessionForScope,
  identitySessionQueryScope,
  identitySessionScope,
} from "../../src/domains/identity/components/identity-query-keys";

const userA = {
  authenticated: true,
  email: "user-a@example.test",
  personType: "individual",
  profileCompleted: false,
  status: "active",
  userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
} satisfies IdentitySession;

const userB = {
  authenticated: true,
  email: "user-b@example.test",
  personType: "company",
  profileCompleted: true,
  status: "active",
  userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
} satisfies IdentitySession;

const userANewSession = {
  ...userA,
  email: "user-a-current@example.test",
  status: "suspended",
} satisfies IdentitySession;

const userANextRscSession = {
  ...userANewSession,
  email: "user-a-next-rsc@example.test",
  profileCompleted: true,
} satisfies IdentitySession;

describe("identity session cache", () => {
  it("isolates authenticated users without putting their e-mail in the query key", () => {
    const userAKey = identityQueryKeys.session(identitySessionScope(userA));
    const userBKey = identityQueryKeys.session(identitySessionScope(userB));

    expect(userAKey).toEqual(["identity", "session", userA.userId]);
    expect(userBKey).toEqual(["identity", "session", userB.userId]);
    expect(userAKey).not.toEqual(userBKey);
    expect(JSON.stringify([userAKey, userBKey])).not.toContain("@example.test");
    expect(identityQueryKeys.session(identitySessionScope({ authenticated: false }))).toEqual([
      "identity",
      "session",
      "anonymous",
    ]);
  });

  it("does not let a prior user override current SSR initial data", async () => {
    const queryClient = new QueryClient();
    const userAKey = identityQueryKeys.session(identitySessionScope(userA));
    const userBKey = identityQueryKeys.session(identitySessionScope(userB));
    queryClient.setQueryData(userAKey, userA);

    const observedSession = await queryClient.fetchQuery({
      initialData: userB,
      queryFn: async () => userB,
      queryKey: userBKey,
      staleTime: 30_000,
    });

    expect(observedSession).toEqual(userB);
    expect(queryClient.getQueryData(userAKey)).toEqual(userA);
  });

  it("replaces a fresh cache entry when SSR returns a new session for the same user", async () => {
    const queryClient = new QueryClient();
    const userAScope = identitySessionScope(userA);
    const userAKey = identityQueryKeys.session(userAScope);
    queryClient.setQueryData(userAKey, userA);
    const preexistingQuery = queryClient.getQueryCache().find({ exact: true, queryKey: userAKey });

    const ignoredInitialSession = await queryClient.fetchQuery({
      initialData: userANewSession,
      queryFn: async () => userANewSession,
      queryKey: userAKey,
      staleTime: 30_000,
    });
    expect(ignoredInitialSession).toEqual(userA);
    const staleObserver = new QueryObserver<IdentitySession>(queryClient, {
      initialData: userANewSession,
      queryFn: async () => userANewSession,
      queryKey: userAKey,
      staleTime: 30_000,
    });
    const unsubscribeStaleObserver = staleObserver.subscribe(() => undefined);
    expect(staleObserver.getCurrentResult().data).toEqual(userA);

    unsubscribeStaleObserver();
    queryClient.removeQueries({ queryKey: identityQueryKeys.sessions });
    queryClient.setQueryData(userAKey, userANewSession);
    const preparedQuery = queryClient.getQueryCache().find({ exact: true, queryKey: userAKey });
    expect(preparedQuery).not.toBe(preexistingQuery);
    expect(queryClient.getQueryData(userAKey)).toEqual(userANewSession);
    const preparedObserver = new QueryObserver<IdentitySession>(queryClient, {
      initialData: userANewSession,
      queryFn: async () => userANewSession,
      queryKey: userAKey,
      staleTime: 30_000,
    });
    const unsubscribePreparedObserver = preparedObserver.subscribe(() => undefined);
    expect(preparedObserver.getCurrentResult().data).toBe(queryClient.getQueryData(userAKey));
    expect(identitySessionCanRender(userANewSession, userAScope, "idle")).toBe(true);

    queryClient.setQueryData(userAKey, userA);
    expect(preparedObserver.getCurrentResult().data).toBe(queryClient.getQueryData(userAKey));

    const preexistingAtNextRsc = queryClient
      .getQueryCache()
      .find({ exact: true, queryKey: userAKey });
    unsubscribePreparedObserver();
    queryClient.removeQueries({ queryKey: identityQueryKeys.sessions });
    queryClient.setQueryData(userAKey, userANextRscSession);
    const queryAfterNextRsc = queryClient.getQueryCache().find({ exact: true, queryKey: userAKey });
    expect(queryAfterNextRsc).not.toBe(preexistingAtNextRsc);
    expect(queryClient.getQueryData(userAKey)).toEqual(userANextRscSession);
    const observerAfterNextRsc = new QueryObserver<IdentitySession>(queryClient, {
      initialData: userANextRscSession,
      queryFn: async () => userANextRscSession,
      queryKey: userAKey,
      staleTime: 30_000,
    });
    const unsubscribeAfterNextRsc = observerAfterNextRsc.subscribe(() => undefined);
    expect(observerAfterNextRsc.getCurrentResult().data).toBe(queryClient.getQueryData(userAKey));
    unsubscribeAfterNextRsc();
  });

  it("fails closed while refetching and when the authoritative user changes", async () => {
    const queryClient = new QueryClient();
    const userAScope = identitySessionScope(userA);
    const userAKey = identityQueryKeys.session(userAScope);
    queryClient.setQueryData(userAKey, userA);

    let resolveRefetch: ((session: IdentitySession) => void) | undefined;
    const refetchResponse = new Promise<IdentitySession>((resolve) => {
      resolveRefetch = resolve;
    });
    const observer = new QueryObserver<IdentitySession>(queryClient, {
      queryFn: async () => refetchResponse,
      queryKey: userAKey,
      staleTime: 30_000,
    });
    const unsubscribe = observer.subscribe(() => undefined);

    const pendingRefetch = observer.refetch();
    const duringRefetch = observer.getCurrentResult();
    expect(duringRefetch.data).toEqual(userA);
    expect(duringRefetch.isFetching).toBe(true);
    expect(identitySessionCanRender(userA, userAScope, duringRefetch.fetchStatus)).toBe(false);

    resolveRefetch?.(userB);
    await pendingRefetch;
    const afterRefetch = observer.getCurrentResult();
    expect(afterRefetch.data).toEqual(userB);
    expect(identitySessionCanRender(userB, userAScope, afterRefetch.fetchStatus)).toBe(false);
    unsubscribe();
  });

  it("rejects a scope change before another user's payload enters the cache", async () => {
    const queryClient = new QueryClient();
    const userAScope = identitySessionScope(userA);
    const userAKey = identityQueryKeys.session(userAScope);
    queryClient.setQueryData(userAKey, userA);

    await expect(
      queryClient.fetchQuery({
        queryFn: async () => identitySessionForScope(userB, userAScope),
        queryKey: userAKey,
        staleTime: 0,
      }),
    ).rejects.toThrow("A sessão autoritativa mudou de escopo.");

    expect(queryClient.getQueryData(userAKey)).toEqual(userA);
    expect(queryClient.getQueryData(userAKey)).not.toEqual(userB);
  });

  it("keeps private session data hidden while an offline refetch is paused", async () => {
    const queryClient = new QueryClient();
    queryClient.mount();
    const userAScope = identitySessionScope(userA);
    const userAKey = identityQueryKeys.session(userAScope);
    queryClient.setQueryData(userAKey, userA);
    const observer = new QueryObserver<IdentitySession>(queryClient, {
      queryFn: async () => userA,
      queryKey: userAKey,
      staleTime: 30_000,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    onlineManager.setOnline(false);
    const pendingRefetch = observer.refetch();

    try {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      const pausedRefetch = observer.getCurrentResult();
      expect(pausedRefetch).toMatchObject({
        data: userA,
        fetchStatus: "paused",
        isFetching: false,
        status: "success",
      });
      expect(identitySessionCanRender(userA, userAScope, pausedRefetch.fetchStatus)).toBe(false);
    } finally {
      onlineManager.setOnline(true);
      await pendingRefetch;
      unsubscribe();
      queryClient.unmount();
    }
  });

  it("removes every previous session scope while preserving the selected scope", () => {
    const queryClient = new QueryClient();
    const userAKey = identityQueryKeys.session(identitySessionScope(userA));
    const userBScope = identitySessionScope(userB);
    const userBKey = identityQueryKeys.session(userBScope);
    const unrelatedKey = ["public", "legal"] as const;
    queryClient.setQueryData(userAKey, userA);
    queryClient.setQueryData(userBKey, userB);
    queryClient.setQueryData(unrelatedKey, { published: true });

    queryClient.removeQueries({
      predicate: (query) => identitySessionQueryScope(query.queryKey) !== userBScope,
      queryKey: identityQueryKeys.sessions,
    });

    expect(queryClient.getQueryData(userAKey)).toBeUndefined();
    expect(queryClient.getQueryData(userBKey)).toEqual(userB);
    expect(queryClient.getQueryData(unrelatedKey)).toEqual({ published: true });

    queryClient.removeQueries({ queryKey: identityQueryKeys.sessions });
    expect(queryClient.getQueryData(userBKey)).toBeUndefined();
  });
});

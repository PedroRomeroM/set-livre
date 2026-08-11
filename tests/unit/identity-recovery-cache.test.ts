import {
  identityRecoveryStatusResultSchema,
  type IdentityRecoverySessionScope,
  type IdentityRecoveryStatusResult,
} from "@set-livre/contracts";
import { onlineManager, QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import {
  identityQueryKeys,
  identityRecoveryQueryScope,
  identityRecoveryStatusCanAuthorize,
  identityRecoveryStatusForScope,
} from "../../src/domains/identity/components/identity-query-keys";

const recoveryScopeA =
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" satisfies IdentityRecoverySessionScope;
const recoveryScopeB =
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" satisfies IdentityRecoverySessionScope;
const allowedScopeA = {
  allowed: true,
  scope: recoveryScopeA,
} satisfies IdentityRecoveryStatusResult;

describe("identity recovery authorization cache", () => {
  it("accepts only the decision and an opaque non-secret scope at the API boundary", () => {
    expect(identityRecoveryStatusResultSchema.safeParse(allowedScopeA).success).toBe(true);
    expect(
      identityRecoveryStatusResultSchema.safeParse({
        ...allowedScopeA,
        grant: "private-grant-token",
      }).success,
    ).toBe(false);
    expect(
      identityRecoveryStatusResultSchema.safeParse({
        ...allowedScopeA,
        email: "private@example.test",
      }).success,
    ).toBe(false);
    expect(
      identityRecoveryStatusResultSchema.safeParse({
        ...allowedScopeA,
        sessionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      }).success,
    ).toBe(false);
    expect(
      identityRecoveryStatusResultSchema.safeParse({ allowed: true, scope: "not-a-uuid" }).success,
    ).toBe(false);
    expect(
      identityRecoveryStatusResultSchema.safeParse({ allowed: true, scope: "anonymous" }).success,
    ).toBe(false);
  });

  it("isolates opaque recovery sessions without caching the grant, token or PII", () => {
    const queryClient = new QueryClient();
    const scopeAKey = identityQueryKeys.recoveryStatus(recoveryScopeA);
    const scopeBKey = identityQueryKeys.recoveryStatus(recoveryScopeB);
    queryClient.setQueryData(scopeAKey, allowedScopeA);

    expect(scopeAKey).toEqual(["identity", "recovery", "status", recoveryScopeA]);
    expect(scopeBKey).not.toEqual(scopeAKey);
    expect(queryClient.getQueryData(scopeBKey)).toBeUndefined();
    expect(JSON.stringify([scopeAKey, scopeBKey, allowedScopeA])).not.toMatch(
      /@|password|token|grant/iu,
    );
  });

  it("rejects a cookie scope change before its authorization enters the prior cache key", async () => {
    const queryClient = new QueryClient();
    const scopeAKey = identityQueryKeys.recoveryStatus(recoveryScopeA);
    queryClient.setQueryData(scopeAKey, allowedScopeA);

    await expect(
      queryClient.fetchQuery({
        queryFn: async () =>
          identityRecoveryStatusForScope({ allowed: true, scope: recoveryScopeB }, recoveryScopeA),
        queryKey: scopeAKey,
        staleTime: 0,
      }),
    ).rejects.toThrow("A autorização de recuperação mudou de escopo.");

    expect(queryClient.getQueryData(scopeAKey)).toEqual(allowedScopeA);
    expect(
      queryClient.getQueryData(identityQueryKeys.recoveryStatus(recoveryScopeB)),
    ).toBeUndefined();
  });

  it("invalidates every prior marker scope when the SSR marker changes or disappears", () => {
    const queryClient = new QueryClient();
    const scopeAKey = identityQueryKeys.recoveryStatus(recoveryScopeA);
    const scopeBKey = identityQueryKeys.recoveryStatus(recoveryScopeB);
    const anonymousKey = identityQueryKeys.recoveryStatus("anonymous");
    const unrelatedKey = ["public", "legal"] as const;
    queryClient.setQueryData(scopeAKey, allowedScopeA);
    queryClient.setQueryData(scopeBKey, { allowed: true, scope: recoveryScopeB });
    queryClient.setQueryData(anonymousKey, { allowed: false, scope: "anonymous" });
    queryClient.setQueryData(unrelatedKey, { published: true });

    queryClient.removeQueries({
      predicate: (query) => identityRecoveryQueryScope(query.queryKey) !== "anonymous",
      queryKey: identityQueryKeys.recoveryStatuses,
    });

    expect(queryClient.getQueryData(scopeAKey)).toBeUndefined();
    expect(queryClient.getQueryData(scopeBKey)).toBeUndefined();
    expect(queryClient.getQueryData(anonymousKey)).toEqual({
      allowed: false,
      scope: "anonymous",
    });
    expect(queryClient.getQueryData(unrelatedKey)).toEqual({ published: true });
  });

  it("fails closed when a cached allowed status is paused offline with isFetching false", async () => {
    const queryClient = new QueryClient();
    queryClient.mount();
    const scopeAKey = identityQueryKeys.recoveryStatus(recoveryScopeA);
    queryClient.setQueryData(scopeAKey, allowedScopeA);
    onlineManager.setOnline(false);
    const observer = new QueryObserver<IdentityRecoveryStatusResult>(queryClient, {
      queryFn: async () => allowedScopeA,
      queryKey: scopeAKey,
      refetchOnMount: "always",
      staleTime: 0,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    const mountRefetch = observer.getCurrentResult();
    const pendingRefetch = observer.refetch();

    try {
      expect(mountRefetch).toMatchObject({
        data: allowedScopeA,
        fetchStatus: "paused",
        isFetching: false,
        status: "success",
      });
      expect(
        identityRecoveryStatusCanAuthorize(allowedScopeA, recoveryScopeA, mountRefetch.fetchStatus),
      ).toBe(false);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      const pausedRefetch = observer.getCurrentResult();
      expect(pausedRefetch).toMatchObject({
        data: allowedScopeA,
        fetchStatus: "paused",
        isFetching: false,
        status: "success",
      });
      expect(
        identityRecoveryStatusCanAuthorize(
          allowedScopeA,
          recoveryScopeA,
          pausedRefetch.fetchStatus,
        ),
      ).toBe(false);
    } finally {
      onlineManager.setOnline(true);
      await pendingRefetch;
      unsubscribe();
      queryClient.unmount();
    }
  });

  it("fails closed on the first mounted snapshot while a cached allowed status refetches", async () => {
    const queryClient = new QueryClient();
    queryClient.mount();
    onlineManager.setOnline(true);
    const scopeAKey = identityQueryKeys.recoveryStatus(recoveryScopeA);
    queryClient.setQueryData(scopeAKey, allowedScopeA);
    let resolveAuthoritativeStatus: ((status: IdentityRecoveryStatusResult) => void) | undefined;
    const authoritativeStatus = new Promise<IdentityRecoveryStatusResult>((resolve) => {
      resolveAuthoritativeStatus = resolve;
    });
    const observer = new QueryObserver<IdentityRecoveryStatusResult>(queryClient, {
      queryFn: async () => authoritativeStatus,
      queryKey: scopeAKey,
      refetchOnMount: "always",
      staleTime: 0,
    });
    const unsubscribe = observer.subscribe(() => undefined);

    const firstMountedSnapshot = observer.getCurrentResult();
    const pendingRefetch = observer.refetch();
    resolveAuthoritativeStatus?.(allowedScopeA);

    try {
      expect(firstMountedSnapshot).toMatchObject({
        data: allowedScopeA,
        fetchStatus: "fetching",
        isFetching: true,
        status: "success",
      });
      expect(
        identityRecoveryStatusCanAuthorize(
          allowedScopeA,
          recoveryScopeA,
          firstMountedSnapshot.fetchStatus,
        ),
      ).toBe(false);

      await pendingRefetch;
      expect(
        identityRecoveryStatusCanAuthorize(
          allowedScopeA,
          recoveryScopeA,
          observer.getCurrentResult().fetchStatus,
        ),
      ).toBe(true);
    } finally {
      await pendingRefetch;
      unsubscribe();
      queryClient.unmount();
    }
  });

  it("authorizes only an allowed, matching and authoritatively idle status", () => {
    expect(identityRecoveryStatusCanAuthorize(allowedScopeA, recoveryScopeA, "idle")).toBe(true);
    expect(identityRecoveryStatusCanAuthorize(allowedScopeA, recoveryScopeA, "fetching")).toBe(
      false,
    );
    expect(identityRecoveryStatusCanAuthorize(allowedScopeA, recoveryScopeA, "paused")).toBe(false);
    expect(identityRecoveryStatusCanAuthorize(allowedScopeA, recoveryScopeB, "idle")).toBe(false);
    expect(
      identityRecoveryStatusCanAuthorize(
        { allowed: false, scope: recoveryScopeA },
        recoveryScopeA,
        "idle",
      ),
    ).toBe(false);
  });
});

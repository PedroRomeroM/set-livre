import type { MyProfileResult, OwnerRecipientResult } from "@set-livre/contracts";
import { onlineManager, QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  accountQueryKeys,
  clearIdentityAndAccountQueryCache,
  publishNewestAccountProfileMutationResult,
} from "../../src/domains/identity/components/account-query-keys";
import { identityQueryKeys } from "../../src/domains/identity/components/identity-query-keys";
import {
  OwnerRecipientScopeChangedError,
  newestOwnerRecipientMutationResult,
  newestOwnerRecipientResult,
  ownerQueryKeys,
  ownerRecipientCanRender,
  ownerRecipientForScope,
  ownerRecipientQueryScope,
  publishNewestOwnerRecipientMutationResult,
  readNewestOwnerRecipientResult,
  seedAuthoritativeOwnerRecipient,
} from "../../src/domains/owners/components/owner-query-keys";

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
const sessionA = {
  authenticated: true as const,
  email: "qa-owner-cache-a@example.test",
  personType: "individual" as const,
  profileCompleted: true,
  status: "active" as const,
  userId: userA,
};

function ownerResult(
  scope: string,
  overrides: Partial<OwnerRecipientResult> = {},
): OwnerRecipientResult {
  return {
    acceptedOwnerContractVersionId: null,
    nextAction: "activate_owner",
    ownerContract: {
      bodyMarkdown: "# Contrato local\n\nConteúdo.",
      contentHash: "a".repeat(64),
      effectiveAt: "2026-08-12T00:00:00.000Z",
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      kind: "owner_contract",
      source: "local_fixture",
      title: "Contrato local",
      version: "local-1",
    },
    ownerContractAccepted: false,
    ownerStatus: "inactive",
    ownerVersion: 0,
    profileVersion: 1,
    profileVersionSynced: null,
    providerMode: "local",
    recipientStatus: "not_started",
    recipientVersion: 0,
    requirements: [],
    reservationsEligible: false,
    scope,
    ...overrides,
  };
}

describe("owner recipient query cache", () => {
  afterEach(() => {
    onlineManager.setOnline(true);
  });

  it("scopes keys only by authenticated UUID", () => {
    const keyA = ownerQueryKeys.recipientStatus(userA);
    const keyB = ownerQueryKeys.recipientStatus(userB);

    expect(keyA).toEqual(["owner", "recipient", "status", userA]);
    expect(keyB).toEqual(["owner", "recipient", "status", userB]);
    expect(keyA).not.toEqual(keyB);
    expect(ownerRecipientQueryScope(keyA)).toBe(userA);
    expect(ownerRecipientQueryScope(ownerQueryKeys.recipientStatuses)).toBeUndefined();
  });

  it("rejects scope B before it can enter the key of A", async () => {
    const queryClient = new QueryClient();
    const resultA = ownerResult(userA);
    const resultB = ownerResult(userB);
    queryClient.setQueryData(ownerQueryKeys.recipientStatus(userA), resultA);

    await expect(
      queryClient.fetchQuery({
        queryFn: async () => ownerRecipientForScope(resultB, userA),
        queryKey: ownerQueryKeys.recipientStatus(userA),
        staleTime: 0,
      }),
    ).rejects.toBeInstanceOf(OwnerRecipientScopeChangedError);
    expect(queryClient.getQueryData(ownerQueryKeys.recipientStatus(userA))).toEqual(resultA);
  });

  it("hides the result during fetching and paused offline states", async () => {
    const queryClient = new QueryClient();
    queryClient.mount();
    const resultA = ownerResult(userA);
    const observer = new QueryObserver<OwnerRecipientResult>(queryClient, {
      queryFn: async () => resultA,
      queryKey: ownerQueryKeys.recipientStatus(userA),
      staleTime: 30_000,
    });
    queryClient.setQueryData(ownerQueryKeys.recipientStatus(userA), resultA);
    const unsubscribe = observer.subscribe(() => undefined);
    onlineManager.setOnline(false);
    const pendingRefetch = observer.refetch();

    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const paused = observer.getCurrentResult();
      expect(paused.fetchStatus).toBe("paused");
      expect(ownerRecipientCanRender(resultA, userA, paused.fetchStatus)).toBe(false);
      expect(ownerRecipientCanRender(resultA, userA, "fetching")).toBe(false);
      expect(ownerRecipientCanRender(resultA, userA, "idle")).toBe(true);
    } finally {
      onlineManager.setOnline(true);
      await pendingRefetch;
      unsubscribe();
      queryClient.unmount();
    }
  });

  it("keeps monotonic owner, profile and recipient versions", () => {
    const current = ownerResult(userA, {
      ownerStatus: "active",
      ownerVersion: 3,
      profileVersion: 4,
      profileVersionSynced: 4,
      recipientStatus: "active",
      recipientVersion: 5,
      reservationsEligible: true,
    });
    const lateOwner = ownerResult(userA, { ...current, ownerVersion: 2 });
    const lateProfile = ownerResult(userA, { ...current, profileVersion: 3 });
    const lateRecipient = ownerResult(userA, { ...current, recipientVersion: 4 });

    expect(newestOwnerRecipientResult(current, lateOwner, userA)).toBe(current);
    expect(newestOwnerRecipientResult(current, lateProfile, userA)).toBe(current);
    expect(newestOwnerRecipientResult(current, lateRecipient, userA)).toBe(current);
    expect(() => newestOwnerRecipientMutationResult(undefined, current, userA)).toThrow(
      OwnerRecipientScopeChangedError,
    );
  });

  it("reads the cache after an in-flight response resolves", async () => {
    const queryClient = new QueryClient();
    const initial = ownerResult(userA);
    const newer = ownerResult(userA, { ownerStatus: "active", ownerVersion: 1 });
    queryClient.setQueryData(ownerQueryKeys.recipientStatus(userA), initial);
    let resolveRead: ((result: OwnerRecipientResult) => void) | undefined;
    const read = new Promise<OwnerRecipientResult>((resolve) => {
      resolveRead = resolve;
    });
    const pending = readNewestOwnerRecipientResult(queryClient, userA, async () => read);

    queryClient.setQueryData(ownerQueryKeys.recipientStatus(userA), newer);
    resolveRead?.(initial);

    await expect(pending).resolves.toStrictEqual(newer);
  });

  it("preserves the last snapshot after a provider failure until one read verifies state", async () => {
    const queryClient = new QueryClient();
    const snapshot = ownerResult(userA, {
      acceptedOwnerContractVersionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      nextAction: "refresh_status",
      ownerContractAccepted: true,
      ownerStatus: "active",
      ownerVersion: 1,
      recipientStatus: "pending",
      recipientVersion: 1,
    });
    queryClient.setQueryData(ownerQueryKeys.recipientStatus(userA), snapshot);
    const postCommand = vi.fn(async () => {
      throw new Error("safe provider unavailable");
    });
    const getStatus = vi.fn(async () => snapshot);

    await expect(postCommand()).rejects.toThrow("safe provider unavailable");
    expect(queryClient.getQueryData(ownerQueryKeys.recipientStatus(userA))).toEqual(snapshot);

    await expect(readNewestOwnerRecipientResult(queryClient, userA, getStatus)).resolves.toEqual(
      snapshot,
    );
    expect(postCommand).toHaveBeenCalledOnce();
    expect(getStatus).toHaveBeenCalledOnce();
  });

  it("seeds owner state after clearing owner mutations/scopes and preserves public cache", async () => {
    const queryClient = new QueryClient();
    const publicKey = ["public", "legal"] as const;
    queryClient.setQueryData(publicKey, { published: true });
    queryClient.setQueryData(ownerQueryKeys.recipientStatus(userB), ownerResult(userB));
    const mutation = queryClient.getMutationCache().build(queryClient, {
      mutationFn: async () => ownerResult(userA),
    });
    await mutation.execute(undefined);

    seedAuthoritativeOwnerRecipient(queryClient, userA, ownerResult(userA));

    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
    expect(queryClient.getQueryData(ownerQueryKeys.recipientStatus(userB))).toBeUndefined();
    expect(queryClient.getQueryData(ownerQueryKeys.recipientStatus(userA))).toEqual(
      ownerResult(userA),
    );
    expect(queryClient.getQueryData(publicKey)).toEqual({ published: true });
  });

  it("a late mutation from A cannot recreate its key after B is seeded", () => {
    const queryClient = new QueryClient();
    const resultA = ownerResult(userA);
    const resultB = ownerResult(userB);
    seedAuthoritativeOwnerRecipient(queryClient, userA, resultA);

    seedAuthoritativeOwnerRecipient(queryClient, userB, resultB);

    expect(() => publishNewestOwnerRecipientMutationResult(queryClient, userA, resultA)).toThrow(
      OwnerRecipientScopeChangedError,
    );
    expect(queryClient.getQueryData(ownerQueryKeys.recipientStatus(userA))).toBeUndefined();
    expect(queryClient.getQueryData(ownerQueryKeys.recipientStatus(userB))).toEqual(resultB);
  });

  it("clears the owner family with private identity cache and preserves public cache", () => {
    const queryClient = new QueryClient();
    const publicKey = ["public", "legal"] as const;
    queryClient.setQueryData(publicKey, { published: true });
    queryClient.setQueryData(accountQueryKeys.profile(userA), profileA);
    queryClient.setQueryData(identityQueryKeys.session(userA), sessionA);
    queryClient.setQueryData(ownerQueryKeys.recipientStatus(userA), ownerResult(userA));

    clearIdentityAndAccountQueryCache(queryClient);

    expect(queryClient.getQueryData(accountQueryKeys.profile(userA))).toBeUndefined();
    expect(queryClient.getQueryData(identityQueryKeys.session(userA))).toBeUndefined();
    expect(queryClient.getQueryData(ownerQueryKeys.recipientStatus(userA))).toBeUndefined();
    expect(queryClient.getQueryData(publicKey)).toEqual({ published: true });
  });

  it("profile publication invalidates only its scoped owner key without creating another", () => {
    const queryClient = new QueryClient();
    const publicKey = ["public", "legal"] as const;
    queryClient.setQueryData(publicKey, { published: true });
    queryClient.setQueryData(accountQueryKeys.profile(userA), profileA);
    queryClient.setQueryData(identityQueryKeys.session(userA), sessionA);
    queryClient.setQueryData(ownerQueryKeys.recipientStatus(userA), ownerResult(userA));
    queryClient.setQueryData(ownerQueryKeys.recipientStatus(userB), ownerResult(userB));

    expect(publishNewestAccountProfileMutationResult(queryClient, userA, profileA)).toBe(true);

    expect(queryClient.getQueryData(accountQueryKeys.profile(userA))).toEqual(profileA);
    expect(queryClient.getQueryData(identityQueryKeys.session(userA))).toEqual(sessionA);
    expect(queryClient.getQueryState(ownerQueryKeys.recipientStatus(userA))?.isInvalidated).toBe(
      true,
    );
    expect(queryClient.getQueryState(ownerQueryKeys.recipientStatus(userB))?.isInvalidated).toBe(
      false,
    );
    expect(queryClient.getQueryData(publicKey)).toEqual({ published: true });

    const emptyOwnerClient = new QueryClient();
    emptyOwnerClient.setQueryData(accountQueryKeys.profile(userA), profileA);
    emptyOwnerClient.setQueryData(identityQueryKeys.session(userA), sessionA);

    expect(publishNewestAccountProfileMutationResult(emptyOwnerClient, userA, profileA)).toBe(true);
    expect(emptyOwnerClient.getQueryData(ownerQueryKeys.recipientStatus(userA))).toBeUndefined();
  });
});

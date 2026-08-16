import type {
  MyProfileResult,
  OwnerActivationResult,
  OwnerRecipientStatus,
} from "@set-livre/contracts";
import { onlineManager, QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  accountQueryKeys,
  clearIdentityAndAccountQueryCache,
  publishNewestAccountProfileMutationResult,
} from "../../src/domains/identity/components/account-query-keys";
import { identityQueryKeys } from "../../src/domains/identity/components/identity-query-keys";
import {
  OwnerPrivateScopeChangedError,
  newestOwnerPrivateMutationResult,
  newestOwnerPrivateResult,
  ownerPrivateCanRender,
  ownerPrivateForBoundary,
  ownerPrivateQueryScope,
  ownerQueryKeys,
  publishNewestOwnerPrivateMutationResult,
  readNewestOwnerPrivateResult,
  seedAuthoritativeOwnerPrivate,
} from "../../src/domains/owners/components/owner-query-keys";

const userA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const userB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const contractId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
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

function activationResult(
  scope: string,
  overrides: Partial<OwnerActivationResult> = {},
): OwnerActivationResult {
  return {
    acceptedOwnerContractVersionId: null,
    nextAction: "activate_owner",
    ownerActivationCapability: "available",
    ownerContract: {
      bodyMarkdown: "# Contrato local\n\nConteúdo.",
      contentHash: "a".repeat(64),
      effectiveAt: "2026-08-12T00:00:00.000Z",
      id: contractId,
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
    projection: "activation",
    providerMode: "local",
    recipientOnboardingCapability: "local_adapter",
    recipientStatus: "not_started",
    recipientVersion: 0,
    requirements: [],
    reservationsEligible: false,
    scope,
    ...overrides,
  };
}

function recipientResult(
  scope: string,
  overrides: Partial<OwnerRecipientStatus> = {},
): OwnerRecipientStatus {
  return {
    acceptedOwnerContractVersionId: null,
    nextAction: "activate_owner",
    ownerContract: {
      effectiveAt: "2026-08-12T00:00:00.000Z",
      id: contractId,
      source: "local_fixture",
    },
    ownerContractAccepted: false,
    ownerStatus: "inactive",
    ownerVersion: 0,
    profileVersion: 1,
    profileVersionSynced: null,
    projection: "recipient",
    providerMode: "local",
    recipientOnboardingCapability: "local_adapter",
    recipientStatus: "not_started",
    recipientVersion: 0,
    requirements: [],
    reservationsEligible: false,
    scope,
    ...overrides,
  };
}

describe("owner private query cache", () => {
  afterEach(() => {
    onlineManager.setOnline(true);
  });

  it("separates activation and recipient projections under one scoped private root", () => {
    const activationKey = ownerQueryKeys.activationStatus(userA);
    const recipientKey = ownerQueryKeys.recipientStatus(userA);

    expect(activationKey).toEqual(["owner", "private", "activation", userA]);
    expect(recipientKey).toEqual(["owner", "private", "recipient", userA]);
    expect(activationKey).not.toEqual(recipientKey);
    expect(ownerPrivateQueryScope(activationKey)).toBe(userA);
    expect(ownerPrivateQueryScope(recipientKey)).toBe(userA);
    expect(ownerPrivateQueryScope(ownerQueryKeys.privateResults)).toBeUndefined();
  });

  it("rejects scope or projection drift before it can enter another private key", async () => {
    const queryClient = new QueryClient();
    const resultA = activationResult(userA);
    queryClient.setQueryData(ownerQueryKeys.activationStatus(userA), resultA);

    await expect(
      queryClient.fetchQuery({
        queryFn: async () => ownerPrivateForBoundary(activationResult(userB), userA, "activation"),
        queryKey: ownerQueryKeys.activationStatus(userA),
        staleTime: 0,
      }),
    ).rejects.toBeInstanceOf(OwnerPrivateScopeChangedError);
    expect(() => ownerPrivateForBoundary(recipientResult(userA), userA, "activation")).toThrow(
      OwnerPrivateScopeChangedError,
    );
    expect(queryClient.getQueryData(ownerQueryKeys.activationStatus(userA))).toEqual(resultA);
  });

  it("hides the complete projection during fetching and paused offline states", async () => {
    const queryClient = new QueryClient();
    queryClient.mount();
    const resultA = activationResult(userA);
    const observer = new QueryObserver<OwnerActivationResult>(queryClient, {
      queryFn: async () => resultA,
      queryKey: ownerQueryKeys.activationStatus(userA),
      staleTime: 30_000,
    });
    queryClient.setQueryData(ownerQueryKeys.activationStatus(userA), resultA);
    const unsubscribe = observer.subscribe(() => undefined);
    onlineManager.setOnline(false);
    const pendingRefetch = observer.refetch();

    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const paused = observer.getCurrentResult();
      expect(paused.fetchStatus).toBe("paused");
      expect(ownerPrivateCanRender(resultA, userA, "activation", paused.fetchStatus)).toBe(false);
      expect(ownerPrivateCanRender(resultA, userA, "activation", "fetching")).toBe(false);
      expect(ownerPrivateCanRender(resultA, userA, "activation", "idle")).toBe(true);
    } finally {
      onlineManager.setOnline(true);
      await pendingRefetch;
      unsubscribe();
      queryClient.unmount();
    }
  });

  it("keeps owner, profile, recipient and contract versions monotonic per projection", () => {
    const current = activationResult(userA, {
      acceptedOwnerContractVersionId: contractId,
      nextAction: "none",
      ownerContractAccepted: true,
      ownerStatus: "active",
      ownerVersion: 3,
      profileVersion: 4,
      profileVersionSynced: 4,
      recipientStatus: "active",
      recipientVersion: 5,
      reservationsEligible: true,
    });
    const lateOwner = activationResult(userA, { ...current, ownerVersion: 2 });
    const lateProfile = activationResult(userA, { ...current, profileVersion: 3 });
    const lateRecipient = activationResult(userA, { ...current, recipientVersion: 4 });

    expect(newestOwnerPrivateResult(current, lateOwner, userA, "activation")).toBe(current);
    expect(newestOwnerPrivateResult(current, lateProfile, userA, "activation")).toBe(current);
    expect(newestOwnerPrivateResult(current, lateRecipient, userA, "activation")).toBe(current);
    expect(() => newestOwnerPrivateMutationResult(undefined, current, userA, "activation")).toThrow(
      OwnerPrivateScopeChangedError,
    );
  });

  it("reads the active projection cache after an in-flight response resolves", async () => {
    const queryClient = new QueryClient();
    const initial = activationResult(userA);
    const newer = activationResult(userA, {
      acceptedOwnerContractVersionId: contractId,
      nextAction: "start_onboarding",
      ownerContractAccepted: true,
      ownerStatus: "active",
      ownerVersion: 1,
    });
    queryClient.setQueryData(ownerQueryKeys.activationStatus(userA), initial);
    let resolveRead: ((result: OwnerActivationResult) => void) | undefined;
    const read = new Promise<OwnerActivationResult>((resolve) => {
      resolveRead = resolve;
    });
    const pending = readNewestOwnerPrivateResult(
      queryClient,
      userA,
      "activation",
      async () => read,
    );

    queryClient.setQueryData(ownerQueryKeys.activationStatus(userA), newer);
    resolveRead?.(initial);

    await expect(pending).resolves.toStrictEqual(newer);
  });

  it("preserves recipient state after a command failure until one GET verifies it", async () => {
    const queryClient = new QueryClient();
    const snapshot = recipientResult(userA, {
      acceptedOwnerContractVersionId: contractId,
      nextAction: "refresh_status",
      ownerContractAccepted: true,
      ownerStatus: "active",
      ownerVersion: 1,
      profileVersionSynced: 1,
      recipientStatus: "pending",
      recipientVersion: 1,
      requirements: ["identity_review"],
    });
    queryClient.setQueryData(ownerQueryKeys.recipientStatus(userA), snapshot);
    const postCommand = vi.fn(async () => {
      throw new Error("safe provider unavailable");
    });
    const getStatus = vi.fn(async () => snapshot);

    await expect(postCommand()).rejects.toThrow("safe provider unavailable");
    expect(queryClient.getQueryData(ownerQueryKeys.recipientStatus(userA))).toEqual(snapshot);
    await expect(
      readNewestOwnerPrivateResult(queryClient, userA, "recipient", getStatus),
    ).resolves.toEqual(snapshot);
    expect(postCommand).toHaveBeenCalledOnce();
    expect(getStatus).toHaveBeenCalledOnce();
  });

  it("seeds one authoritative projection after clearing every private projection and mutation", async () => {
    const queryClient = new QueryClient();
    const publicKey = ["public", "legal"] as const;
    queryClient.setQueryData(publicKey, { published: true });
    queryClient.setQueryData(ownerQueryKeys.activationStatus(userB), activationResult(userB));
    queryClient.setQueryData(ownerQueryKeys.recipientStatus(userB), recipientResult(userB));
    const mutation = queryClient.getMutationCache().build(queryClient, {
      mutationFn: async () => activationResult(userA),
    });
    await mutation.execute(undefined);

    seedAuthoritativeOwnerPrivate(queryClient, userA, "recipient", recipientResult(userA));

    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
    expect(queryClient.getQueryData(ownerQueryKeys.activationStatus(userB))).toBeUndefined();
    expect(queryClient.getQueryData(ownerQueryKeys.recipientStatus(userB))).toBeUndefined();
    expect(queryClient.getQueryData(ownerQueryKeys.recipientStatus(userA))).toEqual(
      recipientResult(userA),
    );
    expect(queryClient.getQueryData(publicKey)).toEqual({ published: true });
  });

  it("does not let a slim result replace the full activation cache", () => {
    const queryClient = new QueryClient();
    const full = activationResult(userA);
    seedAuthoritativeOwnerPrivate(queryClient, userA, "activation", full);

    expect(() =>
      publishNewestOwnerPrivateMutationResult(
        queryClient,
        userA,
        "activation",
        recipientResult(userA),
      ),
    ).toThrow(OwnerPrivateScopeChangedError);
    expect(queryClient.getQueryData(ownerQueryKeys.activationStatus(userA))).toEqual(full);
  });

  it("a late mutation from A cannot recreate its key after B is seeded", () => {
    const queryClient = new QueryClient();
    const resultA = recipientResult(userA);
    const resultB = recipientResult(userB);
    seedAuthoritativeOwnerPrivate(queryClient, userA, "recipient", resultA);
    seedAuthoritativeOwnerPrivate(queryClient, userB, "recipient", resultB);

    expect(() =>
      publishNewestOwnerPrivateMutationResult(queryClient, userA, "recipient", resultA),
    ).toThrow(OwnerPrivateScopeChangedError);
    expect(queryClient.getQueryData(ownerQueryKeys.recipientStatus(userA))).toBeUndefined();
    expect(queryClient.getQueryData(ownerQueryKeys.recipientStatus(userB))).toEqual(resultB);
  });

  it("clears both owner projections with private identity cache and preserves public cache", () => {
    const queryClient = new QueryClient();
    const publicKey = ["public", "legal"] as const;
    queryClient.setQueryData(publicKey, { published: true });
    queryClient.setQueryData(accountQueryKeys.profile(userA), profileA);
    queryClient.setQueryData(identityQueryKeys.session(userA), sessionA);
    queryClient.setQueryData(ownerQueryKeys.activationStatus(userA), activationResult(userA));
    queryClient.setQueryData(ownerQueryKeys.recipientStatus(userA), recipientResult(userA));

    clearIdentityAndAccountQueryCache(queryClient);

    expect(queryClient.getQueryData(accountQueryKeys.profile(userA))).toBeUndefined();
    expect(queryClient.getQueryData(identityQueryKeys.session(userA))).toBeUndefined();
    expect(queryClient.getQueryData(ownerQueryKeys.activationStatus(userA))).toBeUndefined();
    expect(queryClient.getQueryData(ownerQueryKeys.recipientStatus(userA))).toBeUndefined();
    expect(queryClient.getQueryData(publicKey)).toEqual({ published: true });
  });

  it("profile publication invalidates both owner projections without creating missing keys", () => {
    const queryClient = new QueryClient();
    const publicKey = ["public", "legal"] as const;
    queryClient.setQueryData(publicKey, { published: true });
    queryClient.setQueryData(accountQueryKeys.profile(userA), profileA);
    queryClient.setQueryData(identityQueryKeys.session(userA), sessionA);
    queryClient.setQueryData(ownerQueryKeys.activationStatus(userA), activationResult(userA));
    queryClient.setQueryData(ownerQueryKeys.recipientStatus(userA), recipientResult(userA));
    queryClient.setQueryData(ownerQueryKeys.recipientStatus(userB), recipientResult(userB));

    expect(publishNewestAccountProfileMutationResult(queryClient, userA, profileA)).toBe(true);

    expect(queryClient.getQueryState(ownerQueryKeys.activationStatus(userA))?.isInvalidated).toBe(
      true,
    );
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
    expect(emptyOwnerClient.getQueryData(ownerQueryKeys.activationStatus(userA))).toBeUndefined();
    expect(emptyOwnerClient.getQueryData(ownerQueryKeys.recipientStatus(userA))).toBeUndefined();
  });
});

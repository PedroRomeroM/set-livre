import { MutationObserver, onlineManager, QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OwnerApiError } from "../../src/domains/owners/components/owner-api";
import {
  beginOwnerScopeTransitionOnce,
  cleanupOwnerMutationAttemptOnce,
  isOwnerAmbiguousCommandError,
  isOwnerSessionChangedError,
  ownerMutationNetworkMode,
  ownerMutationResultCanPublish,
  ownerReadRequiresScopeTransition,
  requireOwnerMutationAttempt,
  type OwnerMutationAttempt,
} from "../../src/domains/owners/components/owner-mutation";

const scopeA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const idempotencyKey = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("owner mutation boundary", () => {
  afterEach(() => {
    onlineManager.setOnline(true);
  });

  it("runs offline without pausing and reuses one captured idempotency key", async () => {
    const queryClient = new QueryClient();
    const attemptRef: {
      current: OwnerMutationAttempt<{ action: "start" }> | undefined;
    } = {
      current: {
        expectedScope: scopeA,
        idempotencyKey,
        payload: { action: "start" },
      },
    };
    const execute = vi.fn(async (attempt: OwnerMutationAttempt<{ action: "start" }>) => ({
      idempotencyKey: attempt.idempotencyKey,
      scope: attempt.expectedScope,
    }));
    const cleanup = vi.fn(() => {
      cleanupOwnerMutationAttemptOnce(attemptRef.current, () => {
        attemptRef.current = undefined;
      });
    });
    const observer = new MutationObserver(queryClient, {
      mutationFn: () => execute(requireOwnerMutationAttempt(attemptRef.current, "missing attempt")),
      networkMode: ownerMutationNetworkMode,
      onSuccess: cleanup,
    });
    onlineManager.setOnline(false);

    const pending = observer.mutate(undefined);

    expect(observer.getCurrentResult()).toMatchObject({ isPaused: false, status: "pending" });
    await expect(pending).resolves.toEqual({ idempotencyKey, scope: scopeA });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toMatchObject({ idempotencyKey, expectedScope: scopeA });
    expect(attemptRef.current).toBeUndefined();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it.each(["SESSION_CHANGED", "UNAUTHENTICATED"] as const)(
    "cleans before closing private UI on %s",
    async (code) => {
      const events: string[] = [];
      const queryClient = new QueryClient();
      const attemptRef: { current: OwnerMutationAttempt<Record<string, never>> | undefined } = {
        current: { expectedScope: scopeA, idempotencyKey, payload: {} },
      };
      const observer = new MutationObserver(queryClient, {
        mutationFn: async () => {
          requireOwnerMutationAttempt(attemptRef.current, "missing attempt");
          throw new OwnerApiError(code, "A sessão mudou.");
        },
        networkMode: ownerMutationNetworkMode,
        onError: (error) => {
          cleanupOwnerMutationAttemptOnce(attemptRef.current, () => {
            attemptRef.current = undefined;
            events.push("cleanup");
          });
          if (isOwnerSessionChangedError(error)) events.push("transition");
        },
      });

      await expect(observer.mutate(undefined)).rejects.toMatchObject({ code });
      expect(attemptRef.current).toBeUndefined();
      expect(events).toEqual(["cleanup", "transition"]);
    },
  );

  it.each(["SESSION_CHANGED", "UNAUTHENTICATED"] as const)(
    "forces a fail-closed scope transition for terminal GET error %s",
    (code) => {
      expect(
        ownerReadRequiresScopeTransition({
          authoritativeScopeChanged: false,
          error: new OwnerApiError(code, "A sessão mudou."),
          observedScopeChanged: false,
        }),
      ).toBe(true);
    },
  );

  it("keeps retryable GET failures recoverable and honors either explicit scope mismatch", () => {
    const serviceError = new OwnerApiError("SERVICE_UNAVAILABLE", "Serviço indisponível.");

    expect(
      ownerReadRequiresScopeTransition({
        authoritativeScopeChanged: false,
        error: serviceError,
        observedScopeChanged: false,
      }),
    ).toBe(false);
    expect(
      ownerReadRequiresScopeTransition({
        authoritativeScopeChanged: true,
        error: serviceError,
        observedScopeChanged: false,
      }),
    ).toBe(true);
    expect(
      ownerReadRequiresScopeTransition({
        authoritativeScopeChanged: false,
        error: serviceError,
        observedScopeChanged: true,
      }),
    ).toBe(true);
  });

  it("closes DOM before cache/reload and ignores a late result after the latch", async () => {
    const events: string[] = [];
    const queryClient = new QueryClient();
    const guard = { current: false };
    const published = vi.fn();
    let resolveMutation: ((result: string) => void) | undefined;
    const remote = new Promise<string>((resolve) => {
      resolveMutation = resolve;
    });
    const observer = new MutationObserver(queryClient, {
      mutationFn: async () => remote,
      networkMode: ownerMutationNetworkMode,
      onSuccess: (result) => {
        events.push("late-callback");
        if (ownerMutationResultCanPublish(guard)) published(result);
      },
    });
    const pending = observer.mutate(undefined);

    expect(
      beginOwnerScopeTransitionOnce(
        guard,
        () => events.push("boundary"),
        () => {
          events.push("cache");
          queryClient.getMutationCache().clear();
        },
        () => events.push("reload"),
      ),
    ).toBe(true);
    expect(beginOwnerScopeTransitionOnce(guard, vi.fn(), vi.fn(), vi.fn())).toBe(false);
    expect(events).toEqual(["boundary", "cache", "reload"]);

    resolveMutation?.("late-result-a");
    await expect(pending).resolves.toBe("late-result-a");
    expect(published).not.toHaveBeenCalled();
    expect(events).toEqual(["boundary", "cache", "reload", "late-callback"]);
  });

  it("always clears cache and reloads even when the boundary commit throws", () => {
    const guard = { current: false };
    const events: string[] = [];

    expect(() =>
      beginOwnerScopeTransitionOnce(
        guard,
        () => {
          events.push("boundary");
          throw new Error("boundary failed");
        },
        () => events.push("cache"),
        () => events.push("reload"),
      ),
    ).toThrow("boundary failed");
    expect(events).toEqual(["boundary", "cache", "reload"]);
  });

  it.each([
    "NETWORK_UNAVAILABLE",
    "PAYMENT_PROVIDER_UNAVAILABLE",
    "REQUEST_TIMEOUT",
    "RESPONSE_INVALID",
    "SERVICE_UNAVAILABLE",
  ])("treats %s as verification-first because the command outcome is ambiguous", (code) => {
    expect(isOwnerAmbiguousCommandError(new OwnerApiError(code, "safe error"))).toBe(true);
  });

  it("does not classify an explicit business conflict as an ambiguous provider outcome", () => {
    expect(isOwnerAmbiguousCommandError(new OwnerApiError("CONFLICT", "conflict"))).toBe(false);
  });
});

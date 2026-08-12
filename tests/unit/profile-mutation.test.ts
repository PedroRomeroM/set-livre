import { MutationObserver, onlineManager, QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProfileApiError } from "../../src/domains/identity/components/profile-api";
import {
  beginProfileScopeTransitionOnce,
  cleanupProfileMutationAttemptOnce,
  isProfileSessionChangedError,
  profileMutationResultCanPublish,
  profileMutationNetworkMode,
  requireProfileMutationAttempt,
  type ProfileMutationAttempt,
} from "../../src/domains/identity/components/profile-mutation";

const scopeA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("profile mutation boundary", () => {
  afterEach(() => {
    onlineManager.setOnline(true);
  });

  it("runs offline without pausing and clears the scope-bound attempt exactly once", async () => {
    const queryClient = new QueryClient();
    const attemptRef: { current: ProfileMutationAttempt<string> | undefined } = {
      current: { expectedScope: scopeA, payload: "private-one-shot-value" },
    };
    const cleanup = vi.fn();
    const execute = vi.fn(async (expectedScope: string, payload: string) => ({
      expectedScope,
      payloadLength: payload.length,
    }));
    const onSessionChanged = vi.fn();
    const onSuccess = vi.fn();
    function cleanupAttemptOnce() {
      cleanupProfileMutationAttemptOnce(
        attemptRef.current,
        () => {
          attemptRef.current = undefined;
        },
        cleanup,
      );
    }
    const observer = new MutationObserver(queryClient, {
      mutationFn: () => {
        const attempt = requireProfileMutationAttempt(attemptRef.current, "missing attempt");
        return execute(attempt.expectedScope, attempt.payload);
      },
      networkMode: profileMutationNetworkMode,
      onError: (error) => {
        cleanupAttemptOnce();
        if (isProfileSessionChangedError(error)) onSessionChanged();
      },
      onSettled: cleanupAttemptOnce,
      onSuccess: (result) => {
        cleanupAttemptOnce();
        onSuccess(result);
      },
    });
    onlineManager.setOnline(false);

    const pending = observer.mutate(undefined);

    expect(observer.getCurrentResult()).toMatchObject({ isPaused: false, status: "pending" });
    await expect(pending).resolves.toEqual({
      expectedScope: scopeA,
      payloadLength: "private-one-shot-value".length,
    });
    expect(execute).toHaveBeenCalledWith(scopeA, "private-one-shot-value");
    expect(attemptRef.current).toBeUndefined();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(onSuccess).toHaveBeenCalledOnce();
    expect(onSessionChanged).not.toHaveBeenCalled();
  });

  it.each(["SESSION_CHANGED", "UNAUTHENTICATED"] as const)(
    "cleans before closing the UI on the terminal session error %s",
    async (errorCode) => {
      const events: string[] = [];
      const queryClient = new QueryClient();
      const attemptRef: { current: ProfileMutationAttempt<{ colorScheme: string }> | undefined } = {
        current: { expectedScope: scopeA, payload: { colorScheme: "dark" } },
      };
      function cleanupAttemptOnce() {
        cleanupProfileMutationAttemptOnce(
          attemptRef.current,
          () => {
            attemptRef.current = undefined;
          },
          () => {
            events.push("cleanup");
          },
        );
      }
      const observer = new MutationObserver(queryClient, {
        mutationFn: async () => {
          requireProfileMutationAttempt(attemptRef.current, "missing attempt");
          throw new ProfileApiError(
            errorCode,
            "Sua sessão mudou. Recarregue a página antes de continuar.",
          );
        },
        networkMode: profileMutationNetworkMode,
        onError: (error) => {
          cleanupAttemptOnce();
          if (isProfileSessionChangedError(error)) events.push("transition");
        },
        onSettled: cleanupAttemptOnce,
        onSuccess: () => {
          events.push("success");
        },
      });

      await expect(observer.mutate(undefined)).rejects.toMatchObject({ code: errorCode });
      expect(attemptRef.current).toBeUndefined();
      expect(events).toEqual(["cleanup", "transition"]);
    },
  );

  it("closes the DOM before cache and reload, then ignores a late result after the latch", async () => {
    const events: string[] = [];
    const queryClient = new QueryClient();
    const guard = { current: false };
    let privateContentMounted = true;
    const published = vi.fn();
    const attemptRef: { current: ProfileMutationAttempt<string> | undefined } = {
      current: { expectedScope: scopeA, payload: "private-one-shot-value" },
    };
    let resolveMutation: ((result: string) => void) | undefined;
    const remoteResult = new Promise<string>((resolve) => {
      resolveMutation = resolve;
    });
    function cleanupAttemptOnce() {
      cleanupProfileMutationAttemptOnce(
        attemptRef.current,
        () => {
          attemptRef.current = undefined;
        },
        () => {
          events.push("cleanup");
        },
      );
    }
    const observer = new MutationObserver(queryClient, {
      mutationFn: async () => remoteResult,
      networkMode: profileMutationNetworkMode,
      onSuccess: (result) => {
        cleanupAttemptOnce();
        events.push("late-callback");
        if (!profileMutationResultCanPublish(guard)) return;
        published(result);
      },
    });
    const pending = observer.mutate(undefined);
    expect(queryClient.getMutationCache().getAll()).toHaveLength(1);

    expect(
      beginProfileScopeTransitionOnce(
        guard,
        () => {
          expect(guard.current).toBe(true);
          privateContentMounted = false;
          events.push("boundary");
        },
        () => {
          events.push("cache");
          queryClient.getMutationCache().clear();
        },
        () => {
          events.push("reload");
        },
      ),
    ).toBe(true);
    expect(beginProfileScopeTransitionOnce(guard, vi.fn(), vi.fn(), vi.fn())).toBe(false);
    expect(privateContentMounted).toBe(false);
    expect(queryClient.getMutationCache().getAll()).toEqual([]);
    expect(events).toEqual(["boundary", "cache", "reload"]);

    resolveMutation?.("late-result-from-scope-a");
    await expect(pending).resolves.toBe("late-result-from-scope-a");

    expect(attemptRef.current).toBeUndefined();
    expect(published).not.toHaveBeenCalled();
    expect(events).toEqual(["boundary", "cache", "reload", "cleanup", "late-callback"]);
  });

  it("still clears private cache and reloads when closing the boundary throws", () => {
    const boundaryError = new Error("boundary commit failed");
    const events: string[] = [];
    const guard = { current: false };

    expect(() =>
      beginProfileScopeTransitionOnce(
        guard,
        () => {
          events.push("boundary");
          throw boundaryError;
        },
        () => {
          events.push("cache");
        },
        () => {
          events.push("reload");
        },
      ),
    ).toThrow(boundaryError);
    expect(guard.current).toBe(true);
    expect(events).toEqual(["boundary", "cache", "reload"]);
    expect(beginProfileScopeTransitionOnce(guard, vi.fn(), vi.fn(), vi.fn())).toBe(false);
  });

  it("still reloads when clearing the private cache throws", () => {
    const cacheError = new Error("cache clear failed");
    const events: string[] = [];
    const guard = { current: false };

    expect(() =>
      beginProfileScopeTransitionOnce(
        guard,
        () => {
          events.push("boundary");
        },
        () => {
          events.push("cache");
          throw cacheError;
        },
        () => {
          events.push("reload");
        },
      ),
    ).toThrow(cacheError);
    expect(guard.current).toBe(true);
    expect(events).toEqual(["boundary", "cache", "reload"]);
    expect(beginProfileScopeTransitionOnce(guard, vi.fn(), vi.fn(), vi.fn())).toBe(false);
  });
});

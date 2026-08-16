import { MutationObserver, onlineManager, QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StudioApiError } from "../../src/domains/studios/components/studio-api";
import {
  beginStudioScopeTransitionOnce,
  cleanupStudioMutationAttemptOnce,
  isStudioAmbiguousCommandError,
  isStudioMutationScopeTransitionError,
  isStudioNotFoundError,
  isStudioSessionChangedError,
  isStudioUnscopedValidationError,
  requireStudioMutationAttempt,
  studioMutationNetworkMode,
  studioMutationRequiresVerification,
  studioMutationResultCanPublish,
  studioReadRequiresScopeTransition,
  type StudioMutationAttempt,
} from "../../src/domains/studios/components/studio-mutation";

const scope = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const idempotencyKey = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("studio mutation boundary", () => {
  afterEach(() => {
    onlineManager.setOnline(true);
  });

  it("runs offline without pausing and clears one captured attempt", async () => {
    const queryClient = new QueryClient();
    const attemptRef: {
      current: StudioMutationAttempt<{ kind: "save" }> | undefined;
    } = {
      current: { expectedScope: scope, idempotencyKey, payload: { kind: "save" } },
    };
    const execute = vi.fn(async (attempt: StudioMutationAttempt<{ kind: "save" }>) => attempt);
    const observer = new MutationObserver(queryClient, {
      mutationFn: () => execute(requireStudioMutationAttempt(attemptRef.current, "missing")),
      networkMode: studioMutationNetworkMode,
      onSuccess: () =>
        cleanupStudioMutationAttemptOnce(attemptRef.current, () => {
          attemptRef.current = undefined;
        }),
    });
    onlineManager.setOnline(false);

    const outcome = observer.mutate(undefined);

    expect(observer.getCurrentResult()).toMatchObject({ isPaused: false, status: "pending" });
    await expect(outcome).resolves.toMatchObject({ expectedScope: scope, idempotencyKey });
    expect(execute).toHaveBeenCalledOnce();
    expect(attemptRef.current).toBeUndefined();
  });

  it.each(["ACCOUNT_SUSPENDED", "FORBIDDEN", "SESSION_CHANGED", "UNAUTHENTICATED"] as const)(
    "classifies %s as a terminal private-boundary change for POST and GET",
    (code) => {
      const error = new StudioApiError(code, "A sessão mudou.");
      expect(isStudioSessionChangedError(error)).toBe(true);
      expect(
        studioReadRequiresScopeTransition({
          authoritativeScopeChanged: false,
          error,
          observedScopeChanged: false,
        }),
      ).toBe(true);
    },
  );

  it("closes the boundary before cache/reload and latches late results", () => {
    const events: string[] = [];
    const guard = { current: false };

    expect(
      beginStudioScopeTransitionOnce(
        guard,
        () => events.push("boundary"),
        () => events.push("cache"),
        () => events.push("reload"),
      ),
    ).toBe(true);
    expect(beginStudioScopeTransitionOnce(guard, vi.fn(), vi.fn(), vi.fn())).toBe(false);
    expect(events).toEqual(["boundary", "cache", "reload"]);
    expect(studioMutationResultCanPublish(guard)).toBe(false);
  });

  it("suppresses a configured mutation callback after the editor controller unmounts", async () => {
    const queryClient = new QueryClient();
    const guard = { current: false };
    const published = vi.fn();
    const configuredCallback = vi.fn();
    const attemptRef: {
      current: StudioMutationAttempt<{ kind: "create" }> | undefined;
    } = {
      current: {
        expectedScope: scope,
        idempotencyKey,
        payload: { kind: "create" },
      },
    };
    let resolveMutation: ((result: string) => void) | undefined;
    const remoteResult = new Promise<string>((resolve) => {
      resolveMutation = resolve;
    });
    const observer = new MutationObserver(queryClient, {
      mutationFn: async () => {
        requireStudioMutationAttempt(attemptRef.current, "missing attempt");
        return remoteResult;
      },
      networkMode: studioMutationNetworkMode,
      onSuccess: (result) => {
        configuredCallback(result);
        cleanupStudioMutationAttemptOnce(attemptRef.current, () => {
          attemptRef.current = undefined;
        });
        if (!studioMutationResultCanPublish(guard)) return;
        published(result);
      },
    });
    const unsubscribe = observer.subscribe(() => undefined);
    const pending = observer.mutate(undefined);

    expect(observer.getCurrentResult()).toMatchObject({ status: "pending" });
    unsubscribe();
    guard.current = true;
    resolveMutation?.("late-studio-result");

    await expect(pending).resolves.toBe("late-studio-result");
    expect(configuredCallback).toHaveBeenCalledExactlyOnceWith("late-studio-result");
    expect(attemptRef.current).toBeUndefined();
    expect(published).not.toHaveBeenCalled();
  });

  it("still clears cache and reloads when rendering the boundary throws", () => {
    const events: string[] = [];

    expect(() =>
      beginStudioScopeTransitionOnce(
        { current: false },
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

  it.each(["NETWORK_UNAVAILABLE", "REQUEST_TIMEOUT", "RESPONSE_INVALID", "SERVICE_UNAVAILABLE"])(
    "requires an authoritative GET after ambiguous %s",
    (code) => {
      const error = new StudioApiError(code, "Confirme o estado atual.");
      expect(isStudioAmbiguousCommandError(error)).toBe(true);
      expect(studioMutationRequiresVerification(error)).toBe(true);
    },
  );

  it("requires comparison for conflict/unscoped validation but keeps field errors editable", () => {
    const conflict = new StudioApiError("CONFLICT", "O rascunho mudou.");
    const unscoped = new StudioApiError("VALIDATION_FAILED", "O estado mudou.");
    const fieldError = new StudioApiError("VALIDATION_FAILED", "Revise os campos.", {
      capacity: "Informe uma capacidade válida.",
    });

    expect(studioMutationRequiresVerification(conflict)).toBe(true);
    expect(isStudioUnscopedValidationError(unscoped)).toBe(true);
    expect(studioMutationRequiresVerification(unscoped)).toBe(true);
    expect(isStudioUnscopedValidationError(fieldError)).toBe(false);
    expect(studioMutationRequiresVerification(fieldError)).toBe(false);
  });

  it("keeps retryable reads recoverable unless a boundary mismatch was observed", () => {
    const error = new StudioApiError("SERVICE_UNAVAILABLE", "Indisponível.");
    expect(
      studioReadRequiresScopeTransition({
        authoritativeScopeChanged: false,
        error,
        observedScopeChanged: false,
      }),
    ).toBe(false);
    expect(
      studioReadRequiresScopeTransition({
        authoritativeScopeChanged: false,
        error,
        observedScopeChanged: true,
      }),
    ).toBe(true);
  });

  it("identifies an absent editor without treating create verification as a session change", () => {
    const notFound = new StudioApiError("NOT_FOUND", "O estúdio não foi encontrado.");

    expect(isStudioNotFoundError(notFound)).toBe(true);
    expect(isStudioSessionChangedError(notFound)).toBe(false);
    expect(isStudioMutationScopeTransitionError(notFound)).toBe(true);
    expect(studioMutationRequiresVerification(notFound)).toBe(false);
  });
});

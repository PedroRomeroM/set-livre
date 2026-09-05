import type { BackofficeSession } from "@set-livre/contracts";
import { onlineManager, QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BackofficeClientError } from "../../apps/backoffice/src/domains/backoffice/components/backoffice-api";
import {
  backofficeSessionExpirationDelay,
  isBackofficeReauthenticationBoundaryError,
  isBackofficeSessionDeadlineCurrent,
  recomposeBackofficePrivateBoundary,
  verifyBackofficeSessionDeadline,
} from "../../apps/backoffice/src/domains/backoffice/components/backoffice-private-boundary";
import { backofficeQueryKeys } from "../../apps/backoffice/src/domains/backoffice/components/query-keys";
import {
  notifyBackofficeActivityCompleted,
  subscribeToBackofficeActivity,
} from "../../apps/backoffice/src/domains/backoffice/components/session-events";

const expiredSession = {
  authenticated: true as const,
  authorizationVersion: 3,
  email: "operator@example.test",
  expiresAt: "2026-09-05T12:00:00.000Z",
  runtimeUnlockExpiresAt: null,
  scope: "10000000-0000-4000-8000-000000000001",
  strongAuthenticationExpiresAt: "2026-09-05T12:05:00.000Z",
} satisfies BackofficeSession;

function clientError(code: string, status: number) {
  return new BackofficeClientError({ code, message: "Erro seguro.", status });
}

afterEach(() => vi.useRealTimers());

describe("backoffice private boundaries", () => {
  it.each([
    clientError("AUTH_SESSION_RECHECK_REQUIRED", 503),
    clientError("NETWORK_UNAVAILABLE", 503),
    clientError("REQUEST_TIMEOUT", 504),
    clientError("RESPONSE_INVALID", 200),
    new Error("Transporte interrompido"),
  ])("treats an inconclusive reauthentication outcome as a session boundary", (error) => {
    expect(isBackofficeReauthenticationBoundaryError(error)).toBe(true);
  });

  it("keeps an authoritative credential rejection recoverable in the form", () => {
    expect(isBackofficeReauthenticationBoundaryError(clientError("AUTH_INVALID", 401))).toBe(false);
  });

  it("derives the local deadline only from the authoritative expiration", () => {
    const now = Date.parse("2026-09-03T12:00:00.000Z");
    expect(backofficeSessionExpirationDelay("2026-09-03T12:00:15.000Z", now)).toBe(15_000);
    expect(backofficeSessionExpirationDelay("2026-09-03T12:00:00.000Z", now)).toBe(0);
    expect(backofficeSessionExpirationDelay("not-an-authoritative-date", now)).toBe(0);
  });

  it("expires only the deadline still bound to the cached authoritative session", () => {
    const expectedSession = {
      authenticated: true as const,
      authorizationVersion: 3,
      email: "operator@example.test",
      expiresAt: "2026-09-03T12:00:15.000Z",
      runtimeUnlockExpiresAt: null,
      scope: "10000000-0000-4000-8000-000000000001",
      strongAuthenticationExpiresAt: "2026-09-03T12:05:00.000Z",
    };
    const renewedSession = {
      ...expectedSession,
      expiresAt: "2026-09-03T12:30:00.000Z",
    };

    expect(
      isBackofficeSessionDeadlineCurrent(
        expectedSession,
        expectedSession,
        expectedSession.expiresAt,
      ),
    ).toBe(true);
    expect(
      isBackofficeSessionDeadlineCurrent(
        renewedSession,
        expectedSession,
        expectedSession.expiresAt,
      ),
    ).toBe(false);
  });

  it("rechecks an elapsed cached deadline before closing a session renewed by recent activity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T12:00:00.000Z"));
    const session = expiredSession;
    let publishSession: (session: BackofficeSession) => void = () => undefined;
    const read = new Promise<BackofficeSession>((resolve) => {
      publishSession = resolve;
    });
    const settled = vi.fn();
    const verification = verifyBackofficeSessionDeadline(
      session,
      () => read,
      () => 0,
    ).then(settled);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).not.toHaveBeenCalled();
    publishSession({ ...session, expiresAt: "2026-09-05T12:29:55.000Z" });
    await verification;
    expect(settled).toHaveBeenCalledWith(true);

    for (const invalid of [
      session,
      { authenticated: false as const },
      { ...session, authorizationVersion: 4, expiresAt: "2026-09-05T12:30:00.000Z" },
      {
        ...session,
        scope: "20000000-0000-4000-8000-000000000002",
        expiresAt: "2026-09-05T12:30:00.000Z",
      },
    ]) {
      await expect(
        verifyBackofficeSessionDeadline(
          session,
          async () => invalid,
          () => 0,
        ),
      ).resolves.toBe(false);
    }
    await expect(
      verifyBackofficeSessionDeadline(
        session,
        async () => {
          throw clientError("NETWORK_UNAVAILABLE", 503);
        },
        () => 0,
      ),
    ).resolves.toBe(false);
  });

  it.each(["renewed", "expired", "failed"] as const)(
    "waits for the post-activity %s read when activity cancels the poll joined by the deadline",
    async (outcome) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(expiredSession.expiresAt));
      if (outcome === "failed") onlineManager.setOnline(false);
      const client = new QueryClient();
      const key = backofficeQueryKeys.session(expiredSession.scope);
      client.setQueryData(key, expiredSession);
      const reads: {
        signal: AbortSignal;
        resolve: (session: BackofficeSession) => void;
        reject: (error: Error) => void;
      }[] = [];
      const observer = new QueryObserver<BackofficeSession>(client, {
        enabled: false,
        networkMode: "always",
        queryFn: ({ signal }) =>
          new Promise<BackofficeSession>((resolve, reject) => {
            reads.push({ signal, resolve, reject });
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
        queryKey: key,
        retry: false,
      });
      const settled = vi.fn();
      let activityGeneration = 0;
      const unsubscribe = subscribeToBackofficeActivity(() => {
        activityGeneration += 1;
        void observer.refetch();
      });
      try {
        const passivePoll = observer.refetch();
        const verification = verifyBackofficeSessionDeadline(
          expiredSession,
          async () => {
            const result = await observer.refetch({ cancelRefetch: false });
            if (result.isError) throw result.error;
            return result.data;
          },
          () => activityGeneration,
        ).then(settled);
        expect(reads).toHaveLength(1);
        notifyBackofficeActivityCompleted();
        expect(reads).toHaveLength(2);
        expect(reads[0]?.signal.aborted).toBe(true);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(settled).not.toHaveBeenCalled();
        expect(client.getQueryData(key)).toEqual(expiredSession);

        const postActivity = reads[1];
        if (postActivity === undefined) throw new Error("A leitura pós-atividade não iniciou.");
        if (outcome === "failed") {
          postActivity.reject(clientError("NETWORK_UNAVAILABLE", 503));
        } else {
          postActivity.resolve(
            outcome === "expired"
              ? { authenticated: false }
              : { ...expiredSession, expiresAt: "2026-09-05T12:29:55.000Z" },
          );
        }
        await Promise.all([passivePoll, verification]);
        expect(settled).toHaveBeenCalledExactlyOnceWith(outcome === "renewed");
      } finally {
        unsubscribe();
        observer.destroy();
        client.clear();
        onlineManager.setOnline(true);
      }
    },
  );

  it("closes, redacts, notifies and reloads the boundary in that order", () => {
    const calls: string[] = [];
    recomposeBackofficePrivateBoundary({
      clearPrivateState: () => calls.push("clear"),
      hidePrivateView: () => calls.push("hide"),
      notifySessionChanged: () => calls.push("notify"),
      reloadAuthoritativeSession: () => calls.push("reload"),
    });
    expect(calls).toEqual(["hide", "clear", "notify", "reload"]);
  });

  it("still requests authoritative recomposition if the React boundary cannot flush", () => {
    const boundaryError = new Error("flush failed");
    const clearPrivateState = vi.fn();
    const notifySessionChanged = vi.fn();
    const reloadAuthoritativeSession = vi.fn();

    expect(() =>
      recomposeBackofficePrivateBoundary({
        clearPrivateState,
        hidePrivateView: () => {
          throw boundaryError;
        },
        notifySessionChanged,
        reloadAuthoritativeSession,
      }),
    ).toThrow(boundaryError);
    expect(clearPrivateState).toHaveBeenCalledOnce();
    expect(notifySessionChanged).toHaveBeenCalledOnce();
    expect(reloadAuthoritativeSession).toHaveBeenCalledOnce();
  });
});

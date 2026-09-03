import { describe, expect, it, vi } from "vitest";

import { BackofficeClientError } from "../../apps/backoffice/src/domains/backoffice/components/backoffice-api";
import {
  backofficeSessionExpirationDelay,
  isBackofficeReauthenticationBoundaryError,
  recomposeBackofficePrivateBoundary,
} from "../../apps/backoffice/src/domains/backoffice/components/backoffice-private-boundary";

function clientError(code: string, status: number) {
  return new BackofficeClientError({ code, message: "Erro seguro.", status });
}

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

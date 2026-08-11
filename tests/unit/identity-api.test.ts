import { afterEach, describe, expect, it, vi } from "vitest";

import {
  IdentityApiError,
  isRetryableIdentityCallbackError,
  loginIdentity,
} from "../../src/domains/identity/components/identity-api";

describe("identity browser API", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("aborts a pending request with a recoverable redacted timeout", async () => {
    vi.useFakeTimers();
    const privatePassword = "NeverPrintThisPassword9A";
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("provider-secret", "AbortError")),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", {
      clearTimeout,
      setTimeout,
    });

    const requestOutcome = loginIdentity({
      email: "qa_timeout@example.test",
      password: privatePassword,
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_000);

    const error = await requestOutcome;
    expect(error).toMatchObject({
      code: "REQUEST_TIMEOUT",
      message: "A solicitação demorou mais que o esperado. Tente novamente.",
    });
    const serializedError = JSON.stringify(error);
    expect(serializedError).not.toContain(privatePassword);
    expect(serializedError).not.toContain("provider-secret");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps signup retries while making ambiguous recovery transport failures terminal", () => {
    for (const code of [
      "NETWORK_UNAVAILABLE",
      "REQUEST_TIMEOUT",
      "RESPONSE_INVALID",
      "SERVICE_UNAVAILABLE",
    ]) {
      expect(
        isRetryableIdentityCallbackError(new IdentityApiError(code, "Erro seguro."), "signup"),
      ).toBe(true);
    }

    expect(
      isRetryableIdentityCallbackError(
        new IdentityApiError("SERVICE_UNAVAILABLE", "Erro seguro."),
        "recovery",
      ),
    ).toBe(true);
    for (const code of ["NETWORK_UNAVAILABLE", "REQUEST_TIMEOUT", "RESPONSE_INVALID"]) {
      expect(
        isRetryableIdentityCallbackError(new IdentityApiError(code, "Erro seguro."), "recovery"),
      ).toBe(false);
    }

    expect(
      isRetryableIdentityCallbackError(
        new IdentityApiError(
          "RECOVERY_RESTART_REQUIRED",
          "Não foi possível preparar a recuperação agora. Solicite um novo link.",
        ),
        "recovery",
      ),
    ).toBe(false);
    expect(
      isRetryableIdentityCallbackError(
        new IdentityApiError("RECOVERY_INVALID", "Solicite um novo link."),
        "recovery",
      ),
    ).toBe(false);
  });
});

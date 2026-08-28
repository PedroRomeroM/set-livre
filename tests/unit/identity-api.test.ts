import { afterEach, describe, expect, it, vi } from "vitest";

import {
  IdentityApiError,
  isRetryableIdentityCallbackError,
  loginIdentity,
  logoutIdentity,
  registerIdentity,
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

  it("maps a transport rejection to a recoverable redacted network error", async () => {
    const privatePassword = "NeverPrintThisPassword9A";
    const fetchMock = vi.fn(async (): Promise<Response> => {
      throw new Error("private-provider-transport");
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { clearTimeout, setTimeout });

    const outcome = await loginIdentity({
      email: "qa_network@example.test",
      password: privatePassword,
    }).catch((error: unknown) => error);

    expect(outcome).toMatchObject({
      code: "NETWORK_UNAVAILABLE",
      message: "Não foi possível conectar. Verifique sua internet e tente novamente.",
    });
    const serializedError = JSON.stringify(outcome);
    expect(serializedError).not.toContain(privatePassword);
    expect(serializedError).not.toContain("private-provider-transport");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends guest registration only to its dedicated public route", async () => {
    const requestId = "11111111-1111-4111-8111-111111111111";
    const fetchMock = vi.fn(async () =>
      Response.json({ data: { confirmationRequired: true }, requestId }, { status: 202 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { clearTimeout, setTimeout });
    const payload = {
      acceptPrivacy: true,
      acceptTerms: true,
      email: "qa_register_route@example.test",
      password: "ValidPassword9",
      personType: "individual",
      privacyVersionId: "22222222-2222-4222-8222-222222222222",
      termsVersionId: "33333333-3333-4333-8333-333333333333",
    } as const;

    await expect(registerIdentity(payload)).resolves.toEqual({ confirmationRequired: true });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/register",
      expect.objectContaining({
        body: JSON.stringify({ action: "identity.register", payload }),
        method: "POST",
      }),
    );
  });

  it("binds logout to the authenticated SSR scope", async () => {
    const requestId = "11111111-1111-4111-8111-111111111111";
    const expectedScope = "22222222-2222-4222-8222-222222222222";
    const fetchMock = vi.fn(async () =>
      Response.json({ data: { signedOut: true }, requestId }, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { clearTimeout, setTimeout });

    await expect(logoutIdentity(expectedScope)).resolves.toEqual({ signedOut: true });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/logout",
      expect.objectContaining({
        body: JSON.stringify({ expectedScope }),
        method: "POST",
      }),
    );
  });

  it("aborts a timed-out logout without losing its scope binding", async () => {
    vi.useFakeTimers();
    const expectedScope = "22222222-2222-4222-8222-222222222222";
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("private-logout-transport", "AbortError")),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { clearTimeout, setTimeout });

    const outcome = logoutIdentity(expectedScope).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(outcome).resolves.toMatchObject({ code: "REQUEST_TIMEOUT" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/logout",
      expect.objectContaining({ body: JSON.stringify({ expectedScope }), method: "POST" }),
    );
    expect(JSON.stringify(await outcome)).not.toContain("private-logout-transport");
  });

  it("retries only a valid pre-OTP service response for signup and recovery callbacks", () => {
    for (const type of ["signup", "recovery"] as const) {
      expect(
        isRetryableIdentityCallbackError(
          new IdentityApiError("SERVICE_UNAVAILABLE", "Erro seguro."),
          type,
        ),
      ).toBe(true);
      for (const code of ["NETWORK_UNAVAILABLE", "REQUEST_TIMEOUT", "RESPONSE_INVALID"]) {
        expect(
          isRetryableIdentityCallbackError(new IdentityApiError(code, "Erro seguro."), type),
        ).toBe(false);
      }
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
        new IdentityApiError(
          "AUTH_RESTART_REQUIRED",
          "Não foi possível confirmar o cadastro com segurança. Solicite um novo link de confirmação.",
        ),
        "signup",
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

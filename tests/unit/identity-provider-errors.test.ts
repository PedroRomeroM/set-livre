import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  handleCallbackProviderError,
  handleLoginProviderError,
  handlePasswordUpdateProviderError,
  handleRecoveryRequestProviderError,
  handleRegistrationProviderError,
  isPasswordUpdateProviderErrorSafeToRetry,
} from "../../src/domains/identity/server/identity-provider-errors";

describe("identity provider error mapping", () => {
  it("keeps registration and recovery enumeration-safe", () => {
    expect(() => handleRegistrationProviderError({ code: "user_already_exists" })).not.toThrow();
    expect(handleRecoveryRequestProviderError({ code: "user_not_found" })).toBe("unavailable");
    expect(handleRecoveryRequestProviderError({ code: "over_request_rate_limit" })).toBe(
      "unavailable",
    );
  });

  it.each([
    handleRegistrationProviderError,
    handleLoginProviderError,
    (error: unknown) => handleCallbackProviderError(error, "recovery"),
    handlePasswordUpdateProviderError,
  ])("maps provider rate limits without provider payloads", (handler) => {
    expect(() =>
      handler({ code: "over_request_rate_limit", secret: "provider-private-payload" }),
    ).toThrow(
      expect.objectContaining({
        code: "RATE_LIMITED",
        message: "Muitas tentativas. Aguarde alguns minutos e tente novamente.",
        status: 429,
      }),
    );
  });

  it("distinguishes invalid credentials and callbacks from provider outages", () => {
    expect(() => handleLoginProviderError({ code: "invalid_credentials" })).toThrow(
      expect.objectContaining({ code: "AUTH_INVALID", status: 401 }),
    );
    expect(() => handleCallbackProviderError({ code: "otp_expired" }, "recovery")).toThrow(
      expect.objectContaining({ code: "RECOVERY_INVALID", status: 400 }),
    );
    expect(() => handleLoginProviderError({ code: "unexpected_failure" })).toThrow(
      expect.objectContaining({ code: "SERVICE_UNAVAILABLE", status: 503 }),
    );
    expect(() =>
      handleCallbackProviderError(new Error("private provider outage"), "signup"),
    ).toThrow(expect.objectContaining({ code: "SERVICE_UNAVAILABLE", status: 503 }));
  });

  it("preserves a recovery grant on a provider-rejected password", () => {
    expect(() => handlePasswordUpdateProviderError({ code: "weak_password" })).toThrow(
      expect.objectContaining({
        code: "INPUT_INVALID",
        fieldErrors: { password: "A nova senha não atende aos requisitos de segurança." },
        status: 400,
      }),
    );
  });

  it("retries only provider outcomes that prove the password was not changed", () => {
    for (const code of ["weak_password", "same_password", "over_request_rate_limit"]) {
      expect(isPasswordUpdateProviderErrorSafeToRetry({ code })).toBe(true);
    }
    expect(isPasswordUpdateProviderErrorSafeToRetry({ code: "unexpected_failure" })).toBe(false);
    expect(isPasswordUpdateProviderErrorSafeToRetry(new Error("ambiguous transport"))).toBe(false);
  });
});

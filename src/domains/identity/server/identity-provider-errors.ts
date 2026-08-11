import "server-only";

import { z } from "zod";

import { ApiRouteError } from "../../../lib/server/api-route";

const providerErrorSchema = z.object({ code: z.string().optional() });
const providerRateLimitCodes = new Set([
  "over_email_send_rate_limit",
  "over_request_rate_limit",
  "over_sms_send_rate_limit",
]);
const invalidCredentialCodes = new Set([
  "email_not_confirmed",
  "invalid_credentials",
  "user_banned",
]);
const invalidCallbackCodes = new Set([
  "bad_code_verifier",
  "flow_state_expired",
  "flow_state_not_found",
  "otp_disabled",
  "otp_expired",
  "validation_failed",
]);

function providerErrorCode(error: unknown) {
  const result = providerErrorSchema.safeParse(error);
  return result.success ? result.data.code : undefined;
}

function throwProviderRateLimit() {
  throw new ApiRouteError(
    429,
    "RATE_LIMITED",
    "Muitas tentativas. Aguarde alguns minutos e tente novamente.",
  );
}

function throwProviderUnavailable(message: string): never {
  throw new ApiRouteError(503, "SERVICE_UNAVAILABLE", message);
}

export function handleRegistrationProviderError(error: unknown) {
  const code = providerErrorCode(error);
  if (code === "user_already_exists" || code === "email_exists") {
    return;
  }
  if (code === "weak_password") {
    throw new ApiRouteError(400, "INPUT_INVALID", "Revise os campos destacados.", {
      password: "A senha não atende aos requisitos de segurança.",
    });
  }
  if (code === "email_address_invalid") {
    throw new ApiRouteError(400, "INPUT_INVALID", "Revise os campos destacados.", {
      email: "Informe um e-mail válido.",
    });
  }
  if (code !== undefined && providerRateLimitCodes.has(code)) {
    throwProviderRateLimit();
  }
  throwProviderUnavailable("Não foi possível concluir o cadastro agora. Tente novamente.");
}

export function handleLoginProviderError(error: unknown): never {
  const code = providerErrorCode(error);
  if (code !== undefined && providerRateLimitCodes.has(code)) {
    throwProviderRateLimit();
  }
  if (code !== undefined && invalidCredentialCodes.has(code)) {
    throw new ApiRouteError(
      401,
      "AUTH_INVALID",
      "E-mail ou senha inválidos. Revise os dados e tente novamente.",
    );
  }
  throwProviderUnavailable("Não foi possível entrar agora. Tente novamente.");
}

export function handleRecoveryRequestProviderError(error: unknown) {
  providerErrorCode(error);
  return "unavailable" as const;
}

export function handleCallbackProviderError(error: unknown, type: "recovery" | "signup"): never {
  const code = providerErrorCode(error);
  if (code !== undefined && providerRateLimitCodes.has(code)) {
    throwProviderRateLimit();
  }
  if (code !== undefined && invalidCallbackCodes.has(code)) {
    throw new ApiRouteError(
      400,
      type === "recovery" ? "RECOVERY_INVALID" : "AUTH_INVALID",
      "Este link é inválido ou expirou. Solicite um novo link.",
    );
  }
  throwProviderUnavailable("Não foi possível validar o link agora. Tente novamente.");
}

export function handlePasswordUpdateProviderError(error: unknown): never {
  const code = providerErrorCode(error);
  if (code !== undefined && providerRateLimitCodes.has(code)) {
    throwProviderRateLimit();
  }
  if (code === "weak_password" || code === "same_password") {
    throw new ApiRouteError(400, "INPUT_INVALID", "Revise os campos destacados.", {
      password: "A nova senha não atende aos requisitos de segurança.",
    });
  }
  throwProviderUnavailable("Não foi possível atualizar a senha agora. Tente novamente.");
}

export function isPasswordUpdateProviderErrorSafeToRetry(error: unknown) {
  const code = providerErrorCode(error);
  return (
    code === "same_password" ||
    code === "weak_password" ||
    (code !== undefined && providerRateLimitCodes.has(code))
  );
}

export function handleLogoutProviderError(error: unknown): never {
  void providerErrorCode(error);
  throwProviderUnavailable("Não foi possível encerrar a sessão agora. Tente novamente.");
}

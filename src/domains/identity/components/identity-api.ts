import {
  apiErrorSchema,
  apiSuccessSchema,
  identityCallbackResultSchema,
  identityLoginResultSchema,
  identityRecoveryRequestResultSchema,
  identityRecoveryStatusResultSchema,
  identityRecoveryUpdateResultSchema,
  identityRegisterResultSchema,
  identitySessionSchema,
  type IdentityLoginPayload,
  type IdentityLogoutPayload,
  type IdentityRegistrationPayload,
} from "@set-livre/contracts";
import { z } from "zod";

const identityLogoutResultSchema = z.strictObject({ signedOut: z.literal(true) });
const identityRequestTimeoutMs = 10_000;
const retryableIdentityCallbackCode = {
  recovery: "SERVICE_UNAVAILABLE",
  signup: "SERVICE_UNAVAILABLE",
} as const;

export class IdentityApiError extends Error {
  readonly code: string;
  readonly fieldErrors: Readonly<Record<string, string>>;

  constructor(code: string, message: string, fieldErrors: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "IdentityApiError";
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}

export function isRetryableIdentityCallbackError(error: unknown, type: "recovery" | "signup") {
  if (!(error instanceof IdentityApiError)) {
    return false;
  }
  return error.code === retryableIdentityCallbackCode[type];
}

async function readPayload(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new IdentityApiError(
      "RESPONSE_INVALID",
      "O servidor enviou uma resposta inesperada. Tente novamente.",
    );
  }
}

async function requestIdentity<TData>(
  path: string,
  dataSchema: z.ZodType<TData>,
  init?: RequestInit,
): Promise<TData> {
  const abortController = new AbortController();
  const timeout = window.setTimeout(() => abortController.abort(), identityRequestTimeoutMs);
  let response: Response;
  let payload: unknown;
  try {
    response = await fetch(path, {
      ...init,
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
        ...init?.headers,
      },
      signal: abortController.signal,
    });
    payload = await readPayload(response);
  } catch (error) {
    if (abortController.signal.aborted) {
      throw new IdentityApiError(
        "REQUEST_TIMEOUT",
        "A solicitação demorou mais que o esperado. Tente novamente.",
      );
    }
    if (error instanceof IdentityApiError) {
      throw error;
    }
    throw new IdentityApiError(
      "NETWORK_UNAVAILABLE",
      "Não foi possível conectar. Verifique sua internet e tente novamente.",
    );
  } finally {
    window.clearTimeout(timeout);
  }

  if (!response.ok) {
    const parsedError = apiErrorSchema.safeParse(payload);
    if (!parsedError.success) {
      throw new IdentityApiError(
        "RESPONSE_INVALID",
        "Não foi possível concluir agora. Tente novamente.",
      );
    }
    throw new IdentityApiError(
      parsedError.data.error.code,
      parsedError.data.error.message,
      parsedError.data.error.fieldErrors,
    );
  }

  const parsedSuccess = apiSuccessSchema(dataSchema).safeParse(payload);
  if (!parsedSuccess.success) {
    throw new IdentityApiError(
      "RESPONSE_INVALID",
      "O servidor enviou uma resposta inesperada. Tente novamente.",
    );
  }
  return parsedSuccess.data.data;
}

function jsonBody(value: unknown) {
  return JSON.stringify(value);
}

export function registerIdentity(payload: IdentityRegistrationPayload) {
  return requestIdentity("/api/auth/register", identityRegisterResultSchema, {
    body: jsonBody({ action: "identity.register", payload }),
    method: "POST",
  });
}

export function loginIdentity(payload: IdentityLoginPayload) {
  return requestIdentity("/api/auth/login", identityLoginResultSchema, {
    body: jsonBody(payload),
    method: "POST",
  });
}

export function logoutIdentity(expectedScope: IdentityLogoutPayload["expectedScope"]) {
  return requestIdentity("/api/auth/logout", identityLogoutResultSchema, {
    body: jsonBody({ expectedScope } satisfies IdentityLogoutPayload),
    method: "POST",
  });
}

export function readIdentitySession() {
  return requestIdentity("/api/auth/session", identitySessionSchema);
}

export function requestPasswordRecovery(email: string) {
  return requestIdentity("/api/auth/recovery/request", identityRecoveryRequestResultSchema, {
    body: jsonBody({ email }),
    method: "POST",
  });
}

export function readPasswordRecoveryStatus() {
  return requestIdentity("/api/auth/recovery/status", identityRecoveryStatusResultSchema);
}

export function updateRecoveredPassword(password: string, confirmPassword: string) {
  return requestIdentity("/api/auth/recovery/update", identityRecoveryUpdateResultSchema, {
    body: jsonBody({ confirmPassword, password }),
    method: "POST",
  });
}

export function completeIdentityCallback(payload: {
  returnTo?: string;
  tokenHash: string;
  type: "recovery" | "signup";
}) {
  return requestIdentity("/api/auth/callback", identityCallbackResultSchema, {
    body: jsonBody(payload),
    method: "POST",
  });
}

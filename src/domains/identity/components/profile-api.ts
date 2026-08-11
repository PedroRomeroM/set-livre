import {
  apiErrorSchema,
  apiSuccessSchema,
  myProfileResultSchema,
  type ProfileCompletePayload,
  type ProfileUpdatePayload,
} from "@set-livre/contracts";
import type { z } from "zod";

const profileRequestTimeoutMs = 10_000;

export class ProfileApiError extends Error {
  readonly code: string;
  readonly fieldErrors: Readonly<Record<string, string>>;

  constructor(code: string, message: string, fieldErrors: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "ProfileApiError";
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}

async function readPayload(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new ProfileApiError(
      "RESPONSE_INVALID",
      "O servidor enviou uma resposta inesperada. Tente novamente.",
    );
  }
}

async function requestProfile<TData>(
  path: string,
  dataSchema: z.ZodType<TData>,
  init?: RequestInit,
): Promise<TData> {
  const abortController = new AbortController();
  const timeout = window.setTimeout(() => abortController.abort(), profileRequestTimeoutMs);
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
      throw new ProfileApiError(
        "REQUEST_TIMEOUT",
        "A solicitação demorou mais que o esperado. Tente novamente.",
      );
    }
    if (error instanceof ProfileApiError) {
      throw error;
    }
    throw new ProfileApiError(
      "NETWORK_UNAVAILABLE",
      "Não foi possível conectar. Verifique sua internet e tente novamente.",
    );
  } finally {
    window.clearTimeout(timeout);
  }

  if (!response.ok) {
    const parsedError = apiErrorSchema.safeParse(payload);
    if (!parsedError.success) {
      throw new ProfileApiError(
        "RESPONSE_INVALID",
        "Não foi possível concluir agora. Tente novamente.",
      );
    }
    throw new ProfileApiError(
      parsedError.data.error.code,
      parsedError.data.error.message,
      parsedError.data.error.fieldErrors,
    );
  }

  const parsedSuccess = apiSuccessSchema(dataSchema).safeParse(payload);
  if (!parsedSuccess.success) {
    throw new ProfileApiError(
      "RESPONSE_INVALID",
      "O servidor enviou uma resposta inesperada. Tente novamente.",
    );
  }
  return parsedSuccess.data.data;
}

function profileCommandBody(
  action: "profile.complete" | "profile.update",
  payload: ProfileCompletePayload | ProfileUpdatePayload,
) {
  return JSON.stringify({ action, payload });
}

export function readOwnProfile() {
  return requestProfile("/api/account/profile", myProfileResultSchema);
}

export function completeOwnProfile(payload: ProfileCompletePayload) {
  return requestProfile("/api/commands", myProfileResultSchema, {
    body: profileCommandBody("profile.complete", payload),
    method: "POST",
  });
}

export function updateOwnProfile(payload: ProfileUpdatePayload) {
  return requestProfile("/api/commands", myProfileResultSchema, {
    body: profileCommandBody("profile.update", payload),
    method: "POST",
  });
}

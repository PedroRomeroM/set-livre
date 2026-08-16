import {
  apiErrorSchema,
  apiSuccessSchema,
  ownerActivationResultSchema,
  ownerRecipientStatusSchema,
  type OwnerCommand,
  type OwnerActivationResult,
  type OwnerRecipientResult,
  type OwnerRecipientStatus,
} from "@set-livre/contracts";
import { z } from "zod";

const ownerRequestTimeoutMs = 10_000;

export class OwnerApiError extends Error {
  readonly code: string;
  readonly fieldErrors: Readonly<Record<string, string>>;

  constructor(code: string, message: string, fieldErrors: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "OwnerApiError";
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}

async function readPayload(response: Response): Promise<unknown> {
  try {
    return z.unknown().parse(await response.json());
  } catch {
    throw new OwnerApiError(
      "RESPONSE_INVALID",
      "O servidor enviou uma resposta inesperada. Tente novamente.",
    );
  }
}

async function requestOwner<TData>(
  path: string,
  dataSchema: z.ZodType<TData>,
  init?: RequestInit,
): Promise<TData> {
  const abortController = new AbortController();
  const timeout = window.setTimeout(() => abortController.abort(), ownerRequestTimeoutMs);
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
      throw new OwnerApiError(
        "REQUEST_TIMEOUT",
        "A solicitação demorou mais que o esperado. Verifique o estado atual antes de tentar novamente.",
      );
    }
    if (error instanceof OwnerApiError) {
      throw error;
    }
    throw new OwnerApiError(
      "NETWORK_UNAVAILABLE",
      "Não foi possível conectar. Verifique sua internet e atualize o estado antes de tentar novamente.",
    );
  } finally {
    window.clearTimeout(timeout);
  }

  if (!response.ok) {
    const parsedError = apiErrorSchema.safeParse(payload);
    if (!parsedError.success) {
      throw new OwnerApiError(
        "RESPONSE_INVALID",
        "Não foi possível concluir agora. Verifique o estado atual antes de tentar novamente.",
      );
    }
    throw new OwnerApiError(
      parsedError.data.error.code,
      parsedError.data.error.message,
      parsedError.data.error.fieldErrors,
    );
  }

  const parsedSuccess = apiSuccessSchema(dataSchema).safeParse(payload);
  if (!parsedSuccess.success) {
    throw new OwnerApiError(
      "RESPONSE_INVALID",
      "O servidor enviou uma resposta inesperada. Tente novamente.",
    );
  }
  return parsedSuccess.data.data;
}

function ownerCommand(
  command: Extract<OwnerCommand, { action: "owner.activate" }>,
): Promise<OwnerActivationResult>;
function ownerCommand(
  command: Exclude<OwnerCommand, { action: "owner.activate" }>,
): Promise<OwnerRecipientStatus>;
function ownerCommand(command: OwnerCommand): Promise<OwnerRecipientResult> {
  return command.action === "owner.activate"
    ? requestOwner("/api/commands", ownerActivationResultSchema, {
        body: JSON.stringify(command),
        method: "POST",
      })
    : requestOwner("/api/commands", ownerRecipientStatusSchema, {
        body: JSON.stringify(command),
        method: "POST",
      });
}

export function readOwnerRecipient() {
  return requestOwner("/api/owner/recipient", ownerRecipientStatusSchema);
}

export function readOwnerActivation() {
  return requestOwner("/api/owner/activation", ownerActivationResultSchema);
}

export function activateOwner(
  expectedScope: string,
  idempotencyKey: string,
  ownerContractVersionId: string,
) {
  return ownerCommand({
    action: "owner.activate",
    expectedScope,
    idempotencyKey,
    payload: { acceptOwnerContract: true, ownerContractVersionId },
  });
}

export function startRecipientOnboarding(expectedScope: string, idempotencyKey: string) {
  return ownerCommand({
    action: "recipient.onboarding.start",
    expectedScope,
    idempotencyKey,
    payload: {},
  });
}

export function refreshRecipientOnboarding(expectedScope: string, idempotencyKey: string) {
  return ownerCommand({
    action: "recipient.onboarding.refresh",
    expectedScope,
    idempotencyKey,
    payload: {},
  });
}

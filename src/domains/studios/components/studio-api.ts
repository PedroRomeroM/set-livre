import {
  apiErrorSchema,
  apiSuccessSchema,
  studioDraftDiscardResultSchema,
  studioEditorSchema,
  studioTypeOptionsSchema,
  type StudioCommand,
  type StudioDraftDiscardResult,
  type StudioEditor,
  type StudioTypeOption,
} from "@set-livre/contracts";
import { z } from "zod";

const studioRequestTimeoutMs = 10_000;

export class StudioApiError extends Error {
  readonly code: string;
  readonly fieldErrors: Readonly<Record<string, string>>;

  constructor(code: string, message: string, fieldErrors: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "StudioApiError";
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}

async function readPayload(response: Response): Promise<unknown> {
  try {
    return z.unknown().parse(await response.json());
  } catch {
    throw new StudioApiError(
      "RESPONSE_INVALID",
      "O servidor enviou uma resposta inesperada. Tente novamente.",
    );
  }
}

async function requestStudio<TData>(
  path: string,
  dataSchema: z.ZodType<TData>,
  init?: RequestInit,
): Promise<TData> {
  const controller = new AbortController();
  const externalSignal = init?.signal;
  const requestSignal =
    externalSignal === undefined || externalSignal === null
      ? controller.signal
      : AbortSignal.any([controller.signal, externalSignal]);
  const timeout = window.setTimeout(() => controller.abort(), studioRequestTimeoutMs);
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
      signal: requestSignal,
    });
    payload = await readPayload(response);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new StudioApiError(
        "REQUEST_TIMEOUT",
        "A solicitação demorou mais que o esperado. Verifique o estado antes de repetir.",
      );
    }
    if (externalSignal?.aborted === true) throw error;
    if (error instanceof StudioApiError) throw error;
    throw new StudioApiError(
      "NETWORK_UNAVAILABLE",
      "Não foi possível conectar. Verifique sua internet e tente novamente.",
    );
  } finally {
    window.clearTimeout(timeout);
  }

  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(payload);
    if (!parsed.success) {
      throw new StudioApiError(
        "RESPONSE_INVALID",
        "Não foi possível interpretar a resposta do servidor.",
      );
    }
    throw new StudioApiError(
      parsed.data.error.code,
      parsed.data.error.message,
      parsed.data.error.fieldErrors,
    );
  }

  const parsed = apiSuccessSchema(dataSchema).safeParse(payload);
  if (!parsed.success) {
    throw new StudioApiError("RESPONSE_INVALID", "O servidor enviou dados de estúdio inesperados.");
  }
  return parsed.data.data;
}

export function readStudioEditor(studioId: string, signal?: AbortSignal): Promise<StudioEditor> {
  return requestStudio(
    `/api/owner/studios/${encodeURIComponent(studioId)}`,
    studioEditorSchema,
    signal === undefined ? undefined : { signal },
  );
}

export function readStudioTypes(signal?: AbortSignal): Promise<StudioTypeOption[]> {
  return requestStudio(
    "/api/studio-types",
    studioTypeOptionsSchema,
    signal === undefined ? undefined : { signal },
  );
}

export function createStudio(command: Extract<StudioCommand, { action: "studio.create" }>) {
  return requestStudio("/api/commands", studioEditorSchema, {
    body: JSON.stringify(command),
    method: "POST",
  });
}

export function updateStudioCore(
  command: Extract<StudioCommand, { action: "studio.revision.updateCore" }>,
) {
  return requestStudio("/api/commands", studioEditorSchema, {
    body: JSON.stringify(command),
    method: "POST",
  });
}

export function discardStudioDraft(
  command: Extract<StudioCommand, { action: "studio.draft.discard" }>,
): Promise<StudioDraftDiscardResult> {
  return requestStudio("/api/commands", studioDraftDiscardResultSchema, {
    body: JSON.stringify(command),
    method: "POST",
  });
}

export function isAmbiguousStudioError(error: unknown) {
  return (
    error instanceof StudioApiError &&
    ["NETWORK_UNAVAILABLE", "REQUEST_TIMEOUT", "RESPONSE_INVALID", "SERVICE_UNAVAILABLE"].includes(
      error.code,
    )
  );
}

export function isStudioBoundaryChangedError(error: unknown) {
  return (
    error instanceof StudioApiError &&
    [
      "ACCOUNT_SUSPENDED",
      "FORBIDDEN",
      "NOT_FOUND",
      "OWNER_CONTRACT_CHANGED",
      "SESSION_CHANGED",
      "UNAUTHENTICATED",
    ].includes(error.code)
  );
}

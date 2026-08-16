import {
  apiErrorSchema,
  apiSuccessSchema,
  ownerStudioEditorExpectedScopeHeader,
  ownerStudioEditorExpectedScopeSchema,
  ownerStudioEditorResultSchema,
  studioDraftDiscardResultSchema,
  type OwnerStudioEditorResult,
  type StudioCoreInput,
  type StudioDraftDiscardResult,
} from "@set-livre/contracts";
import { z } from "zod";

const studioRequestTimeoutMs = 10_000;

type StudioEditorEditResult = Extract<OwnerStudioEditorResult, { mode: "edit" }>;

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
  const abortController = new AbortController();
  const timeout = window.setTimeout(() => abortController.abort(), studioRequestTimeoutMs);
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
      throw new StudioApiError(
        "REQUEST_TIMEOUT",
        "A solicitação demorou mais que o esperado. Verifique o estado atual antes de tentar novamente.",
      );
    }
    if (error instanceof StudioApiError) throw error;
    throw new StudioApiError(
      "NETWORK_UNAVAILABLE",
      "Não foi possível conectar. Verifique sua internet e confirme o estado atual.",
    );
  } finally {
    window.clearTimeout(timeout);
  }

  if (!response.ok) {
    const parsedError = apiErrorSchema.safeParse(payload);
    if (!parsedError.success) {
      throw new StudioApiError(
        "RESPONSE_INVALID",
        "Não foi possível concluir agora. Verifique o estado atual antes de tentar novamente.",
      );
    }
    throw new StudioApiError(
      parsedError.data.error.code,
      parsedError.data.error.message,
      parsedError.data.error.fieldErrors,
    );
  }

  const parsedSuccess = apiSuccessSchema(dataSchema).safeParse(payload);
  if (!parsedSuccess.success) {
    throw new StudioApiError(
      "RESPONSE_INVALID",
      "O servidor enviou uma resposta inesperada. Tente novamente.",
    );
  }
  return parsedSuccess.data.data;
}

function requireEditResult(
  result: OwnerStudioEditorResult,
  expectedScope: string,
  expectedStudioId: string,
): StudioEditorEditResult {
  if (
    result.mode !== "edit" ||
    result.scope !== expectedScope ||
    result.studio.id !== expectedStudioId
  ) {
    throw new StudioApiError(
      "RESPONSE_INVALID",
      "O servidor enviou um editor de estúdio inesperado. Tente novamente.",
    );
  }
  return result;
}

export function readStudioEditor(expectedScope: string, studioId?: string) {
  const query = studioId === undefined ? "" : `?studioId=${encodeURIComponent(studioId)}`;
  return requestStudio(`/api/owner/studio-editor${query}`, ownerStudioEditorResultSchema, {
    headers: {
      [ownerStudioEditorExpectedScopeHeader]:
        ownerStudioEditorExpectedScopeSchema.parse(expectedScope),
    },
  });
}

export async function createStudio(
  expectedScope: string,
  idempotencyKey: string,
  studioId: string,
  core: StudioCoreInput,
) {
  return requireEditResult(
    await requestStudio("/api/commands", ownerStudioEditorResultSchema, {
      body: JSON.stringify({
        action: "studio.create",
        expectedScope,
        idempotencyKey,
        payload: { core, studioId },
      }),
      method: "POST",
    }),
    expectedScope,
    studioId,
  );
}

export async function updateStudioCore(
  expectedScope: string,
  idempotencyKey: string,
  studioId: string,
  expectedEditVersion: number,
  core: StudioCoreInput,
) {
  return requireEditResult(
    await requestStudio("/api/commands", ownerStudioEditorResultSchema, {
      body: JSON.stringify({
        action: "studio.revision.updateCore",
        expectedScope,
        idempotencyKey,
        payload: { core, expectedEditVersion, studioId },
      }),
      method: "POST",
    }),
    expectedScope,
    studioId,
  );
}

export async function discardStudioDraft(
  expectedScope: string,
  idempotencyKey: string,
  studioId: string,
  expectedEditVersion: number,
): Promise<StudioDraftDiscardResult> {
  const result = await requestStudio("/api/commands", studioDraftDiscardResultSchema, {
    body: JSON.stringify({
      action: "studio.draft.discard",
      expectedScope,
      idempotencyKey,
      payload: { expectedEditVersion, studioId },
    }),
    method: "POST",
  });
  if (
    result.scope !== expectedScope ||
    result.studioId !== studioId ||
    (result.outcome === "draft_removed" &&
      (result.editor.scope !== expectedScope || result.editor.studio.id !== studioId))
  ) {
    throw new StudioApiError(
      "RESPONSE_INVALID",
      "O servidor enviou um editor de estúdio inesperado. Tente novamente.",
    );
  }
  return result;
}

import {
  apiErrorSchema,
  apiSuccessSchema,
  studioCreateResultSchema,
  studioDraftDiscardResultSchema,
  studioEditorSchema,
  studioMediaGallerySchema,
  studioMediaPrivateCacheSeconds,
  studioMediaUploadDeadlineMs,
  studioMediaUploadPreparationSchema,
  studioPublicationSchema,
  studioTaxonomiesSchema,
  studioTypeOptionsSchema,
  type StudioCommand,
  type StudioDraftDiscardResult,
  type StudioEditor,
  type StudioMediaCommand,
  type StudioMediaGallery,
  type StudioMediaUploadPreparation,
  type StudioPublication,
  type StudioTaxonomies,
  type StudioTypeOption,
} from "@set-livre/contracts";
import { StorageApiError, StorageClient } from "@supabase/storage-js";
import { z } from "zod";

const studioRequestTimeoutMs = 10_000;
export const studioMediaFinalizeRequestTimeoutMs = 45_000;

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
  timeoutMs = studioRequestTimeoutMs,
): Promise<TData> {
  const controller = new AbortController();
  const externalSignal = init?.signal;
  const requestSignal =
    externalSignal === undefined || externalSignal === null
      ? controller.signal
      : AbortSignal.any([controller.signal, externalSignal]);
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
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

function requestStudioCommand<TData extends Readonly<{ scope: string; studioId: string }>>(
  command: Exclude<StudioCommand, { action: "studio.create" }>,
  dataSchema: z.ZodType<TData>,
  timeoutMs = studioRequestTimeoutMs,
): Promise<TData> {
  const expectedScope = command.expectedScope;
  const expectedStudioId = command.payload.studioId;
  return requestStudio(
    "/api/commands",
    dataSchema.refine(
      (result) => result.scope === expectedScope && result.studioId === expectedStudioId,
    ),
    { body: JSON.stringify(command), method: "POST" },
    timeoutMs,
  );
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

export function readStudioTaxonomies(signal?: AbortSignal): Promise<StudioTaxonomies> {
  return requestStudio(
    "/api/studio-taxonomies",
    studioTaxonomiesSchema,
    signal === undefined ? undefined : { signal },
  );
}

export async function createStudio(command: Extract<StudioCommand, { action: "studio.create" }>) {
  const { expectedScope, idempotencyKey } = command;
  const result = await requestStudio(
    "/api/commands",
    studioCreateResultSchema.refine(
      (result) => result.idempotencyKey === idempotencyKey && result.editor.scope === expectedScope,
    ),
    { body: JSON.stringify(command), method: "POST" },
  );
  return result.editor;
}

export function updateStudioCore(
  command: Extract<StudioCommand, { action: "studio.revision.updateCore" }>,
) {
  return requestStudioCommand(command, studioEditorSchema);
}

export function updateStudioTaxonomy(
  command: Extract<StudioCommand, { action: "studio.revision.updateTaxonomy" }>,
) {
  return requestStudioCommand(command, studioEditorSchema);
}

export function updateStudioContent(
  command: Extract<StudioCommand, { action: "studio.revision.updateContent" }>,
) {
  return requestStudioCommand(command, studioEditorSchema);
}

export function discardStudioDraft(
  command: Extract<StudioCommand, { action: "studio.draft.discard" }>,
): Promise<StudioDraftDiscardResult> {
  return requestStudioCommand(
    command,
    studioDraftDiscardResultSchema.refine(
      (result) =>
        result.studioDeleted ||
        (result.editor.scope === result.scope && result.editor.studioId === result.studioId),
    ),
  );
}

export function readStudioMedia(
  studioId: string,
  signal?: AbortSignal,
): Promise<StudioMediaGallery> {
  return requestStudio(
    `/api/owner/studios/${encodeURIComponent(studioId)}/media`,
    studioMediaGallerySchema,
    signal === undefined ? undefined : { signal },
  );
}

export function readStudioPublication(
  studioId: string,
  signal?: AbortSignal,
): Promise<StudioPublication> {
  return requestStudio(
    `/api/owner/studios/${encodeURIComponent(studioId)}/publication`,
    studioPublicationSchema,
    signal === undefined ? undefined : { signal },
  );
}

type StudioPublicationCommand = Extract<
  StudioCommand,
  { action: "studio.pause" | "studio.resume" | "studio.revision.submit" }
>;

export function changeStudioPublication(command: StudioPublicationCommand) {
  return requestStudioCommand(command, studioPublicationSchema);
}

export function prepareStudioMediaUpload(
  command: Extract<StudioMediaCommand, { action: "studio.media.upload.prepare" }>,
): Promise<StudioMediaUploadPreparation> {
  return requestStudioCommand(command, studioMediaUploadPreparationSchema);
}

export function finalizeStudioMediaUpload(
  command: Extract<StudioMediaCommand, { action: "studio.media.upload.finalize" }>,
) {
  return requestStudioCommand(
    command,
    studioMediaGallerySchema,
    studioMediaFinalizeRequestTimeoutMs,
  );
}

export function reorderStudioMedia(
  command: Extract<StudioMediaCommand, { action: "studio.media.reorder" }>,
) {
  return requestStudioCommand(command, studioMediaGallerySchema);
}

export function setStudioMediaCover(
  command: Extract<StudioMediaCommand, { action: "studio.media.cover.set" }>,
) {
  return requestStudioCommand(command, studioMediaGallerySchema);
}

export function deleteStudioMedia(
  command: Extract<StudioMediaCommand, { action: "studio.media.delete" }>,
) {
  return requestStudioCommand(command, studioMediaGallerySchema);
}

function mediaUploadEnvironment() {
  const origin = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const parsed = z.strictObject({ key: z.string().min(1), origin: z.url() }).parse({ key, origin });
  return parsed;
}

export async function uploadStudioMediaObject(
  preparation: StudioMediaUploadPreparation,
  file: File,
  signal: AbortSignal,
) {
  const environment = mediaUploadEnvironment();
  const deadlineController = new AbortController();
  const deadline = window.setTimeout(() => deadlineController.abort(), studioMediaUploadDeadlineMs);
  const storage = new StorageClient(
    new URL("/storage/v1", environment.origin).href.replace(/\/$/u, ""),
    { apikey: environment.key },
    (input, init) =>
      fetch(input, {
        ...init,
        signal:
          init?.signal === undefined || init.signal === null
            ? AbortSignal.any([signal, deadlineController.signal])
            : AbortSignal.any([signal, deadlineController.signal, init.signal]),
      }),
  );
  try {
    const { error } = await storage
      .from(preparation.bucket)
      .uploadToSignedUrl(preparation.path, preparation.signedToken, file, {
        cacheControl: String(studioMediaPrivateCacheSeconds),
        contentType: file.type,
        upsert: false,
      });
    if (error !== null) {
      const definitiveRejection =
        error instanceof StorageApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        ![408, 409, 429].includes(error.status);
      throw new StudioApiError(
        definitiveRejection ? "STORAGE_UPLOAD_REJECTED" : "STORAGE_UPLOAD_FAILED",
        definitiveRejection
          ? "O armazenamento recusou este token sem salvar o arquivo. Renove o envio e tente novamente."
          : "Não foi possível confirmar o envio. Verifique o estado antes de tentar novamente.",
      );
    }
  } finally {
    window.clearTimeout(deadline);
  }
}

export function isAmbiguousStudioError(error: unknown): boolean {
  return (
    error instanceof StudioApiError &&
    ["NETWORK_UNAVAILABLE", "REQUEST_TIMEOUT", "RESPONSE_INVALID", "SERVICE_UNAVAILABLE"].includes(
      error.code,
    )
  );
}

export function isStudioBoundaryChangedError(error: unknown): boolean {
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

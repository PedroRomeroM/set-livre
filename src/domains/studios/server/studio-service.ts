import "server-only";

import {
  studioDraftDiscardResultSchema,
  type OwnerStudioEditorEditResult,
  type StudioCommand,
  type StudioDraftDiscardResult,
} from "@set-livre/contracts";
import { z } from "zod";

import type { PrivateCommandContext } from "@/domains/commands/server/private-command-context";
import { ApiRouteError, hashPrivateRateLimitValue } from "@/lib/server/api-route";
import { enforceIdentityRateLimit } from "@/lib/server/rate-limit";

import {
  createStudioDraft,
  discardStudioDraft as discardStudioDraftInDatabase,
  mapOwnerStudioEditorDalRow,
  updateStudioDraftCore,
} from "./studio-dal";
import { readActiveStudioTypes, readOwnerStudioEditor } from "./studio-read-model";

const databaseErrorSchema = z.object({
  code: z.string().optional(),
  message: z.string().optional(),
});
const forbiddenStudioDatabaseMessages = new Set([
  "owner_authority_required",
  "owner_blocked",
  "owner_profile_inactive",
]);
const conflictingStudioDatabaseMessages = new Set([
  "studio_edit_version_conflict",
  "studio_idempotency_conflict",
  "studio_identifier_unavailable",
  "studio_result_no_longer_available",
]);
const exhaustedStudioDatabaseMessages = new Set([
  "studio_edit_version_exhausted",
  "studio_revision_number_exhausted",
]);
const studioEditsRateLimit = {
  limit: 60,
  partition: "studio.edits",
  windowMs: 10 * 60_000,
} as const;

type CreateStudioCommand = Extract<StudioCommand, { action: "studio.create" }>;
type UpdateStudioCoreCommand = Extract<StudioCommand, { action: "studio.revision.updateCore" }>;
type DiscardStudioDraftCommand = Extract<StudioCommand, { action: "studio.draft.discard" }>;

export type StudioServiceDependencies = Readonly<{
  createStudioDraft: typeof createStudioDraft;
  discardStudioDraftInDatabase: typeof discardStudioDraftInDatabase;
  readActiveStudioTypes: typeof readActiveStudioTypes;
  readOwnerStudioEditor: typeof readOwnerStudioEditor;
  updateStudioDraftCore: typeof updateStudioDraftCore;
}>;

const studioServiceDefaults: StudioServiceDependencies = {
  createStudioDraft,
  discardStudioDraftInDatabase,
  readActiveStudioTypes,
  readOwnerStudioEditor,
  updateStudioDraftCore,
};

function assertMutableAccount(context: PrivateCommandContext) {
  if (context.session.status !== "active") {
    throw new ApiRouteError(
      403,
      "ACCOUNT_SUSPENDED",
      "Esta conta não pode alterar estúdios enquanto estiver suspensa.",
    );
  }
  if (!context.session.profileCompleted) {
    throw new ApiRouteError(409, "CONFLICT", "Conclua seu perfil antes de editar estúdios.");
  }
}

function handleStudioDatabaseError(error: unknown): never {
  const parsed = databaseErrorSchema.safeParse(error);
  const databaseError = parsed.success ? parsed.data : undefined;

  if (databaseError?.code === "P0002" && databaseError.message === "studio_not_found") {
    throw new ApiRouteError(404, "NOT_FOUND", "O estúdio não foi encontrado.");
  }
  if (
    databaseError?.code === "42501" &&
    databaseError.message !== undefined &&
    forbiddenStudioDatabaseMessages.has(databaseError.message)
  ) {
    throw new ApiRouteError(
      403,
      "FORBIDDEN",
      "Esta conta não pode editar estúdios no estado atual.",
    );
  }
  if (
    (databaseError?.code === "40001" &&
      databaseError.message !== undefined &&
      conflictingStudioDatabaseMessages.has(databaseError.message)) ||
    (databaseError?.code === "23514" && databaseError.message === "studio_draft_missing")
  ) {
    throw new ApiRouteError(
      409,
      "CONFLICT",
      "O estúdio foi alterado por outra solicitação. Recarregue os dados atuais.",
    );
  }
  if (
    databaseError?.code === "22003" &&
    databaseError.message !== undefined &&
    exhaustedStudioDatabaseMessages.has(databaseError.message)
  ) {
    throw new ApiRouteError(
      409,
      "CONFLICT",
      "O estúdio atingiu o limite de versões suportado e não pode receber novas alterações.",
    );
  }
  if (
    (databaseError?.code === "22023" && databaseError.message === "studio_core_invalid") ||
    (databaseError?.code === "23514" && databaseError.message === "studio_type_unavailable")
  ) {
    throw new ApiRouteError(
      422,
      "VALIDATION_FAILED",
      "Revise os dados centrais do estúdio e tente novamente.",
    );
  }
  throw error;
}

function enforceStudioMutationRateLimit(userId: string) {
  enforceIdentityRateLimit(
    studioEditsRateLimit.partition,
    hashPrivateRateLimitValue(userId),
    studioEditsRateLimit,
  );
}

export function createStudioService(
  dependencies: StudioServiceDependencies = studioServiceDefaults,
) {
  async function createStudio(command: CreateStudioCommand, context: PrivateCommandContext) {
    assertMutableAccount(context);
    enforceStudioMutationRateLimit(context.session.userId);
    try {
      const studioTypes = await dependencies.readActiveStudioTypes();
      const row = await dependencies.createStudioDraft({
        core: command.payload.core,
        idempotencyKey: command.idempotencyKey,
        requestId: context.requestId,
        studioId: command.payload.studioId,
        userId: context.session.userId,
      });
      return mapOwnerStudioEditorDalRow(row, context.session.userId, studioTypes);
    } catch (error) {
      if (error instanceof ApiRouteError) throw error;
      return handleStudioDatabaseError(error);
    }
  }

  async function updateStudioCore(
    command: UpdateStudioCoreCommand,
    context: PrivateCommandContext,
  ) {
    assertMutableAccount(context);
    enforceStudioMutationRateLimit(context.session.userId);
    try {
      const studioTypes = await dependencies.readActiveStudioTypes();
      const row = await dependencies.updateStudioDraftCore({
        core: command.payload.core,
        expectedEditVersion: command.payload.expectedEditVersion,
        idempotencyKey: command.idempotencyKey,
        requestId: context.requestId,
        studioId: command.payload.studioId,
        userId: context.session.userId,
      });
      return mapOwnerStudioEditorDalRow(row, context.session.userId, studioTypes);
    } catch (error) {
      if (error instanceof ApiRouteError) throw error;
      return handleStudioDatabaseError(error);
    }
  }

  async function discardStudioDraft(
    command: DiscardStudioDraftCommand,
    context: PrivateCommandContext,
  ): Promise<StudioDraftDiscardResult> {
    assertMutableAccount(context);
    enforceStudioMutationRateLimit(context.session.userId);
    try {
      let editorBeforeDiscard: OwnerStudioEditorEditResult | null = null;
      try {
        const editor = await dependencies.readOwnerStudioEditor(
          context.session.userId,
          command.payload.studioId,
        );
        if (
          editor.mode !== "edit" ||
          editor.scope !== context.session.userId ||
          editor.studio.id !== command.payload.studioId
        ) {
          throw new Error("O editor anterior ao descarte retornou um escopo inesperado.");
        }
        editorBeforeDiscard = editor;
      } catch (error) {
        if (!(
          error instanceof ApiRouteError &&
          error.status === 404 &&
          error.code === "NOT_FOUND"
        )) {
          throw error;
        }
      }
      const result = await dependencies.discardStudioDraftInDatabase({
        expectedEditVersion: command.payload.expectedEditVersion,
        idempotencyKey: command.idempotencyKey,
        requestId: context.requestId,
        studioId: command.payload.studioId,
        userId: context.session.userId,
      });
      if (
        result.scope !== context.session.userId ||
        result.studio_id !== command.payload.studioId
      ) {
        throw new Error("O descarte de estúdio retornou um escopo inesperado.");
      }
      if (result.studio_deleted) {
        return studioDraftDiscardResultSchema.parse({
          outcome: "studio_removed",
          projection: "studio_draft_discard",
          scope: result.scope,
          studioId: result.studio_id,
        });
      }
      if (editorBeforeDiscard === null) {
        throw new Error("O descarte retido não possui um editor anterior válido.");
      }
      if (!result.draft_discarded || result.edit_version === null) {
        throw new Error("O descarte de rascunho não retornou a nova versão de edição.");
      }

      const nextExpectedEditVersion =
        command.payload.expectedEditVersion < Number.MAX_SAFE_INTEGER
          ? command.payload.expectedEditVersion + 1
          : null;
      const firstApplicationIsCurrent =
        nextExpectedEditVersion !== null &&
        editorBeforeDiscard.studio.draft !== null &&
        editorBeforeDiscard.studio.editVersion === command.payload.expectedEditVersion &&
        result.edit_version === nextExpectedEditVersion;
      const replayIsStillCurrent =
        editorBeforeDiscard.studio.draft === null &&
        editorBeforeDiscard.studio.editVersion === result.edit_version;

      if (!firstApplicationIsCurrent && !replayIsStillCurrent) {
        throw new Error("O resultado do descarte não corresponde ao editor atual.");
      }

      return studioDraftDiscardResultSchema.parse({
        editor: replayIsStillCurrent
          ? editorBeforeDiscard
          : {
              ...editorBeforeDiscard,
              studio: {
                ...editorBeforeDiscard.studio,
                draft: null,
                editVersion: result.edit_version,
              },
            },
        outcome: "draft_removed",
        projection: "studio_draft_discard",
        scope: result.scope,
        studioId: result.studio_id,
      });
    } catch (error) {
      if (error instanceof ApiRouteError) throw error;
      return handleStudioDatabaseError(error);
    }
  }

  return { createStudio, discardStudioDraft, updateStudioCore };
}

const studioService = createStudioService();

export const createStudio = studioService.createStudio;
export const discardStudioDraft = studioService.discardStudioDraft;
export const updateStudioCore = studioService.updateStudioCore;

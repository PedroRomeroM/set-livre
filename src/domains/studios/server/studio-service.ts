import "server-only";

import type { StudioCommand } from "@set-livre/contracts";
import { z } from "zod";

import type { PrivateCommandContext } from "@/domains/commands/server/private-command-context";
import { ApiRouteError, hashPrivateRateLimitValue } from "@/lib/server/api-route";
import { enforceIdentityRateLimit } from "@/lib/server/rate-limit";

import {
  createStudioDraft,
  discardStudioDraft,
  updateStudioRevisionContent,
  updateStudioRevisionCore,
  updateStudioRevisionTaxonomy,
} from "./studio-dal";

const databaseErrorSchema = z.object({
  code: z.string().optional(),
  message: z.string().optional(),
});

type StudioCreateCommand = Extract<StudioCommand, { action: "studio.create" }>;
type StudioUpdateCommand = Extract<StudioCommand, { action: "studio.revision.updateCore" }>;
type StudioContentCommand = Extract<StudioCommand, { action: "studio.revision.updateContent" }>;
type StudioTaxonomyCommand = Extract<StudioCommand, { action: "studio.revision.updateTaxonomy" }>;
type StudioDiscardCommand = Extract<StudioCommand, { action: "studio.draft.discard" }>;

export type StudioServiceDependencies = Readonly<{
  createStudioDraft: typeof createStudioDraft;
  discardStudioDraft: typeof discardStudioDraft;
  updateStudioRevisionCore: typeof updateStudioRevisionCore;
  updateStudioRevisionContent: typeof updateStudioRevisionContent;
  updateStudioRevisionTaxonomy: typeof updateStudioRevisionTaxonomy;
}>;

const studioServiceDefaults: StudioServiceDependencies = {
  createStudioDraft,
  discardStudioDraft,
  updateStudioRevisionCore,
  updateStudioRevisionContent,
  updateStudioRevisionTaxonomy,
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
    throw new ApiRouteError(409, "CONFLICT", "Conclua seu perfil antes de gerenciar estúdios.");
  }
}

function enforceStudioMutationRateLimit(action: StudioCommand["action"], userId: string) {
  const profile =
    action === "studio.media.upload.prepare"
      ? { limit: 20, windowMs: 60 * 60_000 }
      : { limit: 60, windowMs: 10 * 60_000 };
  enforceIdentityRateLimit(action, hashPrivateRateLimitValue(userId), profile);
}

function handleStudioDatabaseError(error: unknown): never {
  const parsed = databaseErrorSchema.safeParse(error);
  const databaseError = parsed.success ? parsed.data : undefined;

  if (databaseError?.code === "P0002") {
    throw new ApiRouteError(404, "NOT_FOUND", "Este estúdio não está disponível para sua conta.");
  }
  if (databaseError?.code === "42501") {
    if (databaseError.message === "owner_contract_not_current") {
      throw new ApiRouteError(
        409,
        "OWNER_CONTRACT_CHANGED",
        "O contrato do dono mudou. Recarregue a página e aceite a versão vigente antes de continuar.",
      );
    }
    throw new ApiRouteError(
      403,
      "FORBIDDEN",
      "Sua conta não pode alterar este estúdio no estado atual.",
    );
  }
  if (databaseError?.code === "22023") {
    throw new ApiRouteError(422, "VALIDATION_FAILED", "Revise os dados do estúdio.");
  }
  if (databaseError?.code === "23514" && databaseError.message === "studio_type_inactive") {
    throw new ApiRouteError(
      409,
      "STUDIO_TYPE_UNAVAILABLE",
      "O tipo de estúdio foi arquivado. Atualize as opções e escolha um tipo ativo.",
    );
  }
  if (databaseError?.code === "23514" && databaseError.message === "studio_taxonomy_inactive") {
    throw new ApiRouteError(
      409,
      "STUDIO_TAXONOMY_UNAVAILABLE",
      "Uma tag ou comodidade foi arquivada. Atualize as opções antes de continuar.",
    );
  }
  if (databaseError?.code === "23505" || databaseError?.code === "40001") {
    throw new ApiRouteError(
      409,
      "CONFLICT",
      "Este estúdio mudou em outra solicitação. Compare com a versão salva antes de continuar.",
    );
  }
  throw error;
}

export const studioServiceBoundary = {
  assertMutableAccount,
  enforceStudioMutationRateLimit,
  handleStudioDatabaseError,
};

export function createStudioService(
  dependencies: StudioServiceDependencies = studioServiceDefaults,
) {
  async function create(command: StudioCreateCommand, context: PrivateCommandContext) {
    assertMutableAccount(context);
    enforceStudioMutationRateLimit(command.action, context.session.userId);
    try {
      const editor = await dependencies.createStudioDraft({
        core: command.payload,
        idempotencyKey: command.idempotencyKey,
        requestId: context.requestId,
        userId: context.session.userId,
      });
      return { editor, idempotencyKey: command.idempotencyKey };
    } catch (error) {
      if (error instanceof ApiRouteError) throw error;
      return handleStudioDatabaseError(error);
    }
  }

  async function updateCore(command: StudioUpdateCommand, context: PrivateCommandContext) {
    assertMutableAccount(context);
    enforceStudioMutationRateLimit(command.action, context.session.userId);
    try {
      const { expectedRevisionId, expectedRevisionVersion, studioId, ...core } = command.payload;
      return await dependencies.updateStudioRevisionCore({
        core,
        expectedRevisionId,
        expectedRevisionVersion,
        idempotencyKey: command.idempotencyKey,
        requestId: context.requestId,
        studioId,
        userId: context.session.userId,
      });
    } catch (error) {
      if (error instanceof ApiRouteError) throw error;
      return handleStudioDatabaseError(error);
    }
  }

  async function discard(command: StudioDiscardCommand, context: PrivateCommandContext) {
    assertMutableAccount(context);
    enforceStudioMutationRateLimit(command.action, context.session.userId);
    try {
      return await dependencies.discardStudioDraft({
        ...command.payload,
        idempotencyKey: command.idempotencyKey,
        requestId: context.requestId,
        userId: context.session.userId,
      });
    } catch (error) {
      if (error instanceof ApiRouteError) throw error;
      return handleStudioDatabaseError(error);
    }
  }

  async function updateTaxonomy(command: StudioTaxonomyCommand, context: PrivateCommandContext) {
    assertMutableAccount(context);
    enforceStudioMutationRateLimit(command.action, context.session.userId);
    try {
      const { expectedRevisionId, expectedRevisionVersion, studioId, ...taxonomy } =
        command.payload;
      return await dependencies.updateStudioRevisionTaxonomy({
        expectedRevisionId,
        expectedRevisionVersion,
        idempotencyKey: command.idempotencyKey,
        requestId: context.requestId,
        studioId,
        taxonomy,
        userId: context.session.userId,
      });
    } catch (error) {
      if (error instanceof ApiRouteError) throw error;
      return handleStudioDatabaseError(error);
    }
  }

  async function updateContent(command: StudioContentCommand, context: PrivateCommandContext) {
    assertMutableAccount(context);
    enforceStudioMutationRateLimit(command.action, context.session.userId);
    try {
      const { expectedRevisionId, expectedRevisionVersion, studioId, ...content } = command.payload;
      return await dependencies.updateStudioRevisionContent({
        content,
        expectedRevisionId,
        expectedRevisionVersion,
        idempotencyKey: command.idempotencyKey,
        requestId: context.requestId,
        studioId,
        userId: context.session.userId,
      });
    } catch (error) {
      if (error instanceof ApiRouteError) throw error;
      return handleStudioDatabaseError(error);
    }
  }

  return { create, discard, updateContent, updateCore, updateTaxonomy };
}

const studioService = createStudioService();

export const createStudio = studioService.create;
export const discardStudio = studioService.discard;
export const updateStudioCore = studioService.updateCore;
export const updateStudioContent = studioService.updateContent;
export const updateStudioTaxonomy = studioService.updateTaxonomy;

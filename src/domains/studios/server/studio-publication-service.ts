import "server-only";

import type { StudioCommand, StudioPublicationRecord } from "@set-livre/contracts";
import { z } from "zod";

import type { PrivateCommandContext } from "@/domains/commands/server/private-command-context";
import { ApiRouteError } from "@/lib/server/api-route";

import { pauseStudio, resumeStudio, submitStudioRevision } from "./studio-publication-dal";
import {
  assertStudioPublicationBoundary,
  isStudioPublicationAbortError,
  signStudioPublicationCovers,
} from "./studio-publication-read-model";
import { StudioMediaStorageError, type StudioMediaStorage } from "./studio-media-storage";
import { studioServiceBoundary } from "./studio-service";

type StudioPublicationCommand = Extract<
  StudioCommand,
  { action: "studio.pause" | "studio.resume" | "studio.revision.submit" }
>;

const publicationDatabaseErrorSchema = z.object({
  code: z.string().optional(),
  message: z.string().optional(),
});

const publicationStateConflictMessages = new Set([
  "studio_pause_state_invalid",
  "studio_resume_state_invalid",
  "studio_submission_state_invalid",
]);

export type StudioPublicationServiceDependencies = Readonly<{
  pauseStudio: typeof pauseStudio;
  resumeStudio: typeof resumeStudio;
  submitStudioRevision: typeof submitStudioRevision;
}>;

const studioPublicationServiceDefaults: StudioPublicationServiceDependencies = {
  pauseStudio,
  resumeStudio,
  submitStudioRevision,
};

function publicationStorage(context: PrivateCommandContext) {
  if (context.studioMediaStorage === undefined) {
    throw new Error("O adaptador privado de mídia não foi configurado para a publicação.");
  }
  return context.studioMediaStorage;
}

function signStudioPublicationCommandResult(
  record: StudioPublicationRecord,
  command: StudioPublicationCommand,
  context: PrivateCommandContext,
  storage: StudioMediaStorage,
) {
  return signStudioPublicationCovers(
    assertStudioPublicationBoundary(record, context.session.userId, command.payload.studioId),
    storage,
  );
}

function handleStudioPublicationError(error: unknown): never {
  if (error instanceof ApiRouteError) throw error;
  if (error instanceof StudioMediaStorageError) {
    throw new ApiRouteError(
      503,
      "SERVICE_UNAVAILABLE",
      "Não foi possível assinar a prévia da publicação agora. Confirme o estado antes de repetir.",
    );
  }
  if (isStudioPublicationAbortError(error)) {
    throw new ApiRouteError(
      503,
      "SERVICE_UNAVAILABLE",
      "A operação de publicação excedeu o prazo seguro. Confirme o estado antes de repetir.",
    );
  }

  const parsed = publicationDatabaseErrorSchema.safeParse(error);
  if (parsed.success) {
    const { code, message } = parsed.data;
    if (code === "23514" && message === "studio_submission_incomplete") {
      throw new ApiRouteError(
        422,
        "STUDIO_SUBMISSION_INCOMPLETE",
        "Complete os dados, o conteúdo e a mídia obrigatórios antes de enviar para revisão.",
      );
    }
    if (
      code === "23514" &&
      message !== undefined &&
      publicationStateConflictMessages.has(message)
    ) {
      throw new ApiRouteError(
        409,
        "CONFLICT",
        "O estado editorial do estúdio mudou. Recarregue a publicação antes de continuar.",
      );
    }
    if (code === "42501" && message === "studio_disabled") {
      throw new ApiRouteError(
        403,
        "FORBIDDEN",
        "Este estúdio foi desativado e não pode ser alterado pelo dono.",
      );
    }
  }
  return studioServiceBoundary.handleStudioDatabaseError(error);
}

export function createStudioPublicationService(
  dependencies: StudioPublicationServiceDependencies = studioPublicationServiceDefaults,
) {
  async function execute(command: StudioPublicationCommand, context: PrivateCommandContext) {
    studioServiceBoundary.assertMutableAccount(context);
    studioServiceBoundary.enforceStudioMutationRateLimit(command.action, context.session.userId);
    const storage = publicationStorage(context);

    try {
      const identity = {
        idempotencyKey: command.idempotencyKey,
        requestId: context.requestId,
        studioId: command.payload.studioId,
        userId: context.session.userId,
      };
      switch (command.action) {
        case "studio.revision.submit":
          return await signStudioPublicationCommandResult(
            await dependencies.submitStudioRevision({
              ...identity,
              expectedRevisionId: command.payload.expectedRevisionId,
              expectedRevisionVersion: command.payload.expectedRevisionVersion,
            }),
            command,
            context,
            storage,
          );
        case "studio.pause":
          return await signStudioPublicationCommandResult(
            await dependencies.pauseStudio({
              ...identity,
              expectedPublicationVersion: command.payload.expectedPublicationVersion,
            }),
            command,
            context,
            storage,
          );
        case "studio.resume":
          return await signStudioPublicationCommandResult(
            await dependencies.resumeStudio({
              ...identity,
              expectedPublicationVersion: command.payload.expectedPublicationVersion,
            }),
            command,
            context,
            storage,
          );
      }
    } catch (error) {
      return handleStudioPublicationError(error);
    }
  }

  return { execute };
}

const studioPublicationService = createStudioPublicationService();

export const executeStudioPublicationCommand = studioPublicationService.execute;

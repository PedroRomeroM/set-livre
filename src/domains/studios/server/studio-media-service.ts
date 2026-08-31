import "server-only";

import type { StudioCommand, StudioMediaCommand } from "@set-livre/contracts";
import { z } from "zod";

import type { PrivateCommandContext } from "@/domains/commands/server/private-command-context";
import { ApiRouteError } from "@/lib/server/api-route";

import {
  deleteStudioMedia,
  finalizeStudioMediaUpload,
  prepareStudioMediaUpload,
  readStudioMediaUploadCandidate,
  rejectStudioMediaUpload,
  replayStudioMediaFinalize,
  reorderStudioMedia,
  setStudioMediaCover,
} from "./studio-media-dal";
import {
  StudioMediaCapacityError,
  StudioMediaImageError,
  verifyStudioMediaImage,
  withStudioMediaImageCapacity,
} from "./studio-media-image";
import { StudioMediaStorageError } from "./studio-media-storage";
import { studioServiceBoundary } from "./studio-service";

type MediaCommand = Extract<StudioCommand, StudioMediaCommand>;

const mediaDatabaseErrorSchema = z.object({
  code: z.string().optional(),
  message: z.string().optional(),
});

function mediaStorage(context: PrivateCommandContext) {
  if (context.studioMediaStorage === undefined) {
    throw new Error("O adaptador privado de mídia não foi configurado na rota de comandos.");
  }
  return context.studioMediaStorage;
}

function handleMediaError(error: unknown): never {
  if (error instanceof ApiRouteError) throw error;
  if (error instanceof StudioMediaCapacityError) {
    throw new ApiRouteError(
      503,
      "SERVICE_UNAVAILABLE",
      "O processamento seguro de fotos está ocupado. Tente novamente em instantes.",
    );
  }
  if (error instanceof StudioMediaStorageError) {
    if (error.operation === "download" && error.reason === "not-found") {
      throw new ApiRouteError(
        409,
        "UPLOAD_OBJECT_MISSING",
        "O arquivo não chegou ao armazenamento. Renove o envio antes de finalizar.",
      );
    }
    throw new ApiRouteError(
      503,
      "SERVICE_UNAVAILABLE",
      "O armazenamento de fotos está temporariamente indisponível.",
    );
  }
  const databaseError = mediaDatabaseErrorSchema.safeParse(error);
  if (databaseError.success) {
    const { code, message } = databaseError.data;
    if (code === "23514" && message === "studio_media_limit_reached") {
      throw new ApiRouteError(
        409,
        "MEDIA_LIMIT_REACHED",
        "Este estúdio já possui o limite de 20 fotos.",
      );
    }
    if (code === "23514" && message === "studio_media_order_set_mismatch") {
      throw new ApiRouteError(
        409,
        "MEDIA_ORDER_CHANGED",
        "A galeria mudou em outra solicitação. Recarregue as fotos antes de ordenar novamente.",
      );
    }
    if (code === "23514" && message === "studio_media_cover_replacement_required") {
      throw new ApiRouteError(
        409,
        "MEDIA_COVER_REPLACEMENT_REQUIRED",
        "Escolha outra foto de capa antes de excluir a capa atual.",
      );
    }
    if (code === "23514" && message === "studio_media_metadata_mismatch") {
      throw new ApiRouteError(
        422,
        "VALIDATION_FAILED",
        "A foto enviada não corresponde aos dados verificados.",
      );
    }
    if (code === "40001" && message === "studio_media_upload_expired") {
      throw new ApiRouteError(
        409,
        "UPLOAD_EXPIRED",
        "A autorização de envio expirou. Renove o envio antes de finalizar.",
      );
    }
  }
  return studioServiceBoundary.handleStudioDatabaseError(error);
}

export async function executeStudioMediaCommand(
  command: MediaCommand,
  context: PrivateCommandContext,
) {
  studioServiceBoundary.assertMutableAccount(context);
  studioServiceBoundary.enforceStudioMutationRateLimit(command.action, context.session.userId);
  const storage = mediaStorage(context);

  try {
    switch (command.action) {
      case "studio.media.upload.prepare": {
        const preparation = await prepareStudioMediaUpload({
          ...command.payload,
          idempotencyKey: command.idempotencyKey,
          requestId: context.requestId,
          userId: context.session.userId,
        });
        const signedToken = await storage.createUploadToken(preparation.path);
        return { ...preparation, signedToken };
      }
      case "studio.media.upload.finalize": {
        const input = {
          ...command.payload,
          idempotencyKey: command.idempotencyKey,
          requestId: context.requestId,
          userId: context.session.userId,
        };
        const replay = await replayStudioMediaFinalize(input);
        if (replay !== null) {
          return storage.signGalleryPreviews(replay);
        }
        const candidate = await readStudioMediaUploadCandidate(input);
        const verification = await withStudioMediaImageCapacity(async () => {
          let verified;
          try {
            verified = await verifyStudioMediaImage(
              await storage.download(candidate.path),
              candidate,
            );
          } catch (error) {
            if (!(error instanceof StudioMediaImageError)) throw error;
            await rejectStudioMediaUpload(input);
            throw new ApiRouteError(
              422,
              "VALIDATION_FAILED",
              "A foto enviada não corresponde ao tipo, tamanho ou conteúdo informado.",
            );
          }
          await storage.uploadPreview(candidate.previewPath, verified.previewBytes);
          return verified.verification;
        });
        return storage.signGalleryPreviews(
          await finalizeStudioMediaUpload({ ...input, verification }),
        );
      }
      case "studio.media.reorder":
        return storage.signGalleryPreviews(
          await reorderStudioMedia({
            ...command.payload,
            idempotencyKey: command.idempotencyKey,
            requestId: context.requestId,
            userId: context.session.userId,
          }),
        );
      case "studio.media.cover.set":
        return storage.signGalleryPreviews(
          await setStudioMediaCover({
            ...command.payload,
            idempotencyKey: command.idempotencyKey,
            requestId: context.requestId,
            userId: context.session.userId,
          }),
        );
      case "studio.media.delete":
        return storage.signGalleryPreviews(
          await deleteStudioMedia({
            ...command.payload,
            idempotencyKey: command.idempotencyKey,
            requestId: context.requestId,
            userId: context.session.userId,
          }),
        );
    }
  } catch (error) {
    return handleMediaError(error);
  }
}

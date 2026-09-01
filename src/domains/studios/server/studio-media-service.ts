import "server-only";

import type { StudioCommand, StudioMediaCommand } from "@set-livre/contracts";
import { z } from "zod";

import type { PrivateCommandContext } from "@/domains/commands/server/private-command-context";
import { ApiRouteError } from "@/lib/server/api-route";

import {
  deleteStudioMedia,
  finalizeStudioMediaUpload,
  prepareStudioMediaUpload,
  rejectStudioMediaUpload,
  renewStudioMediaFinalizeClaim,
  reorderStudioMedia,
  setStudioMediaCover,
  StudioMediaFinalizeClaimBusyError,
  withStudioMediaFinalizeClaim,
} from "./studio-media-dal";
import {
  StudioMediaCapacityError,
  StudioMediaDeadlineError,
  StudioMediaImageError,
  verifyStudioMediaImage,
  withStudioMediaImageCapacity,
} from "./studio-media-image";
import {
  studioMediaPreviewSigningDeadlineMs,
  StudioMediaStorageError,
  type StudioMediaStorage,
} from "./studio-media-storage";
import { studioServiceBoundary } from "./studio-service";

type MediaCommand = Extract<StudioCommand, StudioMediaCommand>;

const studioMediaFinalizeMinimumLeaseRemainingMs = 22_000;

const mediaDatabaseErrorSchema = z.object({
  code: z.string().optional(),
  message: z.string().optional(),
});

function isStudioMediaRevisionConflict(error: unknown) {
  const parsed = mediaDatabaseErrorSchema.safeParse(error);
  return (
    parsed.success &&
    parsed.data.code === "40001" &&
    parsed.data.message === "studio_revision_conflict"
  );
}

function studioMediaRevisionConflict() {
  return { code: "40001", message: "studio_revision_conflict" } as const;
}

function assertStudioMediaFinalizeLeaseBudget(leaseExpiresAt: string) {
  if (Date.parse(leaseExpiresAt) - Date.now() < studioMediaFinalizeMinimumLeaseRemainingMs) {
    throw new StudioMediaFinalizeClaimBusyError();
  }
}

function throwStudioMediaFinalizeRejection(
  rejectionCode: "object_missing" | "superseded" | "validation_failed",
): never {
  if (rejectionCode === "object_missing") {
    throw new ApiRouteError(
      409,
      "UPLOAD_OBJECT_MISSING",
      "O arquivo não chegou ao armazenamento. Renove o envio antes de finalizar.",
    );
  }
  if (rejectionCode === "validation_failed") {
    throw new ApiRouteError(
      422,
      "VALIDATION_FAILED",
      "A foto enviada não corresponde ao tipo, tamanho ou conteúdo informado.",
    );
  }
  throw studioMediaRevisionConflict();
}

function mediaStorage(context: PrivateCommandContext) {
  if (context.studioMediaStorage === undefined) {
    throw new Error("O adaptador privado de mídia não foi configurado na rota de comandos.");
  }
  return context.studioMediaStorage;
}

async function signCommandGallery(
  storage: StudioMediaStorage,
  gallery: Parameters<StudioMediaStorage["signGalleryPreviews"]>[0],
) {
  const controller = new AbortController();
  const timeoutError = new StudioMediaStorageError("preview");
  const abortOutcome = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => reject(controller.signal.reason ?? timeoutError),
      { once: true },
    );
  });
  const timer = setTimeout(
    () => controller.abort(timeoutError),
    studioMediaPreviewSigningDeadlineMs,
  );
  try {
    return await Promise.race([
      storage.signGalleryPreviews(gallery, controller.signal),
      abortOutcome,
    ]);
  } finally {
    clearTimeout(timer);
  }
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
  if (error instanceof StudioMediaDeadlineError) {
    throw new ApiRouteError(
      503,
      "SERVICE_UNAVAILABLE",
      "A verificação segura da foto excedeu o prazo. Confirme o estado antes de repetir.",
    );
  }
  if (error instanceof StudioMediaFinalizeClaimBusyError) {
    throw new ApiRouteError(
      503,
      "SERVICE_UNAVAILABLE",
      "Esta foto ainda está sendo finalizada. Verifique o estado antes de repetir.",
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
    if (
      code === "40001" &&
      (message === "studio_media_finalize_claim_lost" ||
        message === "studio_media_finalize_claim_inconsistent")
    ) {
      throw new ApiRouteError(
        503,
        "SERVICE_UNAVAILABLE",
        "A finalização segura da foto perdeu sua autorização. Confirme o estado antes de repetir.",
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
        const gallery = await withStudioMediaFinalizeClaim(input, async (claim) => {
          if (claim.state === "replay") return claim.result;
          if (claim.state === "rejected") {
            return throwStudioMediaFinalizeRejection(claim.rejectionCode);
          }
          if (claim.state === "superseded") {
            await rejectStudioMediaUpload({
              claimToken: claim.claimToken,
              rejectionCode: "superseded",
              requestId: context.requestId,
            });
            throw studioMediaRevisionConflict();
          }

          assertStudioMediaFinalizeLeaseBudget(claim.leaseExpiresAt);
          try {
            const verification = await withStudioMediaImageCapacity(async (deadline) => {
              let verified;
              try {
                verified = await verifyStudioMediaImage(
                  await storage.download(claim.candidate.path, deadline.signal),
                  claim.candidate,
                  deadline,
                );
              } catch (error) {
                const objectMissing =
                  error instanceof StudioMediaStorageError &&
                  error.operation === "download" &&
                  error.reason === "not-found";
                if (!objectMissing && !(error instanceof StudioMediaImageError)) throw error;
                await rejectStudioMediaUpload({
                  claimToken: claim.claimToken,
                  rejectionCode: objectMissing ? "object_missing" : "validation_failed",
                  requestId: context.requestId,
                });
                if (objectMissing) throw error;
                throw new ApiRouteError(
                  422,
                  "VALIDATION_FAILED",
                  "A foto enviada não corresponde ao tipo, tamanho ou conteúdo informado.",
                );
              }
              await renewStudioMediaFinalizeClaim({ claimToken: claim.claimToken });
              await storage.uploadPreview(
                claim.candidate.previewPath,
                verified.previewBytes,
                deadline.signal,
              );
              return verified.verification;
            });
            return finalizeStudioMediaUpload({
              claimToken: claim.claimToken,
              requestId: context.requestId,
              verification,
            });
          } catch (error) {
            if (isStudioMediaRevisionConflict(error)) {
              await rejectStudioMediaUpload({
                claimToken: claim.claimToken,
                rejectionCode: "superseded",
                requestId: context.requestId,
              });
            }
            throw error;
          }
        });
        return signCommandGallery(storage, gallery);
      }
      case "studio.media.reorder": {
        const result = await signCommandGallery(
          storage,
          await reorderStudioMedia({
            ...command.payload,
            idempotencyKey: command.idempotencyKey,
            requestId: context.requestId,
            userId: context.session.userId,
          }),
        );
        return result;
      }
      case "studio.media.cover.set": {
        const result = await signCommandGallery(
          storage,
          await setStudioMediaCover({
            ...command.payload,
            idempotencyKey: command.idempotencyKey,
            requestId: context.requestId,
            userId: context.session.userId,
          }),
        );
        return result;
      }
      case "studio.media.delete": {
        const result = await signCommandGallery(
          storage,
          await deleteStudioMedia({
            ...command.payload,
            idempotencyKey: command.idempotencyKey,
            requestId: context.requestId,
            userId: context.session.userId,
          }),
        );
        return result;
      }
    }
  } catch (error) {
    return handleMediaError(error);
  }
}

import "server-only";

import { studioMediaGalleryRecordSchema } from "@set-livre/contracts";
import { z } from "zod";

import { readOwnerStudioMediaRecord } from "./studio-media-dal";
import {
  createTrustedStudioMediaStorage,
  studioMediaPreviewSigningDeadlineMs,
} from "./studio-media-storage";

export class StudioMediaNotFoundError extends Error {
  constructor() {
    super("A galeria solicitada não foi encontrada para a sessão atual.");
    this.name = "StudioMediaNotFoundError";
  }
}

function assertStudioMediaBoundary(
  record: unknown,
  expectedUserId: string,
  expectedStudioId: string,
) {
  const gallery = studioMediaGalleryRecordSchema.parse(record);
  if (gallery.scope !== expectedUserId || gallery.studioId !== expectedStudioId) {
    throw new Error("A galeria retornou uma fronteira diferente da sessão solicitante.");
  }
  return gallery;
}

export async function readOwnerStudioMedia(
  userId: string,
  studioId: string,
  externalSignal?: AbortSignal,
) {
  const parsedUserId = z.uuid().parse(userId);
  const parsedStudioId = z.uuid().parse(studioId);
  const controller = new AbortController();
  const abortError = new DOMException("A leitura da galeria expirou.", "AbortError");
  const abortOutcome = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => reject(abortError), { once: true });
  });
  const abortFromExternal = () => controller.abort();
  let deadline: ReturnType<typeof setTimeout> | undefined;

  try {
    if (externalSignal?.aborted === true) controller.abort();
    else externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
    deadline = setTimeout(() => controller.abort(), studioMediaPreviewSigningDeadlineMs);
    const galleryOutcome = readOwnerStudioMediaRecord({
      studioId: parsedStudioId,
      userId: parsedUserId,
    })
      .then((record) => {
        if (record === null) throw new StudioMediaNotFoundError();
        return assertStudioMediaBoundary(record, parsedUserId, parsedStudioId);
      })
      .then((gallery) =>
        createTrustedStudioMediaStorage().signGalleryPreviews(gallery, controller.signal),
      );
    return await Promise.race([galleryOutcome, abortOutcome]);
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
    externalSignal?.removeEventListener("abort", abortFromExternal);
  }
}

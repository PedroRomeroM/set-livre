import { z } from "zod";

export const studioMediaMaximumFiles = 20;
export const studioMediaMaximumBytes = 15 * 1024 * 1024;
export const studioMediaBucket = "studio-media" as const;
export const studioMediaPrivateCacheSeconds = 60;
export const studioMediaPreviewLifetimeSeconds = 5 * 60;
export const studioMediaPreviewMaximumBytes = 3 * 1024 * 1024;
export const studioMediaPreviewMaximumEdge = 1_280;
export const studioMediaUploadDeadlineMs = 60_000;
export const studioMediaMaximumDimension = 8_192;
export const studioMediaMaximumPixels = 36_000_000;

export const studioMediaMimeTypeSchema = z.enum([
  "image/avif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export const studioMediaChecksumSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/u, "O checksum SHA-256 precisa usar 64 caracteres hexadecimais.");

const studioMediaUuidPattern = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const studioMediaPathPattern = new RegExp(
  `^owners/(${studioMediaUuidPattern})/studios/(${studioMediaUuidPattern})/revisions/(${studioMediaUuidPattern})/(${studioMediaUuidPattern})\\.(avif|jpe?g|png|webp)$`,
  "u",
);
const studioMediaPreviewPathPattern = new RegExp(
  `^owners/(${studioMediaUuidPattern})/studios/(${studioMediaUuidPattern})/revisions/(${studioMediaUuidPattern})/(${studioMediaUuidPattern})\\.preview\\.webp$`,
  "u",
);

export type StudioMediaPathIdentity = Readonly<{
  extension: string;
  mediaId: string;
  revisionId: string;
  scope: string;
  studioId: string;
}>;

function pathIdentity(rawPath: string, preview: boolean): StudioMediaPathIdentity | undefined {
  const match = (preview ? studioMediaPreviewPathPattern : studioMediaPathPattern).exec(rawPath);
  const scope = match?.[1];
  const studioId = match?.[2];
  const revisionId = match?.[3];
  const mediaId = match?.[4];
  const extension = preview ? "webp" : match?.[5];
  if (
    scope === undefined ||
    studioId === undefined ||
    revisionId === undefined ||
    mediaId === undefined ||
    extension === undefined
  ) {
    return undefined;
  }
  return { extension, mediaId, revisionId, scope, studioId };
}

export const studioMediaPathSchema = z
  .string()
  .regex(studioMediaPathPattern, "O caminho da mídia não corresponde ao namespace canônico.");

export const studioMediaPreviewPathSchema = z
  .string()
  .regex(
    studioMediaPreviewPathPattern,
    "O caminho da prévia não corresponde ao namespace canônico.",
  );

export function parseStudioMediaPathIdentity(rawPath: string) {
  const path = studioMediaPathSchema.parse(rawPath);
  const identity = pathIdentity(path, false);
  if (identity === undefined) throw new Error("O caminho canônico não publicou sua identidade.");
  return identity;
}

export function parseStudioMediaPreviewPathIdentity(rawPath: string) {
  const path = studioMediaPreviewPathSchema.parse(rawPath);
  const identity = pathIdentity(path, true);
  if (identity === undefined) throw new Error("A prévia canônica não publicou sua identidade.");
  return identity;
}

export const studioMediaDeclarationSchema = z.strictObject({
  declaredByteSize: z
    .number()
    .int("O tamanho do arquivo precisa ser inteiro.")
    .min(1, "A foto está vazia.")
    .max(studioMediaMaximumBytes, "Cada foto pode ter no máximo 15 MB."),
  declaredChecksumSha256: studioMediaChecksumSchema.nullable(),
  declaredMimeType: studioMediaMimeTypeSchema,
});

const studioMediaRevisionBoundarySchema = z.strictObject({
  expectedRevisionId: z.uuid(),
  expectedRevisionVersion: z.number().int().positive(),
  studioId: z.uuid(),
});

const privateStudioMediaCommandEnvelope = {
  expectedScope: z.uuid(),
  idempotencyKey: z.uuid(),
} as const;

export const studioMediaUploadPrepareCommandSchema = z.strictObject({
  action: z.literal("studio.media.upload.prepare"),
  ...privateStudioMediaCommandEnvelope,
  payload: studioMediaRevisionBoundarySchema.extend(studioMediaDeclarationSchema.shape),
});

export const studioMediaUploadFinalizeCommandSchema = z.strictObject({
  action: z.literal("studio.media.upload.finalize"),
  ...privateStudioMediaCommandEnvelope,
  payload: studioMediaRevisionBoundarySchema.extend({ mediaId: z.uuid() }),
});

export const studioMediaReorderCommandSchema = z.strictObject({
  action: z.literal("studio.media.reorder"),
  ...privateStudioMediaCommandEnvelope,
  payload: studioMediaRevisionBoundarySchema.extend({
    orderedMediaIds: z
      .array(z.uuid())
      .min(1)
      .max(studioMediaMaximumFiles)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "A ordem não pode repetir a mesma foto.",
      }),
  }),
});

export const studioMediaCoverSetCommandSchema = z.strictObject({
  action: z.literal("studio.media.cover.set"),
  ...privateStudioMediaCommandEnvelope,
  payload: studioMediaRevisionBoundarySchema.extend({ mediaId: z.uuid() }),
});

export const studioMediaDeleteCommandSchema = z.strictObject({
  action: z.literal("studio.media.delete"),
  ...privateStudioMediaCommandEnvelope,
  payload: studioMediaRevisionBoundarySchema.extend({ mediaId: z.uuid() }),
});

export const studioMediaCommandActionSchema = z.enum([
  "studio.media.upload.prepare",
  "studio.media.upload.finalize",
  "studio.media.reorder",
  "studio.media.cover.set",
  "studio.media.delete",
]);

export const studioMediaCommandSchema = z.discriminatedUnion("action", [
  studioMediaUploadPrepareCommandSchema,
  studioMediaUploadFinalizeCommandSchema,
  studioMediaReorderCommandSchema,
  studioMediaCoverSetCommandSchema,
  studioMediaDeleteCommandSchema,
]);

const studioMediaRecordBaseSchema = z.strictObject({
  byteSize: z.number().int().min(1).max(studioMediaMaximumBytes),
  checksumSha256: studioMediaChecksumSchema,
  height: z.number().int().min(1).max(studioMediaMaximumDimension),
  id: z.uuid(),
  isCover: z.boolean(),
  mimeType: studioMediaMimeTypeSchema,
  position: z.number().int().min(1).max(studioMediaMaximumFiles),
  previewStoragePath: studioMediaPreviewPathSchema,
  width: z.number().int().min(1).max(studioMediaMaximumDimension),
});

export const studioMediaRecordSchema = studioMediaRecordBaseSchema.refine(
  (item) => item.width * item.height <= studioMediaMaximumPixels,
  {
    message: "A foto excede o orçamento seguro de pixels.",
    path: ["width"],
  },
);

const studioMediaGalleryBoundaryShape = {
  revisionId: z.uuid(),
  revisionNumber: z.number().int().positive(),
  revisionVersion: z.number().int().positive(),
  scope: z.uuid(),
  studioId: z.uuid(),
} as const;

function validateStudioMediaOrderAndCover(
  gallery: Readonly<{
    items: ReadonlyArray<{
      id?: string;
      isCover: boolean;
      position: number;
      previewStoragePath?: string;
    }>;
    revisionId?: string;
    scope?: string;
    studioId?: string;
  }>,
  context: z.RefinementCtx,
) {
  const mediaIds = gallery.items.flatMap((item) => (item.id === undefined ? [] : [item.id]));
  gallery.items.forEach((item, index) => {
    if (item.position !== index + 1) {
      context.addIssue({
        code: "custom",
        message: "A ordem da galeria precisa ser contínua.",
        path: ["items", index, "position"],
      });
    }
    if (
      item.id !== undefined &&
      item.previewStoragePath !== undefined &&
      gallery.scope !== undefined &&
      gallery.studioId !== undefined &&
      gallery.revisionId !== undefined
    ) {
      const identity = pathIdentity(item.previewStoragePath, true);
      if (
        identity === undefined ||
        identity.scope !== gallery.scope ||
        identity.studioId !== gallery.studioId ||
        identity.revisionId !== gallery.revisionId ||
        identity.mediaId !== item.id
      ) {
        context.addIssue({
          code: "custom",
          message: "A prévia não corresponde à identidade da galeria.",
          path: ["items", index, "previewStoragePath"],
        });
      }
    }
  });
  if (new Set(mediaIds).size !== mediaIds.length) {
    context.addIssue({
      code: "custom",
      message: "A galeria não pode repetir a mesma foto.",
      path: ["items"],
    });
  }
  const coverCount = gallery.items.filter((item) => item.isCover).length;
  if (coverCount !== (gallery.items.length === 0 ? 0 : 1)) {
    context.addIssue({
      code: "custom",
      message: "Uma galeria não vazia precisa possuir exatamente uma capa.",
      path: ["items"],
    });
  }
}

export const studioMediaGalleryRecordSchema = z
  .strictObject({
    ...studioMediaGalleryBoundaryShape,
    items: z.array(studioMediaRecordSchema).max(studioMediaMaximumFiles),
  })
  .superRefine(validateStudioMediaOrderAndCover);

export const studioMediaItemSchema = studioMediaRecordBaseSchema
  .omit({ previewStoragePath: true })
  .extend({ previewUrl: z.url() })
  .refine((item) => item.width * item.height <= studioMediaMaximumPixels, {
    message: "A foto excede o orçamento seguro de pixels.",
    path: ["width"],
  });

export const studioMediaGallerySchema = z
  .strictObject({
    ...studioMediaGalleryBoundaryShape,
    items: z.array(studioMediaItemSchema).max(studioMediaMaximumFiles),
    previewExpiresAt: z.iso.datetime({ offset: true }),
  })
  .superRefine(validateStudioMediaOrderAndCover);

const studioMediaUploadPreparationRecordShape = {
  bucket: z.literal(studioMediaBucket),
  expiresAt: z.iso.datetime({ offset: true }),
  mediaId: z.uuid(),
  path: studioMediaPathSchema,
  revisionId: z.uuid(),
  revisionVersion: z.number().int().positive(),
  scope: z.uuid(),
  studioId: z.uuid(),
} as const;

function validateStudioMediaUploadIdentity(
  value: Readonly<{
    declaredMimeType?: StudioMediaMimeType;
    mediaId: string;
    path: string;
    previewPath?: string;
    revisionId: string;
    scope: string;
    studioId: string;
  }>,
  context: z.RefinementCtx,
) {
  const identity = pathIdentity(value.path, false);
  const expectedExtension =
    value.declaredMimeType === undefined
      ? identity?.extension
      : studioMediaExtensionByMimeType[value.declaredMimeType];
  if (
    identity === undefined ||
    identity.scope !== value.scope ||
    identity.studioId !== value.studioId ||
    identity.revisionId !== value.revisionId ||
    identity.mediaId !== value.mediaId ||
    identity.extension !== expectedExtension
  ) {
    context.addIssue({
      code: "custom",
      message: "O path não corresponde à identidade reservada para o upload.",
      path: ["path"],
    });
  }
  if (value.previewPath !== undefined) {
    const previewIdentity = pathIdentity(value.previewPath, true);
    if (
      previewIdentity === undefined ||
      previewIdentity.scope !== value.scope ||
      previewIdentity.studioId !== value.studioId ||
      previewIdentity.revisionId !== value.revisionId ||
      previewIdentity.mediaId !== value.mediaId
    ) {
      context.addIssue({
        code: "custom",
        message: "A prévia não corresponde à identidade reservada para o upload.",
        path: ["previewPath"],
      });
    }
  }
}

export const studioMediaUploadPreparationRecordSchema = z
  .strictObject(studioMediaUploadPreparationRecordShape)
  .superRefine(validateStudioMediaUploadIdentity);

export const studioMediaUploadPreparationSchema = z
  .strictObject({
    ...studioMediaUploadPreparationRecordShape,
    signedToken: z.string().min(1),
  })
  .superRefine(validateStudioMediaUploadIdentity);

export const studioMediaUploadCandidateSchema = z
  .strictObject({
    ...studioMediaUploadPreparationRecordShape,
    declaredByteSize: z.number().int().min(1).max(studioMediaMaximumBytes),
    declaredChecksumSha256: studioMediaChecksumSchema.nullable(),
    declaredMimeType: studioMediaMimeTypeSchema,
    previewPath: studioMediaPreviewPathSchema,
  })
  .superRefine(validateStudioMediaUploadIdentity);

export const studioMediaVerificationSchema = z
  .strictObject({
    byteSize: z.number().int().min(1).max(studioMediaMaximumBytes),
    checksumSha256: studioMediaChecksumSchema,
    height: z.number().int().min(1).max(studioMediaMaximumDimension),
    mimeType: studioMediaMimeTypeSchema,
    width: z.number().int().min(1).max(studioMediaMaximumDimension),
  })
  .refine((verification) => verification.width * verification.height <= studioMediaMaximumPixels, {
    message: "A foto excede o orçamento seguro de pixels.",
    path: ["width"],
  });

export const studioMediaExtensionByMimeType: Readonly<Record<StudioMediaMimeType, string>> = {
  "image/avif": "avif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export type StudioMediaCommand = z.infer<typeof studioMediaCommandSchema>;
export type StudioMediaCommandAction = z.infer<typeof studioMediaCommandActionSchema>;
export type StudioMediaGallery = z.infer<typeof studioMediaGallerySchema>;
export type StudioMediaGalleryRecord = z.infer<typeof studioMediaGalleryRecordSchema>;
export type StudioMediaMimeType = z.infer<typeof studioMediaMimeTypeSchema>;
export type StudioMediaUploadCandidate = z.infer<typeof studioMediaUploadCandidateSchema>;
export type StudioMediaUploadPreparation = z.infer<typeof studioMediaUploadPreparationSchema>;
export type StudioMediaUploadPreparationRecord = z.infer<
  typeof studioMediaUploadPreparationRecordSchema
>;
export type StudioMediaVerification = z.infer<typeof studioMediaVerificationSchema>;

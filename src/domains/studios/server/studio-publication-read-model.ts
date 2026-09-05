import "server-only";

import {
  parseStudioMediaPreviewPathIdentity,
  studioMediaGalleryRecordSchema,
  studioMediaGallerySchema,
  studioMediaItemSchema,
  studioPublicationRecordSchema,
  studioPublicationSchema,
  type StudioPublication,
  type StudioPublicationRecord,
  type StudioPublicationRevisionRecord,
} from "@set-livre/contracts";
import { z } from "zod";

import { readOwnerStudioPublicationRecord } from "./studio-publication-dal";
import { createTrustedStudioMediaStorage, type StudioMediaStorage } from "./studio-media-storage";

const studioPublicationDeadlineMs = 2_000;

type PublicationCoverRecord = NonNullable<StudioPublicationRevisionRecord["cover"]>;

export class StudioPublicationNotFoundError extends Error {
  constructor() {
    super("A publicação solicitada não foi encontrada para a sessão atual.");
    this.name = "StudioPublicationNotFoundError";
  }
}

function coverFingerprint(cover: PublicationCoverRecord) {
  return [
    cover.byteSize,
    cover.checksumSha256,
    cover.height,
    cover.id,
    cover.mimeType,
    cover.previewStoragePath,
    cover.width,
  ].join("\u0000");
}

export function assertStudioPublicationBoundary(
  rawRecord: unknown,
  expectedUserId: string,
  expectedStudioId: string,
) {
  const record = studioPublicationRecordSchema.parse(rawRecord);
  if (record.scope !== expectedUserId || record.studioId !== expectedStudioId) {
    throw new Error("A publicação retornou uma fronteira diferente da sessão solicitante.");
  }
  return record;
}

function assertCoverBoundary(record: StudioPublicationRecord, cover: PublicationCoverRecord) {
  const identity = parseStudioMediaPreviewPathIdentity(cover.previewStoragePath);
  if (
    identity.scope !== record.scope ||
    identity.studioId !== record.studioId ||
    identity.mediaId !== cover.id ||
    !cover.isCover
  ) {
    throw new Error("A capa retornou uma identidade diferente da publicação solicitada.");
  }
  return identity;
}

function browserCoverFrom(
  cover: PublicationCoverRecord,
  signedCover: z.infer<typeof studioMediaItemSchema>,
) {
  if (
    signedCover.id !== cover.id ||
    signedCover.byteSize !== cover.byteSize ||
    signedCover.checksumSha256 !== cover.checksumSha256 ||
    signedCover.height !== cover.height ||
    signedCover.mimeType !== cover.mimeType ||
    signedCover.width !== cover.width
  ) {
    throw new Error("A assinatura da capa retornou metadados diferentes da mídia solicitada.");
  }
  return studioMediaItemSchema.parse({
    byteSize: cover.byteSize,
    checksumSha256: cover.checksumSha256,
    height: cover.height,
    id: cover.id,
    isCover: cover.isCover,
    mimeType: cover.mimeType,
    position: cover.position,
    previewUrl: signedCover.previewUrl,
    width: cover.width,
  });
}

async function signUniqueCover(
  record: StudioPublicationRecord,
  revision: StudioPublicationRevisionRecord,
  storage: StudioMediaStorage,
  signal: AbortSignal,
) {
  const cover = revision.cover;
  if (cover === null) {
    throw new Error("Uma assinatura de capa foi solicitada sem uma capa canônica.");
  }
  const identity = assertCoverBoundary(record, cover);
  const syntheticGallery = studioMediaGalleryRecordSchema.parse({
    canEdit: ["approved", "draft"].includes(revision.status),
    items: [{ ...cover, position: 1 }],
    revisionId: identity.revisionId,
    revisionNumber: revision.number,
    revisionStatus: revision.status,
    revisionVersion: revision.version,
    scope: record.scope,
    studioId: record.studioId,
  });
  const signedGallery = studioMediaGallerySchema.parse(
    await storage.signGalleryPreviews(syntheticGallery, signal),
  );
  const signedCover = signedGallery.items[0];
  if (
    signedGallery.scope !== record.scope ||
    signedGallery.studioId !== record.studioId ||
    signedGallery.revisionId !== identity.revisionId ||
    signedGallery.items.length !== 1 ||
    signedCover === undefined
  ) {
    throw new Error("A assinatura da capa retornou uma fronteira diferente da publicação.");
  }
  return {
    cover: browserCoverFrom(cover, signedCover),
    previewExpiresAt: signedGallery.previewExpiresAt,
  };
}

async function withStudioPublicationStorageDeadline<T>(
  execute: (signal: AbortSignal) => Promise<T>,
  externalSignal?: AbortSignal,
) {
  const deadlineController = new AbortController();
  const timeoutError = new DOMException("A assinatura da publicação expirou.", "TimeoutError");
  const deadline = setTimeout(
    () => deadlineController.abort(timeoutError),
    studioPublicationDeadlineMs,
  );
  const signal =
    externalSignal === undefined
      ? deadlineController.signal
      : AbortSignal.any([externalSignal, deadlineController.signal]);
  let rejectOnAbort: (() => void) | undefined;

  try {
    if (signal.aborted) throw signal.reason ?? timeoutError;
    const abortOutcome = new Promise<never>((_resolve, reject) => {
      rejectOnAbort = () => reject(signal.reason ?? timeoutError);
      signal.addEventListener("abort", rejectOnAbort, { once: true });
    });
    return await Promise.race([execute(signal), abortOutcome]);
  } finally {
    clearTimeout(deadline);
    if (rejectOnAbort !== undefined) signal.removeEventListener("abort", rejectOnAbort);
  }
}

export function isStudioPublicationAbortError(error: unknown) {
  return (
    error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

export async function signStudioPublicationCovers(
  rawRecord: StudioPublicationRecord,
  storage: StudioMediaStorage,
  externalSignal?: AbortSignal,
): Promise<StudioPublication> {
  const record = studioPublicationRecordSchema.parse(rawRecord);
  const revisions = [record.currentRevision, record.publishedRevision].filter(
    (revision): revision is StudioPublicationRevisionRecord => revision !== null,
  );
  const uniqueCovers = new Map<
    string,
    Readonly<{ cover: PublicationCoverRecord; revision: StudioPublicationRevisionRecord }>
  >();

  for (const revision of revisions) {
    const cover = revision.cover;
    if (cover === null) continue;
    assertCoverBoundary(record, cover);
    const existing = uniqueCovers.get(cover.previewStoragePath);
    if (existing !== undefined && coverFingerprint(existing.cover) !== coverFingerprint(cover)) {
      throw new Error("A mesma capa canônica retornou metadados divergentes.");
    }
    uniqueCovers.set(cover.previewStoragePath, { cover, revision });
  }

  const signedEntries =
    uniqueCovers.size === 0
      ? []
      : await withStudioPublicationStorageDeadline(async (signal) => {
          const entries = [...uniqueCovers.entries()];
          return Promise.all(
            entries.map(
              async ([path, entry]) =>
                [path, await signUniqueCover(record, entry.revision, storage, signal)] as const,
            ),
          );
        }, externalSignal);
  const signedByPath = new Map(signedEntries);
  const previewExpiresAt =
    signedEntries.length === 0
      ? null
      : new Date(
          Math.min(...signedEntries.map(([, signed]) => Date.parse(signed.previewExpiresAt))),
        ).toISOString();

  function publicRevision(revision: StudioPublicationRevisionRecord) {
    const signed =
      revision.cover === null ? undefined : signedByPath.get(revision.cover.previewStoragePath);
    if (revision.cover !== null && signed === undefined) {
      throw new Error("A capa canônica não recebeu uma assinatura privada.");
    }
    const { cover: privateCover, ...safeRevision } = revision;
    void privateCover;
    return {
      ...safeRevision,
      cover:
        revision.cover === null || signed === undefined
          ? null
          : browserCoverFrom(revision.cover, signed.cover),
    };
  }

  return studioPublicationSchema.parse({
    canPause: record.canPause,
    canResume: record.canResume,
    canSubmit: record.canSubmit,
    checklist: record.checklist,
    currentRevision: publicRevision(record.currentRevision),
    latestReview: record.latestReview,
    previewExpiresAt,
    publicationVersion: record.publicationVersion,
    publishedRevision:
      record.publishedRevision === null ? null : publicRevision(record.publishedRevision),
    scope: record.scope,
    studioId: record.studioId,
    studioStatus: record.studioStatus,
  });
}

export async function readOwnerStudioPublication(
  userId: string,
  studioId: string,
  externalSignal?: AbortSignal,
) {
  const parsedUserId = z.uuid().parse(userId);
  const parsedStudioId = z.uuid().parse(studioId);
  const record = await readOwnerStudioPublicationRecord({
    studioId: parsedStudioId,
    userId: parsedUserId,
  });
  if (record === null) throw new StudioPublicationNotFoundError();
  const publication = assertStudioPublicationBoundary(record, parsedUserId, parsedStudioId);
  return signStudioPublicationCovers(
    publication,
    createTrustedStudioMediaStorage(),
    externalSignal,
  );
}

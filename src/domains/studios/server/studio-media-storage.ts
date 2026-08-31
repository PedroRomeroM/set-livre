import "server-only";

import {
  studioMediaBucket,
  studioMediaPathSchema,
  studioMediaPreviewLifetimeSeconds,
  studioMediaPreviewPathSchema,
  studioMediaPrivateCacheSeconds,
  type StudioMediaGallery,
  type StudioMediaGalleryRecord,
} from "@set-livre/contracts";
import { timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { StorageApiError, StorageClient } from "@supabase/storage-js";

import { readTrustedSupabaseEnvironment } from "@/lib/supabase/config";

export class StudioMediaStorageError extends Error {
  readonly operation: "download" | "preview" | "preview-upload" | "upload-token";
  readonly reason: "not-found" | "unavailable";

  constructor(
    operation: StudioMediaStorageError["operation"],
    reason: StudioMediaStorageError["reason"] = "unavailable",
  ) {
    super("A operação privada de Storage não pôde ser concluída.");
    this.name = "StudioMediaStorageError";
    this.operation = operation;
    this.reason = reason;
  }
}

export type StudioMediaStorage = Readonly<{
  createUploadToken: (path: string) => Promise<string>;
  download: (path: string, signal: AbortSignal) => Promise<Blob>;
  signGalleryPreviews: (
    gallery: StudioMediaGalleryRecord,
    signal?: AbortSignal,
  ) => Promise<StudioMediaGallery>;
  uploadPreview: (path: string, bytes: Uint8Array, signal: AbortSignal) => Promise<void>;
}>;

type StudioMediaBucket = ReturnType<StorageClient["from"]>;
type StudioMediaBucketFactory = (signal?: AbortSignal) => StudioMediaBucket;
type StudioMediaFetch = NonNullable<ConstructorParameters<typeof StorageClient>[2]>;

function storageObjectWasNotFound(error: unknown) {
  return (
    error instanceof StorageApiError && (error.code === "NoSuchKey" || error.statusCode === "404")
  );
}

function storageObjectAlreadyExists(error: unknown) {
  return (
    error instanceof StorageApiError &&
    (error.code === "ResourceAlreadyExists" || error.status === 409)
  );
}

async function existingPreviewMatches(
  bucket: StudioMediaBucket,
  path: string,
  expected: Uint8Array,
  signal: AbortSignal,
) {
  const { data, error } = await bucket.download(path, {}, { cache: "no-store", signal });
  if (error !== null) throw new StudioMediaStorageError("preview-upload");
  const actual = Buffer.from(await data.arrayBuffer());
  const expectedBuffer = Buffer.from(expected);
  return actual.byteLength === expectedBuffer.byteLength && timingSafeEqual(actual, expectedBuffer);
}

function createDeadlineFetch(
  fetchImplementation: StudioMediaFetch,
  deadlineSignal: AbortSignal,
): StudioMediaFetch {
  return (input, init) => {
    const requestSignal = init?.signal;
    const signal =
      requestSignal === undefined || requestSignal === null || requestSignal === deadlineSignal
        ? deadlineSignal
        : AbortSignal.any([deadlineSignal, requestSignal]);
    return fetchImplementation(input, { ...init, signal });
  };
}

function throwStorageAbort(signal: AbortSignal | undefined) {
  if (signal?.aborted !== true) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("A operação privada de Storage foi interrompida.", "AbortError");
}

function createStudioMediaStorage(createBucket: StudioMediaBucketFactory): StudioMediaStorage {
  const bucket = createBucket();

  return {
    async createUploadToken(rawPath) {
      const path = studioMediaPathSchema.parse(rawPath);
      const { data, error } = await bucket.createSignedUploadUrl(path, { upsert: false });
      if (error !== null) throw new StudioMediaStorageError("upload-token");
      return data.token;
    },

    async download(rawPath, signal) {
      const path = studioMediaPathSchema.parse(rawPath);
      const { data, error } = await bucket.download(path, {}, { cache: "no-store", signal });
      if (error !== null) {
        throw new StudioMediaStorageError(
          "download",
          storageObjectWasNotFound(error) ? "not-found" : "unavailable",
        );
      }
      return data;
    },

    async signGalleryPreviews(gallery, signal) {
      const previewExpiresAt = new Date(
        Date.now() + studioMediaPreviewLifetimeSeconds * 1_000,
      ).toISOString();
      throwStorageAbort(signal);
      if (gallery.items.length === 0) return { ...gallery, items: [], previewExpiresAt };
      const paths = gallery.items.map((item) =>
        studioMediaPreviewPathSchema.parse(item.previewStoragePath),
      );
      const signingBucket = createBucket(signal);
      let signingResult: Awaited<ReturnType<StudioMediaBucket["createSignedUrls"]>>;
      try {
        signingResult = await signingBucket.createSignedUrls(
          paths,
          studioMediaPreviewLifetimeSeconds,
        );
      } catch {
        throwStorageAbort(signal);
        throw new StudioMediaStorageError("preview");
      }
      throwStorageAbort(signal);
      const { data, error } = signingResult;
      if (error !== null || data.length !== paths.length) {
        throw new StudioMediaStorageError("preview");
      }
      const previews = gallery.items.map((item, index) => {
        const signed = data[index];
        if (
          signed === undefined ||
          signed.error !== null ||
          signed.path !== paths[index] ||
          typeof signed.signedUrl !== "string"
        ) {
          throw new StudioMediaStorageError("preview");
        }
        return {
          byteSize: item.byteSize,
          checksumSha256: item.checksumSha256,
          height: item.height,
          id: item.id,
          isCover: item.isCover,
          mimeType: item.mimeType,
          position: item.position,
          previewUrl: signed.signedUrl,
          width: item.width,
        };
      });
      return { ...gallery, items: previews, previewExpiresAt };
    },

    async uploadPreview(rawPath, bytes, signal) {
      const path = studioMediaPreviewPathSchema.parse(rawPath);
      const deadlineBucket = createBucket(signal);
      const { error } = await deadlineBucket.upload(path, bytes, {
        cacheControl: String(studioMediaPrivateCacheSeconds),
        contentType: "image/webp",
        upsert: false,
      });
      if (error === null) return;
      if (
        storageObjectAlreadyExists(error) &&
        (await existingPreviewMatches(deadlineBucket, path, bytes, signal))
      ) {
        return;
      }
      throw new StudioMediaStorageError("preview-upload");
    },
  };
}

export function createTrustedStudioMediaStorage(
  fetchImplementation?: ConstructorParameters<typeof StorageClient>[2],
) {
  const environment = readTrustedSupabaseEnvironment();
  const storageOrigin = new URL("/storage/v1", environment.supabaseOrigin).href.replace(/\/$/u, "");
  const trustedFetch = fetchImplementation ?? globalThis.fetch;
  return createStudioMediaStorage((signal) =>
    new StorageClient(
      storageOrigin,
      { apikey: environment.secretKey },
      signal === undefined ? trustedFetch : createDeadlineFetch(trustedFetch, signal),
    ).from(studioMediaBucket),
  );
}

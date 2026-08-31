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
  signGalleryPreviews: (gallery: StudioMediaGalleryRecord) => Promise<StudioMediaGallery>;
  uploadPreview: (path: string, bytes: Uint8Array) => Promise<void>;
}>;

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
  bucket: ReturnType<StorageClient["from"]>,
  path: string,
  expected: Uint8Array,
) {
  const { data, error } = await bucket.download(path);
  if (error !== null) throw new StudioMediaStorageError("preview-upload");
  const actual = Buffer.from(await data.arrayBuffer());
  const expectedBuffer = Buffer.from(expected);
  return actual.byteLength === expectedBuffer.byteLength && timingSafeEqual(actual, expectedBuffer);
}

function createStudioMediaStorage(client: Pick<StorageClient, "from">): StudioMediaStorage {
  const bucket = client.from(studioMediaBucket);

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

    async signGalleryPreviews(gallery) {
      const previewExpiresAt = new Date(
        Date.now() + studioMediaPreviewLifetimeSeconds * 1_000,
      ).toISOString();
      if (gallery.items.length === 0) return { ...gallery, items: [], previewExpiresAt };
      const paths = gallery.items.map((item) =>
        studioMediaPreviewPathSchema.parse(item.previewStoragePath),
      );
      const { data, error } = await bucket.createSignedUrls(
        paths,
        studioMediaPreviewLifetimeSeconds,
      );
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

    async uploadPreview(rawPath, bytes) {
      const path = studioMediaPreviewPathSchema.parse(rawPath);
      const { error } = await bucket.upload(path, bytes, {
        cacheControl: String(studioMediaPrivateCacheSeconds),
        contentType: "image/webp",
        upsert: false,
      });
      if (error === null) return;
      if (
        storageObjectAlreadyExists(error) &&
        (await existingPreviewMatches(bucket, path, bytes))
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
  return createStudioMediaStorage(
    new StorageClient(storageOrigin, { apikey: environment.secretKey }, fetchImplementation),
  );
}

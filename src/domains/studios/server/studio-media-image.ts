import "server-only";

import {
  studioMediaMaximumBytes,
  studioMediaMaximumDimension,
  studioMediaMaximumPixels,
  studioMediaMimeTypeSchema,
  studioMediaPreviewMaximumBytes,
  studioMediaPreviewMaximumEdge,
  studioMediaVerificationSchema,
  type StudioMediaUploadCandidate,
  type StudioMediaVerification,
} from "@set-livre/contracts";
import { createHash } from "node:crypto";
import sharp from "sharp";

const studioMediaCapacityQueueLimit = 3;
const studioMediaCapacityWaitMs = 4_000;

type CapacityWaiter = Readonly<{
  reject: (reason: StudioMediaCapacityError) => void;
  resolve: (release: () => void) => void;
  timer: ReturnType<typeof setTimeout>;
}>;

type CapacityState = {
  active: boolean;
  waiting: CapacityWaiter[];
};

const capacityRegistry = globalThis as typeof globalThis & {
  setLivreStudioMediaCapacity?: CapacityState;
};

sharp.cache({ files: 0, items: 32, memory: 32 });
sharp.concurrency(1);

function capacityState() {
  capacityRegistry.setLivreStudioMediaCapacity ??= { active: false, waiting: [] };
  return capacityRegistry.setLivreStudioMediaCapacity;
}

function releaseCapacity(state: CapacityState) {
  const next = state.waiting.shift();
  if (next === undefined) {
    state.active = false;
    return;
  }
  clearTimeout(next.timer);
  next.resolve(() => releaseCapacity(state));
}

async function acquireCapacity() {
  const state = capacityState();
  if (!state.active) {
    state.active = true;
    return () => releaseCapacity(state);
  }
  if (state.waiting.length >= studioMediaCapacityQueueLimit) {
    throw new StudioMediaCapacityError();
  }
  return new Promise<() => void>((resolve, reject) => {
    const waiter: CapacityWaiter = {
      reject,
      resolve,
      timer: setTimeout(() => {
        const index = state.waiting.indexOf(waiter);
        if (index >= 0) state.waiting.splice(index, 1);
        reject(new StudioMediaCapacityError());
      }, studioMediaCapacityWaitMs),
    };
    state.waiting.push(waiter);
  });
}

export type VerifiedStudioMediaImage = Readonly<{
  previewBytes: Uint8Array;
  verification: StudioMediaVerification;
}>;

export class StudioMediaImageError extends Error {
  readonly reason:
    | "CHECKSUM_MISMATCH"
    | "DECODE_FAILED"
    | "DIMENSIONS_INVALID"
    | "MIME_MISMATCH"
    | "SIZE_MISMATCH";

  constructor(reason: StudioMediaImageError["reason"]) {
    super("O arquivo enviado não corresponde a uma foto válida do contrato de mídia.");
    this.name = "StudioMediaImageError";
    this.reason = reason;
  }
}

export class StudioMediaCapacityError extends Error {
  constructor() {
    super("A capacidade segura de processamento de fotos está ocupada.");
    this.name = "StudioMediaCapacityError";
  }
}

export async function withStudioMediaImageCapacity<T>(work: () => Promise<T>) {
  const release = await acquireCapacity();
  try {
    return await work();
  } finally {
    release();
  }
}

function hasPrefix(bytes: Uint8Array, expected: readonly number[]) {
  return expected.every((value, index) => bytes[index] === value);
}

export function detectStudioMediaMimeType(bytes: Uint8Array) {
  if (hasPrefix(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg" as const;
  if (hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png" as const;
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  ) {
    return "image/webp" as const;
  }
  if (bytes.length >= 16 && String.fromCharCode(...bytes.slice(4, 8)) === "ftyp") {
    const brands = String.fromCharCode(...bytes.slice(8, Math.min(bytes.length, 40)));
    if (brands.includes("avif") || brands.includes("avis")) return "image/avif" as const;
  }
  return undefined;
}

export async function verifyStudioMediaImage(
  blob: Blob,
  candidate: StudioMediaUploadCandidate,
): Promise<VerifiedStudioMediaImage> {
  if (
    blob.size < 1 ||
    blob.size > studioMediaMaximumBytes ||
    blob.size !== candidate.declaredByteSize
  ) {
    throw new StudioMediaImageError("SIZE_MISMATCH");
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const detectedMimeType = detectStudioMediaMimeType(bytes);
  if (
    detectedMimeType === undefined ||
    detectedMimeType !== candidate.declaredMimeType ||
    !studioMediaMimeTypeSchema.safeParse(detectedMimeType).success
  ) {
    throw new StudioMediaImageError("MIME_MISMATCH");
  }

  const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
  if (
    candidate.declaredChecksumSha256 !== null &&
    candidate.declaredChecksumSha256 !== checksumSha256
  ) {
    throw new StudioMediaImageError("CHECKSUM_MISMATCH");
  }

  try {
    const image = sharp(bytes, {
      failOn: "error",
      limitInputPixels: studioMediaMaximumPixels,
      sequentialRead: true,
    });
    const metadata = await image.metadata();
    const width = metadata.autoOrient.width;
    const height = metadata.autoOrient.height;
    if (
      metadata.mediaType !== detectedMimeType ||
      (metadata.pages ?? 1) !== 1 ||
      width < 1 ||
      height < 1 ||
      width > studioMediaMaximumDimension ||
      height > studioMediaMaximumDimension ||
      width * height > studioMediaMaximumPixels
    ) {
      throw new StudioMediaImageError("DIMENSIONS_INVALID");
    }
    const previewBytes = await image
      .clone()
      .autoOrient()
      .resize({
        fit: "inside",
        height: studioMediaPreviewMaximumEdge,
        width: studioMediaPreviewMaximumEdge,
        withoutEnlargement: true,
      })
      .webp({ effort: 4, quality: 80 })
      .toBuffer();
    if (previewBytes.byteLength < 1 || previewBytes.byteLength > studioMediaPreviewMaximumBytes) {
      throw new StudioMediaImageError("DECODE_FAILED");
    }
    const verification = studioMediaVerificationSchema.parse({
      byteSize: bytes.byteLength,
      checksumSha256,
      height,
      mimeType: detectedMimeType,
      width,
    });
    return { previewBytes, verification };
  } catch (error) {
    if (error instanceof StudioMediaImageError) throw error;
    throw new StudioMediaImageError("DECODE_FAILED");
  }
}

import {
  studioMediaCommandSchema,
  studioMediaGalleryRecordSchema,
  studioMediaGallerySchema,
  studioMediaMaximumBytes,
  studioMediaMaximumDimension,
  studioMediaPathSchema,
  studioMediaPreviewMaximumBytes,
  studioMediaPreviewMaximumEdge,
  studioMediaPreviewPathSchema,
  studioMediaUploadPreparationRecordSchema,
  studioMediaUploadCandidateSchema,
  studioMediaVerificationSchema,
  type StudioMediaMimeType,
  type StudioMediaUploadCandidate,
} from "@set-livre/contracts";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  detectStudioMediaMimeType,
  StudioMediaDeadlineError,
  studioMediaServerVerificationDeadlineMs,
  verifyStudioMediaImage,
  withStudioMediaImageCapacity,
} from "@/domains/studios/server/studio-media-image";

const scope = "87000000-0000-4000-8000-000000000001";
const studioId = "87000000-0000-4000-8000-000000000002";
const revisionId = "87000000-0000-4000-8000-000000000003";
const mediaId = "87000000-0000-4000-8000-000000000004";
const path = `owners/${scope}/studios/${studioId}/revisions/${revisionId}/${mediaId}.jpg`;
const previewPath = `owners/${scope}/studios/${studioId}/revisions/${revisionId}/${mediaId}.preview.webp`;

function processingDeadline(milliseconds = 60_000) {
  return { deadlineAt: Date.now() + milliseconds, signal: new AbortController().signal };
}

function candidate(
  byteSize: number,
  mimeType: StudioMediaMimeType,
  checksumSha256: string | null = null,
): StudioMediaUploadCandidate {
  return {
    bucket: "studio-media",
    declaredByteSize: byteSize,
    declaredChecksumSha256: checksumSha256,
    declaredMimeType: mimeType,
    expiresAt: "2026-08-31T10:00:00.000Z",
    mediaId,
    path: path.replace(/\.jpg$/u, `.${mimeType === "image/jpeg" ? "jpg" : mimeType.slice(6)}`),
    previewPath,
    revisionId,
    revisionVersion: 1,
    scope,
    studioId,
  };
}

async function image(format: "avif" | "jpeg" | "png" | "webp", width = 4, height = 3) {
  return sharp({ create: { background: "#315efb", channels: 3, height, width } })
    [format]()
    .toBuffer();
}

describe("studio media contracts", () => {
  it("mantém path, limite e envelopes estritos", () => {
    expect(studioMediaPathSchema.parse(path)).toBe(path);
    expect(studioMediaPreviewPathSchema.parse(previewPath)).toBe(previewPath);
    expect(() => studioMediaPathSchema.parse(`owners/${scope}/../secret.jpg`)).toThrow();
    expect(() =>
      studioMediaCommandSchema.parse({
        action: "studio.media.upload.prepare",
        expectedScope: scope,
        idempotencyKey: mediaId,
        payload: {
          declaredByteSize: studioMediaMaximumBytes + 1,
          declaredChecksumSha256: null,
          declaredMimeType: "image/jpeg",
          expectedRevisionId: revisionId,
          expectedRevisionVersion: 1,
          studioId,
        },
      }),
    ).toThrow();
    const uploadCandidate = candidate(100, "image/jpeg");
    const preparation = {
      bucket: uploadCandidate.bucket,
      expiresAt: uploadCandidate.expiresAt,
      mediaId: uploadCandidate.mediaId,
      path: uploadCandidate.path,
      revisionId: uploadCandidate.revisionId,
      revisionVersion: uploadCandidate.revisionVersion,
      scope: uploadCandidate.scope,
      studioId: uploadCandidate.studioId,
    };
    expect(
      studioMediaUploadPreparationRecordSchema.parse({
        ...preparation,
        expiresAt: "2026-08-31T10:00:00+00:00",
      }).expiresAt,
    ).toBe("2026-08-31T10:00:00+00:00");
    expect(() =>
      studioMediaUploadPreparationRecordSchema.parse({
        ...preparation,
        mediaId: scope,
      }),
    ).toThrow("identidade reservada");
    expect(() =>
      studioMediaUploadCandidateSchema.parse({
        ...uploadCandidate,
        previewPath: previewPath.replace(mediaId, scope),
      }),
    ).toThrow("prévia");
    expect(() =>
      studioMediaVerificationSchema.parse({
        byteSize: 100,
        checksumSha256: "a".repeat(64),
        height: 6_000,
        mimeType: "image/jpeg",
        width: 6_001,
      }),
    ).toThrow("pixels");
  });

  it("recusa posição descontínua, foto repetida e cardinalidade de capa inválida", () => {
    const item = {
      byteSize: 100,
      checksumSha256: "a".repeat(64),
      height: 3,
      id: mediaId,
      isCover: true,
      mimeType: "image/jpeg" as const,
      position: 1,
      previewUrl: "https://example.test/private.jpg",
      width: 4,
    };
    const gallery = {
      canEdit: true,
      items: [item],
      previewExpiresAt: "2026-08-31T12:05:00.000Z",
      revisionId,
      revisionNumber: 1,
      revisionStatus: "draft" as const,
      revisionVersion: 1,
      scope,
      studioId,
    };
    expect(() =>
      studioMediaGallerySchema.parse({
        ...gallery,
        items: [item, { ...item, id: scope, isCover: false, position: 3 }],
      }),
    ).toThrow("contínua");
    expect(() =>
      studioMediaGallerySchema.parse({
        ...gallery,
        items: [item, { ...item, isCover: false, position: 2 }],
      }),
    ).toThrow("repetir");
    expect(() =>
      studioMediaGallerySchema.parse({ ...gallery, items: [{ ...item, isCover: false }] }),
    ).toThrow("exatamente uma capa");
    expect(() =>
      studioMediaGallerySchema.parse({
        ...gallery,
        items: [item, { ...item, id: scope, position: 2 }],
      }),
    ).toThrow("exatamente uma capa");
  });

  it("preserva o namespace da revisão de origem quando uma associação é clonada", () => {
    const sourceRevisionId = "87000000-0000-4000-8000-000000000005";
    const clonedPreviewPath = previewPath.replace(revisionId, sourceRevisionId);
    const item = {
      byteSize: 100,
      checksumSha256: "a".repeat(64),
      height: 3,
      id: mediaId,
      isCover: true,
      mimeType: "image/jpeg" as const,
      position: 1,
      previewStoragePath: clonedPreviewPath,
      width: 4,
    };
    const gallery = {
      canEdit: true,
      items: [item],
      revisionId,
      revisionNumber: 2,
      revisionStatus: "draft" as const,
      revisionVersion: 1,
      scope,
      studioId,
    };

    expect(studioMediaGalleryRecordSchema.parse(gallery)).toEqual(gallery);
    expect(() =>
      studioMediaGalleryRecordSchema.parse({
        ...gallery,
        canEdit: false,
      }),
    ).toThrow("estado factual");
    expect(() =>
      studioMediaGalleryRecordSchema.parse({
        ...gallery,
        items: [
          {
            ...item,
            previewStoragePath: clonedPreviewPath.replace(studioId, scope),
          },
        ],
      }),
    ).toThrow("identidade da galeria");
  });
});

describe("studio media byte verification", () => {
  it.each([
    ["jpeg", "image/jpeg"],
    ["png", "image/png"],
    ["webp", "image/webp"],
    ["avif", "image/avif"],
  ] as const)("decodifica %s e retorna fatos verificados", async (format, mimeType) => {
    const bytes = await image(format);
    const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
    const blob = new Blob([bytes], { type: mimeType });
    expect(detectStudioMediaMimeType(bytes)).toBe(mimeType);
    const verified = await verifyStudioMediaImage(
      blob,
      candidate(bytes.byteLength, mimeType, checksumSha256),
      processingDeadline(),
    );
    expect(verified.verification).toEqual({
      byteSize: bytes.byteLength,
      checksumSha256,
      height: 3,
      mimeType,
      width: 4,
    });
    expect(verified.previewBytes.byteLength).toBeGreaterThan(0);
    expect(verified.previewBytes.byteLength).toBeLessThanOrEqual(studioMediaPreviewMaximumBytes);
    await expect(sharp(verified.previewBytes).metadata()).resolves.toMatchObject({
      format: "webp",
      height: 3,
      width: 4,
    });
  });

  it("rejeita MIME forjado e checksum divergente", async () => {
    const bytes = await image("png");
    const blob = new Blob([bytes], { type: "image/jpeg" });
    await expect(
      verifyStudioMediaImage(blob, candidate(bytes.byteLength, "image/jpeg"), processingDeadline()),
    ).rejects.toMatchObject({ reason: "MIME_MISMATCH" });
    await expect(
      verifyStudioMediaImage(
        new Blob([bytes], { type: "image/png" }),
        candidate(bytes.byteLength, "image/png", "0".repeat(64)),
        processingDeadline(),
      ),
    ).rejects.toMatchObject({ reason: "CHECKSUM_MISMATCH" });
  });

  it("rejeita dimensão acima do limite técnico", async () => {
    const bytes = await image("png", studioMediaMaximumDimension + 1, 1);
    await expect(
      verifyStudioMediaImage(
        new Blob([bytes], { type: "image/png" }),
        candidate(bytes.byteLength, "image/png"),
        processingDeadline(),
      ),
    ).rejects.toMatchObject({ reason: "DIMENSIONS_INVALID" });
  });

  it("serializa o pipeline pesado antes de materializar a próxima imagem", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const entered: string[] = [];
    const first = withStudioMediaImageCapacity(async () => {
      entered.push("first");
      await firstGate;
      return "first";
    });
    const second = withStudioMediaImageCapacity(async () => {
      entered.push("second");
      return "second";
    });
    await vi.waitFor(() => expect(entered).toEqual(["first"]));
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    expect(entered).toEqual(["first", "second"]);
  });

  it("aborta trabalho estagnado e só então libera a capacidade global", async () => {
    vi.useFakeTimers();
    try {
      const timedOut = withStudioMediaImageCapacity(
        (deadline) =>
          new Promise<never>((_resolve, reject) => {
            deadline.signal.addEventListener("abort", () => reject(deadline.signal.reason), {
              once: true,
            });
          }),
      );
      await Promise.resolve();
      const deadlineFailure = expect(timedOut).rejects.toBeInstanceOf(StudioMediaDeadlineError);
      await vi.advanceTimersByTimeAsync(studioMediaServerVerificationDeadlineMs);
      await deadlineFailure;
      await expect(withStudioMediaImageCapacity(async () => "released")).resolves.toBe("released");
    } finally {
      vi.useRealTimers();
    }
  });

  it("limita a maior aresta da prévia privada derivada", async () => {
    const bytes = await image("jpeg", 2_560, 1_440);
    const verified = await verifyStudioMediaImage(
      new Blob([bytes], { type: "image/jpeg" }),
      candidate(bytes.byteLength, "image/jpeg"),
      processingDeadline(),
    );
    const metadata = await sharp(verified.previewBytes).metadata();
    expect(Math.max(metadata.width ?? 0, metadata.height ?? 0)).toBe(studioMediaPreviewMaximumEdge);
  });
});

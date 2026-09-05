import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  createTrustedStudioMediaStorage,
  studioMediaUploadTokenSigningDeadlineMs,
} from "../../src/domains/studios/server/studio-media-storage";
import { studioTestIds } from "./studio-test-fixture";

const mediaId = "88888888-8888-4888-8888-888888888888";
const mediaPath = `owners/${studioTestIds.userId}/studios/${studioTestIds.studioId}/revisions/${studioTestIds.revisionId}/${mediaId}.jpg`;
const previewPath = mediaPath.replace(/\.jpg$/u, ".preview.webp");
const galleryRecord = {
  canEdit: true,
  items: [
    {
      byteSize: 512,
      checksumSha256: "8".repeat(64),
      height: 720,
      id: mediaId,
      isCover: true,
      mimeType: "image/jpeg" as const,
      position: 1,
      previewStoragePath: previewPath,
      width: 1_280,
    },
  ],
  revisionId: studioTestIds.revisionId,
  revisionNumber: 1,
  revisionStatus: "draft" as const,
  revisionVersion: 3,
  scope: studioTestIds.userId,
  studioId: studioTestIds.studioId,
};

describe("trusted studio media storage", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("sends a modern server key only in apikey and never as a Bearer token", async () => {
    const secretKey = "sb_secret_storage_contract_key";
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://setlivre.example");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "sb_publishable_public_contract_key");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", secretKey);
    const requests: Array<Readonly<{ headers: Headers; method: string; url: string }>> = [];
    const fetchImplementation: typeof fetch = vi.fn(async (input, init) => {
      requests.push({
        headers: new Headers(init?.headers),
        method: init?.method ?? "GET",
        url: String(input),
      });
      return new Response(
        JSON.stringify({
          url: `/object/upload/sign/studio-media/${mediaPath}?token=signed-upload-token`,
        }),
        { headers: { "content-type": "application/json" }, status: 200 },
      );
    });

    await expect(
      createTrustedStudioMediaStorage(fetchImplementation).createUploadToken(mediaPath),
    ).resolves.toBe("signed-upload-token");

    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe(
      `https://project.supabase.co/storage/v1/object/upload/sign/studio-media/${mediaPath}`,
    );
    expect(request?.headers.get("apikey")).toBe(secretKey);
    expect(request?.headers.has("authorization")).toBe(false);
  });

  it("aborts a stalled upload-token signing request at the server deadline", async () => {
    vi.useFakeTimers();
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://setlivre.example");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "sb_publishable_public_contract_key");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_storage_contract_key");
    let observedSignal: AbortSignal | null | undefined;
    let announceRequestStarted: (() => void) | undefined;
    const requestStarted = new Promise<void>((resolve) => {
      announceRequestStarted = resolve;
    });
    const fetchImplementation: typeof fetch = vi.fn((_input, init) => {
      observedSignal = init?.signal;
      announceRequestStarted?.();
      return new Promise<Response>((_resolve, reject) => {
        if (observedSignal?.aborted === true) {
          reject(observedSignal.reason);
          return;
        }
        observedSignal?.addEventListener("abort", () => reject(observedSignal?.reason), {
          once: true,
        });
      });
    });
    const outcome = createTrustedStudioMediaStorage(fetchImplementation)
      .createUploadToken(mediaPath)
      .catch((error: unknown) => error);

    await requestStarted;
    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect(observedSignal?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(studioMediaUploadTokenSigningDeadlineMs - 1);
    expect(observedSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(outcome).resolves.toMatchObject({
      name: "StudioMediaStorageError",
      operation: "upload-token",
      reason: "unavailable",
    });
    expect(observedSignal?.aborted).toBe(true);
    expect(observedSignal?.reason).toMatchObject({ name: "AbortError" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the upload-token signing timer after Storage responds", async () => {
    vi.useFakeTimers();
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://setlivre.example");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "sb_publishable_public_contract_key");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_storage_contract_key");
    let observedSignal: AbortSignal | null | undefined;
    let resolveRequest: ((response: Response) => void) | undefined;
    let announceRequestStarted: (() => void) | undefined;
    const requestStarted = new Promise<void>((resolve) => {
      announceRequestStarted = resolve;
    });
    const fetchImplementation: typeof fetch = vi.fn((_input, init) => {
      observedSignal = init?.signal;
      announceRequestStarted?.();
      return new Promise<Response>((resolve) => {
        resolveRequest = resolve;
      });
    });
    const operation =
      createTrustedStudioMediaStorage(fetchImplementation).createUploadToken(mediaPath);

    await requestStarted;
    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect(observedSignal?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(1);

    resolveRequest?.(
      new Response(
        JSON.stringify({
          url: `/object/upload/sign/studio-media/${mediaPath}?token=signed-upload-token`,
        }),
        { headers: { "content-type": "application/json" }, status: 200 },
      ),
    );
    await expect(operation).resolves.toBe("signed-upload-token");
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(studioMediaUploadTokenSigningDeadlineMs);
    expect(observedSignal?.aborted).toBe(false);
  });

  it("forwards the server deadline signal to the private object download", async () => {
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://setlivre.example");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "sb_publishable_public_contract_key");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_storage_contract_key");
    let observedSignal: AbortSignal | null | undefined;
    let observedCache: RequestCache | undefined;
    const fetchImplementation: typeof fetch = vi.fn(async (_input, init) => {
      observedSignal = init?.signal;
      observedCache = init?.cache;
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });
    const controller = new AbortController();

    await expect(
      createTrustedStudioMediaStorage(fetchImplementation).download(mediaPath, controller.signal),
    ).resolves.toBeInstanceOf(Blob);

    expect(observedSignal).toBe(controller.signal);
    expect(observedCache).toBe("no-store");
  });

  it("binds the signed-preview request to the supplied Storage deadline", async () => {
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://setlivre.example");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "sb_publishable_public_contract_key");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_storage_contract_key");
    let observedSignal: AbortSignal | null | undefined;
    const fetchImplementation: typeof fetch = vi.fn(async (_input, init) => {
      observedSignal = init?.signal;
      return new Response(
        JSON.stringify([
          {
            error: null,
            path: previewPath,
            signedURL: `/object/sign/studio-media/${previewPath}?token=signed-preview-token`,
          },
        ]),
        { headers: { "content-type": "application/json" }, status: 200 },
      );
    });
    const controller = new AbortController();

    const gallery = await createTrustedStudioMediaStorage(fetchImplementation).signGalleryPreviews(
      galleryRecord,
      controller.signal,
    );

    expect(observedSignal).toBe(controller.signal);
    expect(gallery.items[0]?.previewUrl).toContain("signed-preview-token");
  });

  it("propagates cancellation only after the signed-preview fetch has settled", async () => {
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://setlivre.example");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "sb_publishable_public_contract_key");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_storage_contract_key");
    let observedSignal: AbortSignal | null | undefined;
    let fetchSettled = false;
    const fetchImplementation: typeof fetch = vi.fn((_input, init) => {
      observedSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        if (observedSignal?.aborted) {
          fetchSettled = true;
          reject(observedSignal.reason);
          return;
        }
        observedSignal?.addEventListener(
          "abort",
          () => {
            queueMicrotask(() => {
              fetchSettled = true;
              reject(observedSignal?.reason);
            });
          },
          { once: true },
        );
      });
    });
    const controller = new AbortController();
    const operation = createTrustedStudioMediaStorage(fetchImplementation).signGalleryPreviews(
      galleryRecord,
      controller.signal,
    );

    await vi.waitFor(() => expect(observedSignal).toBe(controller.signal));
    controller.abort(new DOMException("deadline", "TimeoutError"));
    await expect(operation).rejects.toMatchObject({ name: "TimeoutError" });
    expect(fetchSettled).toBe(true);
  });

  it("honors an already-aborted read deadline even for an empty gallery", async () => {
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://setlivre.example");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "sb_publishable_public_contract_key");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_storage_contract_key");
    const controller = new AbortController();
    controller.abort(new Error("deadline reached"));

    await expect(
      createTrustedStudioMediaStorage(vi.fn()).signGalleryPreviews(
        { ...galleryRecord, items: [] },
        controller.signal,
      ),
    ).rejects.toThrow("deadline reached");
  });

  it("aborts the underlying preview upload with the absolute server deadline", async () => {
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://setlivre.example");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "sb_publishable_public_contract_key");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_storage_contract_key");
    let observedSignal: AbortSignal | null | undefined;
    const fetchImplementation: typeof fetch = vi.fn((_input, init) => {
      observedSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        if (observedSignal?.aborted) {
          reject(observedSignal.reason);
          return;
        }
        observedSignal?.addEventListener("abort", () => reject(observedSignal?.reason), {
          once: true,
        });
      });
    });
    const controller = new AbortController();
    const operation = createTrustedStudioMediaStorage(fetchImplementation).uploadPreview(
      previewPath,
      new Uint8Array([1, 2, 3]),
      controller.signal,
    );
    const failure = expect(operation).rejects.toMatchObject({
      name: "StudioMediaStorageError",
      operation: "preview-upload",
    });

    await vi.waitFor(() => expect(observedSignal).toBe(controller.signal));
    controller.abort(new Error("deadline reached"));
    await failure;
  });

  it("uses the same deadline when a duplicate preview is verified for replay", async () => {
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://setlivre.example");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "sb_publishable_public_contract_key");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_storage_contract_key");
    const bytes = new Uint8Array([7, 8, 9]);
    const requests: Array<Readonly<{ method: string; signal: AbortSignal | null | undefined }>> =
      [];
    const fetchImplementation: typeof fetch = vi.fn(async (_input, init) => {
      requests.push({ method: init?.method ?? "GET", signal: init?.signal });
      if (requests.length === 1) {
        return new Response(
          JSON.stringify({
            error: "Duplicate",
            message: "The resource already exists",
            statusCode: "409",
          }),
          { headers: { "content-type": "application/json" }, status: 409 },
        );
      }
      return new Response(bytes, { status: 200 });
    });
    const controller = new AbortController();

    await expect(
      createTrustedStudioMediaStorage(fetchImplementation).uploadPreview(
        previewPath,
        bytes,
        controller.signal,
      ),
    ).resolves.toBeUndefined();

    expect(requests).toEqual([
      { method: "POST", signal: controller.signal },
      { method: "GET", signal: controller.signal },
    ]);
  });

  it("rejects a duplicate preview when the stored bytes differ", async () => {
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://setlivre.example");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "sb_publishable_public_contract_key");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_storage_contract_key");
    const fetchImplementation: typeof fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: "Duplicate",
            message: "The resource already exists",
            statusCode: "409",
          }),
          { headers: { "content-type": "application/json" }, status: 409 },
        ),
      )
      .mockResolvedValueOnce(new Response(new Uint8Array([7, 8, 0]), { status: 200 }));

    await expect(
      createTrustedStudioMediaStorage(fetchImplementation).uploadPreview(
        previewPath,
        new Uint8Array([7, 8, 9]),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      name: "StudioMediaStorageError",
      operation: "preview-upload",
      reason: "unavailable",
    });
  });
});

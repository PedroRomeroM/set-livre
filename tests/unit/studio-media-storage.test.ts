import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createTrustedStudioMediaStorage } from "../../src/domains/studios/server/studio-media-storage";
import { studioTestIds } from "./studio-test-fixture";

const mediaId = "88888888-8888-4888-8888-888888888888";
const mediaPath = `owners/${studioTestIds.userId}/studios/${studioTestIds.studioId}/revisions/${studioTestIds.revisionId}/${mediaId}.jpg`;
const previewPath = mediaPath.replace(/\.jpg$/u, ".preview.webp");

describe("trusted studio media storage", () => {
  afterEach(() => {
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

  it("aborts the underlying signed preview request with the read deadline", async () => {
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://setlivre.example");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "sb_publishable_public_contract_key");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_storage_contract_key");
    let observedSignal: AbortSignal | null | undefined;
    const fetchImplementation: typeof fetch = vi.fn((_input, init) => {
      observedSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener("abort", () => reject(observedSignal?.reason), {
          once: true,
        });
      });
    });
    const controller = new AbortController();
    const operation = createTrustedStudioMediaStorage(fetchImplementation).signGalleryPreviews(
      {
        items: [
          {
            byteSize: 512,
            checksumSha256: "8".repeat(64),
            height: 720,
            id: mediaId,
            isCover: true,
            mimeType: "image/jpeg",
            position: 1,
            previewStoragePath: previewPath,
            width: 1280,
          },
        ],
        revisionId: studioTestIds.revisionId,
        revisionNumber: 1,
        revisionVersion: 3,
        scope: studioTestIds.userId,
        studioId: studioTestIds.studioId,
      },
      controller.signal,
    );
    const failure = expect(operation).rejects.toMatchObject({ message: "deadline reached" });

    await vi.waitFor(() => expect(observedSignal).toBe(controller.signal));
    controller.abort(new Error("deadline reached"));
    await failure;
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
        {
          items: [],
          revisionId: studioTestIds.revisionId,
          revisionNumber: 1,
          revisionVersion: 3,
          scope: studioTestIds.userId,
          studioId: studioTestIds.studioId,
        },
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
});

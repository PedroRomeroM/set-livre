import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createTrustedStudioMediaStorage } from "../../src/domains/studios/server/studio-media-storage";
import { studioTestIds } from "./studio-test-fixture";

const mediaId = "88888888-8888-4888-8888-888888888888";
const mediaPath = `owners/${studioTestIds.userId}/studios/${studioTestIds.studioId}/revisions/${studioTestIds.revisionId}/${mediaId}.jpg`;

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
});

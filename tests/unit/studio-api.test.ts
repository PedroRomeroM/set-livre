import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createStudio,
  finalizeStudioMediaUpload,
  isAmbiguousStudioError,
  isStudioBoundaryChangedError,
  readStudioEditor,
  readStudioTaxonomies,
  readStudioTypes,
  StudioApiError,
  studioMediaFinalizeRequestTimeoutMs,
  updateStudioContent,
  updateStudioTaxonomy,
} from "../../src/domains/studios/components/studio-api";
import {
  studioCoreFixture,
  studioEditorFixture,
  studioTestIds,
  studioTypeFixture,
} from "./studio-test-fixture";

const responseRequestId = "99999999-9999-4999-8999-999999999999";

describe("studio browser API", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reads strict private editor and taxonomy responses", async () => {
    const taxonomies = {
      amenities: [{ id: studioTestIds.amenityId, name: "Wi-Fi", sortOrder: 10 }],
      tags: [{ id: studioTestIds.tagId, name: "Podcast", sortOrder: 10 }],
    };
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        Response.json({ data: studioEditorFixture, requestId: responseRequestId }),
      )
      .mockResolvedValueOnce(
        Response.json({ data: [studioTypeFixture], requestId: responseRequestId }),
      )
      .mockResolvedValueOnce(Response.json({ data: taxonomies, requestId: responseRequestId }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { clearTimeout, setTimeout });

    await expect(readStudioEditor(studioTestIds.studioId)).resolves.toEqual(studioEditorFixture);
    await expect(readStudioTypes()).resolves.toEqual([studioTypeFixture]);
    await expect(readStudioTaxonomies()).resolves.toEqual(taxonomies);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/owner/studios/${studioTestIds.studioId}`);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/studio-types");
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/studio-taxonomies");
  });

  it("serializes the strict idempotent create command", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => Response.json({ data: studioEditorFixture, requestId: responseRequestId }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { clearTimeout, setTimeout });
    const command = {
      action: "studio.create",
      expectedScope: studioTestIds.userId,
      idempotencyKey: studioTestIds.idempotencyKey,
      payload: studioCoreFixture,
    } satisfies Parameters<typeof createStudio>[0];

    await expect(createStudio(command)).resolves.toEqual(studioEditorFixture);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual(command);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
  });

  it("serializes taxonomy and content commands without translating their payload", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => Response.json({ data: studioEditorFixture, requestId: responseRequestId }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { clearTimeout, setTimeout });
    const boundary = {
      expectedRevisionId: studioTestIds.revisionId,
      expectedRevisionVersion: 3,
      studioId: studioTestIds.studioId,
    };
    const taxonomy = {
      action: "studio.revision.updateTaxonomy",
      expectedScope: studioTestIds.userId,
      idempotencyKey: studioTestIds.idempotencyKey,
      payload: {
        ...boundary,
        amenityIds: [studioTestIds.amenityId],
        tagIds: [studioTestIds.tagId],
      },
    } satisfies Parameters<typeof updateStudioTaxonomy>[0];
    const content = {
      action: "studio.revision.updateContent",
      expectedScope: studioTestIds.userId,
      idempotencyKey: studioTestIds.idempotencyKey,
      payload: {
        ...boundary,
        faqs: [{ answer: "Resposta.", question: "Pergunta?" }],
        usageRules: "Regras seguras.",
        youtubeVideoId: null,
      },
    } satisfies Parameters<typeof updateStudioContent>[0];

    await updateStudioTaxonomy(taxonomy);
    await updateStudioContent(content);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual(taxonomy);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual(content);
  });

  it("rejects extra private response fields and classifies verification-first failures", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        data: { ...studioEditorFixture, ownerTaxId: "52998224725" },
        requestId: responseRequestId,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { clearTimeout, setTimeout });

    const error = await readStudioEditor(studioTestIds.studioId).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: "RESPONSE_INVALID" });
    expect(JSON.stringify(error)).not.toContain("52998224725");
    expect(isAmbiguousStudioError(new StudioApiError("SERVICE_UNAVAILABLE", "indisponível"))).toBe(
      true,
    );
    expect(isAmbiguousStudioError(new StudioApiError("CONFLICT", "conflito"))).toBe(false);
    expect(
      isStudioBoundaryChangedError(
        new StudioApiError("OWNER_CONTRACT_CHANGED", "contrato alterado"),
      ),
    ).toBe(true);
    expect(isStudioBoundaryChangedError(new StudioApiError("CONFLICT", "conflito"))).toBe(false);
  });

  it("combines query cancellation with its timeout without relabeling a cancellation", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("cancelled query", "AbortError")),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { clearTimeout, setTimeout });
    const controller = new AbortController();
    const outcome = readStudioEditor(studioTestIds.studioId, controller.signal).catch(
      (error: unknown) => error,
    );

    controller.abort();
    await expect(outcome).resolves.toMatchObject({ name: "AbortError" });
  });

  it("keeps media finalization alive through the server envelope before timing out", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          requestSignal = init?.signal ?? undefined;
          requestSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("finalization deadline", "AbortError")),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { clearTimeout, setTimeout });
    const outcome = finalizeStudioMediaUpload({
      action: "studio.media.upload.finalize",
      expectedScope: studioTestIds.userId,
      idempotencyKey: studioTestIds.idempotencyKey,
      payload: {
        expectedRevisionId: studioTestIds.revisionId,
        expectedRevisionVersion: 1,
        mediaId: "88888888-8888-4888-8888-888888888888",
        studioId: studioTestIds.studioId,
      },
    }).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(requestSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(studioMediaFinalizeRequestTimeoutMs - 10_001);
    expect(requestSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(outcome).resolves.toMatchObject({ code: "REQUEST_TIMEOUT" });
    expect(requestSignal?.aborted).toBe(true);
  });
});

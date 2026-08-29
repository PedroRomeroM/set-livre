import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createStudio,
  isAmbiguousStudioError,
  isStudioBoundaryChangedError,
  readStudioEditor,
  readStudioTypes,
  StudioApiError,
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
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        Response.json({ data: studioEditorFixture, requestId: responseRequestId }),
      )
      .mockResolvedValueOnce(
        Response.json({ data: [studioTypeFixture], requestId: responseRequestId }),
      );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { clearTimeout, setTimeout });

    await expect(readStudioEditor(studioTestIds.studioId)).resolves.toEqual(studioEditorFixture);
    await expect(readStudioTypes()).resolves.toEqual([studioTypeFixture]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/owner/studios/${studioTestIds.studioId}`);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/studio-types");
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
    } as const;

    await expect(createStudio(command)).resolves.toEqual(studioEditorFixture);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual(command);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
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
});

import {
  ownerStudioEditorExpectedScopeHeader,
  type OwnerStudioEditorResult,
  type StudioCoreInput,
} from "@set-livre/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createStudio,
  discardStudioDraft,
  readStudioEditor,
  StudioApiError,
  updateStudioCore,
} from "../../src/domains/studios/components/studio-api";

const requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const userId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const otherUserId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const studioId = "11111111-1111-4111-8111-111111111111";
const studioTypeId = "22222222-2222-4222-8222-222222222222";
const idempotencyKey = "33333333-3333-4333-8333-333333333333";
const core = {
  address: {
    complement: "Sala qa_f006_api",
    neighborhood: "Batel",
    postalCode: "80000000",
    street: "Rua qa_f006_api",
    streetNumber: "10",
  },
  capacity: 6,
  description: "Descrição sintética qa_f006_api para validar o transporte.",
  name: "qa_f006_api",
  studioTypeId,
} satisfies StudioCoreInput;
const editResult = {
  mode: "edit",
  projection: "studio_editor",
  scope: userId,
  studio: {
    draft: {
      core: { ...core, city: "Curitiba", state: "PR", studioTypeName: "Podcast" },
      revisionNumber: 1,
    },
    editVersion: 1,
    id: studioId,
    published: null,
    status: "draft",
  },
  studioTypes: [{ id: studioTypeId, name: "Podcast" }],
} satisfies OwnerStudioEditorResult;

function stubBrowser() {
  vi.stubGlobal("window", { clearTimeout, setTimeout });
}

describe("studio browser API", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reads create and edit projections only from the scoped GET route", async () => {
    const createResult = {
      mode: "create",
      projection: "studio_editor",
      scope: userId,
      studio: null,
      studioTypes: editResult.studioTypes,
    } satisfies OwnerStudioEditorResult;
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(Response.json({ data: createResult, requestId }, { status: 200 }))
      .mockResolvedValueOnce(Response.json({ data: editResult, requestId }, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    stubBrowser();

    await expect(readStudioEditor(userId)).resolves.toEqual(createResult);
    await expect(readStudioEditor(userId, studioId)).resolves.toEqual(editResult);

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/owner/studio-editor");
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`/api/owner/studio-editor?studioId=${studioId}`);
    for (const call of fetchMock.mock.calls) {
      expect(call[1]).toMatchObject({ cache: "no-store", credentials: "same-origin" });
      expect(call[1]?.headers).toEqual({ [ownerStudioEditorExpectedScopeHeader]: userId });
      expect(call[1]?.method).toBeUndefined();
    }
  });

  it.each([
    [
      "studio.create",
      () => createStudio(userId, idempotencyKey, studioId, core),
      {
        action: "studio.create",
        expectedScope: userId,
        idempotencyKey,
        payload: { core, studioId },
      },
      editResult,
    ],
    [
      "studio.revision.updateCore",
      () => updateStudioCore(userId, idempotencyKey, studioId, 1, core),
      {
        action: "studio.revision.updateCore",
        expectedScope: userId,
        idempotencyKey,
        payload: { core, expectedEditVersion: 1, studioId },
      },
      editResult,
    ],
    [
      "studio.draft.discard",
      () => discardStudioDraft(userId, idempotencyKey, studioId, 1),
      {
        action: "studio.draft.discard",
        expectedScope: userId,
        idempotencyKey,
        payload: { expectedEditVersion: 1, studioId },
      },
      {
        outcome: "studio_removed",
        projection: "studio_draft_discard",
        scope: userId,
        studioId,
      },
    ],
  ] as const)("serializes the strict %s command envelope", async (_action, execute, body, data) => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => Response.json({ data, requestId }, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    stubBrowser();

    await expect(execute()).resolves.toEqual(data);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [path, init] = fetchMock.mock.calls[0] ?? [];
    expect(path).toBe("/api/commands");
    expect(init).toMatchObject({
      cache: "no-store",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(JSON.parse(String(init?.body))).toEqual(body);
    expect(JSON.stringify(body)).not.toContain("revisionNumber");
    expect(JSON.stringify(body)).not.toContain('"status"');
    expect(JSON.stringify(body)).not.toContain('"city"');
    expect(JSON.stringify(body)).not.toContain('"state"');
  });

  it("keeps safe field errors and redacts invalid response details", async () => {
    const privateDetail = "raw-private-studio-row";
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        Response.json(
          {
            error: {
              code: "VALIDATION_FAILED",
              fieldErrors: { capacity: "Informe uma capacidade válida." },
              message: "Revise os campos destacados.",
              requestId,
            },
          },
          { status: 422 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({ data: { ...editResult, privateDetail }, requestId }, { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    stubBrowser();

    await expect(updateStudioCore(userId, idempotencyKey, studioId, 1, core)).rejects.toMatchObject(
      {
        code: "VALIDATION_FAILED",
        fieldErrors: { capacity: "Informe uma capacidade válida." },
      },
    );
    const invalid = await readStudioEditor(userId, studioId).catch((error: unknown) => error);
    expect(invalid).toBeInstanceOf(StudioApiError);
    expect(invalid).toMatchObject({ code: "RESPONSE_INVALID" });
    expect(JSON.stringify(invalid)).not.toContain(privateDetail);
  });

  it("rejects a valid command DTO that drifts from the expected scope or studio", async () => {
    const otherStudioId = "44444444-4444-4444-8444-444444444444";
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        Response.json({ data: { ...editResult, scope: otherUserId }, requestId }, { status: 200 }),
      )
      .mockResolvedValueOnce(
        Response.json(
          {
            data: {
              editor: {
                ...editResult,
                studio: { ...editResult.studio, id: otherStudioId },
              },
              outcome: "draft_removed",
              projection: "studio_draft_discard",
              scope: userId,
              studioId,
            },
            requestId,
          },
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    stubBrowser();

    await expect(createStudio(userId, idempotencyKey, studioId, core)).rejects.toMatchObject({
      code: "RESPONSE_INVALID",
    });
    await expect(discardStudioDraft(userId, idempotencyKey, studioId, 1)).rejects.toMatchObject({
      code: "RESPONSE_INVALID",
    });
  });

  it("maps a timeout to a verification-first, redacted error", async () => {
    vi.useFakeTimers();
    const privateDetail = "raw-private-timeout";
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException(privateDetail, "AbortError")),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    stubBrowser();

    const outcome = createStudio(userId, idempotencyKey, studioId, core).catch(
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(10_000);
    const error = await outcome;

    expect(error).toBeInstanceOf(StudioApiError);
    expect(error).toMatchObject({ code: "REQUEST_TIMEOUT" });
    expect(JSON.stringify(error)).not.toContain(privateDetail);
  });
});

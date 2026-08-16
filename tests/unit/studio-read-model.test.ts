import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  editorAbortSignal: vi.fn(),
  editorMaybeSingle: vi.fn(),
  readOwnerRecipient: vi.fn(),
  rpc: vi.fn(),
  typesAbortSignal: vi.fn(),
}));
const client = { rpc: mocks.rpc };

vi.mock("../../src/domains/owners/server/owner-read-model", () => ({
  readOwnerRecipient: mocks.readOwnerRecipient,
}));

vi.mock("../../src/lib/supabase/server", () => ({
  createComponentSupabaseClient: async () => client,
}));

import {
  readActiveStudioTypes,
  readOwnerStudioEditor,
} from "../../src/domains/studios/server/studio-read-model";

const userId = "11111111-1111-4111-8111-111111111111";
const studioId = "22222222-2222-4222-8222-222222222222";
const revisionId = "33333333-3333-4333-8333-333333333333";
const studioTypeId = "44444444-4444-4444-8444-444444444444";
const studioTypes = [{ id: studioTypeId, name: "Fotografia" }];
const row = {
  draft_address_complement: null,
  draft_capacity: 12,
  draft_city: "Curitiba",
  draft_description: "Um estúdio completo para ensaios profissionais.",
  draft_name: "Estúdio Luz",
  draft_neighborhood: "Batel",
  draft_postal_code: "80420090",
  draft_revision_id: revisionId,
  draft_revision_number: 1,
  draft_state: "PR",
  draft_street: "Rua Exemplo",
  draft_street_number: "120 A",
  draft_studio_type_id: studioTypeId,
  draft_studio_type_name: "Fotografia",
  edit_version: 1,
  published_address_complement: null,
  published_capacity: null,
  published_city: null,
  published_description: null,
  published_name: null,
  published_neighborhood: null,
  published_postal_code: null,
  published_revision_id: null,
  published_revision_number: null,
  published_state: null,
  published_street: null,
  published_street_number: null,
  published_studio_type_id: null,
  published_studio_type_name: null,
  scope: userId,
  studio_id: studioId,
  studio_status: "draft",
};

function deferred<T>() {
  let fulfill: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    fulfill = resolve;
  });
  return {
    promise,
    resolve(value: T) {
      if (fulfill === undefined) throw new Error("Deferred indisponível.");
      fulfill(value);
    },
  };
}

describe("studio editor read model", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readOwnerRecipient.mockResolvedValue({ ownerStatus: "active" });
    mocks.rpc.mockImplementation((name: string) =>
      name === "list_active_studio_types"
        ? { abortSignal: mocks.typesAbortSignal }
        : { abortSignal: mocks.editorAbortSignal },
    );
    mocks.typesAbortSignal.mockResolvedValue({ data: studioTypes, error: null });
    mocks.editorAbortSignal.mockReturnValue({ maybeSingle: mocks.editorMaybeSingle });
    mocks.editorMaybeSingle.mockResolvedValue({ data: row, error: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns create mode from the active taxonomy without querying a studio", async () => {
    await expect(readOwnerStudioEditor(userId)).resolves.toEqual({
      mode: "create",
      projection: "studio_editor",
      scope: userId,
      studio: null,
      studioTypes,
    });
    expect(mocks.rpc).toHaveBeenCalledWith("list_active_studio_types");
    expect(mocks.rpc).not.toHaveBeenCalledWith("get_owner_studio_editor", expect.anything());
    expect(mocks.typesAbortSignal).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(mocks.readOwnerRecipient).toHaveBeenCalledWith(userId, expect.any(AbortSignal));
    expect(mocks.readOwnerRecipient.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.rpc.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it.each(["inactive", "blocked"])(
    "rejects owner status %s before loading taxonomy or editor data",
    async (ownerStatus) => {
      mocks.readOwnerRecipient.mockResolvedValueOnce({ ownerStatus });

      await expect(readOwnerStudioEditor(userId, studioId)).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: "Esta conta não pode gerenciar estúdios no estado atual.",
        status: 403,
      });
      expect(mocks.rpc).not.toHaveBeenCalled();
    },
  );

  it("reads taxonomy and the owner-filtered editor in parallel with one abort signal", async () => {
    const result = await readOwnerStudioEditor(userId, studioId);
    expect(result).toMatchObject({
      mode: "edit",
      scope: userId,
      studio: { editVersion: 1, id: studioId, status: "draft" },
      studioTypes,
    });
    expect(mocks.rpc).toHaveBeenCalledWith("get_owner_studio_editor", {
      p_studio_id: studioId,
    });
    expect(mocks.editorAbortSignal).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(mocks.editorAbortSignal.mock.calls[0]?.[0]).toBe(
      mocks.typesAbortSignal.mock.calls[0]?.[0],
    );
    expect(mocks.readOwnerRecipient).toHaveBeenCalledWith(
      userId,
      mocks.typesAbortSignal.mock.calls[0]?.[0],
    );
    expect(JSON.stringify(result)).not.toContain(revisionId);
  });

  it("returns a uniform 404 for an absent or cross-owner row", async () => {
    mocks.editorMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
    await expect(readOwnerStudioEditor(userId, studioId)).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
  });

  it("fails closed on RPC, scope, taxonomy and row-shape drift", async () => {
    mocks.editorMaybeSingle.mockResolvedValueOnce({ data: null, error: { code: "unexpected" } });
    await expect(readOwnerStudioEditor(userId, studioId)).rejects.toThrow(
      "Não foi possível carregar",
    );

    mocks.editorMaybeSingle.mockResolvedValueOnce({
      data: { ...row, scope: "55555555-5555-4555-8555-555555555555" },
      error: null,
    });
    await expect(readOwnerStudioEditor(userId, studioId)).rejects.toThrow("não corresponde");

    mocks.typesAbortSignal.mockResolvedValueOnce({
      data: [...studioTypes, studioTypes[0]],
      error: null,
    });
    await expect(readOwnerStudioEditor(userId)).rejects.toThrow();

    mocks.editorMaybeSingle.mockResolvedValueOnce({
      data: { ...row, owner_user_id: userId },
      error: null,
    });
    await expect(readOwnerStudioEditor(userId, studioId)).rejects.toThrow();
  });

  it("supports the taxonomy-only read used after private commands", async () => {
    await expect(readActiveStudioTypes()).resolves.toEqual(studioTypes);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it("propagates an external abort through a private internal signal", async () => {
    const pending = deferred<{ data: unknown; error: null }>();
    mocks.typesAbortSignal.mockReturnValueOnce(pending.promise);
    const externalController = new AbortController();
    const outcome = readOwnerStudioEditor(userId, undefined, externalController.signal).catch(
      (error: unknown) => error,
    );
    await Promise.resolve();
    await Promise.resolve();
    const internalSignal = mocks.readOwnerRecipient.mock.calls[0]?.[1];
    expect(internalSignal).toBeInstanceOf(AbortSignal);
    expect(internalSignal).not.toBe(externalController.signal);

    externalController.abort();
    await expect(outcome).resolves.toMatchObject({ name: "AbortError" });
    expect(internalSignal?.aborted).toBe(true);
    pending.resolve({ data: studioTypes, error: null });
  });

  it("expires at exactly 2,000ms and ignores a non-cooperative late result", async () => {
    vi.useFakeTimers();
    const pending = deferred<{ data: unknown; error: null }>();
    mocks.typesAbortSignal.mockReturnValueOnce(pending.promise);
    let settled = false;
    const outcome = readOwnerStudioEditor(userId).catch((error: unknown) => error);
    void outcome.then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    const internalSignal = mocks.readOwnerRecipient.mock.calls[0]?.[1];

    await vi.advanceTimersByTimeAsync(1_999);
    expect(settled).toBe(false);
    expect(internalSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(outcome).resolves.toMatchObject({ name: "AbortError" });
    expect(internalSignal?.aborted).toBe(true);

    pending.resolve({ data: studioTypes, error: null });
    await Promise.resolve();
    expect(await outcome).toMatchObject({ name: "AbortError" });
  });
});

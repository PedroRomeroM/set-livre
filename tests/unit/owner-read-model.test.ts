import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({ abortSignal: vi.fn(), maybeSingle: vi.fn(), rpc: vi.fn() }));
const client = { rpc: mocks.rpc };

vi.mock("../../src/lib/supabase/server", () => ({
  createComponentSupabaseClient: async () => client,
}));

import { readOwnerRecipient } from "../../src/domains/owners/server/owner-read-model";

const userId = "11111111-1111-4111-8111-111111111111";
const row = {
  accepted_owner_contract_version_id: null,
  next_action: "activate_owner",
  owner_contract_accepted: false,
  owner_contract_body_markdown: "# Contrato local",
  owner_contract_content_hash: "a".repeat(64),
  owner_contract_effective_at: "2026-08-12T00:00:00.000Z",
  owner_contract_id: "33333333-3333-4333-8333-333333333333",
  owner_contract_kind: "owner_contract",
  owner_contract_source: "local_fixture",
  owner_contract_title: "Contrato do dono",
  owner_contract_version: "local-1",
  owner_status: "inactive",
  owner_version: 0,
  profile_version: 4,
  profile_version_synced: null,
  provider_mode: "local",
  recipient_status: "not_started",
  recipient_version: 0,
  requirements: [],
  reservations_eligible: false,
  scope: userId,
};

function deferred<T>() {
  let fulfill: ((value: T) => void) | undefined;
  let fail: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    fulfill = resolve;
    fail = reject;
  });
  return {
    promise,
    reject(error: unknown) {
      if (fail === undefined) throw new Error("Deferred indisponível.");
      fail(error);
    },
    resolve(value: T) {
      if (fulfill === undefined) throw new Error("Deferred indisponível.");
      fulfill(value);
    },
  };
}

async function startPendingOwnerRead() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("owner recipient read model", () => {
  beforeEach(() => {
    process.env.APP_ENV = "test";
    vi.clearAllMocks();
    mocks.abortSignal.mockReturnValue({ maybeSingle: mocks.maybeSingle });
    mocks.rpc.mockReturnValue({ abortSignal: mocks.abortSignal, maybeSingle: mocks.maybeSingle });
    mocks.maybeSingle.mockResolvedValue({ data: row, error: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads the no-argument authenticated invoker RPC and maps only the safe DTO", async () => {
    await expect(readOwnerRecipient(userId)).resolves.toMatchObject({
      nextAction: "activate_owner",
      ownerContract: { id: row.owner_contract_id, kind: "owner_contract" },
      providerMode: "local",
      scope: userId,
    });
    expect(mocks.rpc).toHaveBeenCalledWith("get_owner_recipient_status");
    expect(mocks.abortSignal).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(JSON.stringify(await mocks.maybeSingle.mock.results[0]?.value)).not.toContain(
      "provider_reference",
    );
  });

  it("combines an external abort with the internal signal without passing a UUID to the RPC", async () => {
    const pending = deferred<{ data: unknown; error: null }>();
    mocks.maybeSingle.mockReturnValueOnce(pending.promise);
    const externalController = new AbortController();
    const outcome = readOwnerRecipient(userId, externalController.signal).catch(
      (error: unknown) => error,
    );
    await startPendingOwnerRead();
    expect(mocks.rpc).toHaveBeenCalledWith("get_owner_recipient_status");
    const internalSignal = mocks.abortSignal.mock.calls[0]?.[0];
    expect(internalSignal).toBeInstanceOf(AbortSignal);
    expect(internalSignal).not.toBe(externalController.signal);
    expect(internalSignal?.aborted).toBe(false);

    externalController.abort();
    await expect(outcome).resolves.toMatchObject({ name: "AbortError" });
    expect(internalSignal?.aborted).toBe(true);
  });

  it("expires at exactly 2,000ms and ignores a non-cooperative late resolution", async () => {
    vi.useFakeTimers();
    const pending = deferred<{ data: unknown; error: null }>();
    mocks.maybeSingle.mockReturnValueOnce(pending.promise);
    let settled = false;
    const outcome = readOwnerRecipient(userId).catch((error: unknown) => error);
    void outcome.then(() => {
      settled = true;
    });
    await startPendingOwnerRead();
    const internalSignal = mocks.abortSignal.mock.calls[0]?.[0];

    await vi.advanceTimersByTimeAsync(1_999);
    expect(settled).toBe(false);
    expect(internalSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(outcome).resolves.toMatchObject({ name: "AbortError" });
    expect(internalSignal?.aborted).toBe(true);
    pending.resolve({ data: row, error: null });
    await Promise.resolve();
    expect(await outcome).toMatchObject({ name: "AbortError" });
  });

  it("absorbs a late RPC rejection after timeout without an unhandled rejection", async () => {
    vi.useFakeTimers();
    const pending = deferred<{ data: unknown; error: null }>();
    mocks.maybeSingle.mockReturnValueOnce(pending.promise);
    const unhandledRejection = vi.fn();
    process.on("unhandledRejection", unhandledRejection);
    try {
      const outcome = readOwnerRecipient(userId).catch((error: unknown) => error);
      await startPendingOwnerRead();
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(outcome).resolves.toMatchObject({ name: "AbortError" });

      pending.reject(new Error("late private RPC error"));
      await Promise.resolve();
      await Promise.resolve();
      expect(unhandledRejection).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandledRejection);
    }
  });

  it("clears its deadline timer after a successful read", async () => {
    vi.useFakeTimers();
    const pending = deferred<{ data: unknown; error: null }>();
    mocks.maybeSingle.mockReturnValueOnce(pending.promise);
    const outcome = readOwnerRecipient(userId);
    await startPendingOwnerRead();
    expect(vi.getTimerCount()).toBe(1);

    pending.resolve({ data: row, error: null });
    await expect(outcome).resolves.toMatchObject({ scope: userId });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails closed on another scope, malformed/extra rows, absence and RPC errors", async () => {
    mocks.maybeSingle.mockResolvedValueOnce({
      data: { ...row, scope: "22222222-2222-4222-8222-222222222222" },
      error: null,
    });
    await expect(readOwnerRecipient(userId)).rejects.toThrow("não corresponde");

    mocks.maybeSingle.mockResolvedValueOnce({
      data: { ...row, provider_reference: "private" },
      error: null,
    });
    await expect(readOwnerRecipient(userId)).rejects.toThrow();

    mocks.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    await expect(readOwnerRecipient(userId)).rejects.toThrow();

    mocks.maybeSingle.mockResolvedValueOnce({ data: null, error: { code: "unexpected" } });
    await expect(readOwnerRecipient(userId)).rejects.toThrow("Não foi possível carregar");
  });

  it("refuses a local fixture read in production without exposing its legal body", async () => {
    process.env.APP_ENV = "production";
    const error = await readOwnerRecipient(userId).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(row.owner_contract_body_markdown);

    mocks.maybeSingle.mockResolvedValueOnce({
      data: { ...row, owner_contract_source: "approved" },
      error: null,
    });
    await expect(readOwnerRecipient(userId)).resolves.toMatchObject({
      ownerContract: { source: "approved" },
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({ abortSignal: vi.fn(), maybeSingle: vi.fn(), rpc: vi.fn() }));
const client = { rpc: mocks.rpc };

vi.mock("../../src/lib/supabase/server", () => ({
  createComponentSupabaseClient: async () => client,
}));

import {
  readOwnerActivation,
  readOwnerRecipient,
} from "../../src/domains/owners/server/owner-read-model";

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
const recipientRow = {
  accepted_owner_contract_version_id: row.accepted_owner_contract_version_id,
  next_action: row.next_action,
  owner_contract_accepted: row.owner_contract_accepted,
  owner_contract_effective_at: row.owner_contract_effective_at,
  owner_contract_id: row.owner_contract_id,
  owner_contract_source: row.owner_contract_source,
  owner_status: row.owner_status,
  owner_version: row.owner_version,
  profile_version: row.profile_version,
  profile_version_synced: row.profile_version_synced,
  provider_mode: row.provider_mode,
  recipient_status: row.recipient_status,
  recipient_version: row.recipient_version,
  requirements: row.requirements,
  reservations_eligible: row.reservations_eligible,
  scope: row.scope,
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
    mocks.maybeSingle.mockResolvedValue({ data: recipientRow, error: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads the no-argument authenticated invoker RPC and maps only the safe DTO", async () => {
    const result = await readOwnerRecipient(userId);
    expect(result).toMatchObject({
      nextAction: "activate_owner",
      ownerContract: { id: row.owner_contract_id },
      projection: "recipient",
      providerMode: "local",
      recipientOnboardingCapability: "local_adapter",
      scope: userId,
    });
    expect(mocks.rpc).toHaveBeenCalledWith("get_owner_recipient_status");
    expect(mocks.abortSignal).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(Object.keys(result.ownerContract).sort()).toEqual(["effectiveAt", "id", "source"]);
    expect(JSON.stringify(result)).not.toContain("provider_reference");
    expect(JSON.stringify(result)).not.toContain("bodyMarkdown");
    expect(JSON.stringify(result)).not.toContain("contentHash");
  });

  it("reads the full contract only from the activation RPC", async () => {
    mocks.maybeSingle.mockResolvedValueOnce({ data: row, error: null });
    await expect(readOwnerActivation(userId)).resolves.toMatchObject({
      ownerActivationCapability: "available",
      ownerContract: {
        bodyMarkdown: row.owner_contract_body_markdown,
        id: row.owner_contract_id,
        kind: "owner_contract",
      },
      projection: "activation",
      recipientOnboardingCapability: "local_adapter",
      scope: userId,
    });
    expect(mocks.rpc).toHaveBeenCalledWith("get_owner_activation_status");
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
    pending.resolve({ data: recipientRow, error: null });
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

    pending.resolve({ data: recipientRow, error: null });
    await expect(outcome).resolves.toMatchObject({ scope: userId });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails closed on another scope, malformed/extra rows, absence and RPC errors", async () => {
    mocks.maybeSingle.mockResolvedValueOnce({
      data: { ...recipientRow, scope: "22222222-2222-4222-8222-222222222222" },
      error: null,
    });
    await expect(readOwnerRecipient(userId)).rejects.toThrow("não corresponde");

    mocks.maybeSingle.mockResolvedValueOnce({
      data: { ...recipientRow, provider_reference: "private" },
      error: null,
    });
    await expect(readOwnerRecipient(userId)).rejects.toThrow();

    mocks.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    await expect(readOwnerRecipient(userId)).rejects.toThrow();

    mocks.maybeSingle.mockResolvedValueOnce({ data: null, error: { code: "unexpected" } });
    await expect(readOwnerRecipient(userId)).rejects.toThrow("Não foi possível carregar");
  });

  it("keeps the compact local-fixture facts readable in production", async () => {
    process.env.APP_ENV = "production";
    await expect(readOwnerRecipient(userId)).resolves.toMatchObject({
      ownerContract: { source: "local_fixture" },
      recipientOnboardingCapability: "unavailable",
    });
    expect(JSON.stringify(recipientRow)).not.toContain(row.owner_contract_body_markdown);
  });

  it.each(["development", "production", "preview", undefined] as const)(
    "keeps the complete local-fixture contract readable with activation unavailable in APP_ENV=%s",
    async (environment) => {
      if (environment === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = environment;
      mocks.maybeSingle.mockResolvedValueOnce({ data: row, error: null });

      await expect(readOwnerActivation(userId)).resolves.toMatchObject({
        ownerActivationCapability: "unavailable",
        ownerContract: {
          bodyMarkdown: row.owner_contract_body_markdown,
          source: "local_fixture",
        },
        recipientOnboardingCapability: "unavailable",
      });
    },
  );

  it("keeps an approved contract executable when the local recipient adapter is unavailable", async () => {
    process.env.APP_ENV = "production";
    mocks.maybeSingle.mockResolvedValueOnce({
      data: { ...row, owner_contract_source: "approved" },
      error: null,
    });

    await expect(readOwnerActivation(userId)).resolves.toMatchObject({
      ownerActivationCapability: "available",
      ownerContract: { source: "approved" },
      recipientOnboardingCapability: "unavailable",
    });
  });
});

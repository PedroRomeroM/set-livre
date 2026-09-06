import { describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";

import {
  cleanupBatchSize,
  CleanupRunError,
  parseCleanupFunctionSlug,
  parseCleanupRunRequest,
  runStudioMediaCleanup,
} from "../../supabase/functions/media-cleanup/cleanup-core.ts";
import { createCleanupRequestHandler } from "../../supabase/functions/media-cleanup/index.ts";
import { isConfirmedStorageObjectAbsence } from "../../scripts/configure-production-media-cleanup.mjs";

const runId = "87000000-0000-4000-8000-000000000000";
const functionSlug = `media-cleanup-${"a".repeat(40)}`;
const workerId = runId;
const candidates = [
  {
    attempt: 1,
    bucket: "studio-media",
    mediaId: "87000000-0000-4000-8000-000000000002",
    paths: [
      "owners/87000000-0000-4000-8000-000000000003/studios/87000000-0000-4000-8000-000000000004/revisions/87000000-0000-4000-8000-000000000005/87000000-0000-4000-8000-000000000002.jpg",
      "owners/87000000-0000-4000-8000-000000000003/studios/87000000-0000-4000-8000-000000000004/revisions/87000000-0000-4000-8000-000000000005/87000000-0000-4000-8000-000000000002.preview.webp",
    ],
  },
  {
    attempt: 2,
    bucket: "studio-media",
    mediaId: "87000000-0000-4000-8000-000000000006",
    paths: [
      "owners/87000000-0000-4000-8000-000000000003/studios/87000000-0000-4000-8000-000000000004/revisions/87000000-0000-4000-8000-000000000005/87000000-0000-4000-8000-000000000006.webp",
      "owners/87000000-0000-4000-8000-000000000003/studios/87000000-0000-4000-8000-000000000004/revisions/87000000-0000-4000-8000-000000000005/87000000-0000-4000-8000-000000000006.preview.webp",
    ],
  },
];

function dependencies(overrides = {}) {
  return {
    beginRun: vi.fn().mockResolvedValue({
      claimed: null,
      deleted: null,
      errorCode: null,
      failed: null,
      functionSlug,
      runId,
      status: "running",
    }),
    claim: vi.fn().mockResolvedValue({ claimToken: workerId, items: candidates }),
    complete: vi.fn().mockResolvedValue(undefined),
    completeRun: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function adapterRpc(items = [candidates[0]]) {
  return vi.fn(async (name, parameters = {}) => {
    if (name === "begin_studio_media_cleanup_run") {
      return {
        data: {
          claimed: null,
          deleted: null,
          errorCode: null,
          failed: null,
          functionSlug,
          runId,
          status: "running",
        },
        error: null,
      };
    }
    if (name === "claim_studio_media_cleanup") {
      return { data: { claimToken: runId, items }, error: null };
    }
    if (name === "complete_studio_media_cleanup") {
      return { data: null, error: null };
    }
    if (name === "complete_studio_media_cleanup_run") {
      return {
        data: {
          claimed: parameters.p_claimed,
          deleted: parameters.p_deleted,
          errorCode: parameters.p_error_code,
          failed: parameters.p_failed,
          functionSlug,
          runId,
          status: parameters.p_status,
        },
        error: null,
      };
    }
    throw new Error(`RPC inesperada: ${name}`);
  });
}

describe("studio media cleanup edge adapter", () => {
  it("recebe a rota interna do provider e executa claim e complete com a identidade do core", async () => {
    const remove = vi.fn(async () => ({ data: [], error: null }));
    const rpc = adapterRpc();
    const createSupabaseClient = vi.fn(() => ({
      rpc,
      storage: { from: vi.fn(() => ({ remove })) },
    }));
    const secretKey = "sb_secret_adapterTestKey123";
    const handler = createCleanupRequestHandler({
      createSupabaseClient,
      readConfiguration: () => ({ secretKey, url: "https://supabase.example" }),
    });

    const response = await handler(
      new Request(`https://supabase.example/${functionSlug}`, {
        body: JSON.stringify({ runId }),
        headers: { apikey: secretKey, "content-type": "application/json" },
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ claimed: 1, deleted: 1, failed: 0 });
    expect(rpc).toHaveBeenCalledWith("begin_studio_media_cleanup_run", {
      p_function_slug: functionSlug,
      p_run_id: runId,
    });
    expect(rpc).toHaveBeenCalledWith("claim_studio_media_cleanup", {
      p_claim_token: runId,
      p_limit: 2,
    });
    expect(rpc).toHaveBeenCalledWith("complete_studio_media_cleanup", {
      p_claim_token: runId,
      p_error_code: null,
      p_media_id: candidates[0].mediaId,
      p_succeeded: true,
    });
    expect(remove).toHaveBeenCalledWith(candidates[0].paths);
  });

  it("rejeita prefixo externo e sufixos de rota antes de abrir o ledger", async () => {
    const createSupabaseClient = vi.fn();
    const secretKey = "sb_secret_adapterTestKey123";
    const handler = createCleanupRequestHandler({
      createSupabaseClient,
      readConfiguration: () => ({ secretKey, url: "https://supabase.example" }),
    });
    for (const path of [
      `/functions/v1/${functionSlug}`,
      `/${functionSlug}/extra`,
      `/${functionSlug}?retry=1`,
      `/${functionSlug}#fragment`,
    ]) {
      const response = await handler(
        new Request(`https://supabase.example${path}`, {
          body: JSON.stringify({ runId }),
          headers: { apikey: secretKey, "content-type": "application/json" },
          method: "POST",
        }),
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        claimed: 0,
        deleted: 0,
        errorCode: "invalid_request",
        failed: 0,
      });
    }
    expect(createSupabaseClient).not.toHaveBeenCalled();
  });

  it("aborta remoção Storage pendente no deadline individual e fecha o ledger", async () => {
    vi.useFakeTimers();
    try {
      let observedSignal;
      let notifyStorageStarted;
      const storageStarted = new Promise((resolve) => {
        notifyStorageStarted = resolve;
      });
      const fetchImplementation = vi.fn(
        (_input, init) =>
          new Promise((_resolve, reject) => {
            observedSignal = init?.signal;
            if (!(observedSignal instanceof AbortSignal)) {
              reject(new Error("missing storage abort signal"));
              return;
            }
            notifyStorageStarted();
            const rejectOnAbort = () =>
              reject(
                observedSignal.reason ??
                  new DOMException("cleanup_storage_remove_aborted", "AbortError"),
              );
            if (observedSignal.aborted) rejectOnAbort();
            else observedSignal.addEventListener("abort", rejectOnAbort, { once: true });
          }),
      );
      const rpc = adapterRpc();
      const createSupabaseClient = vi.fn((_url, _secretKey, options) => ({
        rpc,
        storage: {
          from: vi.fn(() => ({
            remove: vi.fn(async (paths) => {
              await options.global.fetch(
                "https://supabase.example/storage/v1/object/studio-media",
                {
                  body: JSON.stringify({ prefixes: paths }),
                  method: "DELETE",
                },
              );
              return { data: [], error: null };
            }),
          })),
        },
      }));
      const secretKey = "sb_secret_adapterTestKey123";
      const handler = createCleanupRequestHandler({
        createSupabaseClient,
        fetchImplementation,
        readConfiguration: () => ({ secretKey, url: "https://supabase.example" }),
      });

      const responsePromise = handler(
        new Request(`https://supabase.example/${functionSlug}`, {
          body: JSON.stringify({ runId }),
          headers: { apikey: secretKey, "content-type": "application/json" },
          method: "POST",
        }),
      );
      await storageStarted;
      expect(observedSignal).toBeInstanceOf(AbortSignal);
      expect(observedSignal.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(10_000);

      const response = await responsePromise;
      expect(observedSignal.aborted).toBe(true);
      expect(observedSignal.reason).toMatchObject({
        message: "cleanup_storage_remove_deadline_exceeded",
        name: "TimeoutError",
      });
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        claimed: 1,
        deleted: 0,
        errorCode: "cleanup_storage_remove_failed",
        failed: 1,
      });
      expect(rpc).toHaveBeenCalledWith("complete_studio_media_cleanup", {
        p_claim_token: runId,
        p_error_code: "storage_remove_failed",
        p_media_id: candidates[0].mediaId,
        p_succeeded: false,
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("concede um deadline completo a cada remoção Storage sequencial", async () => {
    vi.useFakeTimers();
    try {
      const observedSignals = [];
      let notifyFirstStorageStarted;
      let notifySecondStorageStarted;
      const firstStorageStarted = new Promise((resolve) => {
        notifyFirstStorageStarted = resolve;
      });
      const secondStorageStarted = new Promise((resolve) => {
        notifySecondStorageStarted = resolve;
      });
      const fetchImplementation = vi.fn(
        (_input, init) =>
          new Promise((resolve, reject) => {
            const signal = init?.signal;
            if (!(signal instanceof AbortSignal)) {
              reject(new Error("missing storage abort signal"));
              return;
            }
            observedSignals.push(signal);
            if (observedSignals.length === 1) notifyFirstStorageStarted();
            if (observedSignals.length === 2) notifySecondStorageStarted();

            const resolveRemoval = () => {
              signal.removeEventListener("abort", rejectOnAbort);
              resolve(Response.json([]));
            };
            const removalDuration = setTimeout(resolveRemoval, 6_000);
            const rejectOnAbort = () => {
              clearTimeout(removalDuration);
              reject(
                signal.reason ?? new DOMException("cleanup_storage_remove_aborted", "AbortError"),
              );
            };
            if (signal.aborted) rejectOnAbort();
            else signal.addEventListener("abort", rejectOnAbort, { once: true });
          }),
      );
      const rpc = adapterRpc(candidates);
      const createSupabaseClient = vi.fn((_url, _secretKey, options) => ({
        rpc,
        storage: {
          from: vi.fn(() => ({
            remove: vi.fn(async (paths) => {
              await options.global.fetch(
                "https://supabase.example/storage/v1/object/studio-media",
                {
                  body: JSON.stringify({ prefixes: paths }),
                  method: "DELETE",
                },
              );
              return { data: [], error: null };
            }),
          })),
        },
      }));
      const secretKey = "sb_secret_adapterTestKey123";
      const handler = createCleanupRequestHandler({
        createSupabaseClient,
        fetchImplementation,
        readConfiguration: () => ({ secretKey, url: "https://supabase.example" }),
      });

      const responsePromise = handler(
        new Request(`https://supabase.example/${functionSlug}`, {
          body: JSON.stringify({ runId }),
          headers: { apikey: secretKey, "content-type": "application/json" },
          method: "POST",
        }),
      );

      await firstStorageStarted;
      await vi.advanceTimersByTimeAsync(6_000);
      await secondStorageStarted;
      expect(fetchImplementation).toHaveBeenCalledTimes(2);
      expect(observedSignals).toHaveLength(2);
      expect(observedSignals[1].aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(6_000);

      const response = await responsePromise;
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ claimed: 2, deleted: 2, failed: 0 });
      expect(observedSignals.every((signal) => signal.aborted === false)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancela trabalho sem cancelar confirmação de item ou fechamento do ledger", async () => {
    const invocationController = new AbortController();
    const observedRequests = [];
    const fetchImplementation = vi.fn(async (input, init) => {
      const endpoint = new URL(input instanceof Request ? input.url : String(input));
      observedRequests.push({ pathname: endpoint.pathname, signal: init?.signal });

      if (endpoint.pathname === "/rest/v1/rpc/begin_studio_media_cleanup_run") {
        return Response.json({
          claimed: null,
          deleted: null,
          errorCode: null,
          failed: null,
          functionSlug,
          runId,
          status: "running",
        });
      }
      if (endpoint.pathname === "/rest/v1/rpc/claim_studio_media_cleanup") {
        return Response.json({ claimToken: runId, items: [candidates[0]] });
      }
      if (endpoint.pathname === "/rest/v1/rpc/complete_studio_media_cleanup") {
        return Response.json(null);
      }
      if (endpoint.pathname === "/rest/v1/rpc/complete_studio_media_cleanup_run") {
        const body = JSON.parse(String(init?.body));
        return Response.json({
          claimed: body.p_claimed,
          deleted: body.p_deleted,
          errorCode: body.p_error_code,
          failed: body.p_failed,
          functionSlug,
          runId,
          status: body.p_status,
        });
      }
      if (endpoint.pathname === "/storage/v1/object/studio-media") {
        return Response.json([]);
      }
      throw new Error(`Requisição inesperada: ${endpoint.pathname}`);
    });
    const secretKey = "sb_secret_adapterTestKey123";
    const handler = createCleanupRequestHandler({
      createSupabaseClient: createClient,
      fetchImplementation,
      readConfiguration: () => ({ secretKey, url: "https://supabase.example" }),
    });

    const response = await handler(
      new Request(`https://supabase.example/${functionSlug}`, {
        body: JSON.stringify({ runId }),
        headers: { apikey: secretKey, "content-type": "application/json" },
        method: "POST",
        signal: invocationController.signal,
      }),
    );

    expect(response.status).toBe(200);
    expect(observedRequests.map(({ pathname }) => pathname)).toEqual([
      "/rest/v1/rpc/begin_studio_media_cleanup_run",
      "/rest/v1/rpc/claim_studio_media_cleanup",
      "/storage/v1/object/studio-media",
      "/rest/v1/rpc/complete_studio_media_cleanup",
      "/rest/v1/rpc/complete_studio_media_cleanup_run",
    ]);
    expect(observedRequests.every(({ signal }) => signal instanceof AbortSignal)).toBe(true);
    expect(observedRequests.every(({ signal }) => signal.aborted === false)).toBe(true);

    const abortReason = new DOMException("cleanup_invocation_aborted", "AbortError");
    invocationController.abort(abortReason);

    expect(observedRequests.slice(0, 3).every(({ signal }) => signal.aborted === true)).toBe(true);
    expect(observedRequests.slice(0, 3).every(({ signal }) => signal.reason === abortReason)).toBe(
      true,
    );
    expect(observedRequests.slice(-2).every(({ signal }) => signal.aborted === false)).toBe(true);
  });

  it.each([
    ["sem apikey", {}],
    ["com apikey incorreta", { apikey: "sb_secret_wrongAdapterKey123" }],
  ])("rejeita %s antes de criar cliente, chamar RPC ou tocar Storage", async (_label, headers) => {
    const rpc = vi.fn();
    const remove = vi.fn();
    const createSupabaseClient = vi.fn(() => ({
      rpc,
      storage: { from: vi.fn(() => ({ remove })) },
    }));
    const secretKey = "sb_secret_adapterTestKey123";
    const handler = createCleanupRequestHandler({
      createSupabaseClient,
      readConfiguration: () => ({ secretKey, url: "https://supabase.example" }),
    });

    const response = await handler(
      new Request(`https://supabase.example/${functionSlug}`, {
        body: JSON.stringify({ runId }),
        headers: { ...headers, "content-type": "application/json" },
        method: "POST",
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      claimed: 0,
      deleted: 0,
      errorCode: "unauthenticated",
      failed: 0,
    });
    expect(createSupabaseClient).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});

describe("studio media cleanup edge core", () => {
  it.each([
    { outcomes: ["deleted"], deleted: 2, failed: 0, removals: 1 },
    { outcomes: ["deleted", "deleted"], deleted: 2, failed: 0, removals: 0 },
    { outcomes: ["failed", "deleted"], deleted: 1, failed: 1, removals: 0 },
  ])("replay preserva resultados persistidos sem repetir Storage (%#)", async (scenario) => {
    const items = candidates.map((candidate, index) =>
      scenario.outcomes[index] === undefined
        ? candidate
        : { mediaId: candidate.mediaId, outcome: scenario.outcomes[index] },
    );
    const contract = dependencies({
      claim: vi.fn().mockResolvedValue({ claimToken: workerId, items }),
    });
    const result = { claimed: 2, deleted: scenario.deleted, failed: scenario.failed };
    const invocation = runStudioMediaCleanup(contract, { functionSlug, runId });
    if (scenario.failed === 0) await expect(invocation).resolves.toEqual(result);
    else
      await expect(invocation).rejects.toMatchObject({
        errorCode: "cleanup_replayed_item_failed",
        result,
      });
    expect(contract.remove).toHaveBeenCalledTimes(scenario.removals);
    expect(contract.complete).toHaveBeenCalledTimes(scenario.removals);
    expect(contract.completeRun).toHaveBeenCalledWith(expect.objectContaining(result));
  });

  it("limita lote e cardinalidade reclamada antes de qualquer remoção", async () => {
    expect(cleanupBatchSize).toBe(2);
    for (const batchSize of [0, 3, 4, 5, 25, 100, Number.NaN]) {
      const contract = dependencies();
      await expect(
        runStudioMediaCleanup(contract, { batchSize, functionSlug, runId }),
      ).rejects.toThrow();
      expect(contract.beginRun).not.toHaveBeenCalled();
    }
    const contract = dependencies({
      claim: vi.fn().mockResolvedValue({
        claimToken: runId,
        items: [...candidates, ...candidates, candidates[0]],
      }),
    });
    await expect(runStudioMediaCleanup(contract, { functionSlug, runId })).rejects.toMatchObject({
      errorCode: "cleanup_claim_payload_invalid",
      result: { claimed: 5, deleted: 0, failed: 5 },
    });
    expect(contract.remove).not.toHaveBeenCalled();
    expect(contract.complete).not.toHaveBeenCalled();
    expect(contract.completeRun).toHaveBeenCalledWith(
      expect.objectContaining({ claimed: 5, failed: 5 }),
    );
  });
  it("extrai somente o slug imutável exato da URL interna do provider", () => {
    for (const origin of ["https://supabase.example", "http://edge-runtime:9000"]) {
      expect(parseCleanupFunctionSlug(`${origin}/${functionSlug}`)).toBe(functionSlug);
    }
    for (const url of [
      "https://supabase.example/media-cleanup",
      `https://supabase.example/media-cleanup-${"a".repeat(39)}`,
      `https://supabase.example/media-cleanup-${"a".repeat(41)}`,
      `https://supabase.example/media-cleanup-${"g".repeat(40)}`,
      `https://supabase.example/media-cleanup-${"A".repeat(40)}`,
      `https://supabase.example/functions/v1/${functionSlug}`,
      `https://supabase.example/${functionSlug}/extra`,
      `https://supabase.example/${functionSlug}/`,
      `https://supabase.example/${functionSlug}?retry=1`,
      `https://supabase.example/${functionSlug}?`,
      `https://supabase.example/${functionSlug}#fragment`,
      `https://supabase.example/${functionSlug}#`,
      `https://supabase.example/other/${functionSlug}`,
    ]) {
      expect(() => parseCleanupFunctionSlug(url)).toThrow("URL");
    }
  });

  it("aceita somente o JSON estrito com um único runId UUID", () => {
    expect(
      parseCleanupRunRequest({
        contentType: "application/json; charset=utf-8",
        rawBody: JSON.stringify({ runId }),
      }),
    ).toBe(runId);
    for (const request of [
      { contentType: "text/plain", rawBody: JSON.stringify({ runId }) },
      { contentType: "application/json", rawBody: JSON.stringify({ runId, retry: true }) },
      { contentType: "application/json", rawBody: JSON.stringify({ runId: "invalid" }) },
      { contentType: "application/json", rawBody: "{" },
    ]) {
      expect(() => parseCleanupRunRequest(request)).toThrow();
    }
  });

  it("registra uma execução contabilmente fechada depois da remoção física", async () => {
    const contract = dependencies();

    await expect(runStudioMediaCleanup(contract, { functionSlug, runId })).resolves.toEqual({
      claimed: 2,
      deleted: 2,
      failed: 0,
    });

    expect(contract.beginRun).toHaveBeenCalledWith({ functionSlug, runId, workerId });
    expect(contract.completeRun).toHaveBeenCalledWith({
      claimed: 2,
      deleted: 2,
      errorCode: null,
      failed: 0,
      functionSlug,
      runId,
      workerId,
    });
    expect(contract.complete).toHaveBeenNthCalledWith(1, {
      errorCode: null,
      mediaId: candidates[0].mediaId,
      functionSlug,
      runId,
      succeeded: true,
      workerId,
    });
  });

  it("não mascara falha física e ainda fecha a execução com uma decisão por item", async () => {
    const completeRun = vi.fn().mockResolvedValue(undefined);
    const contract = dependencies({
      completeRun,
      remove: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("storage unavailable")),
    });

    await expect(runStudioMediaCleanup(contract, { functionSlug, runId })).rejects.toMatchObject({
      errorCode: "cleanup_storage_remove_failed",
      result: { claimed: 2, deleted: 1, failed: 1 },
    });
    expect(completeRun).toHaveBeenCalledWith({
      claimed: 2,
      deleted: 1,
      errorCode: "cleanup_storage_remove_failed",
      failed: 1,
      functionSlug,
      runId,
      workerId,
    });
  });

  it("reconcilia uma conclusão confirmada cuja primeira resposta foi perdida", async () => {
    const complete = vi.fn().mockRejectedValueOnce(new Error("response lost")).mockResolvedValue();
    const completeRun = vi.fn().mockResolvedValue(undefined);
    const contract = dependencies({ complete, completeRun });

    await expect(runStudioMediaCleanup(contract, { functionSlug, runId })).resolves.toEqual({
      claimed: 2,
      deleted: 2,
      failed: 0,
    });
    expect(complete).toHaveBeenCalledTimes(3);
    expect(complete.mock.calls[1]).toEqual(complete.mock.calls[0]);
    expect(completeRun).toHaveBeenCalledWith({
      claimed: 2,
      deleted: 2,
      errorCode: null,
      failed: 0,
      functionSlug,
      runId,
      workerId,
    });
  });

  it("preserva execução inconclusiva quando complete e releitura não provam o resultado", async () => {
    const completeRun = vi.fn().mockResolvedValue(undefined);
    const contract = dependencies({
      complete: vi
        .fn()
        .mockRejectedValueOnce(new Error("ledger item unavailable"))
        .mockRejectedValueOnce(new Error("ledger item unavailable"))
        .mockResolvedValueOnce(undefined),
      completeRun,
    });

    await expect(runStudioMediaCleanup(contract, { functionSlug, runId })).rejects.toMatchObject({
      errorCode: "cleanup_item_complete_failed",
      result: null,
    });
    expect(contract.claim).toHaveBeenCalledTimes(2);
    expect(contract.remove).toHaveBeenCalledTimes(2);
    expect(completeRun).not.toHaveBeenCalled();
  });

  it.each([
    { name: "membro pendente", items: candidates },
    { name: "membro ausente", items: [] },
    {
      name: "membro trocado",
      items: [
        { mediaId: runId, outcome: "deleted" },
        { mediaId: candidates[1].mediaId, outcome: "deleted" },
      ],
    },
    {
      name: "membro duplicado",
      items: [
        { mediaId: candidates[0].mediaId, outcome: "deleted" },
        { mediaId: candidates[0].mediaId, outcome: "deleted" },
      ],
    },
  ])("não sela contagens com $name na reconciliação", async ({ items }) => {
    const contract = dependencies({
      claim: vi
        .fn()
        .mockResolvedValueOnce({ claimToken: workerId, items: candidates })
        .mockResolvedValueOnce({ claimToken: workerId, items }),
      complete: vi.fn().mockRejectedValue(new Error("Lost item response")),
    });
    await expect(runStudioMediaCleanup(contract, { functionSlug, runId })).rejects.toMatchObject({
      errorCode: "cleanup_item_complete_failed",
      result: null,
    });
    expect(contract.completeRun).not.toHaveBeenCalled();
    expect(contract.claim).toHaveBeenCalledTimes(2);
    expect(contract.remove).toHaveBeenCalledTimes(2);
  });

  it("reconcilia falhas persistidas sem convertê-las em sucesso ou repetir Storage", async () => {
    const contract = dependencies({
      claim: vi
        .fn()
        .mockResolvedValueOnce({ claimToken: workerId, items: candidates })
        .mockResolvedValueOnce({
          claimToken: workerId,
          items: [
            { mediaId: candidates[1].mediaId, outcome: "deleted" },
            { mediaId: candidates[0].mediaId, outcome: "failed" },
          ],
        }),
      complete: vi.fn().mockRejectedValue(new Error("Lost item response")),
      remove: vi.fn().mockRejectedValueOnce(new Error("Storage failed")).mockResolvedValue(),
    });
    await expect(runStudioMediaCleanup(contract, { functionSlug, runId })).rejects.toMatchObject({
      errorCode: "cleanup_storage_remove_failed",
      result: { claimed: 2, deleted: 1, failed: 1 },
    });
    expect(contract.completeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        claimed: 2,
        deleted: 1,
        failed: 1,
        errorCode: "cleanup_storage_remove_failed",
      }),
    );
    expect(contract.remove).toHaveBeenCalledTimes(2);
  });

  it("rejeita UUIDs válidos trocados antes de remover ou completar qualquer item", async () => {
    const remove = vi.fn();
    const complete = vi.fn();
    const completeRun = vi.fn().mockResolvedValue(undefined);
    const swappedPreview = candidates[0].paths[1];
    const contract = dependencies({
      claim: vi.fn().mockResolvedValue({
        claimToken: workerId,
        items: [
          candidates[0],
          { ...candidates[1], paths: [candidates[1].paths[0], swappedPreview] },
        ],
      }),
      complete,
      completeRun,
      remove,
    });

    await expect(runStudioMediaCleanup(contract, { functionSlug, runId })).rejects.toMatchObject({
      errorCode: "cleanup_claim_payload_invalid",
      result: { claimed: 2, deleted: 0, failed: 2 },
    });
    expect(remove).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(completeRun).toHaveBeenCalledWith({
      claimed: 2,
      deleted: 0,
      errorCode: "cleanup_claim_payload_invalid",
      failed: 2,
      functionSlug,
      runId,
      workerId,
    });
  });

  it("preserva o formato canônico com ponto e rejeita o antigo hífen", async () => {
    const contract = dependencies({
      claim: vi.fn().mockResolvedValue({
        claimToken: workerId,
        items: [
          {
            ...candidates[0],
            paths: [candidates[0].paths[0], candidates[0].paths[1].replace(".preview", "-preview")],
          },
        ],
      }),
    });

    await expect(runStudioMediaCleanup(contract, { functionSlug, runId })).rejects.toMatchObject({
      errorCode: "cleanup_claim_payload_invalid",
      result: { claimed: 1, deleted: 0, failed: 1 },
    });
    expect(contract.remove).not.toHaveBeenCalled();
    expect(contract.complete).not.toHaveBeenCalled();
  });

  it("não publica saúde quando begin ou complete do ledger falha", async () => {
    const beginFailure = dependencies({
      beginRun: vi.fn().mockRejectedValue(new Error("ledger unavailable")),
    });
    await expect(
      runStudioMediaCleanup(beginFailure, { functionSlug, runId }),
    ).rejects.toBeInstanceOf(CleanupRunError);
    expect(beginFailure.claim).not.toHaveBeenCalled();
    expect(beginFailure.completeRun).not.toHaveBeenCalled();

    const completionFailure = dependencies({
      completeRun: vi.fn().mockRejectedValue(new Error("ledger unavailable")),
    });
    await expect(
      runStudioMediaCleanup(completionFailure, { functionSlug, runId }),
    ).rejects.toMatchObject({
      errorCode: "cleanup_run_complete_failed",
      result: { claimed: 2, deleted: 2, failed: 0 },
    });
  });

  it.each([
    { runId: "87000000-0000-4000-8000-000000000099" },
    { functionSlug: `media-cleanup-${"b".repeat(40)}` },
    { claimed: 1, deleted: 1 },
    { status: "running", claimed: null, deleted: null, failed: null },
    { status: "failed", deleted: 1, failed: 1, errorCode: "cleanup_storage_remove_failed" },
  ])("recusa confirmação final divergente: %j", async (difference) => {
    const contract = dependencies({
      completeRun: vi.fn().mockRejectedValue(new Error("Lost response")),
    });
    const running = await contract.beginRun();
    contract.beginRun
      .mockClear()
      .mockResolvedValueOnce(running)
      .mockResolvedValue({
        runId,
        functionSlug,
        status: "succeeded",
        claimed: 2,
        deleted: 2,
        failed: 0,
        errorCode: null,
        ...difference,
      });
    await expect(runStudioMediaCleanup(contract, { runId, functionSlug })).rejects.toMatchObject({
      errorCode: "cleanup_run_complete_failed",
    });
    expect(contract.beginRun).toHaveBeenCalledTimes(2);
    expect(contract.completeRun).toHaveBeenCalledTimes(2);
    expect(contract.claim).toHaveBeenCalledOnce();
    expect(contract.remove).toHaveBeenCalledTimes(2);
  });

  it.each(["cleanup_storage_remove_failed", "other_failure"])(
    "mantém falha terminal e valida seu código exato: %s",
    async (persistedError) => {
      const contract = dependencies({
        remove: vi.fn().mockRejectedValue(new Error("Storage failure")),
        completeRun: vi.fn().mockRejectedValue(new Error("Lost response")),
      });
      const running = await contract.beginRun();
      contract.beginRun.mockClear().mockResolvedValueOnce(running).mockResolvedValue({
        runId,
        functionSlug,
        status: "failed",
        claimed: 2,
        deleted: 0,
        failed: 2,
        errorCode: persistedError,
      });
      await expect(runStudioMediaCleanup(contract, { runId, functionSlug })).rejects.toMatchObject({
        errorCode:
          persistedError === "cleanup_storage_remove_failed"
            ? persistedError
            : "cleanup_run_complete_failed",
        result: { claimed: 2, deleted: 0, failed: 2 },
      });
      expect(contract.beginRun).toHaveBeenCalledTimes(2);
      expect(contract.completeRun).toHaveBeenCalledTimes(2);
      expect(contract.remove).toHaveBeenCalledTimes(2);
    },
  );

  it.each([false, true])(
    "reproduz sucesso terminal sem efeitos, com resposta inicial perdida: %s",
    async (loseFirstResponse) => {
      const contract = dependencies({
        beginRun: vi.fn().mockResolvedValue({
          claimed: 2,
          deleted: 2,
          errorCode: null,
          failed: 0,
          functionSlug,
          runId,
          status: "succeeded",
        }),
      });
      if (loseFirstResponse)
        contract.beginRun.mockRejectedValueOnce(new Error("Lost begin response"));

      await expect(runStudioMediaCleanup(contract, { functionSlug, runId })).resolves.toEqual({
        claimed: 2,
        deleted: 2,
        failed: 0,
      });
      expect(contract.claim).not.toHaveBeenCalled();
      expect(contract.remove).not.toHaveBeenCalled();
      expect(contract.complete).not.toHaveBeenCalled();
      expect(contract.completeRun).not.toHaveBeenCalled();
    },
  );

  it("reproduz exatamente uma falha terminal sem repetir efeitos físicos", async () => {
    const contract = dependencies({
      beginRun: vi.fn().mockResolvedValue({
        claimed: 2,
        deleted: 1,
        errorCode: "cleanup_storage_remove_failed",
        failed: 1,
        functionSlug,
        runId,
        status: "failed",
      }),
    });

    await expect(runStudioMediaCleanup(contract, { functionSlug, runId })).rejects.toMatchObject({
      errorCode: "cleanup_storage_remove_failed",
      result: { claimed: 2, deleted: 1, failed: 1 },
    });
    expect(contract.claim).not.toHaveBeenCalled();
    expect(contract.remove).not.toHaveBeenCalled();
    expect(contract.complete).not.toHaveBeenCalled();
    expect(contract.completeRun).not.toHaveBeenCalled();
  });

  it("rejeita replays terminais contraditórios antes de qualquer efeito", async () => {
    const contradictoryStates = [
      {
        claimed: 2,
        deleted: 1,
        errorCode: null,
        failed: 0,
        functionSlug,
        runId,
        status: "succeeded",
      },
      {
        claimed: 1,
        deleted: 0,
        errorCode: null,
        failed: 1,
        functionSlug,
        runId,
        status: "failed",
      },
      {
        claimed: 1,
        deleted: 1,
        errorCode: null,
        failed: 0,
        functionSlug,
        runId: "87000000-0000-4000-8000-000000000099",
        status: "succeeded",
      },
      {
        claimed: 0,
        deleted: 0,
        errorCode: null,
        failed: 0,
        functionSlug,
        runId,
        status: "running",
      },
      {
        claimed: 1,
        deleted: 1,
        errorCode: null,
        failed: 0,
        functionSlug: `media-cleanup-${"b".repeat(40)}`,
        runId,
        status: "succeeded",
      },
    ];

    for (const ledgerState of contradictoryStates) {
      const contract = dependencies({ beginRun: vi.fn().mockResolvedValue(ledgerState) });
      await expect(runStudioMediaCleanup(contract, { functionSlug, runId })).rejects.toMatchObject({
        errorCode: "cleanup_run_begin_failed",
        result: null,
      });
      expect(contract.claim).not.toHaveBeenCalled();
      expect(contract.remove).not.toHaveBeenCalled();
      expect(contract.completeRun).not.toHaveBeenCalled();
    }
  });
});

const integrationVariables = [
  "SET_LIVRE_MEDIA_CLEANUP_INTEGRATION_DATABASE_URL",
  "SET_LIVRE_MEDIA_CLEANUP_INTEGRATION_SECRET_KEY",
  "SET_LIVRE_MEDIA_CLEANUP_INTEGRATION_SLUG",
  "SET_LIVRE_MEDIA_CLEANUP_INTEGRATION_SUPABASE_URL",
];
const integrationEnabled = integrationVariables.every(
  (name) => typeof process.env[name] === "string" && process.env[name] !== "",
);

describe.runIf(integrationEnabled)("studio media cleanup local integration", () => {
  it("removes a disposable original and preview through the real Edge and Storage runtimes", async () => {
    const { randomUUID } = await import("node:crypto");
    const { StorageClient } = await import("@supabase/storage-js");
    const { Client } = await import("pg");
    const databaseUrl = process.env.SET_LIVRE_MEDIA_CLEANUP_INTEGRATION_DATABASE_URL;
    const secretKey = process.env.SET_LIVRE_MEDIA_CLEANUP_INTEGRATION_SECRET_KEY;
    const slug = process.env.SET_LIVRE_MEDIA_CLEANUP_INTEGRATION_SLUG;
    const supabaseUrl = process.env.SET_LIVRE_MEDIA_CLEANUP_INTEGRATION_SUPABASE_URL;
    const parsedDatabaseUrl = new URL(databaseUrl);
    if (
      supabaseUrl !== "http://127.0.0.1:54321" ||
      parsedDatabaseUrl.protocol !== "postgresql:" ||
      parsedDatabaseUrl.hostname !== "127.0.0.1" ||
      parsedDatabaseUrl.port !== "54322" ||
      parsedDatabaseUrl.username !== "postgres" ||
      parsedDatabaseUrl.pathname !== "/postgres" ||
      parsedDatabaseUrl.search !== "" ||
      parsedDatabaseUrl.hash !== ""
    ) {
      throw new Error("A integração destrutiva de cleanup aceita somente Supabase local.");
    }
    if (!/^sb_secret_[A-Za-z0-9_-]{12,}$/u.test(secretKey)) {
      throw new Error("A integração local exige a secret key moderna gerada pela CLI.");
    }

    const runId = randomUUID();
    const client = new Client({ connectionString: databaseUrl });
    const storage = new StorageClient(
      `${supabaseUrl}/storage/v1`,
      { apikey: secretKey },
      (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10_000) }),
    );
    let probe;
    await client.connect();
    try {
      const prepared = await client.query(
        "select maintenance.prepare_studio_media_cleanup_probe($1::uuid) as probe",
        [runId],
      );
      probe = prepared.rows[0]?.probe;
      expect(probe).toMatchObject({ bucket: "studio-media", runId, status: "prepared" });
      expect(probe.paths).toHaveLength(2);

      const bytes = new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]);
      for (const path of probe.paths) {
        const { error } = await storage.from(probe.bucket).upload(path, bytes, {
          contentType: "image/webp",
          upsert: false,
        });
        expect(error).toBeNull();
        const downloaded = await storage.from(probe.bucket).download(path);
        expect(downloaded.error).toBeNull();
        expect(new Uint8Array(await downloaded.data.arrayBuffer())).toEqual(bytes);
      }
      const armed = await client.query(
        "select maintenance.arm_studio_media_cleanup_probe($1::uuid) as probe",
        [runId],
      );
      expect(armed.rows[0]?.probe).toMatchObject({ runId, status: "queued" });

      expect(slug).toMatch(/^media-cleanup-[0-9a-f]{40}$/u);
      const response = await fetch(`${supabaseUrl}/functions/v1/${slug}`, {
        body: JSON.stringify({ runId }),
        headers: {
          apikey: secretKey,
          "content-type": "application/json",
        },
        method: "POST",
        signal: AbortSignal.timeout(20_000),
      });
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.claimed).toBeGreaterThan(0);
      expect(result).toEqual({ claimed: result.claimed, deleted: result.claimed, failed: 0 });

      const run = await client.query(
        [
          "select pg_catalog.jsonb_build_object(",
          "'runId', candidate.run_id,",
          "'functionSlug', candidate.function_slug,",
          "'status', candidate.status,",
          "'claimed', candidate.claimed_count,",
          "'deleted', candidate.deleted_count,",
          "'failed', candidate.failed_count,",
          "'errorCode', candidate.error_code",
          ") as run",
          "from maintenance.studio_media_cleanup_runs as candidate",
          "where candidate.run_id = $1::uuid",
        ].join(" "),
        [runId],
      );
      expect(run.rows[0]?.run).toMatchObject({
        claimed: result.claimed,
        deleted: result.claimed,
        failed: 0,
        functionSlug: slug,
        runId,
        status: "succeeded",
      });
      const terminal = await client.query(
        "select maintenance.get_studio_media_cleanup_probe($1::uuid) as probe",
        [runId],
      );
      expect(terminal.rows[0]?.probe).toMatchObject({ runId, status: "deleted" });
      for (const path of probe.paths) {
        const { data, error } = await storage.from(probe.bucket).download(path);
        expect(data).toBeNull();
        expect(isConfirmedStorageObjectAbsence(error)).toBe(true);
      }
    } finally {
      if (probe !== undefined) {
        await storage.from(probe.bucket).remove(probe.paths);
        await client
          .query("select maintenance.abort_studio_media_cleanup_probe($1::uuid, $2::text)", [
            runId,
            "integration_cleanup",
          ])
          .catch(() => undefined);
      }
      await client.end();
    }
  }, 30_000);
});

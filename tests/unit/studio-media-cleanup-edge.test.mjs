import { describe, expect, it, vi } from "vitest";

import {
  CleanupRunError,
  parseCleanupFunctionSlug,
  parseCleanupRunRequest,
  runStudioMediaCleanup,
} from "../../supabase/functions/media-cleanup/cleanup-core.ts";
import { createCleanupRequestHandler } from "../../supabase/functions/media-cleanup/index.ts";

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

describe("studio media cleanup edge adapter", () => {
  it("executa claim e complete com o workerId entregue pelo core", async () => {
    const remove = vi.fn(async () => ({ data: [], error: null }));
    const rpc = vi.fn(async (name) => {
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
        return {
          data: { claimToken: runId, items: [candidates[0]] },
          error: null,
        };
      }
      if (name === "complete_studio_media_cleanup") {
        return { data: null, error: null };
      }
      if (name === "complete_studio_media_cleanup_run") {
        return {
          data: {
            claimed: 1,
            deleted: 1,
            errorCode: null,
            failed: 0,
            functionSlug,
            runId,
            status: "succeeded",
          },
          error: null,
        };
      }
      throw new Error(`RPC inesperada: ${name}`);
    });
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
      new Request(`https://supabase.example/functions/v1/${functionSlug}`, {
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
      p_limit: 25,
    });
    expect(rpc).toHaveBeenCalledWith("complete_studio_media_cleanup", {
      p_claim_token: runId,
      p_error_code: null,
      p_media_id: candidates[0].mediaId,
      p_succeeded: true,
    });
    expect(remove).toHaveBeenCalledWith(candidates[0].paths);
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
      new Request(`https://supabase.example/functions/v1/${functionSlug}`, {
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
  it("extrai somente o slug imutável exato da URL canônica", () => {
    expect(parseCleanupFunctionSlug(`https://supabase.example/functions/v1/${functionSlug}`)).toBe(
      functionSlug,
    );
    for (const url of [
      "https://supabase.example/functions/v1/media-cleanup",
      `https://supabase.example/functions/v1/${functionSlug}/extra`,
      `https://supabase.example/functions/v1/${functionSlug}?retry=1`,
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

  it("classifica falha de complete por item como execução não saudável", async () => {
    const completeRun = vi.fn().mockResolvedValue(undefined);
    const contract = dependencies({
      complete: vi
        .fn()
        .mockRejectedValueOnce(new Error("ledger item unavailable"))
        .mockResolvedValueOnce(undefined),
      completeRun,
    });

    await expect(runStudioMediaCleanup(contract, { functionSlug, runId })).rejects.toMatchObject({
      errorCode: "cleanup_item_complete_failed",
      result: { claimed: 2, deleted: 1, failed: 1 },
    });
    expect(completeRun).toHaveBeenCalledWith({
      claimed: 2,
      deleted: 1,
      errorCode: "cleanup_item_complete_failed",
      failed: 1,
      functionSlug,
      runId,
      workerId,
    });
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

  it("reproduz exatamente um sucesso terminal sem reclamar nem remover os itens", async () => {
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

    await expect(runStudioMediaCleanup(contract, { functionSlug, runId })).resolves.toEqual({
      claimed: 2,
      deleted: 2,
      failed: 0,
    });
    expect(contract.claim).not.toHaveBeenCalled();
    expect(contract.remove).not.toHaveBeenCalled();
    expect(contract.complete).not.toHaveBeenCalled();
    expect(contract.completeRun).not.toHaveBeenCalled();
  });

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
        result: { claimed: 0, deleted: 0, failed: 0 },
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
    const parsedUrl = new URL(supabaseUrl);
    if (!["127.0.0.1", "localhost", "::1"].includes(parsedUrl.hostname)) {
      throw new Error("A integração destrutiva de cleanup aceita somente Supabase local.");
    }
    const { Buffer } = await import("node:buffer");
    let localSecretClaims;
    try {
      const segments = secretKey.split(".");
      localSecretClaims = JSON.parse(Buffer.from(segments[1] ?? "", "base64url").toString("utf8"));
    } catch {
      throw new Error("A integração local exige a chave JWT legada service_role do stack local.");
    }
    if (localSecretClaims?.role !== "service_role") {
      throw new Error("A integração local exige a chave JWT legada service_role do stack local.");
    }

    const runId = randomUUID();
    const client = new Client({ connectionString: databaseUrl });
    const storage = new StorageClient(
      `${supabaseUrl}/storage/v1`,
      { apikey: secretKey, Authorization: `Bearer ${secretKey}` },
      fetch,
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

      for (const path of probe.paths) {
        const { error } = await storage
          .from(probe.bucket)
          .upload(path, new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]), {
            contentType: "image/webp",
            upsert: false,
          });
        expect(error).toBeNull();
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
        expect(error).not.toBeNull();
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

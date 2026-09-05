import { spawnSync } from "node:child_process";
import { relative, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { invokeProductionMediaCleanup } from "../../ops/runtime/invoke-media-cleanup.mjs";

const releaseSha = "a".repeat(40);
const runId = "01234567-89ab-4cde-8fab-0123456789ab";
const secretKey = "sb_secret_runtime_contract_key";
const environment = Object.freeze({
  APP_RELEASE_SHA: releaseSha,
  NEXT_PUBLIC_SUPABASE_URL: "https://oirvvnojgkzdppkdvhej.supabase.co",
  SUPABASE_SECRET_KEY: secretKey,
});

describe("production media cleanup runtime", () => {
  it.each(["headers", "body"])(
    "aborts stalled response %s at 110s without retry",
    async (stage) => {
      vi.useFakeTimers();
      try {
        const started = Promise.withResolvers();
        let signal;
        const fetchImplementation = vi.fn((_url, init) => {
          signal = init.signal;
          started.resolve();
          if (stage === "headers") {
            return new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
          }
          return Promise.resolve(
            new Response(
              new ReadableStream({
                start(controller) {
                  signal.addEventListener("abort", () => controller.error(signal.reason), {
                    once: true,
                  });
                },
              }),
              { headers: { "content-type": "application/json" } },
            ),
          );
        });
        const invocation = invokeProductionMediaCleanup({
          environment,
          fetchImplementation,
          makeRunId: () => runId,
        });
        const outcome = expect(invocation).rejects.toThrow(
          stage === "headers" ? "request-failed" : "invalid-response",
        );
        await started.promise;
        await vi.advanceTimersByTimeAsync(109_999);
        expect(signal.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await outcome;
        expect(signal.aborted).toBe(true);
        expect(fetchImplementation).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("posts one strict lowercase run to the immutable function with only the apikey secret", async () => {
    const fetchImplementation = vi.fn(async () =>
      Response.json({ claimed: 2, deleted: 2, failed: 0 }),
    );

    await invokeProductionMediaCleanup({
      environment,
      fetchImplementation,
      makeRunId: () => runId,
    });

    expect(fetchImplementation).toHaveBeenCalledOnce();
    const [url, request] = fetchImplementation.mock.calls[0];
    expect(url).toBe(
      `https://oirvvnojgkzdppkdvhej.supabase.co/functions/v1/media-cleanup-${releaseSha}`,
    );
    expect(request).toMatchObject({
      body: JSON.stringify({ runId }),
      headers: { apikey: secretKey, "content-type": "application/json" },
      method: "POST",
      redirect: "manual",
      signal: expect.any(AbortSignal),
    });
    expect(Object.keys(request.headers).sort()).toEqual(["apikey", "content-type"]);
  });

  it("rejects an uppercase runId before making a request", async () => {
    const fetchImplementation = vi.fn();

    await expect(
      invokeProductionMediaCleanup({
        environment,
        fetchImplementation,
        makeRunId: () => runId.toUpperCase(),
      }),
    ).rejects.toThrow("invalid-run-id");
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("accepts application/json parameters and rejects a non-JSON response before parsing", async () => {
    await expect(
      invokeProductionMediaCleanup({
        environment,
        fetchImplementation: async () =>
          new Response('{"claimed":0,"deleted":0,"failed":0}', {
            headers: { "content-type": "application/json; charset=utf-8" },
            status: 200,
          }),
        makeRunId: () => runId,
      }),
    ).resolves.toBeUndefined();

    const response = new Response('{"claimed":0,"deleted":0,"failed":0}', {
      headers: { "content-type": "text/plain" },
      status: 200,
    });
    const json = vi.spyOn(response, "json");
    await expect(
      invokeProductionMediaCleanup({
        environment,
        fetchImplementation: async () => response,
        makeRunId: () => runId,
      }),
    ).rejects.toThrow("invalid-response-content-type");
    expect(json).not.toHaveBeenCalled();
  });

  it.each([
    {
      response: () => Response.json({ claimed: 0, deleted: 0, failed: 0 }, { status: 201 }),
      error: "unexpected-status",
    },
    {
      response: () => Response.json({ claimed: 1, deleted: 0, failed: 0 }),
      error: "invalid-response",
    },
    {
      response: () => Response.json({ claimed: 0, deleted: 0, failed: 0, status: "succeeded" }),
      error: "invalid-response",
    },
  ])("fails closed for a non-terminal success response", async ({ response, error }) => {
    await expect(
      invokeProductionMediaCleanup({
        environment,
        fetchImplementation: async () => response(),
        makeRunId: () => runId,
      }),
    ).rejects.toThrow(error);
  });

  it("executes through a relative path from another cwd and fails on runtime configuration", () => {
    const cwd = resolve(import.meta.dirname, "..");
    const executable = relative(
      cwd,
      resolve(import.meta.dirname, "../../ops/runtime/invoke-media-cleanup.mjs"),
    );
    const result = spawnSync(process.execPath, [executable], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        APP_RELEASE_SHA: releaseSha,
        NEXT_PUBLIC_SUPABASE_URL: "http://invalid.example",
        SUPABASE_SECRET_KEY: secretKey,
      },
      windowsHide: true,
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("media-cleanup: invalid-supabase-origin\n");
  });
});

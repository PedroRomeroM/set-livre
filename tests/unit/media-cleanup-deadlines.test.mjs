import { createClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { cleanupBatchSize } from "../../supabase/functions/media-cleanup/cleanup-core.ts";
import { createCleanupRequestHandler } from "../../supabase/functions/media-cleanup/index.ts";
import { invokeProductionMediaCleanup } from "../../ops/runtime/invoke-media-cleanup.mjs";

const runId = "87000000-0000-4000-8000-000000000000";
const functionSlug = `media-cleanup-${"a".repeat(40)}`;
const secretKey = "sb_secret_deadlineContractKey";
const items = Array.from({ length: cleanupBatchSize }, (_, index) => {
  const mediaId = `87000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
  const prefix = `owners/${runId}/studios/${runId}/revisions/${runId}/${mediaId}`;
  return {
    attempt: 1,
    bucket: "studio-media",
    mediaId,
    paths: [`${prefix}.jpg`, `${prefix}.preview.webp`],
  };
});
const begin = "begin_studio_media_cleanup_run";
const claim = "claim_studio_media_cleanup";
const complete = "complete_studio_media_cleanup";
const finish = "complete_studio_media_cleanup_run";
const storage = "studio-media";

function request(options = {}) {
  return new Request(`https://supabase.example/functions/v1/${functionSlug}`, {
    body: JSON.stringify({ runId }),
    headers: { apikey: secretKey, "content-type": "application/json" },
    method: "POST",
    ...options,
  });
}

function slowBody(value, durationMs, status = 200) {
  let timer;
  const cancel = vi.fn(() => clearTimeout(timer));
  const body = new ReadableStream({
    start(controller) {
      if (durationMs === null) return;
      timer = setTimeout(() => {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(value)));
        controller.close();
      }, durationMs);
    },
    cancel,
  });
  return {
    cancel,
    body,
    response: new Response(body, { headers: { "content-type": "application/json" }, status }),
  };
}

function harness(transform = ({ value }) => Response.json(value)) {
  const calls = [];
  const firstStorage = Promise.withResolvers();
  const firstRpc = Promise.withResolvers();
  const handler = createCleanupRequestHandler({
    createSupabaseClient: createClient,
    readConfiguration: () => ({ secretKey, url: "https://supabase.example" }),
    fetchImplementation: async (input, init) => {
      const name = new URL(String(input)).pathname.split("/").at(-1);
      const parameters = JSON.parse(init.body);
      calls.push({ name, parameters, signal: init.signal, at: performance.now() });
      let value;
      if (name === begin) {
        value = {
          runId,
          functionSlug,
          status: "running",
          claimed: null,
          deleted: null,
          failed: null,
          errorCode: null,
        };
      } else if (name === claim) {
        value = { claimToken: runId, items };
      } else if (name === complete) {
        value = null;
      } else if (name === finish) {
        value = {
          runId,
          functionSlug,
          status: parameters.p_status,
          claimed: parameters.p_claimed,
          deleted: parameters.p_deleted,
          failed: parameters.p_failed,
          errorCode: parameters.p_error_code,
        };
      } else if (name === storage) {
        value = [];
      } else {
        throw new Error(`Unexpected cleanup endpoint: ${name}`);
      }
      if (name === storage) firstStorage.resolve();
      else firstRpc.resolve();
      return transform({ name, value, parameters, signal: init.signal });
    },
  });
  return { calls, handler, firstStorage: firstStorage.promise, firstRpc: firstRpc.promise };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("cleanup HTTP and ledger deadlines", () => {
  it("reserves setup, claim replay and item reconciliation before sealing the full batch", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    let beginAttempts = 0;
    let claimAttempts = 0;
    let finishAttempts = 0;
    const completionAttempts = new Map();
    const outcomes = new Map();
    const probe = harness(({ name, value, parameters }) => {
      if (name === begin && ++beginAttempts === 1) return slowBody(null, null).response;
      if (name === claim) {
        if (++claimAttempts === 1) return slowBody(null, null).response;
        if (claimAttempts === 3) {
          return slowBody(
            {
              claimToken: runId,
              items: items.map(({ mediaId }) => ({ mediaId, outcome: "deleted" })),
            },
            4_900,
          ).response;
        }
      }
      if (name === storage) return slowBody(value, 9_900).response;
      if (name === complete) {
        const mediaId = parameters.p_media_id;
        outcomes.set(mediaId, parameters.p_succeeded);
        const attempt = (completionAttempts.get(mediaId) ?? 0) + 1;
        completionAttempts.set(mediaId, attempt);
        // Both writes commit but neither response arrives; one batch reconciliation must fit.
        return slowBody(null, null).response;
      }
      if (name === finish) {
        const deleted = [...outcomes.values()].filter(Boolean).length;
        if (
          parameters.p_claimed !== items.length ||
          parameters.p_deleted !== deleted ||
          parameters.p_failed !== items.length - deleted
        ) {
          return Response.json(
            { code: "40001", message: "Run membership mismatch" },
            { status: 409 },
          );
        }
        if (++finishAttempts === 1) return slowBody(null, null).response;
      }
      return slowBody(value, 4_900).response;
    });
    const input = slowBody({ runId }, 4_900);
    const responsePromise = probe
      .handler(request({ body: input.body, duplex: "half" }))
      .then((response) => ({ response, settledAt: performance.now() }));
    await vi.advanceTimersByTimeAsync(4_900);
    await probe.firstRpc;
    await vi.advanceTimersByTimeAsync(100_000);
    const { response, settledAt } = await responsePromise;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      claimed: items.length,
      deleted: items.length,
      failed: 0,
    });
    expect(beginAttempts).toBe(2);
    expect(claimAttempts).toBe(3);
    expect(finishAttempts).toBe(2);
    expect(outcomes.size).toBe(items.length);
    expect([...completionAttempts.values()]).toEqual(items.map(() => 2));
    expect(probe.calls.filter(({ name }) => name === storage)).toHaveLength(items.length);
    expect(probe.calls.at(-1).name).toBe(finish);
    const finishes = probe.calls.filter(({ name }) => name === finish);
    expect(finishes[1].parameters).toEqual(finishes[0].parameters);
    const reconciliation = probe.calls.filter(({ name }) => name === claim).at(-1);
    expect(reconciliation.at).toBeLessThan(85_000);
    expect(finishes[0].at).toBeLessThan(90_000);
    expect(settledAt).toBeLessThan(100_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["headers", "body"])(
    "recovers an ambiguously committed begin after losing response %s using the same identity",
    async (stage) => {
      vi.useFakeTimers();
      let attempts = 0;
      const probe = harness(({ name, value }) => {
        if (name === begin && ++attempts === 1) {
          if (stage === "headers") throw new TypeError("Connection closed after begin commit");
          return slowBody(null, null).response;
        }
        return Response.json(value);
      });
      const responsePromise = probe.handler(request());
      await probe.firstRpc;
      await vi.advanceTimersByTimeAsync(5_000);
      const response = await responsePromise;
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ claimed: 3, deleted: 3, failed: 0 });
      const begins = probe.calls.filter(({ name }) => name === begin);
      expect(begins).toHaveLength(2);
      expect(begins[1].parameters).toEqual(begins[0].parameters);
      expect(begins[0].parameters).toEqual({ p_run_id: runId, p_function_slug: functionSlug });
      expect(probe.calls.filter(({ name }) => name === storage)).toHaveLength(3);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["headers", "body"])(
    "rereads persisted outcomes after both item completion responses lose their %s",
    async (stage) => {
      vi.useFakeTimers();
      const outcomes = new Map();
      const probe = harness(({ name, value, parameters }) => {
        if (name === claim && outcomes.size > 0) {
          return Response.json({
            claimToken: runId,
            items: items.map(({ mediaId }) => ({ mediaId, outcome: outcomes.get(mediaId) })),
          });
        }
        if (name === complete) {
          outcomes.set(parameters.p_media_id, parameters.p_succeeded ? "deleted" : "failed");
          if (stage === "headers") throw new TypeError("Connection closed after item commit");
          return slowBody(null, null).response;
        }
        if (name === finish && parameters.p_deleted !== outcomes.size) {
          return Response.json({ code: "40001", message: "Membership mismatch" }, { status: 409 });
        }
        return Response.json(value);
      });
      const responsePromise = probe.handler(request());
      await probe.firstRpc;
      await vi.advanceTimersByTimeAsync(30_000);
      const response = await responsePromise;
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ claimed: 3, deleted: 3, failed: 0 });
      expect(probe.calls.filter(({ name }) => name === complete)).toHaveLength(6);
      expect(probe.calls.filter(({ name }) => name === storage)).toHaveLength(3);
      const claims = probe.calls.filter(({ name }) => name === claim);
      expect(claims).toHaveLength(2);
      expect(claims[1].parameters).toEqual(claims[0].parameters);
      expect(probe.calls.at(-1).name).toBe(finish);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("finishes three sequential slow removals beyond the old 20s caller timeout", async () => {
    vi.useFakeTimers();
    const probe = harness(({ name, value }) =>
      name === storage ? slowBody(value, 8_000).response : Response.json(value),
    );
    const responsePromise = invokeProductionMediaCleanup({
      environment: {
        APP_RELEASE_SHA: "a".repeat(40),
        NEXT_PUBLIC_SUPABASE_URL: "https://oirvvnojgkzdppkdvhej.supabase.co",
        SUPABASE_SECRET_KEY: secretKey,
      },
      fetchImplementation: (url, init) => probe.handler(new Request(url, init)),
      makeRunId: () => runId,
    });
    await probe.firstStorage;
    await vi.advanceTimersByTimeAsync(24_000);
    await expect(responsePromise).resolves.toBeUndefined();
    expect(probe.calls.at(-1).parameters).toMatchObject({
      p_status: "succeeded",
      p_claimed: 3,
      p_deleted: 3,
      p_failed: 0,
    });
    expect(probe.calls.map(({ name }) => name)).toEqual([
      begin,
      claim,
      storage,
      complete,
      storage,
      complete,
      storage,
      complete,
      finish,
    ]);
    expect(probe.calls.find(({ name }) => name === claim).parameters.p_limit).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([200, 503])(
    "bounds a stalled Storage body after HTTP %s headers and records failure",
    async (status) => {
      vi.useFakeTimers();
      const bodies = [];
      const probe = harness(({ name, value }) => {
        if (name !== storage) return Response.json(value);
        const pending = slowBody(null, null, status);
        bodies.push(pending);
        return pending.response;
      });
      const responsePromise = probe.handler(request());
      await probe.firstStorage;
      await vi.advanceTimersByTimeAsync(30_000);
      const response = await responsePromise;
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        claimed: 3,
        deleted: 0,
        failed: 3,
        errorCode: "cleanup_storage_remove_failed",
      });
      expect(bodies).toHaveLength(3);
      expect(bodies.every(({ cancel }) => cancel.mock.calls.length === 1)).toBe(true);
      expect(probe.calls.at(-1).parameters).toMatchObject({
        p_status: "failed",
        p_claimed: 3,
        p_failed: 3,
      });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    [begin, 10_000, "cleanup_run_begin_failed"],
    [claim, 10_000, "cleanup_claim_failed"],
    [complete, 30_000, "cleanup_item_complete_failed"],
    [finish, 10_000, "cleanup_run_complete_failed"],
  ])(
    "bounds stalled %s response bodies without publishing success",
    async (stage, duration, errorCode) => {
      vi.useFakeTimers();
      const probe = harness(({ name, value }) =>
        name === stage ? slowBody(null, null).response : Response.json(value),
      );
      const responsePromise = probe.handler(request());
      await probe.firstRpc;
      await vi.advanceTimersByTimeAsync(duration);
      const response = await responsePromise;
      expect(response.status).toBe(503);
      if (stage === finish) await expect(response.json()).resolves.toMatchObject({ errorCode });
      else await expect(response.json()).resolves.toEqual({ errorCode });
      if (stage === claim) {
        expect(probe.calls.map(({ name }) => name)).toEqual([begin, claim, claim]);
      }
      if (stage === complete) {
        expect(probe.calls.filter(({ name }) => name === complete)).toHaveLength(6);
        expect(probe.calls.at(-1).name).toBe(claim);
        expect(probe.calls.some(({ name }) => name === finish)).toBe(false);
      }
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["headers", "body"])(
    "replays a committed claim after losing its response %s without acquiring another batch",
    async (stage) => {
      vi.useFakeTimers();
      let claimed = false;
      let attempts = 0;
      const outcomes = new Map();
      const probe = harness(({ name, value, parameters }) => {
        if (name === claim) {
          claimed = true;
          attempts += 1;
          if (attempts === 1) {
            if (stage === "headers") throw new TypeError("Connection closed after commit");
            return slowBody(null, null).response;
          }
        }
        if (name === complete) {
          outcomes.set(parameters.p_media_id, parameters.p_succeeded);
        }
        if (name === finish) {
          const deleted = [...outcomes.values()].filter(Boolean).length;
          if (
            parameters.p_claimed !== (claimed ? items.length : 0) ||
            parameters.p_deleted !== deleted ||
            parameters.p_failed !== items.length - deleted
          ) {
            return Response.json(
              { code: "40001", message: "Run membership mismatch" },
              {
                status: 409,
              },
            );
          }
        }
        return Response.json(value);
      });
      const responsePromise = probe.handler(request());
      await probe.firstRpc;
      await vi.advanceTimersByTimeAsync(5_000);
      const response = await responsePromise;
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ claimed: 3, deleted: 3, failed: 0 });
      const claims = probe.calls.filter(({ name }) => name === claim);
      expect(claims).toHaveLength(2);
      expect(claims[1].parameters).toEqual(claims[0].parameters);
      expect(claims[1].parameters).toEqual({ p_claim_token: runId, p_limit: 3 });
      expect(probe.calls.filter(({ name }) => name === storage)).toHaveLength(3);
      expect(outcomes.size).toBe(3);
      expect(probe.calls.filter(({ name }) => name === finish)).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("leaves unknown claim membership replayable after two lost responses without reporting zeros", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const probe = harness(({ name, value }) => {
      if (name === claim && ++attempts <= 2) return slowBody(null, null).response;
      return Response.json(value);
    });
    const responsePromise = probe.handler(request());
    await probe.firstRpc;
    await vi.advanceTimersByTimeAsync(10_000);
    const response = await responsePromise;
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ errorCode: "cleanup_claim_failed" });
    expect(probe.calls.map(({ name }) => name)).toEqual([begin, claim, claim]);
    expect(vi.getTimerCount()).toBe(0);

    const replay = await probe.handler(request());
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toEqual({ claimed: 3, deleted: 3, failed: 0 });
    expect(probe.calls.filter(({ name }) => name === claim)).toHaveLength(3);
    expect(probe.calls.filter(({ name }) => name === finish)).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not claim again or seal unknown totals after caller disconnect", async () => {
    const controller = new AbortController();
    const probe = harness(({ name, value }) => {
      if (name === claim) {
        controller.abort();
        throw new TypeError("Connection closed after claim commit");
      }
      return Response.json(value);
    });
    const response = await probe.handler(request({ signal: controller.signal }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ errorCode: "cleanup_claim_failed" });
    expect(probe.calls.map(({ name }) => name)).toEqual([begin, claim]);
  });

  it("stops work at 90s without sealing unknown outcomes after an event-loop suspension", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const elapsed = performance.now.bind(performance);
    let suspensionMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed() + suspensionMs);
    const probe = harness(({ name, value }) => {
      if (name === storage || name === complete) return slowBody(null, null).response;
      return slowBody(value, 4_500).response;
    });
    const input = slowBody({ runId }, 4_500);
    const responsePromise = probe.handler(request({ body: input.body, duplex: "half" }));
    await vi.advanceTimersByTimeAsync(4_500);
    await probe.firstRpc;
    // An event-loop suspension can still exhaust the work envelope even with a bounded batch.
    suspensionMs = 65_000;
    await vi.advanceTimersByTimeAsync(25_000);
    const response = await responsePromise;
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ errorCode: "cleanup_item_complete_failed" });
    expect(probe.calls.some(({ name }) => name === finish)).toBe(false);
    expect(probe.calls.every(({ at }) => at < 90_000)).toBe(true);
    expect(performance.now()).toBe(94_500);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("seals a cancelled invocation without issuing further physical removals", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const probe = harness(({ name, value }) =>
      name === storage ? slowBody(null, null).response : Response.json(value),
    );
    const responsePromise = probe.handler(request({ signal: controller.signal }));
    await probe.firstStorage;
    controller.abort();
    const response = await responsePromise;
    expect(response.status).toBe(503);
    expect(probe.calls.filter(({ name }) => name === storage)).toHaveLength(1);
    expect(probe.calls.at(-1)).toMatchObject({
      name: finish,
      parameters: { p_status: "failed", p_failed: 3 },
    });
    expect(probe.calls.at(-1).signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["headers", "body"])(
    "reconciles a committed item after disconnect loses its response %s",
    async (stage) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const firstCompletion = Promise.withResolvers();
      const outcomes = new Map();
      let lostResponse = false;
      const probe = harness(({ name, value, parameters }) => {
        if (name === complete) {
          const { p_media_id: mediaId, p_succeeded: succeeded } = parameters;
          if (outcomes.has(mediaId)) expect(outcomes.get(mediaId)).toBe(succeeded);
          outcomes.set(mediaId, succeeded);
          if (!lostResponse) {
            lostResponse = true;
            controller.abort();
            firstCompletion.resolve();
            if (stage === "headers") throw new TypeError("Connection closed after commit");
            return slowBody(null, null).response;
          }
        }
        if (name === finish) {
          const deleted = [...outcomes.values()].filter(Boolean).length;
          if (parameters.p_deleted !== deleted || parameters.p_failed !== items.length - deleted) {
            return Response.json(
              { code: "40001", message: "Run membership mismatch" },
              { status: 409 },
            );
          }
        }
        return Response.json(value);
      });

      const responsePromise = probe.handler(request({ signal: controller.signal }));
      await firstCompletion.promise;
      await vi.advanceTimersByTimeAsync(5_000);
      const response = await responsePromise;

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        claimed: 3,
        deleted: 1,
        failed: 2,
        errorCode: "cleanup_storage_remove_failed",
      });
      expect(probe.calls.filter(({ name }) => name === storage)).toHaveLength(1);
      const completions = probe.calls.filter(({ name }) => name === complete);
      expect(completions).toHaveLength(4);
      expect(completions[1].parameters).toEqual(completions[0].parameters);
      expect(completions.slice(1).every(({ signal }) => !signal.aborted)).toBe(true);
      expect(outcomes.size).toBe(3);
      expect(probe.calls.at(-1)).toMatchObject({
        name: finish,
        parameters: { p_status: "failed", p_deleted: 1, p_failed: 2 },
      });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("bounds the input body before creating a ledger or issuing any request", async () => {
    vi.useFakeTimers();
    const input = slowBody(null, null);
    const probe = harness();
    const inputRequest = request({ body: input.body, duplex: "half" });
    const reading = Promise.withResolvers();
    const getReader = inputRequest.body.getReader.bind(inputRequest.body);
    vi.spyOn(inputRequest.body, "getReader").mockImplementation(() => {
      reading.resolve();
      return getReader();
    });
    const responsePromise = probe.handler(inputRequest);
    await reading.promise;
    await vi.advanceTimersByTimeAsync(5_000);
    const response = await responsePromise;
    expect(response.status).toBe(400);
    expect(probe.calls).toEqual([]);
    expect(input.cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects oversized provider bodies without starting cleanup work", async () => {
    const probe = harness(() => new Response("x".repeat(64 * 1024 + 1)));
    const response = await probe.handler(request());
    expect(response.status).toBe(503);
    expect(probe.calls.map(({ name }) => name)).toEqual([begin, begin]);
  });
});

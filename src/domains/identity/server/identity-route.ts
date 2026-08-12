import "server-only";

import {
  apiErrorResponse,
  apiSuccessResponse,
  assertTrustedRequestOrigin,
  requestRateLimitDiscriminator,
  requestIdFrom,
  writeSafeOperationalEvent,
} from "../../../lib/server/api-route";
import { enforceIdentityRateLimit } from "../../../lib/server/rate-limit";

type OperationalAction = Parameters<typeof writeSafeOperationalEvent>[0]["action"];
type OperationalEvent = Parameters<typeof writeSafeOperationalEvent>[0]["event"];

async function runPostRoute(
  request: Request,
  action: OperationalAction,
  event: OperationalEvent,
  execute: (
    requestId: string,
    setOperationalAction: (action: OperationalAction) => void,
    setResponseHeaders: (headers: HeadersInit) => void,
  ) => Promise<{
    data: unknown;
    operationalOutcome?: "accepted" | "rejected" | "unavailable" | undefined;
    responseHeaders?: HeadersInit | undefined;
    status?: number | undefined;
  }>,
) {
  const startedAt = performance.now();
  const requestId = requestIdFrom(request);
  let status = 503;
  let outcome: "accepted" | "rejected" | "unavailable" = "unavailable";
  let operationalAction = action;
  let responseHeaders: HeadersInit | undefined;
  try {
    assertTrustedRequestOrigin(request);
    enforceIdentityRateLimit(`${action}.request`, requestRateLimitDiscriminator(request), {
      limit: 300,
      windowMs: 60_000,
    });
    const result = await execute(
      requestId,
      (nextAction) => {
        operationalAction = nextAction;
      },
      (headers) => {
        responseHeaders = headers;
      },
    );
    status = result.status ?? 200;
    outcome = result.operationalOutcome ?? "accepted";
    return apiSuccessResponse(
      result.data,
      requestId,
      status,
      result.responseHeaders ?? responseHeaders,
    );
  } catch (error) {
    const response = apiErrorResponse(error, requestId, responseHeaders);
    status = response.status;
    outcome = status >= 500 ? "unavailable" : "rejected";
    return response;
  } finally {
    writeSafeOperationalEvent({
      action: operationalAction,
      durationMs: performance.now() - startedAt,
      event,
      outcome,
      requestId,
      status,
    });
  }
}

export function runIdentityPostRoute(
  request: Request,
  action: OperationalAction,
  execute: Parameters<typeof runPostRoute>[3],
) {
  return runPostRoute(request, action, "identity.request", execute);
}

export function runPrivateCommandPostRoute(
  request: Request,
  execute: Parameters<typeof runPostRoute>[3],
) {
  return runPostRoute(request, "private.command", "private.command", execute);
}

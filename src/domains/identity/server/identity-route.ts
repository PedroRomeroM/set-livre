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

type IdentityAction = Parameters<typeof writeSafeOperationalEvent>[0]["action"];

export async function runIdentityPostRoute(
  request: Request,
  action: IdentityAction,
  execute: (requestId: string) => Promise<{
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
  try {
    assertTrustedRequestOrigin(request);
    enforceIdentityRateLimit(`${action}.request`, requestRateLimitDiscriminator(request), {
      limit: 300,
      windowMs: 60_000,
    });
    const result = await execute(requestId);
    status = result.status ?? 200;
    outcome = result.operationalOutcome ?? "accepted";
    return apiSuccessResponse(result.data, requestId, status, result.responseHeaders);
  } catch (error) {
    const response = apiErrorResponse(error, requestId);
    status = response.status;
    outcome = status >= 500 ? "unavailable" : "rejected";
    return response;
  } finally {
    writeSafeOperationalEvent({
      action,
      durationMs: performance.now() - startedAt,
      outcome,
      requestId,
      status,
    });
  }
}

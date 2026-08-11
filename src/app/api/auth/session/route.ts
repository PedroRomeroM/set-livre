import { readRouteIdentitySession } from "@/domains/identity/server/identity-read-model";
import {
  apiErrorResponse,
  apiSuccessResponse,
  requestIdFrom,
  writeSafeOperationalEvent,
} from "@/lib/server/api-route";

export async function GET(request: Request) {
  const startedAt = performance.now();
  const requestId = requestIdFrom(request);
  let status = 503;
  let outcome: "accepted" | "unavailable" = "unavailable";
  try {
    const result = await readRouteIdentitySession();
    status = 200;
    outcome = "accepted";
    return apiSuccessResponse(result.session, requestId, status, result.responseHeaders);
  } catch (error) {
    return apiErrorResponse(error, requestId);
  } finally {
    writeSafeOperationalEvent({
      action: "identity.session",
      durationMs: performance.now() - startedAt,
      outcome,
      requestId,
      status,
    });
  }
}

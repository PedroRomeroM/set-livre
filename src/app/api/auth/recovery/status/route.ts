import { readIdentityRecoveryStatus } from "@/domains/identity/server/identity-service";
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
    const result = await readIdentityRecoveryStatus();
    status = 200;
    outcome = "accepted";
    return apiSuccessResponse(result.data, requestId, status, result.responseHeaders);
  } catch (error) {
    return apiErrorResponse(error, requestId);
  } finally {
    writeSafeOperationalEvent({
      action: "identity.recovery.status",
      durationMs: performance.now() - startedAt,
      outcome,
      requestId,
      status,
    });
  }
}

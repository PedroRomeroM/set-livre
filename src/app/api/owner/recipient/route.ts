import { readRouteIdentitySession } from "@/domains/identity/server/identity-read-model";
import { readOwnerRecipient } from "@/domains/owners/server/owner-read-model";
import {
  ApiRouteError,
  apiErrorResponse,
  apiSuccessResponse,
  requestIdFrom,
  writeSafeOperationalEvent,
} from "@/lib/server/api-route";

export async function GET(request: Request) {
  const startedAt = performance.now();
  const requestId = requestIdFrom(request);
  let status = 503;
  let outcome: "accepted" | "rejected" | "unavailable" = "unavailable";
  let responseHeaders: HeadersInit | undefined;
  try {
    const identity = await readRouteIdentitySession();
    responseHeaders = identity.responseHeaders;
    if (!identity.session.authenticated) {
      throw new ApiRouteError(401, "UNAUTHENTICATED", "Entre novamente para continuar.");
    }
    status = 200;
    outcome = "accepted";
    return apiSuccessResponse(
      await readOwnerRecipient(identity.session.userId),
      requestId,
      status,
      identity.responseHeaders,
    );
  } catch (error) {
    const response = apiErrorResponse(error, requestId, responseHeaders);
    status = response.status;
    outcome = status >= 500 ? "unavailable" : "rejected";
    return response;
  } finally {
    writeSafeOperationalEvent({
      action: "owner.read",
      durationMs: performance.now() - startedAt,
      event: "owner.request",
      outcome,
      requestId,
      status,
    });
  }
}

import { readRouteIdentitySession } from "@/domains/identity/server/identity-read-model";
import { writeProfilePreferenceCookie } from "@/domains/identity/server/profile-preference-cookie";
import { readOwnProfile } from "@/domains/identity/server/profile-read-model";
import {
  ApiRouteError,
  apiErrorResponse,
  apiSuccessResponse,
  requestIdFrom,
  writeSafeOperationalEvent,
} from "@/lib/server/api-route";
import { cookies } from "next/headers";

export async function GET(request: Request) {
  const startedAt = performance.now();
  const requestId = requestIdFrom(request);
  let status = 503;
  let outcome: "accepted" | "rejected" | "unavailable" = "unavailable";
  try {
    const identity = await readRouteIdentitySession();
    if (!identity.session.authenticated) {
      throw new ApiRouteError(401, "UNAUTHENTICATED", "Entre novamente para continuar.");
    }
    const profile = await readOwnProfile(identity.session.userId);
    try {
      writeProfilePreferenceCookie(await cookies(), profile.profile.colorScheme);
    } catch {
      // O cookie é projeção visual; falha de sincronização não invalida o read model canônico.
    }
    status = 200;
    outcome = "accepted";
    return apiSuccessResponse(profile, requestId, status, identity.responseHeaders);
  } catch (error) {
    const response = apiErrorResponse(error, requestId);
    status = response.status;
    outcome = status >= 500 ? "unavailable" : "rejected";
    return response;
  } finally {
    writeSafeOperationalEvent({
      action: "profile.read",
      durationMs: performance.now() - startedAt,
      event: "identity.request",
      outcome,
      requestId,
      status,
    });
  }
}

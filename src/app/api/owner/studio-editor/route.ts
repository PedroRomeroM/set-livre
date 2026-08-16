import {
  ownerStudioEditorExpectedScopeHeader,
  ownerStudioEditorExpectedScopeSchema,
  ownerStudioEditorQuerySchema,
} from "@set-livre/contracts";

import { readRouteIdentitySession } from "@/domains/identity/server/identity-read-model";
import { readOwnerStudioEditor } from "@/domains/studios/server/studio-read-model";
import {
  ApiRouteError,
  apiErrorResponse,
  apiSuccessResponse,
  parseOrInputError,
  requestIdFrom,
  writeSafeOperationalEvent,
} from "@/lib/server/api-route";

function parseStudioEditorQuery(request: Request) {
  const searchParams = new URL(request.url).searchParams;
  const keys = [...searchParams.keys()];
  if (keys.some((key) => key !== "studioId") || searchParams.getAll("studioId").length > 1) {
    throw new ApiRouteError(422, "VALIDATION_FAILED", "Revise os campos destacados.", {
      studioId: "Envie no máximo um identificador de estúdio válido.",
    });
  }
  return parseOrInputError(
    ownerStudioEditorQuerySchema,
    searchParams.has("studioId") ? { studioId: searchParams.get("studioId") } : {},
    { code: "VALIDATION_FAILED", status: 422 },
  );
}

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
    if (identity.session.status !== "active") {
      throw new ApiRouteError(
        403,
        "ACCOUNT_SUSPENDED",
        "Esta conta não pode acessar estúdios enquanto estiver suspensa.",
      );
    }
    if (!identity.session.profileCompleted) {
      throw new ApiRouteError(403, "FORBIDDEN", "Conclua seu perfil antes de acessar estúdios.");
    }
    const expectedScope = parseOrInputError(
      ownerStudioEditorExpectedScopeSchema,
      request.headers.get(ownerStudioEditorExpectedScopeHeader),
      { code: "VALIDATION_FAILED", status: 422 },
    );
    if (expectedScope !== identity.session.userId) {
      throw new ApiRouteError(
        409,
        "SESSION_CHANGED",
        "Sua sessão mudou. Recarregue a página antes de continuar.",
      );
    }
    const query = parseStudioEditorQuery(request);
    const editor = await readOwnerStudioEditor(
      identity.session.userId,
      query.studioId,
      request.signal,
    );
    status = 200;
    outcome = "accepted";
    return apiSuccessResponse(editor, requestId, status, identity.responseHeaders);
  } catch (error) {
    const response = apiErrorResponse(error, requestId, responseHeaders);
    status = response.status;
    outcome = status >= 500 ? "unavailable" : "rejected";
    return response;
  } finally {
    writeSafeOperationalEvent({
      action: "studio.read",
      durationMs: performance.now() - startedAt,
      event: "studio.request",
      outcome,
      requestId,
      status,
    });
  }
}

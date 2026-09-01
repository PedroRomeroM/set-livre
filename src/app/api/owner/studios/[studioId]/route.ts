import { readRouteIdentitySession } from "@/domains/identity/server/identity-read-model";
import { readOwnerActivation } from "@/domains/owners/server/owner-read-model";
import {
  readOwnerStudioEditor,
  StudioNotFoundError,
} from "@/domains/studios/server/studio-read-model";
import {
  ApiRouteError,
  apiErrorResponse,
  apiSuccessResponse,
  canonicalRouteUuid,
  requestIdFrom,
  writeSafeOperationalEvent,
} from "@/lib/server/api-route";

export async function GET(
  request: Request,
  context: Readonly<{ params: Promise<{ studioId: string }> }>,
) {
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
      throw new ApiRouteError(403, "FORBIDDEN", "Conclua seu perfil antes de gerenciar estúdios.");
    }
    const { studioId: rawStudioId } = await context.params;
    const studioId = canonicalRouteUuid(rawStudioId);
    if (studioId === null) {
      throw new ApiRouteError(404, "NOT_FOUND", "Este estúdio não está disponível para sua conta.");
    }
    const owner = await readOwnerActivation(identity.session.userId);
    if (owner.ownerStatus !== "active") {
      throw new ApiRouteError(
        403,
        "FORBIDDEN",
        "Ative seu cadastro de dono antes de gerenciar estúdios.",
      );
    }
    if (!owner.ownerContractAccepted) {
      throw new ApiRouteError(
        409,
        "OWNER_CONTRACT_CHANGED",
        "O contrato do dono mudou. Recarregue a página e aceite a versão vigente antes de continuar.",
      );
    }
    try {
      const editor = await readOwnerStudioEditor(identity.session.userId, studioId);
      status = 200;
      outcome = "accepted";
      return apiSuccessResponse(editor, requestId, status, identity.responseHeaders);
    } catch (error) {
      if (error instanceof StudioNotFoundError) {
        throw new ApiRouteError(
          404,
          "NOT_FOUND",
          "Este estúdio não está disponível para sua conta.",
        );
      }
      throw error;
    }
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

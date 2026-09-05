import { readRouteIdentitySession } from "@/domains/identity/server/identity-read-model";
import { readOwnerActivation } from "@/domains/owners/server/owner-read-model";
import {
  isStudioPublicationAbortError,
  readOwnerStudioPublication,
  StudioPublicationNotFoundError,
} from "@/domains/studios/server/studio-publication-read-model";
import { StudioMediaStorageError } from "@/domains/studios/server/studio-media-storage";
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
        "Esta conta não pode acessar a publicação enquanto estiver suspensa.",
      );
    }
    if (!identity.session.profileCompleted) {
      throw new ApiRouteError(
        403,
        "FORBIDDEN",
        "Conclua seu perfil antes de gerenciar a publicação.",
      );
    }

    const { studioId: rawStudioId } = await context.params;
    const studioId = canonicalRouteUuid(rawStudioId);
    if (studioId === null) {
      throw new ApiRouteError(404, "NOT_FOUND", "Este estúdio não está disponível para sua conta.");
    }
    const owner = await readOwnerActivation(identity.session.userId, request.signal);
    if (owner.ownerStatus !== "active") {
      throw new ApiRouteError(
        403,
        "FORBIDDEN",
        "Ative seu cadastro de dono antes de gerenciar a publicação.",
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
      const publication = await readOwnerStudioPublication(
        identity.session.userId,
        studioId,
        request.signal,
      );
      status = 200;
      outcome = "accepted";
      return apiSuccessResponse(publication, requestId, status, identity.responseHeaders);
    } catch (error) {
      if (error instanceof StudioPublicationNotFoundError) {
        throw new ApiRouteError(
          404,
          "NOT_FOUND",
          "Este estúdio não está disponível para sua conta.",
        );
      }
      if (error instanceof StudioMediaStorageError) {
        throw new ApiRouteError(
          503,
          "SERVICE_UNAVAILABLE",
          "Não foi possível carregar a prévia da publicação agora. Tente novamente.",
        );
      }
      if (isStudioPublicationAbortError(error)) {
        throw new ApiRouteError(
          503,
          "SERVICE_UNAVAILABLE",
          "A leitura da publicação excedeu o prazo seguro. Tente novamente.",
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
      action: "studio.publication.read",
      durationMs: performance.now() - startedAt,
      event: "studio.request",
      outcome,
      requestId,
      status,
    });
  }
}

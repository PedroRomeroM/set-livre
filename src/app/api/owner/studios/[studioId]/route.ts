import { readRouteIdentitySession } from "@/domains/identity/server/identity-read-model";
import {
  readOwnerStudioEditor,
  StudioNotFoundError,
} from "@/domains/studios/server/studio-read-model";
import {
  ApiRouteError,
  apiErrorResponse,
  apiSuccessResponse,
  requestIdFrom,
  writeSafeOperationalEvent,
} from "@/lib/server/api-route";
import { z } from "zod";

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
    const { studioId: rawStudioId } = await context.params;
    const parsedStudioId = z.uuid().safeParse(rawStudioId);
    if (!parsedStudioId.success) {
      throw new ApiRouteError(404, "NOT_FOUND", "Este estúdio não está disponível para sua conta.");
    }
    try {
      const editor = await readOwnerStudioEditor(identity.session.userId, parsedStudioId.data);
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

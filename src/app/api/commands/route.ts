import { identityCommandActionSchema, identityCommandSchema } from "@set-livre/contracts";

import { executeIdentityCommand } from "@/domains/identity/server/identity-command-registry";
import { readRouteIdentitySession } from "@/domains/identity/server/identity-read-model";
import { runIdentityPostRoute } from "@/domains/identity/server/identity-route";
import { ApiRouteError, parseOrInputError, readLimitedJson } from "@/lib/server/api-route";

export async function POST(request: Request) {
  return runIdentityPostRoute(request, "identity.command", async (requestId, setAction) => {
    const rawCommand = await readLimitedJson(request);
    const action = parseOrInputError(
      identityCommandActionSchema,
      (rawCommand as { action?: unknown })?.action,
    );
    setAction(action);
    const routeIdentity =
      action === "identity.register" ? undefined : await readRouteIdentitySession();
    if (routeIdentity !== undefined && !routeIdentity.session.authenticated) {
      throw new ApiRouteError(401, "UNAUTHENTICATED", "Entre novamente para continuar.");
    }
    const authenticatedSession =
      routeIdentity?.session.authenticated === true ? routeIdentity.session : undefined;
    const command = parseOrInputError(
      identityCommandSchema,
      rawCommand,
      action === "identity.register" ? undefined : { code: "VALIDATION_FAILED", status: 422 },
    );
    return {
      data: await executeIdentityCommand(command, {
        requestId,
        session: authenticatedSession,
        userAgent: request.headers.get("user-agent"),
      }),
      responseHeaders: routeIdentity?.responseHeaders,
      status: action === "identity.register" ? 202 : 200,
    };
  });
}

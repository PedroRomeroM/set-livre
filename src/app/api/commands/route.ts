import { profileCompleteCommandSchema, profileUpdateCommandSchema } from "@set-livre/contracts";
import { z } from "zod";

import { executeIdentityCommand } from "@/domains/identity/server/identity-command-registry";
import { readRouteIdentitySession } from "@/domains/identity/server/identity-read-model";
import { runIdentityPostRoute } from "@/domains/identity/server/identity-route";
import { ApiRouteError, parseOrInputError, readLimitedJson } from "@/lib/server/api-route";

const privateIdentityCommandSchema = z.discriminatedUnion("action", [
  profileCompleteCommandSchema,
  profileUpdateCommandSchema,
]);

export async function POST(request: Request) {
  return runIdentityPostRoute(request, "identity.command", async (requestId, setAction) => {
    const routeIdentity = await readRouteIdentitySession();
    if (!routeIdentity.session.authenticated) {
      throw new ApiRouteError(401, "UNAUTHENTICATED", "Entre novamente para continuar.");
    }
    const command = parseOrInputError(
      privateIdentityCommandSchema,
      await readLimitedJson(request),
      { code: "VALIDATION_FAILED", status: 422 },
    );
    setAction(command.action);
    return {
      data: await executeIdentityCommand(command, {
        requestId,
        session: routeIdentity.session,
        userAgent: request.headers.get("user-agent"),
      }),
      responseHeaders: routeIdentity.responseHeaders,
      status: 200,
    };
  });
}

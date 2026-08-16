import {
  createPrivateCommandRegistry,
  privateCommandSchema,
} from "@/domains/commands/server/private-command-registry";
import { readRouteIdentitySession } from "@/domains/identity/server/identity-read-model";
import { runPrivateCommandPostRoute } from "@/domains/identity/server/identity-route";
import { executeOwnerCommand } from "@/domains/owners/server/owner-command-handler";
import { ApiRouteError, parseOrInputError, readLimitedJson } from "@/lib/server/api-route";

const executePrivateCommand = createPrivateCommandRegistry({ executeOwnerCommand });

export async function POST(request: Request) {
  return runPrivateCommandPostRoute(request, async (requestId, setAction, setResponseHeaders) => {
    const routeIdentity = await readRouteIdentitySession();
    setResponseHeaders(routeIdentity.responseHeaders);
    if (!routeIdentity.session.authenticated) {
      throw new ApiRouteError(401, "UNAUTHENTICATED", "Entre novamente para continuar.");
    }
    const command = parseOrInputError(privateCommandSchema, await readLimitedJson(request), {
      code: "VALIDATION_FAILED",
      status: 422,
    });
    setAction(command.action);
    return {
      data: await executePrivateCommand(command, {
        requestId,
        session: routeIdentity.session,
        userAgent: request.headers.get("user-agent"),
      }),
      responseHeaders: routeIdentity.responseHeaders,
      status: 200,
    };
  });
}

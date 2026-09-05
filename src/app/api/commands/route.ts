import {
  createPrivateCommandRegistry,
  privateCommandSchema,
} from "@/domains/commands/server/private-command-registry";
import { readRouteIdentitySession } from "@/domains/identity/server/identity-read-model";
import {
  enforcePrivateCommandFacadeRateLimit,
  runPrivateCommandPostRoute,
} from "@/domains/identity/server/identity-route";
import { executeOwnerCommand } from "@/domains/owners/server/owner-command-handler";
import { executeStudioCommand } from "@/domains/studios/server/studio-command-handler";
import { createTrustedStudioMediaStorage } from "@/domains/studios/server/studio-media-storage";
import { ApiRouteError, parseOrInputError, readLimitedJson } from "@/lib/server/api-route";

const executePrivateCommand = createPrivateCommandRegistry({
  executeOwnerCommand,
  executeStudioCommand,
});

export const privateCommandMaximumBytes = 384 * 1024;

export async function POST(request: Request) {
  return runPrivateCommandPostRoute(request, async (requestId, setAction, setResponseHeaders) => {
    const routeIdentity = await readRouteIdentitySession();
    setResponseHeaders(routeIdentity.responseHeaders);
    if (!routeIdentity.session.authenticated) {
      throw new ApiRouteError(401, "UNAUTHENTICATED", "Entre novamente para continuar.");
    }
    enforcePrivateCommandFacadeRateLimit(request);
    const command = parseOrInputError(
      privateCommandSchema,
      await readLimitedJson(request, privateCommandMaximumBytes),
      {
        code: "VALIDATION_FAILED",
        status: 422,
      },
    );
    setAction(command.action);
    const requiresStudioMediaStorage =
      command.action.startsWith("studio.media.") ||
      command.action === "studio.revision.submit" ||
      command.action === "studio.pause" ||
      command.action === "studio.resume";
    const studioMediaStorage = requiresStudioMediaStorage
      ? createTrustedStudioMediaStorage()
      : undefined;
    return {
      data: await executePrivateCommand(command, {
        requestId,
        session: routeIdentity.session,
        ...(studioMediaStorage === undefined ? {} : { studioMediaStorage }),
        userAgent: request.headers.get("user-agent"),
      }),
      responseHeaders: routeIdentity.responseHeaders,
      status: 200,
    };
  });
}

import { identityRegisterCommandSchema } from "@set-livre/contracts";

import { executeIdentityCommand } from "@/domains/identity/server/identity-command-registry";
import { runIdentityPostRoute } from "@/domains/identity/server/identity-route";
import { parseOrInputError, readLimitedJson } from "@/lib/server/api-route";

export async function POST(request: Request) {
  return runIdentityPostRoute(request, "identity.register", async (requestId) => {
    const command = parseOrInputError(
      identityRegisterCommandSchema,
      await readLimitedJson(request),
    );
    return {
      data: await executeIdentityCommand(command, {
        requestId,
        userAgent: request.headers.get("user-agent"),
      }),
      status: 202,
    };
  });
}

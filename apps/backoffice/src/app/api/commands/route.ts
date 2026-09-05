import { backofficeCommandSchema } from "@set-livre/contracts";

import { executeBackofficeCommand } from "@/domains/backoffice/server/backoffice-service";
import {
  backofficeNetworkDiscriminator,
  parseOrBackofficeInputError,
  readLimitedJson,
} from "@/lib/server/api-route";
import { runProtectedBackofficeRoute } from "@/lib/server/protected-api-route";
import {
  enforceBackofficeCommandIdentityRateLimits,
  enforceBackofficeRateLimit,
} from "@/lib/server/rate-limit";

export async function POST(request: Request) {
  return runProtectedBackofficeRoute(
    request,
    "backoffice.command",
    async ({ requestId, route, setAction }) => {
      enforceBackofficeRateLimit(
        "backoffice.commands.network",
        backofficeNetworkDiscriminator(request),
        { limit: 120, windowMs: 60_000 },
      );
      const command = parseOrBackofficeInputError(
        backofficeCommandSchema,
        await readLimitedJson(request),
      );
      setAction(command.action);
      enforceBackofficeCommandIdentityRateLimits(route.session.scope, command.action);
      return executeBackofficeCommand(command, { requestId, route });
    },
  );
}

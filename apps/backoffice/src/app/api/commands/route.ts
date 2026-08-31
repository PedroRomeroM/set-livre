import { backofficeCommandSchema } from "@set-livre/contracts";

import { executeBackofficeCommand } from "@/domains/backoffice/server/backoffice-service";
import { requireRouteBackofficeSession } from "@/domains/backoffice/server/backoffice-session";
import {
  backofficeNetworkDiscriminator,
  parseOrBackofficeInputError,
  readLimitedJson,
  runBackofficeRoute,
} from "@/lib/server/api-route";
import { enforceBackofficeRateLimit } from "@/lib/server/rate-limit";

export async function POST(request: Request) {
  return runBackofficeRoute(
    request,
    "backoffice.command",
    async (requestId, setAction, setResponseHeaders) => {
      const route = await requireRouteBackofficeSession();
      setResponseHeaders(route.responseHeaders);
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
      return executeBackofficeCommand(command, { requestId, route });
    },
  );
}

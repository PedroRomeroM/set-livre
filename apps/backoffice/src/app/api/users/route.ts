import { backofficeUserQuerySchema } from "@set-livre/contracts";

import { readBackofficeUsers } from "@/domains/backoffice/server/backoffice-service";
import {
  backofficeNetworkDiscriminator,
  parseOrBackofficeInputError,
  readLimitedJson,
  runBackofficeRoute,
} from "@/lib/server/api-route";
import { enforceBackofficeRateLimit } from "@/lib/server/rate-limit";

export async function POST(request: Request) {
  return runBackofficeRoute(request, "backoffice.users.read", async () => {
    enforceBackofficeRateLimit(
      "backoffice.users.network",
      backofficeNetworkDiscriminator(request),
      {
        limit: 120,
        windowMs: 60_000,
      },
    );
    const query = parseOrBackofficeInputError(
      backofficeUserQuerySchema,
      await readLimitedJson(request),
    );
    return readBackofficeUsers(query);
  });
}

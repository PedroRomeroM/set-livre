import { backofficeUserQuerySchema } from "@set-livre/contracts";

import { readBackofficeUsers } from "@/domains/backoffice/server/backoffice-service";
import {
  backofficeNetworkDiscriminator,
  parseOrBackofficeInputError,
  readLimitedJson,
} from "@/lib/server/api-route";
import { runProtectedBackofficeRoute } from "@/lib/server/protected-api-route";
import { enforceBackofficeRateLimit } from "@/lib/server/rate-limit";

export async function POST(request: Request) {
  return runProtectedBackofficeRoute(request, "backoffice.users.read", async ({ route }) => {
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
    return readBackofficeUsers(route, query);
  });
}

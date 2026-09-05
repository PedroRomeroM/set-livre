import { backofficeLogoutPayloadSchema } from "@set-livre/contracts";

import { logoutBackoffice } from "@/domains/backoffice/server/backoffice-session";
import {
  backofficeNetworkDiscriminator,
  parseOrBackofficeInputError,
  readLimitedJson,
  runBackofficeRoute,
} from "@/lib/server/api-route";
import { enforceBackofficeRateLimit } from "@/lib/server/rate-limit";

export async function POST(request: Request) {
  return runBackofficeRoute(request, "backoffice.auth.logout", async () => {
    enforceBackofficeRateLimit(
      "backoffice.logout.network",
      backofficeNetworkDiscriminator(request),
      {
        limit: 60,
        windowMs: 60_000,
      },
    );
    const payload = parseOrBackofficeInputError(
      backofficeLogoutPayloadSchema,
      await readLimitedJson(request),
    );
    return logoutBackoffice(payload.expectedScope);
  });
}

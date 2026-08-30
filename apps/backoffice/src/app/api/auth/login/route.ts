import { backofficeLoginPayloadSchema } from "@set-livre/contracts";

import { loginBackoffice } from "@/domains/backoffice/server/backoffice-session";
import {
  backofficeNetworkDiscriminator,
  hashBackofficePrivateValue,
  parseOrBackofficeInputError,
  readLimitedJson,
  runBackofficeRoute,
} from "@/lib/server/api-route";
import { enforceBackofficeRateLimit } from "@/lib/server/rate-limit";

export async function POST(request: Request) {
  return runBackofficeRoute(request, "backoffice.auth.login", async () => {
    enforceBackofficeRateLimit(
      "backoffice.login.network",
      backofficeNetworkDiscriminator(request),
      {
        limit: 30,
        windowMs: 15 * 60_000,
      },
    );
    const payload = parseOrBackofficeInputError(
      backofficeLoginPayloadSchema,
      await readLimitedJson(request),
    );
    enforceBackofficeRateLimit(
      "backoffice.login.identity",
      hashBackofficePrivateValue(payload.email),
      {
        limit: 10,
        windowMs: 15 * 60_000,
      },
    );
    return loginBackoffice(payload);
  });
}

import { backofficeRuntimeUnlockPayloadSchema } from "@set-livre/contracts";

import { requireRouteBackofficeSession } from "@/domains/backoffice/server/backoffice-session";
import { unlockBackofficeRuntime } from "@/domains/backoffice/server/runtime-unlock";
import {
  backofficeNetworkDiscriminator,
  hashBackofficePrivateValue,
  parseOrBackofficeInputError,
  readLimitedJson,
  runBackofficeRoute,
} from "@/lib/server/api-route";
import { backofficeAuthNetworkRateLimitOptions } from "@/lib/server/auth-rate-limit-profile";
import { enforceBackofficeRateLimit } from "@/lib/server/rate-limit";

export async function POST(request: Request) {
  return runBackofficeRoute(request, "backoffice.auth.unlock", async () => {
    const route = await requireRouteBackofficeSession();
    enforceBackofficeRateLimit(
      "backoffice.unlock.network",
      backofficeNetworkDiscriminator(request),
      backofficeAuthNetworkRateLimitOptions(),
    );
    enforceBackofficeRateLimit(
      "backoffice.unlock.identity",
      hashBackofficePrivateValue(route.auth.userId),
      { limit: 10, windowMs: 15 * 60_000 },
    );
    const payload = parseOrBackofficeInputError(
      backofficeRuntimeUnlockPayloadSchema,
      await readLimitedJson(request),
    );
    return {
      data: await unlockBackofficeRuntime(route.auth, payload),
      responseHeaders: route.responseHeaders,
    };
  });
}

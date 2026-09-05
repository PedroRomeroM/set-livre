import { backofficeRuntimeUnlockPayloadSchema } from "@set-livre/contracts";

import { unlockBackofficeRuntime } from "@/domains/backoffice/server/runtime-unlock";
import {
  backofficeNetworkDiscriminator,
  hashBackofficePrivateValue,
  parseOrBackofficeInputError,
  readLimitedJson,
} from "@/lib/server/api-route";
import { backofficeAuthNetworkRateLimitOptions } from "@/lib/server/auth-rate-limit-profile";
import { runProtectedBackofficeRoute } from "@/lib/server/protected-api-route";
import { enforceBackofficeRateLimit } from "@/lib/server/rate-limit";

export async function POST(request: Request) {
  return runProtectedBackofficeRoute(request, "backoffice.auth.unlock", async ({ route }) => {
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
    };
  });
}

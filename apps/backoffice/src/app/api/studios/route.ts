import { backofficeStudioReviewQueueQuerySchema } from "@set-livre/contracts";

import { readBackofficeStudioReviews } from "@/domains/backoffice/server/backoffice-service";
import {
  backofficeNetworkDiscriminator,
  parseOrBackofficeInputError,
  readLimitedJson,
} from "@/lib/server/api-route";
import { runProtectedBackofficeRoute } from "@/lib/server/protected-api-route";
import { enforceBackofficeRateLimit } from "@/lib/server/rate-limit";

export async function POST(request: Request) {
  return runProtectedBackofficeRoute(request, "backoffice.studios.read", async ({ route }) => {
    enforceBackofficeRateLimit(
      "backoffice.studios.network",
      backofficeNetworkDiscriminator(request),
      { limit: 120, windowMs: 60_000 },
    );
    const query = parseOrBackofficeInputError(
      backofficeStudioReviewQueueQuerySchema,
      await readLimitedJson(request),
    );
    return readBackofficeStudioReviews(route, query);
  });
}

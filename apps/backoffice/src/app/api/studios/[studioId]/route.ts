import { readBackofficeStudioReview } from "@/domains/backoffice/server/backoffice-service";
import { backofficeNetworkDiscriminator } from "@/lib/server/api-route";
import { runProtectedBackofficeRoute } from "@/lib/server/protected-api-route";
import { enforceBackofficeRateLimit } from "@/lib/server/rate-limit";

export async function GET(request: Request, context: { params: Promise<{ studioId: string }> }) {
  return runProtectedBackofficeRoute(
    request,
    "backoffice.studio.read",
    async ({ route }) => {
      enforceBackofficeRateLimit(
        "backoffice.studio.network",
        backofficeNetworkDiscriminator(request),
        { limit: 120, windowMs: 60_000 },
      );
      const { studioId } = await context.params;
      return {
        data: await readBackofficeStudioReview({
          auth: route.auth,
          client: route.client,
          signal: request.signal,
          studioId,
        }),
      };
    },
    { origin: false },
  );
}

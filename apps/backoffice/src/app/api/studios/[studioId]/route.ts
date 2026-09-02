import {
  backofficeStudioReadActivityHeader,
  backofficeStudioReadActivitySchema,
} from "@set-livre/contracts";

import { readBackofficeStudioReview } from "@/domains/backoffice/server/backoffice-service";
import {
  backofficeNetworkDiscriminator,
  parseOrBackofficeInputError,
} from "@/lib/server/api-route";
import { runProtectedBackofficeRoute } from "@/lib/server/protected-api-route";
import { enforceBackofficeRateLimit } from "@/lib/server/rate-limit";
import {
  createBackofficeRouteSupabaseClient,
  withBackofficeSupabaseResponseHeaderMerge,
} from "@/lib/supabase/server";

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
      const activity = parseOrBackofficeInputError(
        backofficeStudioReadActivitySchema,
        request.headers.get(backofficeStudioReadActivityHeader) ?? "interactive",
      );
      return withBackofficeSupabaseResponseHeaderMerge(
        route.responseHeaders,
        async (captureResponseHeaders) => ({
          data: await readBackofficeStudioReview({
            activity,
            auth: route.auth,
            createSigningClient: async (signal) => {
              const signingRoute = await createBackofficeRouteSupabaseClient({ signal });
              captureResponseHeaders(signingRoute.responseHeaders);
              return signingRoute.client;
            },
            signal: request.signal,
            studioId,
          }),
        }),
      );
    },
    { origin: false },
  );
}

import { readBackofficeTaxonomies } from "@/domains/backoffice/server/backoffice-service";
import { requireRouteBackofficeSession } from "@/domains/backoffice/server/backoffice-session";
import { backofficeNetworkDiscriminator, runBackofficeRoute } from "@/lib/server/api-route";
import { enforceBackofficeRateLimit } from "@/lib/server/rate-limit";

export async function GET(request: Request) {
  return runBackofficeRoute(
    request,
    "backoffice.taxonomies.read",
    async (_requestId, _setAction, setResponseHeaders) => {
      const route = await requireRouteBackofficeSession();
      setResponseHeaders(route.responseHeaders);
      enforceBackofficeRateLimit(
        "backoffice.taxonomies.network",
        backofficeNetworkDiscriminator(request),
        { limit: 120, windowMs: 60_000 },
      );
      return readBackofficeTaxonomies(route);
    },
    { origin: false },
  );
}

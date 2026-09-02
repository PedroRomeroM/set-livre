import { readBackofficeTaxonomies } from "@/domains/backoffice/server/backoffice-service";
import { backofficeNetworkDiscriminator } from "@/lib/server/api-route";
import { runProtectedBackofficeRoute } from "@/lib/server/protected-api-route";
import { enforceBackofficeRateLimit } from "@/lib/server/rate-limit";

export async function GET(request: Request) {
  return runProtectedBackofficeRoute(
    request,
    "backoffice.taxonomies.read",
    async ({ route }) => {
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

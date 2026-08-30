import { readBackofficeTaxonomies } from "@/domains/backoffice/server/backoffice-service";
import { backofficeNetworkDiscriminator, runBackofficeRoute } from "@/lib/server/api-route";
import { enforceBackofficeRateLimit } from "@/lib/server/rate-limit";

export async function GET(request: Request) {
  return runBackofficeRoute(
    request,
    "backoffice.taxonomies.read",
    async () => {
      enforceBackofficeRateLimit(
        "backoffice.taxonomies.network",
        backofficeNetworkDiscriminator(request),
        { limit: 120, windowMs: 60_000 },
      );
      return readBackofficeTaxonomies();
    },
    { origin: false },
  );
}

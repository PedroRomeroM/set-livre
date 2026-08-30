import { readRouteBackofficeSession } from "@/domains/backoffice/server/backoffice-session";
import { backofficeNetworkDiscriminator, runBackofficeRoute } from "@/lib/server/api-route";
import { enforceBackofficeRateLimit } from "@/lib/server/rate-limit";

export async function GET(request: Request) {
  return runBackofficeRoute(
    request,
    "backoffice.auth.session",
    async () => {
      enforceBackofficeRateLimit(
        "backoffice.session.network",
        backofficeNetworkDiscriminator(request),
        { limit: 120, windowMs: 60_000 },
      );
      const route = await readRouteBackofficeSession();
      return { data: route.session, responseHeaders: route.responseHeaders };
    },
    { origin: false },
  );
}

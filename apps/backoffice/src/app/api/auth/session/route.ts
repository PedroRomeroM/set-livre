import {
  readRouteBackofficeSession,
  toBrowserBackofficeSession,
} from "../../../../domains/backoffice/server/backoffice-session";
import {
  backofficeNetworkDiscriminator,
  hashBackofficePrivateValue,
  runBackofficeRoute,
} from "../../../../lib/server/api-route";
import { enforceBackofficeRateLimit } from "../../../../lib/server/rate-limit";

const sessionRateLimit = { limit: 120, windowMs: 60_000 } as const;

export async function GET(request: Request) {
  return runBackofficeRoute(
    request,
    "backoffice.auth.session",
    async (_requestId, _setAction, setResponseHeaders) => {
      const network = backofficeNetworkDiscriminator(request);
      // A fachada limita a leitura canônica antes de conhecer a identidade. O teto
      // operacional abaixo é separado por sessão, não pelo endereço compartilhado do SSH.
      enforceBackofficeRateLimit("backoffice.session.facade", network, {
        limit: 600,
        windowMs: 60_000,
      });
      const route = await readRouteBackofficeSession().catch((error: unknown) => {
        enforceBackofficeRateLimit("backoffice.session.network", network, sessionRateLimit);
        throw error;
      });
      setResponseHeaders(route.responseHeaders);
      if (route.session.authenticated) {
        enforceBackofficeRateLimit(
          "backoffice.session.authenticated",
          hashBackofficePrivateValue(
            JSON.stringify([route.session.scope, route.session.authSessionId]),
          ),
          sessionRateLimit,
        );
      } else {
        enforceBackofficeRateLimit("backoffice.session.network", network, sessionRateLimit);
      }
      return {
        data: await toBrowserBackofficeSession(route.session),
        responseHeaders: route.responseHeaders,
      };
    },
    { origin: false },
  );
}

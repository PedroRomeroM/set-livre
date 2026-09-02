import "server-only";

import {
  requireRouteBackofficeSession,
  type RequiredRouteBackofficeSession,
} from "../../domains/backoffice/server/backoffice-session";

import { type BackofficeOperationalAction, runBackofficeRoute } from "./api-route";

type ProtectedBackofficeRouteContext = Readonly<{
  requestId: string;
  route: RequiredRouteBackofficeSession;
  setAction: (action: BackofficeOperationalAction) => void;
}>;

type ProtectedBackofficeRouteResult = Readonly<{
  data: unknown;
  responseHeaders?: HeadersInit | undefined;
  status?: number | undefined;
}>;

export function runProtectedBackofficeRoute(
  request: Request,
  action: BackofficeOperationalAction,
  execute: (context: ProtectedBackofficeRouteContext) => Promise<ProtectedBackofficeRouteResult>,
  options?: { origin?: boolean },
) {
  return runBackofficeRoute(
    request,
    action,
    async (requestId, setAction, setResponseHeaders) => {
      const route = await requireRouteBackofficeSession();
      setResponseHeaders(route.responseHeaders);
      return execute({ requestId, route, setAction });
    },
    options,
  );
}

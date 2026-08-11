import { evaluateReadiness, resolveRequestId } from "@set-livre/contracts";

import { isDatabaseReady } from "@/lib/server/database-readiness";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const requestId = resolveRequestId(request.headers.get("x-request-id"));
  const readiness = await evaluateReadiness(
    "web",
    requestId,
    process.env.APP_RELEASE_SHA,
    isDatabaseReady,
  );

  return Response.json(readiness.payload, {
    headers: readiness.headers,
    status: readiness.status,
  });
}

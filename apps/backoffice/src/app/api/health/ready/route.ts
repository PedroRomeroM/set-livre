import { createHealthPayload, healthReleaseSchema, resolveRequestId } from "@set-livre/contracts";

import { isDatabaseReady } from "@/lib/server/database-readiness";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const requestId = resolveRequestId(request.headers.get("x-request-id"));
  const release = healthReleaseSchema.parse(process.env.APP_RELEASE_SHA);
  const ready = await isDatabaseReady();

  return Response.json(
    createHealthPayload("backoffice", ready ? "ready" : "unready", requestId, release),
    {
      headers: { "cache-control": "no-store", "x-request-id": requestId },
      status: ready ? 200 : 503,
    },
  );
}

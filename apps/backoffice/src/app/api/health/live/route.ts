import { createHealthPayload, healthReleaseSchema, resolveRequestId } from "@set-livre/contracts";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const requestId = resolveRequestId(request.headers.get("x-request-id"));
  const release = healthReleaseSchema.parse(process.env.APP_RELEASE_SHA);

  return Response.json(createHealthPayload("backoffice", "live", requestId, release), {
    headers: { "cache-control": "no-store", "x-request-id": requestId },
  });
}

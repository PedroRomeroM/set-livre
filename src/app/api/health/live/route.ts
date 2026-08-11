import { evaluateLiveness, resolveRequestId } from "@set-livre/contracts";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const requestId = resolveRequestId(request.headers.get("x-request-id"));
  const liveness = evaluateLiveness("web", requestId, process.env.APP_RELEASE_SHA);

  return Response.json(liveness.payload, {
    headers: liveness.headers,
    status: liveness.status,
  });
}

import { identityRecoveryRequestPayloadSchema } from "@set-livre/contracts";

import { runIdentityPostRoute } from "@/domains/identity/server/identity-route";
import { requestIdentityRecovery } from "@/domains/identity/server/identity-service";
import { parseOrInputError, readLimitedJson } from "@/lib/server/api-route";

export async function POST(request: Request) {
  return runIdentityPostRoute(request, "identity.recovery.request", async () => {
    const payload = parseOrInputError(
      identityRecoveryRequestPayloadSchema,
      await readLimitedJson(request),
    );
    const result = await requestIdentityRecovery(payload.email);
    return { ...result, status: 202 };
  });
}

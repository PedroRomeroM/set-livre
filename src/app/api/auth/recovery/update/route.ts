import { identityRecoveryUpdatePayloadSchema } from "@set-livre/contracts";

import { runIdentityPostRoute } from "@/domains/identity/server/identity-route";
import { updateRecoveredIdentityPassword } from "@/domains/identity/server/identity-service";
import { parseOrInputError, readLimitedJson } from "@/lib/server/api-route";

export async function POST(request: Request) {
  return runIdentityPostRoute(request, "identity.recovery.update", async () => {
    const payload = parseOrInputError(
      identityRecoveryUpdatePayloadSchema,
      await readLimitedJson(request),
    );
    return updateRecoveredIdentityPassword(payload.password);
  });
}

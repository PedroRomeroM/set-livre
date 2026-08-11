import { identityCallbackPayloadSchema } from "@set-livre/contracts";

import { runIdentityPostRoute } from "@/domains/identity/server/identity-route";
import { verifyIdentityCallback } from "@/domains/identity/server/identity-service";
import { parseOrInputError, readLimitedJson } from "@/lib/server/api-route";

export async function POST(request: Request) {
  return runIdentityPostRoute(request, "identity.callback", async () => {
    const payload = parseOrInputError(
      identityCallbackPayloadSchema,
      await readLimitedJson(request),
    );
    return verifyIdentityCallback(payload);
  });
}

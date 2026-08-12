import { identityLogoutPayloadSchema } from "@set-livre/contracts";

import { runIdentityPostRoute } from "@/domains/identity/server/identity-route";
import { logoutIdentity } from "@/domains/identity/server/identity-service";
import { parseOrInputError, readLimitedJson } from "@/lib/server/api-route";

export async function POST(request: Request) {
  return runIdentityPostRoute(request, "identity.logout", async () => {
    const payload = parseOrInputError(identityLogoutPayloadSchema, await readLimitedJson(request));
    return logoutIdentity(payload.expectedScope);
  });
}

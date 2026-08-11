import { identityLoginPayloadSchema } from "@set-livre/contracts";

import { runIdentityPostRoute } from "@/domains/identity/server/identity-route";
import { loginIdentity } from "@/domains/identity/server/identity-service";
import { parseOrInputError, readLimitedJson } from "@/lib/server/api-route";

export async function POST(request: Request) {
  return runIdentityPostRoute(request, "identity.login", async () => {
    const payload = parseOrInputError(identityLoginPayloadSchema, await readLimitedJson(request));
    return loginIdentity(payload);
  });
}

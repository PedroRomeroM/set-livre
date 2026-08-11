import { runIdentityPostRoute } from "@/domains/identity/server/identity-route";
import { logoutIdentity } from "@/domains/identity/server/identity-service";
import { parseOrInputError, readLimitedJson } from "@/lib/server/api-route";
import { z } from "zod";

const logoutPayloadSchema = z.strictObject({});

export async function POST(request: Request) {
  return runIdentityPostRoute(request, "identity.logout", async () => {
    parseOrInputError(logoutPayloadSchema, await readLimitedJson(request));
    return logoutIdentity();
  });
}

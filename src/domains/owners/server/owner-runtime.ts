import "server-only";

import type { OwnerActivationCapability, OwnerContractReference } from "@set-livre/contracts";

function deriveOwnerActivationCapability(
  source: OwnerContractReference["source"],
  appEnvironment: string | undefined,
): OwnerActivationCapability {
  if (source === "approved") return "available";
  return appEnvironment === "local" || appEnvironment === "test" ? "available" : "unavailable";
}

export function readOwnerActivationCapability(
  source: OwnerContractReference["source"],
): OwnerActivationCapability {
  return deriveOwnerActivationCapability(source, process.env.APP_ENV);
}

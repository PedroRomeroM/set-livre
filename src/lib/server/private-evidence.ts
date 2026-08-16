import "server-only";

import { createHash } from "node:crypto";

export function hashOptionalPrivateEvidence(value: string | null) {
  return value === null ? null : createHash("sha256").update(value).digest("hex");
}

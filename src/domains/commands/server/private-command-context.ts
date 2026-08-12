import "server-only";

import type { IdentitySession } from "@set-livre/contracts";

type AuthenticatedIdentitySession = Extract<IdentitySession, { authenticated: true }>;

export type PrivateCommandContext = Readonly<{
  requestId: string;
  session: AuthenticatedIdentitySession;
  userAgent: string | null;
}>;

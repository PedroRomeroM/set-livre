import "server-only";

import type { IdentitySession } from "@set-livre/contracts";

import type { StudioMediaStorage } from "@/domains/studios/server/studio-media-storage";

type AuthenticatedIdentitySession = Extract<IdentitySession, { authenticated: true }>;

export type PrivateCommandContext = Readonly<{
  requestId: string;
  session: AuthenticatedIdentitySession;
  studioMediaStorage?: StudioMediaStorage;
  userAgent: string | null;
}>;

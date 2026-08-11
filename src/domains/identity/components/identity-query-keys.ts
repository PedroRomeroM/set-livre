import type { IdentitySession } from "@set-livre/contracts";

export type IdentitySessionScope = string;
export type IdentitySessionFetchStatus = "fetching" | "idle" | "paused";

const identitySessionQueryRoot = ["identity", "session"] as const;

export class IdentitySessionScopeChangedError extends Error {
  constructor() {
    super("A sessão autoritativa mudou de escopo.");
    this.name = "IdentitySessionScopeChangedError";
  }
}

export const identityQueryKeys = {
  recoveryStatus: ["identity", "recovery", "current-session"] as const,
  session: (scope: IdentitySessionScope) => [...identitySessionQueryRoot, scope] as const,
  sessions: identitySessionQueryRoot,
};

export function identitySessionScope(session: IdentitySession): IdentitySessionScope {
  return session.authenticated ? session.userId : "anonymous";
}

export function identitySessionQueryScope(
  queryKey: readonly unknown[],
): IdentitySessionScope | undefined {
  if (
    queryKey.length !== 3 ||
    queryKey[0] !== identitySessionQueryRoot[0] ||
    queryKey[1] !== identitySessionQueryRoot[1] ||
    typeof queryKey[2] !== "string"
  ) {
    return undefined;
  }
  return queryKey[2];
}

export function identitySessionCanRender(
  session: IdentitySession,
  expectedScope: IdentitySessionScope,
  fetchStatus: IdentitySessionFetchStatus,
) {
  return fetchStatus === "idle" && identitySessionMatchesScope(session, expectedScope);
}

export function identitySessionMatchesScope(
  session: IdentitySession,
  expectedScope: IdentitySessionScope,
) {
  return identitySessionScope(session) === expectedScope;
}

export function identitySessionForScope(
  session: IdentitySession,
  expectedScope: IdentitySessionScope,
) {
  if (!identitySessionMatchesScope(session, expectedScope)) {
    throw new IdentitySessionScopeChangedError();
  }
  return session;
}

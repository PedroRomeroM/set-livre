import type {
  IdentityRecoverySessionScope,
  IdentityRecoveryStatusResult,
  IdentitySession,
} from "@set-livre/contracts";

export type IdentitySessionScope = string;
type IdentityFetchStatus = "fetching" | "idle" | "paused";

const identityRecoveryQueryRoot = ["identity", "recovery", "status"] as const;
const identitySessionQueryRoot = ["identity", "session"] as const;

export class IdentityRecoveryScopeChangedError extends Error {
  constructor() {
    super("A autorização de recuperação mudou de escopo.");
    this.name = "IdentityRecoveryScopeChangedError";
  }
}

export class IdentitySessionScopeChangedError extends Error {
  constructor() {
    super("A sessão autoritativa mudou de escopo.");
    this.name = "IdentitySessionScopeChangedError";
  }
}

export const identityQueryKeys = {
  recoveryStatus: (scope: IdentityRecoverySessionScope) =>
    [...identityRecoveryQueryRoot, scope] as const,
  recoveryStatuses: identityRecoveryQueryRoot,
  session: (scope: IdentitySessionScope) => [...identitySessionQueryRoot, scope] as const,
  sessions: identitySessionQueryRoot,
};

export function identityRecoveryQueryScope(queryKey: readonly unknown[]): string | undefined {
  if (
    queryKey.length !== 4 ||
    queryKey[0] !== identityRecoveryQueryRoot[0] ||
    queryKey[1] !== identityRecoveryQueryRoot[1] ||
    queryKey[2] !== identityRecoveryQueryRoot[2] ||
    typeof queryKey[3] !== "string"
  ) {
    return undefined;
  }
  return queryKey[3];
}

export function identityRecoveryStatusCanAuthorize(
  status: IdentityRecoveryStatusResult,
  expectedScope: IdentityRecoverySessionScope,
  fetchStatus: IdentityFetchStatus,
) {
  return fetchStatus === "idle" && status.allowed && status.scope === expectedScope;
}

export function identityRecoveryStatusForScope(
  status: IdentityRecoveryStatusResult,
  expectedScope: IdentityRecoverySessionScope,
) {
  if (status.scope !== expectedScope) {
    throw new IdentityRecoveryScopeChangedError();
  }
  return status;
}

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
  fetchStatus: IdentityFetchStatus,
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

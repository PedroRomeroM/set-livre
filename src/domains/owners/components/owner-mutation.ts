import { OwnerApiError } from "./owner-api";

export const ownerMutationNetworkMode = "always" as const;

export type OwnerMutationAttempt<TPayload> = Readonly<{
  expectedScope: string;
  idempotencyKey: string;
  payload: TPayload;
}>;

export type OwnerScopeTransitionGuard = {
  current: boolean;
};

export function ownerMutationResultCanPublish(guard: OwnerScopeTransitionGuard) {
  return !guard.current;
}

export function beginOwnerScopeTransitionOnce(
  guard: OwnerScopeTransitionGuard,
  showBoundary: () => void,
  clearPrivateCache: () => void,
  reload: () => void,
) {
  if (guard.current) return false;
  guard.current = true;
  try {
    showBoundary();
  } finally {
    try {
      clearPrivateCache();
    } finally {
      reload();
    }
  }
  return true;
}

export function requireOwnerMutationAttempt<TPayload>(
  attempt: OwnerMutationAttempt<TPayload> | undefined,
  missingAttemptMessage: string,
) {
  if (attempt === undefined) {
    throw new Error(missingAttemptMessage);
  }
  return attempt;
}

export function cleanupOwnerMutationAttemptOnce<TPayload>(
  attempt: OwnerMutationAttempt<TPayload> | undefined,
  clearAttempt: () => void,
) {
  if (attempt === undefined) return;
  clearAttempt();
}

export function isOwnerSessionChangedError(error: unknown) {
  return (
    error instanceof OwnerApiError &&
    (error.code === "SESSION_CHANGED" || error.code === "UNAUTHENTICATED")
  );
}

export function ownerReadRequiresScopeTransition({
  authoritativeScopeChanged,
  error,
  observedScopeChanged,
}: Readonly<{
  authoritativeScopeChanged: boolean;
  error: unknown;
  observedScopeChanged: boolean;
}>) {
  return observedScopeChanged || authoritativeScopeChanged || isOwnerSessionChangedError(error);
}

export function isOwnerAmbiguousCommandError(error: unknown) {
  return (
    error instanceof OwnerApiError &&
    (error.code === "NETWORK_UNAVAILABLE" ||
      error.code === "PAYMENT_PROVIDER_UNAVAILABLE" ||
      error.code === "REQUEST_TIMEOUT" ||
      error.code === "RESPONSE_INVALID" ||
      error.code === "SERVICE_UNAVAILABLE")
  );
}

export function isOwnerUnscopedValidationError(error: unknown) {
  return (
    error instanceof OwnerApiError &&
    error.code === "VALIDATION_FAILED" &&
    Object.keys(error.fieldErrors).length === 0
  );
}

export function ownerMutationRequiresVerification(error: unknown) {
  return (
    isOwnerAmbiguousCommandError(error) ||
    isOwnerUnscopedValidationError(error) ||
    (error instanceof OwnerApiError && error.code === "CONFLICT")
  );
}

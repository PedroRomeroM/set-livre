import { StudioApiError } from "./studio-api";

export const studioMutationNetworkMode = "always" as const;

export type StudioMutationAttempt<TPayload> = Readonly<{
  expectedScope: string;
  idempotencyKey: string;
  payload: TPayload;
}>;

export type StudioScopeTransitionGuard = { current: boolean };

export function studioMutationResultCanPublish(guard: StudioScopeTransitionGuard) {
  return !guard.current;
}

export function beginStudioScopeTransitionOnce(
  guard: StudioScopeTransitionGuard,
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

export function requireStudioMutationAttempt<TPayload>(
  attempt: StudioMutationAttempt<TPayload> | undefined,
  missingAttemptMessage: string,
) {
  if (attempt === undefined) throw new Error(missingAttemptMessage);
  return attempt;
}

export function cleanupStudioMutationAttemptOnce<TPayload>(
  attempt: StudioMutationAttempt<TPayload> | undefined,
  clearAttempt: () => void,
) {
  if (attempt !== undefined) clearAttempt();
}

export function isStudioSessionChangedError(error: unknown) {
  return (
    error instanceof StudioApiError &&
    (error.code === "ACCOUNT_SUSPENDED" ||
      error.code === "FORBIDDEN" ||
      error.code === "SESSION_CHANGED" ||
      error.code === "UNAUTHENTICATED")
  );
}

export function isStudioNotFoundError(error: unknown) {
  return error instanceof StudioApiError && error.code === "NOT_FOUND";
}

export function isStudioMutationScopeTransitionError(error: unknown) {
  return isStudioSessionChangedError(error) || isStudioNotFoundError(error);
}

export function isStudioAmbiguousCommandError(error: unknown) {
  return (
    error instanceof StudioApiError &&
    (error.code === "NETWORK_UNAVAILABLE" ||
      error.code === "REQUEST_TIMEOUT" ||
      error.code === "RESPONSE_INVALID" ||
      error.code === "SERVICE_UNAVAILABLE")
  );
}

export function isStudioUnscopedValidationError(error: unknown) {
  return (
    error instanceof StudioApiError &&
    error.code === "VALIDATION_FAILED" &&
    Object.keys(error.fieldErrors).length === 0
  );
}

export function studioMutationRequiresVerification(error: unknown) {
  return (
    isStudioAmbiguousCommandError(error) ||
    isStudioUnscopedValidationError(error) ||
    (error instanceof StudioApiError && error.code === "CONFLICT")
  );
}

export function studioReadRequiresScopeTransition({
  authoritativeScopeChanged,
  error,
  observedScopeChanged,
}: Readonly<{
  authoritativeScopeChanged: boolean;
  error: unknown;
  observedScopeChanged: boolean;
}>) {
  return observedScopeChanged || authoritativeScopeChanged || isStudioSessionChangedError(error);
}

import { ProfileApiError } from "./profile-api";

export const profileMutationNetworkMode = "always" as const;

export type ProfileMutationAttempt<TPayload> = Readonly<{
  expectedScope: string;
  payload: TPayload;
}>;

export type ProfileScopeTransitionGuard = {
  current: boolean;
};

export function profileMutationResultCanPublish(guard: ProfileScopeTransitionGuard) {
  return !guard.current;
}

export function beginProfileScopeTransitionOnce(
  guard: ProfileScopeTransitionGuard,
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

export function requireProfileMutationAttempt<TPayload>(
  attempt: ProfileMutationAttempt<TPayload> | undefined,
  missingAttemptMessage: string,
) {
  if (attempt === undefined) {
    throw new Error(missingAttemptMessage);
  }
  return attempt;
}

export function cleanupProfileMutationAttemptOnce<TPayload>(
  attempt: ProfileMutationAttempt<TPayload> | undefined,
  clearAttempt: () => void,
  cleanup: () => void,
) {
  if (attempt === undefined) return;
  clearAttempt();
  cleanup();
}

export function isProfileSessionChangedError(error: unknown) {
  return (
    error instanceof ProfileApiError &&
    (error.code === "SESSION_CHANGED" || error.code === "UNAUTHENTICATED")
  );
}

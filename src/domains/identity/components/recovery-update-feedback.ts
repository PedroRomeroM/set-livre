import type {
  IdentityRecoverySessionScope,
  IdentityRecoveryStatusResult,
} from "@set-livre/contracts";

import type { FieldErrors } from "./form-utils";
import { IdentityApiError } from "./identity-api";

type IdentityRecoveryFetchStatus = "fetching" | "idle" | "paused";

const recoveryUpdateFieldNames = ["password", "confirmPassword"] as const;

export type RecoveryUpdateFeedback = Readonly<{
  fieldErrors: FieldErrors;
  message: string;
  scope: IdentityRecoverySessionScope;
}>;

export function recoveryUpdateFeedbackFromError(
  error: unknown,
  scope: IdentityRecoverySessionScope,
): RecoveryUpdateFeedback | undefined {
  if (!(error instanceof IdentityApiError)) {
    return undefined;
  }

  const fieldErrors: Record<string, string> = {};
  for (const fieldName of recoveryUpdateFieldNames) {
    const fieldError = error.fieldErrors[fieldName];
    if (fieldError !== undefined) {
      fieldErrors[fieldName] = fieldError;
    }
  }

  return {
    fieldErrors,
    message: error.message,
    scope,
  };
}

export function reconcileRecoveryUpdateFeedback(
  feedback: RecoveryUpdateFeedback | undefined,
  status: IdentityRecoveryStatusResult | undefined,
  expectedScope: IdentityRecoverySessionScope,
  fetchStatus: IdentityRecoveryFetchStatus,
): RecoveryUpdateFeedback | undefined {
  if (feedback === undefined) {
    return undefined;
  }
  if (feedback.scope !== expectedScope) {
    return undefined;
  }
  if (fetchStatus !== "idle" || status === undefined) {
    return feedback;
  }

  return status.allowed && status.scope === expectedScope && status.scope === feedback.scope
    ? feedback
    : undefined;
}

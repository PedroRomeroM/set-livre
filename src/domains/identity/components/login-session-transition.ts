import {
  resolveAccountLoginReturnTarget,
  type AccountLoginReturnTarget,
} from "@set-livre/contracts";

import { IdentityApiError } from "./identity-api";

export { resolveAccountLoginReturnTarget };
export type { AccountLoginReturnTarget };

type LoginCredentialForm = {
  hidden: boolean;
  reset: () => void;
};

type AmbiguousLoginTransitionActions = {
  beginSessionTransition: () => void;
  clearEphemeralCredentials: () => void;
  hideAndResetCredentialForm: () => void;
  redactPrivateCaches: () => void;
  reloadAuthoritativeSession: () => void;
};

const ambiguousLoginTransportCodes = new Set([
  "AUTH_SESSION_RECHECK_REQUIRED",
  "NETWORK_UNAVAILABLE",
  "REQUEST_TIMEOUT",
  "RESPONSE_INVALID",
]);

export function isAmbiguousLoginTransportError(error: unknown) {
  return error instanceof IdentityApiError && ambiguousLoginTransportCodes.has(error.code);
}

export function hideAndResetLoginCredentialForm(form: LoginCredentialForm | null) {
  if (form === null) {
    return;
  }
  form.hidden = true;
  form.reset();
}

export function loginSessionVerificationPath(returnTo?: AccountLoginReturnTarget | undefined) {
  return returnTo === undefined
    ? "/entrar?entrada=verificar"
    : `/entrar?entrada=verificar&retorno=${encodeURIComponent(returnTo)}`;
}

export function handleAmbiguousLoginTransportError(
  error: unknown,
  actions: AmbiguousLoginTransitionActions,
) {
  if (!isAmbiguousLoginTransportError(error)) {
    return false;
  }

  actions.clearEphemeralCredentials();
  actions.hideAndResetCredentialForm();
  try {
    actions.redactPrivateCaches();
  } finally {
    try {
      actions.beginSessionTransition();
    } finally {
      actions.reloadAuthoritativeSession();
    }
  }
  return true;
}

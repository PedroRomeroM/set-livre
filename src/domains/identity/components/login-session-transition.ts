import { IdentityApiError } from "./identity-api";

export type AccountLoginReturnTarget = "/conta" | "/conta/seguranca";

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
  if (returnTo === "/conta") {
    return "/entrar?entrada=verificar&retorno=%2Fconta";
  }
  if (returnTo === "/conta/seguranca") {
    return "/entrar?entrada=verificar&retorno=%2Fconta%2Fseguranca";
  }
  return "/entrar?entrada=verificar";
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
  actions.beginSessionTransition();
  actions.redactPrivateCaches();
  actions.reloadAuthoritativeSession();
  return true;
}

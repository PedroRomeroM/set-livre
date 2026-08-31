import { IdentityApiError } from "./identity-api";

const accountLoginReturnTargets = [
  "/conta",
  "/conta/seguranca",
  "/dono",
  "/dono/recebimentos",
] as const;

export type AccountLoginReturnTarget = (typeof accountLoginReturnTargets)[number];

export function resolveAccountLoginReturnTarget(
  candidate: string | readonly string[] | undefined,
): AccountLoginReturnTarget | undefined {
  if (typeof candidate !== "string") return undefined;
  for (const target of accountLoginReturnTargets) {
    if (candidate === target) return target;
  }
  return undefined;
}

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
  actions.beginSessionTransition();
  try {
    actions.redactPrivateCaches();
  } finally {
    actions.reloadAuthoritativeSession();
  }
  return true;
}

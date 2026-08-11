"use client";

import { identityCallbackPayloadSchema } from "@set-livre/contracts";
import { Alert, Button, Stack } from "@set-livre/ui";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { completeIdentityCallback, IdentityApiError } from "./identity-api";
import styles from "./identity.module.css";

type CallbackPayload = Parameters<typeof completeIdentityCallback>[0];
type CallbackState = { status: "error"; error: unknown } | { status: "pending" };

function callbackPayloadFromAddress(): CallbackPayload {
  const address = new URL(window.location.href);
  const fragment = new URLSearchParams(address.hash.startsWith("#") ? address.hash.slice(1) : "");
  const tokenHash = fragment.get("token_hash");
  const type = fragment.get("type");
  const returnTo = fragment.get("returnTo");

  window.history.replaceState(window.history.state, "", address.pathname);

  const fragmentKeys = [...fragment.keys()];
  const hasExactFragmentShape =
    fragment.getAll("token_hash").length === 1 &&
    fragment.getAll("type").length === 1 &&
    fragment.getAll("returnTo").length <= 1 &&
    fragmentKeys.every((key) => ["returnTo", "token_hash", "type"].includes(key));

  const parsed = identityCallbackPayloadSchema.safeParse({
    ...(returnTo === null ? {} : { returnTo }),
    tokenHash: tokenHash ?? "",
    type: type ?? "",
  });
  if (address.search !== "" || !hasExactFragmentShape || !parsed.success) {
    throw new IdentityApiError(
      "CALLBACK_INVALID",
      "Este link é inválido ou está incompleto. Solicite uma nova mensagem.",
    );
  }
  return parsed.data.returnTo === undefined
    ? { tokenHash: parsed.data.tokenHash, type: parsed.data.type }
    : {
        returnTo: parsed.data.returnTo,
        tokenHash: parsed.data.tokenHash,
        type: parsed.data.type,
      };
}

function retryableCallbackError(error: unknown) {
  return (
    error instanceof IdentityApiError &&
    ["NETWORK_UNAVAILABLE", "REQUEST_TIMEOUT", "RESPONSE_INVALID", "SERVICE_UNAVAILABLE"].includes(
      error.code,
    )
  );
}

export function AuthCallbackPanel() {
  const callbackPayload = useRef<CallbackPayload>(undefined);
  const started = useRef(false);
  const [state, setState] = useState<CallbackState>({ status: "pending" });
  const runCallback = useCallback(() => {
    setState({ status: "pending" });
    void (async () => {
      try {
        callbackPayload.current ??= callbackPayloadFromAddress();
        const result = await completeIdentityCallback(callbackPayload.current);
        callbackPayload.current = undefined;
        window.location.replace(result.redirectTo);
      } catch (error) {
        if (!retryableCallbackError(error)) {
          callbackPayload.current = undefined;
        }
        setState({ error, status: "error" });
      }
    })();
  }, []);

  useEffect(() => {
    if (started.current) {
      return;
    }
    started.current = true;
    runCallback();
  }, [runCallback]);

  if (state.status === "error") {
    const message =
      state.error instanceof IdentityApiError
        ? state.error.message
        : "Não foi possível validar este link.";
    return (
      <Stack space={5}>
        <Alert title="Link não confirmado" variant="error">
          {message}
        </Alert>
        <p className={styles.supportingText}>
          Links expirados ou já utilizados não liberam o acesso nem o formulário de nova senha.
        </p>
        <div className={styles.actions}>
          {retryableCallbackError(state.error) ? (
            <Button onClick={runCallback} variant="secondary">
              Tentar novamente
            </Button>
          ) : null}
          <Link className={styles.textLink} href="/recuperar-senha">
            Solicitar recuperação de senha
          </Link>
          <Link className={styles.textLink} href="/entrar">
            Voltar ao login
          </Link>
        </div>
      </Stack>
    );
  }

  return (
    <Stack space={4}>
      <Alert title="Validando link">
        Aguarde enquanto confirmamos a autenticidade e a validade desta solicitação.
      </Alert>
      <p className={styles.statusText}>Você será redirecionado automaticamente.</p>
    </Stack>
  );
}

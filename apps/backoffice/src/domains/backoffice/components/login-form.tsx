"use client";

import type { BackofficeLoginPayload } from "@set-livre/contracts";
import { Alert, Button, Field, Input, Stack } from "@set-livre/ui";
import { PasswordInput } from "@set-livre/ui/password-input";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useRef } from "react";

import {
  BackofficeClientError,
  isAmbiguousBackofficeError,
  loginBackofficeClient,
} from "./backoffice-api";
import styles from "./backoffice.module.css";
import { notifyBackofficeSessionChanged } from "./session-events";
import { useBackofficeHydrated } from "./use-backoffice-hydrated";

export function BackofficeLoginForm({ signedOut }: Readonly<{ signedOut: boolean }>) {
  const isHydrated = useBackofficeHydrated();
  const formRef = useRef<HTMLFormElement>(null);
  const router = useRouter();
  const queryClient = useQueryClient();
  const pendingLogin = useRef<BackofficeLoginPayload>(undefined);
  const login = useMutation({
    mutationFn: () => {
      if (pendingLogin.current === undefined) {
        throw new Error("O login não possui credenciais efêmeras preparadas.");
      }
      return loginBackofficeClient(pendingLogin.current);
    },
    networkMode: "always",
    onError: (error) => {
      if (!isAmbiguousBackofficeError(error)) return;
      queryClient.clear();
      try {
        notifyBackofficeSessionChanged();
      } finally {
        router.replace("/");
        router.refresh();
      }
    },
    onSettled: () => {
      pendingLogin.current = undefined;
      formRef.current?.reset();
    },
    onSuccess: (session) => {
      if (!session.authenticated) return;
      queryClient.clear();
      notifyBackofficeSessionChanged();
      router.replace("/");
      router.refresh();
    },
  });
  const clientError = login.error instanceof BackofficeClientError ? login.error : undefined;
  const controlsDisabled = !isHydrated || login.isPending;

  return (
    <Stack space={4}>
      {isHydrated ? null : (
        <p className={styles.hydrationStatus} role="status">
          Preparando o acesso seguro…
        </p>
      )}
      <noscript>
        <Alert title="JavaScript necessário" variant="error">
          Habilite o JavaScript neste navegador e recarregue a página para acessar o backoffice.
        </Alert>
      </noscript>
      <form
        aria-busy={!isHydrated || login.isPending}
        inert={!isHydrated}
        method="post"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          pendingLogin.current = {
            email: String(data.get("email") ?? ""),
            password: String(data.get("password") ?? ""),
          };
          login.mutate();
        }}
        ref={formRef}
      >
        <fieldset className={styles.secureFormBoundary} disabled={!isHydrated}>
          <Stack space={4}>
            {signedOut ? <Alert>Sessão encerrada com segurança.</Alert> : null}
            {login.isError ? (
              <Alert title="Entrada não concluída" variant="error">
                {clientError?.message ?? "Não foi possível entrar agora."}
              </Alert>
            ) : null}
            <Field
              {...(clientError?.fieldErrors?.email === undefined
                ? {}
                : { error: clientError.fieldErrors.email })}
              label="E-mail"
              required
            >
              <Input
                autoComplete="username"
                disabled={controlsDisabled}
                inputMode="email"
                maxLength={254}
                name="email"
                spellCheck={false}
                type="email"
              />
            </Field>
            <Field
              {...(clientError?.fieldErrors?.password === undefined
                ? {}
                : { error: clientError.fieldErrors.password })}
              label="Senha"
              required
            >
              <PasswordInput
                autoComplete="current-password"
                disabled={controlsDisabled}
                maxLength={128}
                name="password"
              />
            </Field>
            <Button
              disabled={controlsDisabled}
              loading={login.isPending}
              loadingLabel="Validando acesso"
              type="submit"
            >
              Entrar no backoffice
            </Button>
          </Stack>
        </fieldset>
      </form>
    </Stack>
  );
}

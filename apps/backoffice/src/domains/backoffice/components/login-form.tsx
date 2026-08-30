"use client";

import type { BackofficeLoginPayload } from "@set-livre/contracts";
import { Alert, Button, Field, Input, PasswordInput, Stack } from "@set-livre/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useRef } from "react";

import {
  BackofficeClientError,
  isAmbiguousBackofficeError,
  loginBackofficeClient,
} from "./backoffice-api";

export function BackofficeLoginForm({ signedOut }: Readonly<{ signedOut: boolean }>) {
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
      router.replace("/");
      router.refresh();
    },
    onSettled: () => {
      pendingLogin.current = undefined;
      formRef.current?.reset();
    },
    onSuccess: (session) => {
      if (!session.authenticated) return;
      queryClient.clear();
      router.replace("/");
      router.refresh();
    },
  });
  const clientError = login.error instanceof BackofficeClientError ? login.error : undefined;

  return (
    <form
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
          <Input autoComplete="username" inputMode="email" name="email" type="email" />
        </Field>
        <Field
          {...(clientError?.fieldErrors?.password === undefined
            ? {}
            : { error: clientError.fieldErrors.password })}
          label="Senha"
          required
        >
          <PasswordInput autoComplete="current-password" name="password" />
        </Field>
        <Button loading={login.isPending} loadingLabel="Validando acesso" type="submit">
          Entrar no backoffice
        </Button>
      </Stack>
    </form>
  );
}

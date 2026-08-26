"use client";

import {
  identityRecoveryRequestPayloadSchema,
  identityRecoveryUpdatePayloadSchema,
  type IdentityRecoverySessionScope,
} from "@set-livre/contracts";
import { Alert, Button, Field, Input, PasswordInput, Stack } from "@set-livre/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { fieldErrorProp, firstFieldErrors, formValue, type FieldErrors } from "./form-utils";
import {
  IdentityApiError,
  readPasswordRecoveryStatus,
  requestPasswordRecovery,
  updateRecoveredPassword,
} from "./identity-api";
import {
  IdentityRecoveryScopeChangedError,
  identityQueryKeys,
  identityRecoveryQueryScope,
  identityRecoveryStatusCanAuthorize,
  identityRecoveryStatusForScope,
} from "./identity-query-keys";
import styles from "./identity.module.css";
import { passwordRequirements } from "./password-requirements";
import {
  reconcileRecoveryUpdateFeedback,
  recoveryUpdateFeedbackFromError,
  type RecoveryUpdateFeedback,
} from "./recovery-update-feedback";

function RecoveryRequestForm() {
  const pendingRecoveryEmail = useRef<string | undefined>(undefined);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const mutation = useMutation({
    mutationFn: () => {
      const email = pendingRecoveryEmail.current;
      if (email === undefined) {
        throw new Error("A solicitação de recovery não possui um e-mail validado.");
      }
      return requestPasswordRecovery(email);
    },
    networkMode: "always",
    onSettled: () => {
      pendingRecoveryEmail.current = undefined;
    },
  });

  function submitRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    mutation.reset();
    setFieldErrors({});
    const form = new FormData(event.currentTarget);
    const parsed = identityRecoveryRequestPayloadSchema.safeParse({
      email: formValue(form, "email"),
    });
    if (!parsed.success) {
      setFieldErrors(firstFieldErrors(parsed.error));
      return;
    }
    pendingRecoveryEmail.current = parsed.data.email;
    mutation.mutate();
  }

  if (mutation.isSuccess) {
    return (
      <Stack space={5}>
        <Alert title="Confira seu e-mail">
          Se existir uma conta para o endereço informado, enviaremos as instruções de recuperação.
        </Alert>
        <p className={styles.supportingText}>
          Aguarde alguns minutos e confira também a pasta de spam. A resposta é a mesma para todos
          os endereços.
        </p>
        <div className={styles.actions}>
          <Button onClick={() => mutation.reset()} variant="secondary">
            Informar outro e-mail
          </Button>
          <Link className={styles.textLink} href="/entrar">
            Voltar ao login
          </Link>
        </div>
      </Stack>
    );
  }

  const apiError = mutation.error instanceof IdentityApiError ? mutation.error : undefined;
  const visibleFieldErrors = apiError?.fieldErrors ?? fieldErrors;

  return (
    <form className={styles.form} noValidate onSubmit={submitRequest}>
      <p className={styles.formIntro}>
        Informe seu e-mail. Por segurança, não confirmamos se ele está cadastrado.
      </p>

      {apiError === undefined ? null : (
        <Alert title="Não foi possível solicitar agora" variant="error">
          {apiError.message}
        </Alert>
      )}

      <Field {...fieldErrorProp(visibleFieldErrors, "email")} label="E-mail" required>
        <Input
          autoComplete="email"
          disabled={mutation.isPending}
          inputMode="email"
          maxLength={254}
          name="email"
          spellCheck={false}
          type="email"
        />
      </Field>

      <div className={styles.actions}>
        <Button loading={mutation.isPending} loadingLabel="Enviando instruções" type="submit">
          Enviar instruções
        </Button>
        <Link className={styles.textLink} href="/entrar">
          Voltar ao login
        </Link>
      </div>
    </form>
  );
}

function RecoveryUpdateSuccess() {
  return (
    <Stack space={5}>
      <Alert title="Senha atualizada">
        Sua nova senha foi salva. Use-a para entrar novamente com segurança.
      </Alert>
      <Link className={styles.textLink} href="/entrar">
        Entrar com a nova senha
      </Link>
    </Stack>
  );
}

function NewPasswordForm({
  onCompleted,
  onFeedbackChange,
  recoveryUpdateFeedback,
  recoverySessionScope,
}: {
  onCompleted: () => void;
  onFeedbackChange: (feedback: RecoveryUpdateFeedback | undefined) => void;
  recoveryUpdateFeedback: RecoveryUpdateFeedback | undefined;
  recoverySessionScope: IdentityRecoverySessionScope;
}) {
  const queryClient = useQueryClient();
  const pendingRecoveryPassword = useRef<{ confirmPassword: string; password: string } | undefined>(
    undefined,
  );
  const [passwordRequirementState, setPasswordRequirementState] = useState(() =>
    passwordRequirements(""),
  );
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const mutation = useMutation({
    mutationFn: () => {
      const value = pendingRecoveryPassword.current;
      if (value === undefined) {
        throw new Error("A atualização de recovery não possui senhas validadas.");
      }
      return updateRecoveredPassword(value.password, value.confirmPassword);
    },
    networkMode: "always",
    onError: (error) => {
      onFeedbackChange(recoveryUpdateFeedbackFromError(error, recoverySessionScope));
    },
    onSuccess: async () => {
      onFeedbackChange(undefined);
      await queryClient.cancelQueries({
        exact: true,
        queryKey: identityQueryKeys.recoveryStatus(recoverySessionScope),
      });
      queryClient.setQueryData(identityQueryKeys.recoveryStatus(recoverySessionScope), {
        allowed: false,
        scope: recoverySessionScope,
      });
      queryClient.removeQueries({ queryKey: identityQueryKeys.sessions });
      onCompleted();
    },
    onSettled: async (_data, error) => {
      pendingRecoveryPassword.current = undefined;
      if (error !== null) {
        await queryClient.invalidateQueries({
          exact: true,
          queryKey: identityQueryKeys.recoveryStatus(recoverySessionScope),
          refetchType: "active",
        });
      }
    },
  });

  function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onFeedbackChange(undefined);
    mutation.reset();
    setFieldErrors({});
    const form = new FormData(event.currentTarget);
    const parsed = identityRecoveryUpdatePayloadSchema.safeParse({
      confirmPassword: formValue(form, "confirmPassword"),
      password: formValue(form, "password"),
    });
    if (!parsed.success) {
      setFieldErrors(firstFieldErrors(parsed.error));
      return;
    }
    pendingRecoveryPassword.current = parsed.data;
    mutation.mutate();
  }

  const visibleRecoveryUpdateFeedback =
    recoveryUpdateFeedback?.scope === recoverySessionScope ? recoveryUpdateFeedback : undefined;
  const visibleFieldErrors = visibleRecoveryUpdateFeedback?.fieldErrors ?? fieldErrors;

  return (
    <form
      aria-busy={mutation.isPending}
      className={styles.form}
      noValidate
      onSubmit={submitPassword}
    >
      <p className={styles.formIntro}>Crie uma senha nova para concluir a recuperação.</p>

      {visibleRecoveryUpdateFeedback === undefined ? null : (
        <Alert title="Não foi possível atualizar a senha" variant="error">
          {visibleRecoveryUpdateFeedback.message}
        </Alert>
      )}

      <Field {...fieldErrorProp(visibleFieldErrors, "password")} label="Nova senha" required>
        <PasswordInput
          autoComplete="new-password"
          disabled={mutation.isPending}
          maxLength={128}
          name="password"
          onChange={(event) =>
            setPasswordRequirementState(passwordRequirements(event.currentTarget.value))
          }
          requirements={passwordRequirementState}
        />
      </Field>

      <Field
        {...fieldErrorProp(visibleFieldErrors, "confirmPassword")}
        label="Confirme a nova senha"
        required
      >
        <PasswordInput
          autoComplete="new-password"
          disabled={mutation.isPending}
          maxLength={128}
          name="confirmPassword"
        />
      </Field>

      <Button loading={mutation.isPending} loadingLabel="Atualizando senha" type="submit">
        Salvar nova senha
      </Button>
    </form>
  );
}

export function RecoveryFlow({
  initialSessionScope,
}: {
  initialSessionScope: IdentityRecoverySessionScope;
}) {
  const queryClient = useQueryClient();
  const [recoveryCompleted, setRecoveryCompleted] = useState(false);
  const [recoveryUpdateFeedback, setRecoveryUpdateFeedback] = useState<
    RecoveryUpdateFeedback | undefined
  >(undefined);
  const [scopeTransitionStarted, setScopeTransitionStarted] = useState(false);
  const scopeTransitionGuard = useRef(false);
  const recoveryStatusQueryKey = useMemo(
    () => identityQueryKeys.recoveryStatus(initialSessionScope),
    [initialSessionScope],
  );
  const statusQuery = useQuery({
    queryFn: async () =>
      identityRecoveryStatusForScope(await readPasswordRecoveryStatus(), initialSessionScope),
    queryKey: recoveryStatusQueryKey,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    retry: false,
    staleTime: 0,
  });
  const scopeChanged = statusQuery.error instanceof IdentityRecoveryScopeChangedError;
  const visibleRecoveryUpdateFeedback = reconcileRecoveryUpdateFeedback(
    recoveryUpdateFeedback,
    statusQuery.data,
    initialSessionScope,
    statusQuery.fetchStatus,
  );

  useEffect(() => {
    queryClient.removeQueries({
      predicate: (query) => identityRecoveryQueryScope(query.queryKey) !== initialSessionScope,
      queryKey: identityQueryKeys.recoveryStatuses,
    });
  }, [initialSessionScope, queryClient]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) {
        setRecoveryUpdateFeedback((feedback) =>
          reconcileRecoveryUpdateFeedback(
            feedback,
            statusQuery.data,
            initialSessionScope,
            statusQuery.fetchStatus,
          ),
        );
      }
    });
    return () => {
      active = false;
    };
  }, [initialSessionScope, statusQuery.data, statusQuery.fetchStatus]);

  useEffect(() => {
    if (!scopeChanged || scopeTransitionGuard.current) {
      return;
    }
    scopeTransitionGuard.current = true;
    queueMicrotask(() => {
      setScopeTransitionStarted(true);
      setRecoveryUpdateFeedback(undefined);
      queryClient.removeQueries({ queryKey: identityQueryKeys.recoveryStatuses });
      queryClient.removeQueries({ queryKey: identityQueryKeys.sessions });
      window.location.replace("/recuperar-senha");
    });
  }, [queryClient, scopeChanged]);

  if (recoveryCompleted) {
    return <RecoveryUpdateSuccess />;
  }

  if (scopeTransitionStarted || statusQuery.isPending || scopeChanged) {
    return <Alert>Verificando se o link de recuperação é válido…</Alert>;
  }

  if (statusQuery.isError) {
    const message =
      statusQuery.error instanceof IdentityApiError
        ? statusQuery.error.message
        : "Não foi possível verificar o link agora.";
    return (
      <Stack space={4}>
        <Alert title="Verificação indisponível" variant="error">
          {message}
        </Alert>
        <div className={styles.actions}>
          <Button
            loading={statusQuery.isFetching}
            loadingLabel="Verificando link"
            onClick={() => {
              void statusQuery.refetch();
            }}
            variant="secondary"
          >
            Tentar novamente
          </Button>
          <Link className={styles.textLink} href="/entrar">
            Voltar ao login
          </Link>
        </div>
      </Stack>
    );
  }

  return identityRecoveryStatusCanAuthorize(
    statusQuery.data,
    initialSessionScope,
    statusQuery.fetchStatus,
  ) ? (
    <NewPasswordForm
      onCompleted={() => setRecoveryCompleted(true)}
      onFeedbackChange={setRecoveryUpdateFeedback}
      recoveryUpdateFeedback={visibleRecoveryUpdateFeedback}
      recoverySessionScope={initialSessionScope}
    />
  ) : statusQuery.fetchStatus !== "idle" ? (
    <Alert>Verificando se o link de recuperação é válido…</Alert>
  ) : (
    <RecoveryRequestForm />
  );
}

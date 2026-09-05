"use client";

import {
  identityRegistrationFormSchema,
  type CurrentLegalDocuments,
  type IdentityRegistrationPayload,
} from "@set-livre/contracts";
import { Alert, Button, Checkbox, ChoiceGroup, Field, Input, Stack } from "@set-livre/ui";
import { PasswordInput } from "@set-livre/ui/password-input";
import { useMutation } from "@tanstack/react-query";
import Link from "next/link";
import { useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import type { z } from "zod";

import {
  fieldError,
  fieldErrorProp,
  firstFieldErrors,
  formValue,
  type FieldErrors,
} from "./form-utils";
import { IdentityApiError, registerIdentity } from "./identity-api";
import styles from "./identity.module.css";
import { passwordRequirements } from "./password-requirements";

type RegistrationFormProps = {
  legalDocuments: CurrentLegalDocuments;
};

function subscribeToHydration() {
  return () => undefined;
}

function readHydratedClientSnapshot() {
  return true;
}

function readHydratedServerSnapshot() {
  return false;
}

function registrationPayload(input: z.infer<typeof identityRegistrationFormSchema>) {
  return {
    acceptPrivacy: input.acceptPrivacy,
    acceptTerms: input.acceptTerms,
    email: input.email,
    password: input.password,
    personType: input.personType,
    privacyVersionId: input.privacyVersionId,
    termsVersionId: input.termsVersionId,
  } satisfies IdentityRegistrationPayload;
}

export function RegistrationForm({ legalDocuments }: RegistrationFormProps) {
  const isHydrated = useSyncExternalStore(
    subscribeToHydration,
    readHydratedClientSnapshot,
    readHydratedServerSnapshot,
  );
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [passwordRequirementState, setPasswordRequirementState] = useState(() =>
    passwordRequirements(""),
  );
  const pendingRegistration = useRef<IdentityRegistrationPayload>(undefined);
  const mutation = useMutation({
    mutationFn: () => {
      if (pendingRegistration.current === undefined) {
        throw new Error("O cadastro não possui payload efêmero.");
      }
      return registerIdentity(pendingRegistration.current);
    },
    networkMode: "always",
    onSettled: () => {
      pendingRegistration.current = undefined;
    },
    onSuccess: () => {
      setPasswordRequirementState(passwordRequirements(""));
    },
  });

  function submitRegistration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    mutation.reset();
    setFieldErrors({});

    const form = new FormData(event.currentTarget);
    const parsed = identityRegistrationFormSchema.safeParse({
      acceptPrivacy: form.get("acceptPrivacy") === "on",
      acceptTerms: form.get("acceptTerms") === "on",
      confirmPassword: formValue(form, "confirmPassword"),
      email: formValue(form, "email"),
      password: formValue(form, "password"),
      personType: formValue(form, "personType"),
      privacyVersionId: legalDocuments.privacy.id,
      termsVersionId: legalDocuments.terms.id,
    });
    if (!parsed.success) {
      setFieldErrors(firstFieldErrors(parsed.error));
      return;
    }

    pendingRegistration.current = registrationPayload(parsed.data);
    mutation.mutate();
  }

  if (mutation.isSuccess) {
    return (
      <Stack space={5}>
        <Alert title="Confira seu e-mail">
          Enviamos as instruções de confirmação. Abra somente a mensagem recebida por você e conclua
          a ativação da conta.
        </Alert>
        <p className={styles.supportingText}>
          Se a mensagem não aparecer, confira a pasta de spam antes de iniciar outro cadastro.
        </p>
        <div className={styles.actions}>
          <Link className={styles.textLink} href="/entrar">
            Ir para o login
          </Link>
          <Button onClick={() => mutation.reset()} variant="secondary">
            Cadastrar outro e-mail
          </Button>
        </div>
      </Stack>
    );
  }

  const apiError = mutation.error instanceof IdentityApiError ? mutation.error : undefined;
  const visibleFieldErrors = apiError?.fieldErrors ?? fieldErrors;
  const termsError = fieldError(visibleFieldErrors, "acceptTerms");
  const privacyError = fieldError(visibleFieldErrors, "acceptPrivacy");
  const controlsDisabled = !isHydrated || mutation.isPending;

  return (
    <Stack space={5}>
      {isHydrated ? null : (
        <p className={styles.statusText} role="status">
          Preparando o formulário seguro…
        </p>
      )}

      <form
        aria-busy={!isHydrated || mutation.isPending}
        className={styles.form}
        inert={!isHydrated}
        method="post"
        noValidate
        onSubmit={submitRegistration}
      >
        <fieldset className={styles.hydrationBoundary} disabled={!isHydrated}>
          <p className={styles.formIntro}>
            Todos os campos são obrigatórios. O perfil detalhado será concluído em uma etapa
            própria.
          </p>

          {apiError === undefined ? null : (
            <Alert title="Não foi possível criar a conta" variant="error">
              {apiError.message}
            </Alert>
          )}

          <ChoiceGroup
            {...fieldErrorProp(visibleFieldErrors, "personType")}
            defaultValue="individual"
            disabled={controlsDisabled}
            legend="Tipo de cadastro"
            name="personType"
            required
          />

          <Field {...fieldErrorProp(visibleFieldErrors, "email")} label="E-mail" required>
            <Input
              autoComplete="email"
              disabled={controlsDisabled}
              inputMode="email"
              maxLength={254}
              name="email"
              spellCheck={false}
              type="email"
            />
          </Field>

          <Field {...fieldErrorProp(visibleFieldErrors, "password")} label="Senha" required>
            <PasswordInput
              autoComplete="new-password"
              disabled={controlsDisabled}
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
            label="Confirme a senha"
            required
          >
            <PasswordInput
              autoComplete="new-password"
              disabled={controlsDisabled}
              maxLength={128}
              name="confirmPassword"
            />
          </Field>

          <div className={styles.legalChoice}>
            <Checkbox
              {...(termsError === undefined
                ? {}
                : { "aria-describedby": "acceptTerms-error", "aria-invalid": true })}
              disabled={controlsDisabled}
              id="acceptTerms"
              label={`Li e aceito os Termos de Uso, versão ${legalDocuments.terms.version}.`}
              name="acceptTerms"
              required
            />
            {termsError === undefined ? null : (
              <Alert id="acceptTerms-error" variant="error">
                {termsError}
              </Alert>
            )}
            <Link className={styles.legalLink} href="/termos" rel="noopener" target="_blank">
              Ler os Termos de Uso (abre em nova guia)
            </Link>
          </div>

          <div className={styles.legalChoice}>
            <Checkbox
              {...(privacyError === undefined
                ? {}
                : { "aria-describedby": "acceptPrivacy-error", "aria-invalid": true })}
              disabled={controlsDisabled}
              id="acceptPrivacy"
              label={`Li e aceito a Política de Privacidade, versão ${legalDocuments.privacy.version}.`}
              name="acceptPrivacy"
              required
            />
            {privacyError === undefined ? null : (
              <Alert id="acceptPrivacy-error" variant="error">
                {privacyError}
              </Alert>
            )}
            <Link className={styles.legalLink} href="/privacidade" rel="noopener" target="_blank">
              Ler a Política de Privacidade (abre em nova guia)
            </Link>
          </div>

          <div className={styles.actions}>
            <Button
              disabled={controlsDisabled}
              loading={mutation.isPending}
              loadingLabel="Criando conta"
              type="submit"
            >
              Criar conta
            </Button>
            <Link className={styles.textLink} href="/entrar">
              Já tenho uma conta
            </Link>
          </div>
        </fieldset>
      </form>
    </Stack>
  );
}

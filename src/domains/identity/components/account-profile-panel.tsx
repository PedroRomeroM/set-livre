"use client";

import {
  cnpjSchema,
  cpfSchema,
  formatBrazilianPhoneForDisplay,
  formatCnpjForDisplay,
  formatCpfForDisplay,
  profileAppearanceUpdatePayloadSchema,
  profileCompletePayloadSchema,
  profileIdentityUpdatePayloadSchema,
  type MyProfileResult,
  type PersonType,
  type ProfileCompletePayload,
  type ProfileSnapshot,
  type ProfileUpdatePayload,
} from "@set-livre/contracts";
import { Alert, Button, ChoiceGroup, Field, Input, Select, Stack } from "@set-livre/ui";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { flushSync } from "react-dom";

import { fieldErrorProp, firstFieldErrors, formValue, type FieldErrors } from "./form-utils";
import {
  AccountProfileScopeChangedError,
  accountProfileCanRender,
  accountProfileMatchesScope,
  accountQueryKeys,
  clearIdentityAndAccountQueryCache,
  publishNewestAccountProfileMutationResult,
  readNewestAccountProfileResult,
  seedAuthoritativeAccountProfile,
} from "./account-query-keys";
import styles from "./account.module.css";
import {
  ProfileApiError,
  completeOwnProfile,
  readOwnProfile,
  updateOwnProfile,
} from "./profile-api";
import {
  beginProfileScopeTransitionOnce,
  cleanupProfileMutationAttemptOnce,
  isProfileSessionChangedError,
  profileMutationResultCanPublish,
  profileMutationNetworkMode,
  requireProfileMutationAttempt,
  type ProfileMutationAttempt,
  type ProfileScopeTransitionGuard,
} from "./profile-mutation";
import { applyVisualPreference, visualPreferenceOptions } from "./visual-preference";

type AccountProfilePanelProps = {
  initialProfile: MyProfileResult;
  userId: string;
};

type SaveProfile = (profile: MyProfileResult, message: string) => void;
type RefreshProfile = () => Promise<unknown>;

function personTypeLabel(personType: PersonType) {
  return personType === "individual" ? "Pessoa física" : "Pessoa jurídica";
}

function applyTaxMask(event: FormEvent<HTMLInputElement>, personType: PersonType) {
  event.currentTarget.value =
    personType === "individual"
      ? formatCpfForDisplay(event.currentTarget.value)
      : formatCnpjForDisplay(event.currentTarget.value);
}

function applyPhoneMask(event: FormEvent<HTMLInputElement>) {
  event.currentTarget.value = formatBrazilianPhoneForDisplay(event.currentTarget.value);
}

function namedInput(form: HTMLFormElement | null, name: string) {
  const control = form?.elements.namedItem(name);
  return control instanceof HTMLInputElement ? control : undefined;
}

function clearSensitiveInputs(form: HTMLFormElement | null) {
  for (const name of ["taxId", "additionalDocument"]) {
    const input = namedInput(form, name);
    if (input !== undefined) {
      input.value = "";
    }
  }
}

function clearSensitiveInput(form: HTMLFormElement | null, name: string) {
  const input = namedInput(form, name);
  if (input !== undefined) input.value = "";
}

function nestedProfileFieldErrors(errors: FieldErrors): FieldErrors {
  return {
    ...errors,
    ...(errors.documentChange === undefined ? {} : { additionalDocument: errors.documentChange }),
    ...(errors.taxIdChange === undefined ? {} : { taxId: errors.taxIdChange }),
  };
}

function ProfileMutationAlert({
  error,
  sensitive = false,
}: {
  error: ProfileApiError | undefined;
  sensitive?: boolean;
}) {
  if (error === undefined) return null;
  const conflict = error.code === "CONFLICT";
  return (
    <Alert
      title={conflict ? "Este perfil mudou em outro lugar" : "Não foi possível salvar"}
      variant="error"
    >
      {error.message}
      {sensitive
        ? " Por segurança, valores de documentos informados nesta tentativa foram apagados."
        : null}
    </Alert>
  );
}

function ConflictRecoveryAction({
  error,
  onRefresh,
  reset,
}: {
  error: ProfileApiError | undefined;
  onRefresh: RefreshProfile;
  reset: () => void;
}) {
  if (error?.code !== "CONFLICT") return null;
  return (
    <Button
      onClick={() => {
        reset();
        void onRefresh();
      }}
      variant="secondary"
    >
      Carregar versão atual
    </Button>
  );
}

function CompletionForm({
  expectedScope,
  onRefresh,
  onSave,
  onSessionChanged,
  profile,
  scopeTransitionGuard,
}: {
  expectedScope: string;
  onRefresh: RefreshProfile;
  onSave: SaveProfile;
  onSessionChanged: () => void;
  profile: Extract<ProfileSnapshot, { completed: false }>;
  scopeTransitionGuard: ProfileScopeTransitionGuard;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const pendingProfile = useRef<ProfileMutationAttempt<ProfileCompletePayload>>(undefined);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [personType, setPersonType] = useState<PersonType>(profile.personType);
  function cleanupAttemptOnce() {
    cleanupProfileMutationAttemptOnce(
      pendingProfile.current,
      () => {
        pendingProfile.current = undefined;
      },
      () => {
        clearSensitiveInputs(formRef.current);
      },
    );
  }
  const mutation = useMutation({
    mutationFn: () => {
      const attempt = requireProfileMutationAttempt(
        pendingProfile.current,
        "A conclusão do perfil não possui payload efêmero.",
      );
      return completeOwnProfile(attempt.expectedScope, attempt.payload);
    },
    networkMode: profileMutationNetworkMode,
    onError: (error) => {
      cleanupAttemptOnce();
      if (!profileMutationResultCanPublish(scopeTransitionGuard)) return;
      if (isProfileSessionChangedError(error)) onSessionChanged();
    },
    onSuccess: (result) => {
      cleanupAttemptOnce();
      if (!profileMutationResultCanPublish(scopeTransitionGuard)) return;
      onSave(result, "Perfil concluído com segurança.");
    },
  });

  function submitProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    mutation.reset();
    setFieldErrors({});
    const form = new FormData(event.currentTarget);
    const additionalDocument = formValue(form, "additionalDocument").trim();
    const parsed = profileCompletePayloadSchema.safeParse({
      additionalDocument: additionalDocument === "" ? null : additionalDocument,
      expectedProfileVersion: profile.profileVersion,
      name: formValue(form, "name"),
      personType,
      phone: formValue(form, "phone"),
      taxId: formValue(form, "taxId"),
    });
    if (!parsed.success) {
      setFieldErrors(firstFieldErrors(parsed.error));
      return;
    }
    pendingProfile.current = { expectedScope, payload: parsed.data };
    mutation.mutate();
  }

  const apiError = mutation.error instanceof ProfileApiError ? mutation.error : undefined;
  const visibleFieldErrors = apiError?.fieldErrors ?? fieldErrors;

  return (
    <section className={styles.section} aria-labelledby="complete-profile-title">
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle} id="complete-profile-title">
          Complete seu perfil
        </h2>
        <p className={styles.sectionDescription}>
          Esses dados identificam o titular e serão revalidados antes de qualquer pagamento.
        </p>
      </div>
      <form className={styles.form} noValidate onSubmit={submitProfile} ref={formRef}>
        <ProfileMutationAlert error={apiError} sensitive />
        <ChoiceGroup
          disabled={mutation.isPending}
          legend="Tipo de pessoa"
          name="personType"
          onValueChange={(value) => {
            setPersonType(value);
            const taxId = namedInput(formRef.current, "taxId");
            if (taxId !== undefined) taxId.value = "";
          }}
          required
          value={personType}
        />
        <div className={styles.formGrid}>
          <Field
            {...fieldErrorProp(visibleFieldErrors, "name")}
            label={personType === "individual" ? "Nome completo" : "Nome empresarial"}
            required
          >
            <Input
              autoComplete={personType === "individual" ? "name" : "organization"}
              disabled={mutation.isPending}
              maxLength={160}
              name="name"
            />
          </Field>
          <Field {...fieldErrorProp(visibleFieldErrors, "phone")} label="Telefone" required>
            <Input
              autoComplete="tel"
              disabled={mutation.isPending}
              inputMode="tel"
              name="phone"
              onInput={applyPhoneMask}
              placeholder="(41) 99999-1234"
              type="tel"
            />
          </Field>
          <Field
            {...fieldErrorProp(visibleFieldErrors, "taxId")}
            description={
              personType === "individual"
                ? "Use os 11 dígitos do CPF."
                : "O CNPJ aceita letras e números nas 12 primeiras posições; os 2 dígitos finais são numéricos."
            }
            label={personType === "individual" ? "CPF" : "CNPJ"}
            required
          >
            <Input
              autoCapitalize="characters"
              autoComplete="off"
              disabled={mutation.isPending}
              inputMode={personType === "individual" ? "numeric" : "text"}
              name="taxId"
              onInput={(event) => applyTaxMask(event, personType)}
              spellCheck={false}
            />
          </Field>
          <Field
            {...fieldErrorProp(visibleFieldErrors, "additionalDocument")}
            description="Opcional. Texto de 3 a 40 caracteres; não representa verificação documental."
            label="Documento adicional"
          >
            <Input
              autoCapitalize="characters"
              autoComplete="off"
              disabled={mutation.isPending}
              maxLength={40}
              name="additionalDocument"
              spellCheck={false}
            />
          </Field>
        </div>
        <div className={styles.privacyNote}>
          <p className={styles.privacyText}>
            CPF, CNPJ e documento adicional são enviados somente ao salvar. Depois disso, esta tela
            recebe apenas versões mascaradas.
          </p>
        </div>
        <div className={styles.actions}>
          <Button loading={mutation.isPending} loadingLabel="Salvando perfil" type="submit">
            Concluir perfil
          </Button>
          <ConflictRecoveryAction
            error={apiError}
            onRefresh={onRefresh}
            reset={() => mutation.reset()}
          />
        </div>
      </form>
    </section>
  );
}

function CompletedProfileSummary({
  profile,
}: {
  profile: Extract<ProfileSnapshot, { completed: true }>;
}) {
  return (
    <div className={styles.summary} aria-label="Resumo do perfil salvo">
      <div className={styles.summaryItem}>
        <p className={styles.summaryLabel}>Tipo de pessoa</p>
        <p className={styles.summaryValue}>{personTypeLabel(profile.personType)}</p>
      </div>
      <div className={styles.summaryItem}>
        <p className={styles.summaryLabel}>Nome</p>
        <p className={styles.summaryValue}>{profile.name}</p>
      </div>
      <div className={styles.summaryItem}>
        <p className={styles.summaryLabel}>Telefone</p>
        <p className={styles.summaryValue}>{formatBrazilianPhoneForDisplay(profile.phone)}</p>
      </div>
      <div className={styles.summaryItem}>
        <p className={styles.summaryLabel}>
          {profile.personType === "individual" ? "CPF" : "CNPJ"}
        </p>
        <p className={`${styles.summaryValue} ${styles.maskedValue}`}>{profile.taxIdMasked}</p>
      </div>
      <div className={styles.summaryItem}>
        <p className={styles.summaryLabel}>Documento adicional</p>
        <p className={`${styles.summaryValue} ${styles.maskedValue}`}>
          {profile.additionalDocumentMasked ?? "Não informado"}
        </p>
      </div>
    </div>
  );
}

function IdentityUpdateForm({
  expectedScope,
  onRefresh,
  onSave,
  onSessionChanged,
  profile,
  scopeTransitionGuard,
}: {
  expectedScope: string;
  onRefresh: RefreshProfile;
  onSave: SaveProfile;
  onSessionChanged: () => void;
  profile: Extract<ProfileSnapshot, { completed: true }>;
  scopeTransitionGuard: ProfileScopeTransitionGuard;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const pendingUpdate = useRef<ProfileMutationAttempt<ProfileUpdatePayload>>(undefined);
  const [documentAction, setDocumentAction] = useState<"clear" | "keep" | "replace">("keep");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [taxIdAction, setTaxIdAction] = useState<"keep" | "replace">("keep");
  function cleanupAttemptOnce() {
    cleanupProfileMutationAttemptOnce(
      pendingUpdate.current,
      () => {
        pendingUpdate.current = undefined;
      },
      () => {
        clearSensitiveInputs(formRef.current);
      },
    );
  }
  const mutation = useMutation({
    mutationFn: () => {
      const attempt = requireProfileMutationAttempt(
        pendingUpdate.current,
        "A atualização do perfil não possui payload efêmero.",
      );
      return updateOwnProfile(attempt.expectedScope, attempt.payload);
    },
    networkMode: profileMutationNetworkMode,
    onError: (error) => {
      cleanupAttemptOnce();
      if (!profileMutationResultCanPublish(scopeTransitionGuard)) return;
      if (isProfileSessionChangedError(error)) onSessionChanged();
    },
    onSuccess: (result) => {
      cleanupAttemptOnce();
      if (!profileMutationResultCanPublish(scopeTransitionGuard)) return;
      setDocumentAction("keep");
      setTaxIdAction("keep");
      onSave(result, "Dados do perfil atualizados.");
    },
  });

  function submitUpdate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    mutation.reset();
    setFieldErrors({});
    const form = new FormData(event.currentTarget);
    let taxIdChange: { action: "keep" } | { action: "replace"; value: string } = {
      action: "keep",
    };
    if (taxIdAction === "replace") {
      const parsedTaxId = (profile.personType === "individual" ? cpfSchema : cnpjSchema).safeParse(
        formValue(form, "taxId"),
      );
      if (!parsedTaxId.success) {
        setFieldErrors({ taxId: parsedTaxId.error.issues[0]?.message ?? "Revise o documento." });
        return;
      }
      taxIdChange = { action: "replace", value: parsedTaxId.data };
    }
    const documentChange =
      documentAction === "replace"
        ? { action: "replace" as const, value: formValue(form, "additionalDocument") }
        : { action: documentAction };
    const parsed = profileIdentityUpdatePayloadSchema.safeParse({
      documentChange,
      expectedProfileVersion: profile.profileVersion,
      name: formValue(form, "name"),
      phone: formValue(form, "phone"),
      section: "identity",
      taxIdChange,
    });
    if (!parsed.success) {
      setFieldErrors(nestedProfileFieldErrors(firstFieldErrors(parsed.error)));
      return;
    }
    pendingUpdate.current = { expectedScope, payload: parsed.data };
    mutation.mutate();
  }

  const apiError = mutation.error instanceof ProfileApiError ? mutation.error : undefined;
  const visibleFieldErrors = nestedProfileFieldErrors(apiError?.fieldErrors ?? fieldErrors);

  return (
    <section className={styles.section} aria-labelledby="identity-profile-title">
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle} id="identity-profile-title">
          Dados do perfil
        </h2>
        <p className={styles.sectionDescription}>
          O tipo {personTypeLabel(profile.personType).toLowerCase()} fica fixo depois da conclusão.
          Substituições documentais são explícitas e o valor salvo volta apenas mascarado.
        </p>
      </div>
      <CompletedProfileSummary profile={profile} />
      <form className={styles.form} noValidate onSubmit={submitUpdate} ref={formRef}>
        <ProfileMutationAlert error={apiError} sensitive />
        <div className={styles.formGrid}>
          <Field
            {...fieldErrorProp(visibleFieldErrors, "name")}
            label={profile.personType === "individual" ? "Nome completo" : "Nome empresarial"}
            required
          >
            <Input
              autoComplete={profile.personType === "individual" ? "name" : "organization"}
              defaultValue={profile.name}
              disabled={mutation.isPending}
              maxLength={160}
              name="name"
            />
          </Field>
          <Field {...fieldErrorProp(visibleFieldErrors, "phone")} label="Telefone" required>
            <Input
              autoComplete="tel"
              defaultValue={formatBrazilianPhoneForDisplay(profile.phone)}
              disabled={mutation.isPending}
              inputMode="tel"
              name="phone"
              onInput={applyPhoneMask}
              type="tel"
            />
          </Field>
          <Field label={profile.personType === "individual" ? "Alterar CPF" : "Alterar CNPJ"}>
            <Select
              disabled={mutation.isPending}
              name="taxIdAction"
              onChange={(event) => {
                const action = event.currentTarget.value;
                if (action === "keep" || action === "replace") {
                  setTaxIdAction(action);
                  clearSensitiveInput(formRef.current, "taxId");
                }
              }}
              value={taxIdAction}
            >
              <option value="keep">Manter documento atual</option>
              <option value="replace">Substituir documento</option>
            </Select>
          </Field>
          {taxIdAction === "replace" ? (
            <Field
              {...fieldErrorProp(visibleFieldErrors, "taxId")}
              description={
                profile.personType === "company"
                  ? "O CNPJ aceita letras e números nas 12 primeiras posições e 2 DVs numéricos."
                  : "Use os 11 dígitos do CPF."
              }
              label={profile.personType === "individual" ? "Novo CPF" : "Novo CNPJ"}
              required
            >
              <Input
                autoCapitalize="characters"
                autoComplete="off"
                disabled={mutation.isPending}
                inputMode={profile.personType === "individual" ? "numeric" : "text"}
                name="taxId"
                onInput={(event) => applyTaxMask(event, profile.personType)}
                spellCheck={false}
              />
            </Field>
          ) : null}
          <Field label="Alterar documento adicional">
            <Select
              disabled={mutation.isPending}
              name="documentAction"
              onChange={(event) => {
                const action = event.currentTarget.value;
                if (action === "clear" || action === "keep" || action === "replace") {
                  setDocumentAction(action);
                  clearSensitiveInput(formRef.current, "additionalDocument");
                }
              }}
              value={documentAction}
            >
              <option value="keep">
                {profile.additionalDocumentMasked === null
                  ? "Manter sem documento"
                  : "Manter documento atual"}
              </option>
              <option value="replace">
                {profile.additionalDocumentMasked === null
                  ? "Adicionar documento"
                  : "Substituir documento"}
              </option>
              {profile.additionalDocumentMasked === null ? null : (
                <option value="clear">Remover documento</option>
              )}
            </Select>
          </Field>
          {documentAction === "replace" ? (
            <Field
              {...fieldErrorProp(visibleFieldErrors, "additionalDocument")}
              description="Texto de 3 a 40 caracteres."
              label="Novo documento adicional"
              required
            >
              <Input
                autoCapitalize="characters"
                autoComplete="off"
                disabled={mutation.isPending}
                maxLength={40}
                name="additionalDocument"
                spellCheck={false}
              />
            </Field>
          ) : null}
        </div>
        <div className={styles.actions}>
          <Button loading={mutation.isPending} loadingLabel="Salvando dados" type="submit">
            Salvar alterações
          </Button>
          <ConflictRecoveryAction
            error={apiError}
            onRefresh={onRefresh}
            reset={() => mutation.reset()}
          />
        </div>
      </form>
    </section>
  );
}

function AppearanceForm({
  expectedScope,
  onRefresh,
  onSave,
  onSessionChanged,
  profile,
  scopeTransitionGuard,
}: {
  expectedScope: string;
  onRefresh: RefreshProfile;
  onSave: SaveProfile;
  onSessionChanged: () => void;
  profile: ProfileSnapshot;
  scopeTransitionGuard: ProfileScopeTransitionGuard;
}) {
  const pendingUpdate = useRef<ProfileMutationAttempt<ProfileUpdatePayload>>(undefined);
  const [colorScheme, setColorScheme] = useState(profile.colorScheme);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  function cleanupAttemptOnce() {
    cleanupProfileMutationAttemptOnce(
      pendingUpdate.current,
      () => {
        pendingUpdate.current = undefined;
      },
      () => undefined,
    );
  }
  const mutation = useMutation({
    mutationFn: () => {
      const attempt = requireProfileMutationAttempt(
        pendingUpdate.current,
        "A preferência visual não possui payload efêmero.",
      );
      return updateOwnProfile(attempt.expectedScope, attempt.payload);
    },
    networkMode: profileMutationNetworkMode,
    onError: (error) => {
      cleanupAttemptOnce();
      if (!profileMutationResultCanPublish(scopeTransitionGuard)) return;
      if (isProfileSessionChangedError(error)) onSessionChanged();
    },
    onSuccess: (result) => {
      cleanupAttemptOnce();
      if (!profileMutationResultCanPublish(scopeTransitionGuard)) return;
      onSave(result, "Preferência visual atualizada.");
    },
  });

  function submitAppearance(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    mutation.reset();
    setFieldErrors({});
    const form = new FormData(event.currentTarget);
    const parsed = profileAppearanceUpdatePayloadSchema.safeParse({
      colorScheme: formValue(form, "colorScheme"),
      expectedPreferencesVersion: profile.preferencesVersion,
      section: "appearance",
    });
    if (!parsed.success) {
      setFieldErrors(firstFieldErrors(parsed.error));
      return;
    }
    pendingUpdate.current = { expectedScope, payload: parsed.data };
    mutation.mutate();
  }

  const apiError = mutation.error instanceof ProfileApiError ? mutation.error : undefined;
  const visibleFieldErrors = apiError?.fieldErrors ?? fieldErrors;

  return (
    <section className={styles.section} aria-labelledby="appearance-title">
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle} id="appearance-title">
          Aparência
        </h2>
        <p className={styles.sectionDescription}>
          A preferência é aplicada em toda a conta. “Dispositivo” acompanha o tema do sistema.
        </p>
      </div>
      <form className={styles.form} noValidate onSubmit={submitAppearance}>
        <ProfileMutationAlert error={apiError} />
        <Field
          {...fieldErrorProp(visibleFieldErrors, "colorScheme")}
          label="Tema da interface"
          required
        >
          <Select
            disabled={mutation.isPending}
            name="colorScheme"
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (value === "dark" || value === "light" || value === "system") {
                setColorScheme(value);
              }
            }}
            value={colorScheme}
          >
            {visualPreferenceOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
        <div className={styles.actions}>
          <Button loading={mutation.isPending} loadingLabel="Salvando tema" type="submit">
            Salvar aparência
          </Button>
          <ConflictRecoveryAction
            error={apiError}
            onRefresh={onRefresh}
            reset={() => mutation.reset()}
          />
        </div>
      </form>
    </section>
  );
}

function ProfileContent({
  expectedScope,
  onSave,
  onSessionChanged,
  profileResult,
  refreshProfile,
  scopeTransitionGuard,
}: {
  expectedScope: string;
  onSave: SaveProfile;
  onSessionChanged: () => void;
  profileResult: MyProfileResult;
  refreshProfile: RefreshProfile;
  scopeTransitionGuard: ProfileScopeTransitionGuard;
}) {
  const [successMessage, setSuccessMessage] = useState<string>();
  const saveProfile: SaveProfile = (profile, message) => {
    if (!profileMutationResultCanPublish(scopeTransitionGuard)) return;
    setSuccessMessage(message);
    onSave(profile, message);
  };
  const profile = profileResult.profile;

  if (profile.status === "suspended") {
    return (
      <Stack space={5}>
        <Alert title="Conta suspensa" variant="error">
          Os formulários estão indisponíveis. Entre em contato com o suporte para revisar a conta.
        </Alert>
        {profile.completed ? <CompletedProfileSummary profile={profile} /> : null}
      </Stack>
    );
  }

  return (
    <Stack space={6}>
      {successMessage === undefined ? null : (
        <Alert title="Alteração salva">{successMessage}</Alert>
      )}
      {profile.completed ? (
        <IdentityUpdateForm
          expectedScope={expectedScope}
          key={`identity-${profile.profileVersion}`}
          onRefresh={refreshProfile}
          onSave={saveProfile}
          onSessionChanged={onSessionChanged}
          profile={profile}
          scopeTransitionGuard={scopeTransitionGuard}
        />
      ) : (
        <CompletionForm
          expectedScope={expectedScope}
          key={`completion-${profile.profileVersion}`}
          onRefresh={refreshProfile}
          onSave={saveProfile}
          onSessionChanged={onSessionChanged}
          profile={profile}
          scopeTransitionGuard={scopeTransitionGuard}
        />
      )}
      <AppearanceForm
        expectedScope={expectedScope}
        key={`appearance-${profile.preferencesVersion}`}
        onRefresh={refreshProfile}
        onSave={saveProfile}
        onSessionChanged={onSessionChanged}
        profile={profile}
        scopeTransitionGuard={scopeTransitionGuard}
      />
    </Stack>
  );
}

function publishProfileResult(
  queryClient: QueryClient,
  expectedUserId: string,
  result: MyProfileResult,
  scopeTransitionGuard: ProfileScopeTransitionGuard,
  onScopeTransition: () => void,
) {
  if (!profileMutationResultCanPublish(scopeTransitionGuard)) return;
  try {
    publishNewestAccountProfileMutationResult(queryClient, expectedUserId, result);
  } catch {
    onScopeTransition();
  }
}

function PreparedAccountProfilePanel({ initialProfile, userId }: AccountProfilePanelProps) {
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => accountQueryKeys.profile(userId), [userId]);
  const [scopeTransitionStarted, setScopeTransitionStarted] = useState(false);
  const scopeTransitionGuard = useRef(false);
  const profileQuery = useQuery({
    initialData: initialProfile,
    networkMode: "always",
    queryFn: async () => readNewestAccountProfileResult(queryClient, userId, readOwnProfile),
    queryKey,
    refetchOnMount: "always",
    refetchOnReconnect: "always",
    refetchOnWindowFocus: "always",
    retry: false,
    staleTime: 30_000,
  });
  const observedProfile = profileQuery.data;
  const profileCanRender =
    observedProfile !== undefined &&
    accountProfileCanRender(observedProfile, userId, profileQuery.fetchStatus);
  const observedScopeChanged =
    observedProfile !== undefined && !accountProfileMatchesScope(observedProfile, userId);
  const authoritativeScopeChanged = profileQuery.error instanceof AccountProfileScopeChangedError;
  const scopeTransitionRequired = observedScopeChanged || authoritativeScopeChanged;
  const renderablePreference =
    profileCanRender && observedProfile !== undefined && !profileQuery.isError
      ? observedProfile.profile.colorScheme
      : undefined;

  const executeScopeTransition = useCallback(
    (commitBoundary: () => void) => {
      beginProfileScopeTransitionOnce(
        scopeTransitionGuard,
        commitBoundary,
        () => {
          clearIdentityAndAccountQueryCache(queryClient);
        },
        () => {
          window.location.reload();
        },
      );
    },
    [queryClient],
  );

  const beginMutationScopeTransition = useCallback(() => {
    executeScopeTransition(() => {
      flushSync(() => {
        setScopeTransitionStarted(true);
      });
    });
  }, [executeScopeTransition]);

  const beginObservedScopeTransition = useCallback(() => {
    executeScopeTransition(() => {
      setScopeTransitionStarted(true);
    });
  }, [executeScopeTransition]);

  useLayoutEffect(() => {
    if (!scopeTransitionRequired) return;
    beginObservedScopeTransition();
  }, [beginObservedScopeTransition, scopeTransitionRequired]);

  useEffect(() => {
    if (renderablePreference !== undefined) {
      applyVisualPreference(document.documentElement, renderablePreference);
    }
  }, [renderablePreference]);

  if (
    scopeTransitionStarted ||
    scopeTransitionRequired ||
    (observedProfile !== undefined && !profileCanRender)
  ) {
    return <Alert>Validando seus dados privados…</Alert>;
  }

  if (profileQuery.isError || observedProfile === undefined) {
    const message =
      profileQuery.error instanceof ProfileApiError
        ? profileQuery.error.message
        : "Não foi possível validar o perfil.";
    return (
      <Stack space={4}>
        <Alert title="Perfil indisponível" variant="error">
          {message}
        </Alert>
        <div className={styles.actions}>
          <Button
            loading={profileQuery.isFetching}
            loadingLabel="Validando perfil"
            onClick={() => {
              void profileQuery.refetch();
            }}
            variant="secondary"
          >
            Tentar novamente
          </Button>
        </div>
      </Stack>
    );
  }

  return (
    <ProfileContent
      expectedScope={userId}
      onSave={(result) =>
        publishProfileResult(
          queryClient,
          userId,
          result,
          scopeTransitionGuard,
          beginMutationScopeTransition,
        )
      }
      onSessionChanged={beginMutationScopeTransition}
      profileResult={observedProfile}
      refreshProfile={() => profileQuery.refetch()}
      scopeTransitionGuard={scopeTransitionGuard}
    />
  );
}

export function AccountProfilePanel({ initialProfile, userId }: AccountProfilePanelProps) {
  const queryClient = useQueryClient();
  const [preparedInitialProfile, setPreparedInitialProfile] = useState<MyProfileResult>();
  const seedIsCurrent = preparedInitialProfile === initialProfile;

  useEffect(() => {
    let active = true;
    if (!accountProfileMatchesScope(initialProfile, userId)) {
      clearIdentityAndAccountQueryCache(queryClient);
      window.location.reload();
      return () => {
        active = false;
      };
    }
    applyVisualPreference(document.documentElement, initialProfile.profile.colorScheme);
    seedAuthoritativeAccountProfile(queryClient, userId, initialProfile);
    queueMicrotask(() => {
      if (active) setPreparedInitialProfile(initialProfile);
    });
    return () => {
      active = false;
    };
  }, [initialProfile, queryClient, userId]);

  if (!seedIsCurrent) {
    return <Alert>Validando seus dados privados…</Alert>;
  }

  return <PreparedAccountProfilePanel initialProfile={preparedInitialProfile} userId={userId} />;
}

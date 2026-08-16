"use client";

import {
  studioCoreInputSchema,
  type OwnerStudioEditorResult,
  type StudioCoreInput,
  type StudioDraftDiscardResult,
} from "@set-livre/contracts";
import { Alert, Button, Field, Input, Select, Stack, Textarea } from "@set-livre/ui";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { z } from "zod";

import { formValue, type FieldErrors } from "@/domains/identity/components/form-utils";

import { createStudio, discardStudioDraft, StudioApiError, updateStudioCore } from "./studio-api";
import {
  cleanupStudioMutationAttemptOnce,
  isStudioMutationScopeTransitionError,
  requireStudioMutationAttempt,
  studioMutationNetworkMode,
  studioMutationRequiresVerification,
  studioMutationResultCanPublish,
  type StudioMutationAttempt,
  type StudioScopeTransitionGuard,
} from "./studio-mutation";
import styles from "./studio.module.css";

type StudioEditorEditResult = Extract<OwnerStudioEditorResult, { mode: "edit" }>;

export type StudioSaveRecoveryAttempt =
  | Readonly<{
      core: StudioCoreInput;
      kind: "create";
      studioId: string;
    }>
  | Readonly<{
      core: StudioCoreInput;
      expectedEditVersion: number;
      kind: "update";
      studioId: string;
    }>;

export type StudioDiscardRecoveryAttempt = Readonly<{
  expectedEditVersion: number;
  kind: "discard";
  studioId: string;
}>;

export type StudioRecoveryAttempt = StudioSaveRecoveryAttempt | StudioDiscardRecoveryAttempt;

export type StudioCoreFormRawValues = Readonly<{
  capacity: string;
  complement: string;
  description: string;
  name: string;
  neighborhood: string;
  postalCode: string;
  street: string;
  streetNumber: string;
  studioTypeId: string;
}>;

type StudioCoreFormRawCapture = () => StudioCoreFormRawValues | undefined;

export type StudioCoreFormRawBridge = Readonly<{
  capture: StudioCoreFormRawCapture;
  restore: (raw: StudioCoreFormRawValues) => boolean;
}>;

type StudioCoreFormProps = Readonly<{
  createStudioId?: string | undefined;
  expectedScope: string;
  initialCore?: StudioCoreInput | undefined;
  locked: boolean;
  onCreated: (result: StudioEditorEditResult) => void;
  onDirty: () => void;
  onDiscarded: (result: StudioDraftDiscardResult) => void;
  onNeedsVerification: (attempt: StudioRecoveryAttempt, error: StudioApiError) => void;
  onPendingChange: (pending: boolean) => void;
  onSaved: (result: StudioEditorEditResult, message: string) => void;
  onSessionChanged: () => void;
  registerRawFormBridge: (bridge: StudioCoreFormRawBridge | undefined) => void;
  result: OwnerStudioEditorResult;
  scopeProbeHidden: boolean;
  scopeTransitionGuard: StudioScopeTransitionGuard;
}>;

function createIdempotencyKey() {
  return crypto.randomUUID();
}

function nestedStudioFieldErrors(error: z.ZodError): FieldErrors {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const field = issue.path.findLast(
      (candidate): candidate is number | string =>
        typeof candidate === "string" || typeof candidate === "number",
    );
    if (field !== undefined && fieldErrors[String(field)] === undefined) {
      fieldErrors[String(field)] = issue.message;
    }
  }
  return fieldErrors;
}

function fieldErrorProp(errors: FieldErrors, field: string): { error?: string } {
  const error = errors[field];
  return error === undefined ? {} : { error };
}

function rawStudioCoreFormValues(form: FormData): StudioCoreFormRawValues {
  return {
    capacity: formValue(form, "capacity"),
    complement: formValue(form, "complement"),
    description: formValue(form, "description"),
    name: formValue(form, "name"),
    neighborhood: formValue(form, "neighborhood"),
    postalCode: formValue(form, "postalCode"),
    street: formValue(form, "street"),
    streetNumber: formValue(form, "streetNumber"),
    studioTypeId: formValue(form, "studioTypeId"),
  };
}

function formCore(raw: StudioCoreFormRawValues) {
  const complement = raw.complement.trim();
  return {
    address: {
      complement: complement === "" ? null : complement,
      neighborhood: raw.neighborhood,
      postalCode: raw.postalCode,
      street: raw.street,
      streetNumber: raw.streetNumber,
    },
    capacity: Number(raw.capacity),
    description: raw.description,
    name: raw.name,
    studioTypeId: raw.studioTypeId,
  };
}

function studioCoreFormControl(form: HTMLFormElement, name: keyof StudioCoreFormRawValues) {
  const control = form.elements.namedItem(name);
  return control instanceof HTMLInputElement ||
    control instanceof HTMLSelectElement ||
    control instanceof HTMLTextAreaElement
    ? control
    : undefined;
}

function currentRawStudioCoreFormValues(
  form: HTMLFormElement,
): StudioCoreFormRawValues | undefined {
  const capacity = studioCoreFormControl(form, "capacity");
  const complement = studioCoreFormControl(form, "complement");
  const description = studioCoreFormControl(form, "description");
  const name = studioCoreFormControl(form, "name");
  const neighborhood = studioCoreFormControl(form, "neighborhood");
  const postalCode = studioCoreFormControl(form, "postalCode");
  const street = studioCoreFormControl(form, "street");
  const streetNumber = studioCoreFormControl(form, "streetNumber");
  const studioTypeId = studioCoreFormControl(form, "studioTypeId");
  if (
    capacity === undefined ||
    complement === undefined ||
    description === undefined ||
    name === undefined ||
    neighborhood === undefined ||
    postalCode === undefined ||
    street === undefined ||
    streetNumber === undefined ||
    studioTypeId === undefined
  ) {
    return undefined;
  }
  return {
    capacity: capacity.value,
    complement: complement.value,
    description: description.value,
    name: name.value,
    neighborhood: neighborhood.value,
    postalCode: postalCode.value,
    street: street.value,
    streetNumber: streetNumber.value,
    studioTypeId: studioTypeId.value,
  };
}

function restoreRawStudioCoreFormValues(form: HTMLFormElement, raw: StudioCoreFormRawValues) {
  const values: ReadonlyArray<readonly [keyof StudioCoreFormRawValues, string]> = [
    ["capacity", raw.capacity],
    ["complement", raw.complement],
    ["description", raw.description],
    ["name", raw.name],
    ["neighborhood", raw.neighborhood],
    ["postalCode", raw.postalCode],
    ["street", raw.street],
    ["streetNumber", raw.streetNumber],
    ["studioTypeId", raw.studioTypeId],
  ];
  for (const [name, value] of values) {
    const control = studioCoreFormControl(form, name);
    if (control === undefined) return false;
    control.value = value;
  }
  return true;
}

function addressSectionHasError(errors: FieldErrors) {
  return ["street", "streetNumber", "complement", "neighborhood", "postalCode"].some(
    (field) => errors[field] !== undefined,
  );
}

function focusFirstInvalidControl(form: HTMLFormElement) {
  queueMicrotask(() => {
    form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  });
}

function defaultCore(result: OwnerStudioEditorResult, override?: StudioCoreInput) {
  if (override !== undefined) return override;
  if (result.mode === "create") return undefined;
  return result.studio.draft?.core ?? result.studio.published?.core;
}

function apiFieldErrors(error: unknown) {
  return error instanceof StudioApiError ? error.fieldErrors : {};
}

export function StudioCoreForm({
  createStudioId,
  expectedScope,
  initialCore,
  locked,
  onCreated,
  onDirty,
  onDiscarded,
  onNeedsVerification,
  onPendingChange,
  onSaved,
  onSessionChanged,
  registerRawFormBridge,
  result,
  scopeProbeHidden,
  scopeTransitionGuard,
}: StudioCoreFormProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const pendingSave = useRef<StudioMutationAttempt<StudioSaveRecoveryAttempt> | undefined>(
    undefined,
  );
  const pendingDiscard = useRef<StudioMutationAttempt<StudioDiscardRecoveryAttempt> | undefined>(
    undefined,
  );
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const initial = defaultCore(result, initialCore);
  const [descriptionLength, setDescriptionLength] = useState(initial?.description.length ?? 0);
  const [nameLength, setNameLength] = useState(initial?.name.length ?? 0);

  function clearSaveAttempt() {
    cleanupStudioMutationAttemptOnce(pendingSave.current, () => {
      pendingSave.current = undefined;
    });
  }

  function clearDiscardAttempt() {
    cleanupStudioMutationAttemptOnce(pendingDiscard.current, () => {
      pendingDiscard.current = undefined;
    });
  }

  const saveMutation = useMutation({
    mutationFn: () => {
      const attempt = requireStudioMutationAttempt(
        pendingSave.current,
        "O salvamento do estúdio não possui uma tentativa efêmera.",
      );
      return attempt.payload.kind === "create"
        ? createStudio(
            attempt.expectedScope,
            attempt.idempotencyKey,
            attempt.payload.studioId,
            attempt.payload.core,
          )
        : updateStudioCore(
            attempt.expectedScope,
            attempt.idempotencyKey,
            attempt.payload.studioId,
            attempt.payload.expectedEditVersion,
            attempt.payload.core,
          );
    },
    networkMode: studioMutationNetworkMode,
    onError: (error) => {
      onPendingChange(false);
      const attempt = pendingSave.current?.payload;
      clearSaveAttempt();
      if (!studioMutationResultCanPublish(scopeTransitionGuard)) return;
      if (isStudioMutationScopeTransitionError(error)) {
        onSessionChanged();
        return;
      }
      if (attempt !== undefined && studioMutationRequiresVerification(error)) {
        onNeedsVerification(
          attempt,
          error instanceof StudioApiError
            ? error
            : new StudioApiError("SERVICE_UNAVAILABLE", "Não foi possível confirmar o estado."),
        );
      }
    },
    onSuccess: (updated) => {
      onPendingChange(false);
      clearSaveAttempt();
      if (!studioMutationResultCanPublish(scopeTransitionGuard)) return;
      if (result.mode === "create") {
        onCreated(updated);
      } else {
        onSaved(updated, "Rascunho salvo com segurança.");
      }
    },
    retry: false,
  });

  const discardMutation = useMutation({
    mutationFn: () => {
      const attempt = requireStudioMutationAttempt(
        pendingDiscard.current,
        "O descarte do estúdio não possui uma tentativa efêmera.",
      );
      return discardStudioDraft(
        attempt.expectedScope,
        attempt.idempotencyKey,
        attempt.payload.studioId,
        attempt.payload.expectedEditVersion,
      );
    },
    networkMode: studioMutationNetworkMode,
    onError: (error) => {
      onPendingChange(false);
      const attempt = pendingDiscard.current?.payload;
      clearDiscardAttempt();
      if (!studioMutationResultCanPublish(scopeTransitionGuard)) return;
      if (isStudioMutationScopeTransitionError(error)) {
        onSessionChanged();
        return;
      }
      if (attempt !== undefined && studioMutationRequiresVerification(error)) {
        onNeedsVerification(
          attempt,
          error instanceof StudioApiError
            ? error
            : new StudioApiError("SERVICE_UNAVAILABLE", "Não foi possível confirmar o estado."),
        );
      }
    },
    onSuccess: (updated) => {
      onPendingChange(false);
      clearDiscardAttempt();
      if (!studioMutationResultCanPublish(scopeTransitionGuard)) return;
      setConfirmingDiscard(false);
      onDiscarded(updated);
    },
    retry: false,
  });

  const visibleFieldErrors = useMemo(
    () => ({
      ...fieldErrors,
      ...apiFieldErrors(saveMutation.error),
    }),
    [fieldErrors, saveMutation.error],
  );
  const controlsDisabled =
    locked || saveMutation.isPending || discardMutation.isPending || confirmingDiscard;
  const saveApiError =
    saveMutation.error instanceof StudioApiError ? saveMutation.error : undefined;
  const discardApiError =
    discardMutation.error instanceof StudioApiError ? discardMutation.error : undefined;
  const visibleSaveError =
    saveApiError !== undefined &&
    Object.keys(saveApiError.fieldErrors).length === 0 &&
    !studioMutationRequiresVerification(saveApiError)
      ? saveApiError
      : undefined;
  const visibleDiscardError =
    discardApiError !== undefined && !studioMutationRequiresVerification(discardApiError)
      ? discardApiError
      : undefined;

  useEffect(() => {
    if (
      !scopeProbeHidden &&
      Object.keys(visibleFieldErrors).length > 0 &&
      formRef.current !== null
    ) {
      focusFirstInvalidControl(formRef.current);
    }
  }, [scopeProbeHidden, visibleFieldErrors]);

  useLayoutEffect(() => {
    if (scopeProbeHidden) {
      registerRawFormBridge(undefined);
      return () => undefined;
    }
    registerRawFormBridge({
      capture: () => {
        if (formRef.current === null) return undefined;
        return currentRawStudioCoreFormValues(formRef.current);
      },
      restore: (raw) => {
        if (formRef.current === null || !restoreRawStudioCoreFormValues(formRef.current, raw)) {
          return false;
        }
        const descriptionLengthAfterRestore = raw.description.length;
        const nameLengthAfterRestore = raw.name.length;
        queueMicrotask(() => {
          setDescriptionLength(descriptionLengthAfterRestore);
          setNameLength(nameLengthAfterRestore);
        });
        return true;
      },
    });
    return () => registerRawFormBridge(undefined);
  }, [registerRawFormBridge, scopeProbeHidden]);

  if (scopeProbeHidden) return null;

  function submitCore(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (controlsDisabled || studioMutationRequiresVerification(saveMutation.error)) return;
    saveMutation.reset();
    discardMutation.reset();
    setFieldErrors({});
    setConfirmingDiscard(false);
    const parsed = studioCoreInputSchema.safeParse(
      formCore(rawStudioCoreFormValues(new FormData(event.currentTarget))),
    );
    if (!parsed.success) {
      setFieldErrors(nestedStudioFieldErrors(parsed.error));
      focusFirstInvalidControl(event.currentTarget);
      return;
    }

    const studioId =
      result.mode === "create" ? (createStudioId ?? crypto.randomUUID()) : result.studio.id;
    const payload: StudioSaveRecoveryAttempt =
      result.mode === "create"
        ? { core: parsed.data, kind: "create", studioId }
        : {
            core: parsed.data,
            expectedEditVersion: result.studio.editVersion,
            kind: "update",
            studioId,
          };
    pendingSave.current = {
      expectedScope,
      idempotencyKey: createIdempotencyKey(),
      payload,
    };
    onPendingChange(true);
    saveMutation.mutate();
  }

  function confirmDiscard() {
    if (result.mode !== "edit" || result.studio.draft === null || locked) return;
    discardMutation.reset();
    saveMutation.reset();
    pendingDiscard.current = {
      expectedScope,
      idempotencyKey: createIdempotencyKey(),
      payload: {
        expectedEditVersion: result.studio.editVersion,
        kind: "discard",
        studioId: result.studio.id,
      },
    };
    onPendingChange(true);
    discardMutation.mutate();
  }

  return (
    <form
      aria-busy={saveMutation.isPending || discardMutation.isPending}
      noValidate
      onInputCapture={onDirty}
      onSubmit={submitCore}
      ref={formRef}
    >
      <Stack space={6}>
        {visibleSaveError === undefined ? null : (
          <Alert title="Não foi possível salvar o rascunho" variant="error">
            {visibleSaveError.message}
          </Alert>
        )}
        {visibleDiscardError === undefined ? null : (
          <Alert title="Não foi possível descartar o rascunho" variant="error">
            {visibleDiscardError.message}
          </Alert>
        )}

        <section aria-labelledby="studio-identification-title" className={styles.formSection}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle} id="studio-identification-title">
              Identificação
            </h2>
            <p className={styles.sectionDescription}>
              Use um nome claro e escolha somente um tipo disponível.
            </p>
          </div>
          <div className={styles.formGrid}>
            <Field
              {...fieldErrorProp(visibleFieldErrors, "name")}
              controlId="studio-name"
              label="Nome do estúdio"
              required
            >
              <Input
                aria-describedby="studio-name-counter"
                defaultValue={initial?.name}
                disabled={controlsDisabled}
                maxLength={120}
                name="name"
                onInput={(event) => setNameLength(event.currentTarget.value.length)}
              />
            </Field>
            <p className={styles.counter} id="studio-name-counter">
              {nameLength} de 120 caracteres
            </p>

            <Field
              {...fieldErrorProp(visibleFieldErrors, "studioTypeId")}
              label="Tipo de estúdio"
              required
            >
              <Select
                defaultValue={initial?.studioTypeId ?? ""}
                disabled={controlsDisabled}
                name="studioTypeId"
              >
                <option value="">Selecione um tipo</option>
                {result.studioTypes.map((studioType) => (
                  <option key={studioType.id} value={studioType.id}>
                    {studioType.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </section>

        <section aria-labelledby="studio-presentation-title" className={styles.formSection}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle} id="studio-presentation-title">
              Apresentação
            </h2>
            <p className={styles.sectionDescription}>
              A descrição será pública somente depois de uma aprovação posterior.
            </p>
          </div>
          <Field
            {...fieldErrorProp(visibleFieldErrors, "description")}
            controlId="studio-description"
            label="Descrição"
            required
          >
            <Textarea
              aria-describedby="studio-description-counter"
              defaultValue={initial?.description}
              disabled={controlsDisabled}
              maxLength={5000}
              name="description"
              onInput={(event) => setDescriptionLength(event.currentTarget.value.length)}
              rows={8}
            />
          </Field>
          <p className={styles.counter} id="studio-description-counter">
            {descriptionLength} de 5000 caracteres
          </p>
        </section>

        <section aria-labelledby="studio-address-title" className={styles.formSection}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle} id="studio-address-title">
              Endereço
            </h2>
            <p className={styles.sectionDescription}>
              Nesta versão, o cadastro é restrito a Curitiba, Paraná.
            </p>
          </div>
          {addressSectionHasError(visibleFieldErrors) ? (
            <Alert title="Revise a seção Endereço" variant="error">
              Corrija os campos indicados antes de salvar o rascunho.
            </Alert>
          ) : null}
          <div className={styles.formGrid}>
            <Field {...fieldErrorProp(visibleFieldErrors, "street")} label="Logradouro" required>
              <Input
                autoComplete="address-line1"
                defaultValue={initial?.address.street}
                disabled={controlsDisabled}
                maxLength={160}
                name="street"
              />
            </Field>
            <Field {...fieldErrorProp(visibleFieldErrors, "streetNumber")} label="Número" required>
              <Input
                defaultValue={initial?.address.streetNumber}
                disabled={controlsDisabled}
                maxLength={20}
                name="streetNumber"
              />
            </Field>
            <Field {...fieldErrorProp(visibleFieldErrors, "complement")} label="Complemento">
              <Input
                autoComplete="address-line2"
                defaultValue={initial?.address.complement ?? ""}
                disabled={controlsDisabled}
                maxLength={120}
                name="complement"
              />
            </Field>
            <Field {...fieldErrorProp(visibleFieldErrors, "neighborhood")} label="Bairro" required>
              <Input
                defaultValue={initial?.address.neighborhood}
                disabled={controlsDisabled}
                maxLength={120}
                name="neighborhood"
              />
            </Field>
            <Field {...fieldErrorProp(visibleFieldErrors, "postalCode")} label="CEP" required>
              <Input
                autoComplete="postal-code"
                defaultValue={initial?.address.postalCode}
                disabled={controlsDisabled}
                inputMode="numeric"
                maxLength={9}
                name="postalCode"
              />
            </Field>
            <div className={styles.fixedAddress}>
              <p className={styles.fixedAddressLabel}>Cidade e estado</p>
              <p className={styles.fixedAddressValue}>Curitiba · PR</p>
            </div>
          </div>
        </section>

        <section aria-labelledby="studio-capacity-title" className={styles.formSection}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle} id="studio-capacity-title">
              Capacidade
            </h2>
            <p className={styles.sectionDescription}>
              Informe quantas pessoas o espaço comporta com segurança.
            </p>
          </div>
          <Field
            {...fieldErrorProp(visibleFieldErrors, "capacity")}
            label="Capacidade máxima de pessoas"
            required
          >
            <Input
              defaultValue={initial?.capacity}
              disabled={controlsDisabled}
              inputMode="numeric"
              max={500}
              min={1}
              name="capacity"
              step={1}
              type="number"
            />
          </Field>
        </section>

        <div className={styles.actions}>
          <Button
            disabled={controlsDisabled}
            loading={saveMutation.isPending}
            loadingLabel="Salvando rascunho"
            type="submit"
          >
            Salvar rascunho
          </Button>
          {result.mode === "edit" && result.studio.draft !== null ? (
            <Button
              disabled={controlsDisabled}
              onClick={() => setConfirmingDiscard(true)}
              variant="ghost"
            >
              Descartar rascunho
            </Button>
          ) : null}
        </div>

        {confirmingDiscard && result.mode === "edit" && result.studio.draft !== null ? (
          <div className={styles.discardConfirmation}>
            <Alert title="Confirme o descarte" variant="error">
              {result.studio.published === null
                ? "Este estúdio ainda não foi publicado. O descarte removerá o rascunho e seu cadastro inicial."
                : "Somente o rascunho será removido. A versão aprovada continuará inalterada."}
            </Alert>
            <div className={styles.actions}>
              <Button
                loading={discardMutation.isPending}
                loadingLabel="Descartando rascunho"
                onClick={confirmDiscard}
                variant="secondary"
              >
                Confirmar descarte
              </Button>
              <Button
                disabled={discardMutation.isPending}
                onClick={() => setConfirmingDiscard(false)}
                variant="ghost"
              >
                Cancelar
              </Button>
            </div>
          </div>
        ) : null}
      </Stack>
    </form>
  );
}

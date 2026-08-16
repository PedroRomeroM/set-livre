import { z } from "zod";

import { profileVersionSchema } from "./profile";

export const ownerStatusSchema = z.enum(["inactive", "active", "blocked"]);
export const recipientStatusSchema = z.enum([
  "not_started",
  "pending",
  "active",
  "refused",
  "suspended",
  "blocked",
]);
export const recipientRequirementSchema = z.enum([
  "identity_review",
  "additional_information",
  "provider_contact",
]);
export const ownerNextActionSchema = z.enum([
  "activate_owner",
  "start_onboarding",
  "refresh_status",
  "none",
]);
export const ownerProviderModeSchema = z.literal("local");
export const ownerActivationCapabilitySchema = z.enum(["available", "unavailable"]);
export const recipientOnboardingCapabilitySchema = z.enum(["local_adapter", "unavailable"]);

export const ownerContractReferenceSchema = z.strictObject({
  effectiveAt: z.iso.datetime(),
  id: z.uuid(),
  source: z.enum(["local_fixture", "approved"]),
});

export const ownerContractSchema = z.strictObject({
  ...ownerContractReferenceSchema.shape,
  bodyMarkdown: z.string().min(1),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/u),
  kind: z.literal("owner_contract"),
  title: z.string().min(1),
  version: z.string().min(1),
});

const recipientRequirementsSchema = z
  .array(recipientRequirementSchema)
  .max(recipientRequirementSchema.options.length)
  .refine((requirements) => new Set(requirements).size === requirements.length, {
    message: "Os requisitos do recebedor não podem ser repetidos.",
  });

const ownerRecipientStateShape = {
  acceptedOwnerContractVersionId: z.uuid().nullable(),
  nextAction: ownerNextActionSchema,
  ownerContractAccepted: z.boolean(),
  ownerStatus: ownerStatusSchema,
  ownerVersion: profileVersionSchema,
  profileVersion: profileVersionSchema,
  profileVersionSynced: profileVersionSchema.nullable(),
  providerMode: ownerProviderModeSchema,
  recipientOnboardingCapability: recipientOnboardingCapabilitySchema,
  recipientStatus: recipientStatusSchema,
  recipientVersion: profileVersionSchema,
  requirements: recipientRequirementsSchema,
  reservationsEligible: z.boolean(),
  scope: z.uuid(),
} as const;

type OwnerRecipientRelationalState = {
  acceptedOwnerContractVersionId: string | null;
  nextAction: OwnerNextAction;
  ownerContract: OwnerContractReference;
  ownerContractAccepted: boolean;
  ownerStatus: OwnerStatus;
  ownerVersion: number;
  profileVersion: number;
  profileVersionSynced: number | null;
  providerMode: "local";
  recipientOnboardingCapability: RecipientOnboardingCapability;
  recipientStatus: RecipientStatus;
  recipientVersion: number;
  requirements: readonly RecipientRequirement[];
  reservationsEligible: boolean;
  scope: string;
};
type ReportOwnerRecipientIssue = (message: string, path: string) => void;

function validateOwnerRecipientState(
  value: OwnerRecipientRelationalState,
  report: ReportOwnerRecipientIssue,
) {
  const recipientIsInitial =
    value.recipientStatus === "not_started" &&
    value.recipientVersion === 0 &&
    value.profileVersionSynced === null &&
    value.requirements.length === 0;
  const ownerAuthorityExists = value.ownerVersion >= 1;

  if (ownerAuthorityExists !== (value.acceptedOwnerContractVersionId !== null)) {
    report("A versão do dono não corresponde à autoridade contratual persistida.", "ownerVersion");
  }
  if (!ownerAuthorityExists && !recipientIsInitial) {
    report("Um recebedor não pode existir sem a autoridade persistida do dono.", "recipientStatus");
  }
  if (value.ownerStatus === "inactive" && value.ownerVersion !== 0) {
    report("Um dono inativo não pode possuir uma versão persistida.", "ownerVersion");
  }
  if (value.ownerStatus === "active" && !ownerAuthorityExists) {
    report("Um dono ativo exige autoridade persistida.", "ownerVersion");
  }
  if (value.recipientStatus === "not_started" && !recipientIsInitial) {
    report("O recebedor ainda não iniciado deve permanecer no estado inicial.", "recipientStatus");
  }
  if (
    value.recipientStatus !== "not_started" &&
    (value.recipientVersion < 1 || value.profileVersionSynced === null)
  ) {
    report(
      "Um recebedor iniciado exige versão e perfil sincronizado persistidos.",
      "recipientVersion",
    );
  }
  if (value.recipientStatus === "active" && value.requirements.length !== 0) {
    report("Um recebedor ativo não pode conservar requisitos pendentes.", "requirements");
  }

  const profileIsSynced = value.profileVersionSynced === value.profileVersion;
  const eligible =
    value.ownerStatus === "active" &&
    value.ownerContractAccepted &&
    value.recipientStatus === "active" &&
    profileIsSynced;
  if (value.reservationsEligible !== eligible) {
    report(
      "A elegibilidade de reserva está incoerente com o estado canônico.",
      "reservationsEligible",
    );
  }
  if (
    value.ownerContractAccepted !==
    (value.acceptedOwnerContractVersionId === value.ownerContract.id)
  ) {
    report("O indicador de aceite não corresponde ao contrato atual.", "ownerContractAccepted");
  }

  let expectedNextAction: OwnerNextAction;
  if (value.ownerStatus === "blocked" || value.recipientStatus === "blocked") {
    expectedNextAction = "none";
  } else if (value.ownerStatus === "inactive" || !value.ownerContractAccepted) {
    expectedNextAction = "activate_owner";
  } else if (value.recipientStatus === "not_started" || value.recipientStatus === "refused") {
    expectedNextAction = "start_onboarding";
  } else if (
    value.recipientStatus === "pending" ||
    value.recipientStatus === "suspended" ||
    (value.recipientStatus === "active" && !profileIsSynced)
  ) {
    expectedNextAction = "refresh_status";
  } else {
    expectedNextAction = "none";
  }
  if (value.nextAction !== expectedNextAction) {
    report("A próxima ação está incoerente com o estado canônico.", "nextAction");
  }
}

const ownerRecipientStatusBaseSchema = z.strictObject({
  ...ownerRecipientStateShape,
  ownerContract: ownerContractReferenceSchema,
  projection: z.literal("recipient"),
});

export const ownerRecipientStatusSchema = ownerRecipientStatusBaseSchema.superRefine(
  (value, context) => {
    validateOwnerRecipientState(value, (message, path) => {
      context.addIssue({ code: "custom", message, path: [path] });
    });
  },
);

export const ownerActivationResultSchema = z
  .strictObject({
    ...ownerRecipientStateShape,
    ownerActivationCapability: ownerActivationCapabilitySchema,
    ownerContract: ownerContractSchema,
    projection: z.literal("activation"),
  })
  .superRefine((value, context) => {
    validateOwnerRecipientState(value, (message, path) => {
      context.addIssue({ code: "custom", message, path: [path] });
    });
  });

export const ownerRecipientResultSchema = z.discriminatedUnion("projection", [
  ownerRecipientStatusSchema,
  ownerActivationResultSchema,
]);

const privateOwnerCommandEnvelope = {
  expectedScope: z.uuid(),
  idempotencyKey: z.uuid(),
} as const;

export const ownerActivatePayloadSchema = z.strictObject({
  acceptOwnerContract: z.literal(true, "Aceite o contrato do dono para continuar."),
  ownerContractVersionId: z.uuid(),
});

export const ownerActivateCommandSchema = z.strictObject({
  action: z.literal("owner.activate"),
  ...privateOwnerCommandEnvelope,
  payload: ownerActivatePayloadSchema,
});

export const recipientOnboardingStartCommandSchema = z.strictObject({
  action: z.literal("recipient.onboarding.start"),
  ...privateOwnerCommandEnvelope,
  payload: z.strictObject({}),
});

export const recipientOnboardingRefreshCommandSchema = z.strictObject({
  action: z.literal("recipient.onboarding.refresh"),
  ...privateOwnerCommandEnvelope,
  payload: z.strictObject({}),
});

export const ownerCommandActionSchema = z.enum([
  "owner.activate",
  "recipient.onboarding.start",
  "recipient.onboarding.refresh",
]);

export const ownerCommandSchema = z.discriminatedUnion("action", [
  ownerActivateCommandSchema,
  recipientOnboardingStartCommandSchema,
  recipientOnboardingRefreshCommandSchema,
]);

export type OwnerActivatePayload = z.infer<typeof ownerActivatePayloadSchema>;
export type OwnerActivationCapability = z.infer<typeof ownerActivationCapabilitySchema>;
export type OwnerActivationResult = z.infer<typeof ownerActivationResultSchema>;
export type OwnerCommand = z.infer<typeof ownerCommandSchema>;
export type OwnerCommandAction = z.infer<typeof ownerCommandActionSchema>;
export type OwnerContract = z.infer<typeof ownerContractSchema>;
export type OwnerContractReference = z.infer<typeof ownerContractReferenceSchema>;
export type OwnerNextAction = z.infer<typeof ownerNextActionSchema>;
export type OwnerRecipientResult = z.infer<typeof ownerRecipientResultSchema>;
export type OwnerRecipientStatus = z.infer<typeof ownerRecipientStatusSchema>;
export type OwnerStatus = z.infer<typeof ownerStatusSchema>;
export type RecipientRequirement = z.infer<typeof recipientRequirementSchema>;
export type RecipientOnboardingCapability = z.infer<typeof recipientOnboardingCapabilitySchema>;
export type RecipientStatus = z.infer<typeof recipientStatusSchema>;

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

export const ownerContractSchema = z.strictObject({
  bodyMarkdown: z.string().min(1),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/u),
  effectiveAt: z.iso.datetime(),
  id: z.uuid(),
  kind: z.literal("owner_contract"),
  source: z.enum(["local_fixture", "approved"]),
  title: z.string().min(1),
  version: z.string().min(1),
});

const recipientRequirementsSchema = z
  .array(recipientRequirementSchema)
  .max(recipientRequirementSchema.options.length)
  .refine((requirements) => new Set(requirements).size === requirements.length, {
    message: "Os requisitos do recebedor não podem ser repetidos.",
  });

export const ownerRecipientResultSchema = z
  .strictObject({
    acceptedOwnerContractVersionId: z.uuid().nullable(),
    nextAction: ownerNextActionSchema,
    ownerContract: ownerContractSchema,
    ownerContractAccepted: z.boolean(),
    ownerStatus: ownerStatusSchema,
    ownerVersion: profileVersionSchema,
    profileVersion: profileVersionSchema,
    profileVersionSynced: profileVersionSchema.nullable(),
    providerMode: ownerProviderModeSchema,
    recipientStatus: recipientStatusSchema,
    recipientVersion: profileVersionSchema,
    requirements: recipientRequirementsSchema,
    reservationsEligible: z.boolean(),
    scope: z.uuid(),
  })
  .superRefine((value, context) => {
    const recipientIsInitial =
      value.recipientStatus === "not_started" &&
      value.recipientVersion === 0 &&
      value.profileVersionSynced === null &&
      value.requirements.length === 0;
    const ownerAuthorityExists = value.ownerVersion >= 1;

    if (ownerAuthorityExists !== (value.acceptedOwnerContractVersionId !== null)) {
      context.addIssue({
        code: "custom",
        message: "A versão do dono não corresponde à autoridade contratual persistida.",
        path: ["ownerVersion"],
      });
    }
    if (!ownerAuthorityExists && !recipientIsInitial) {
      context.addIssue({
        code: "custom",
        message: "Um recebedor não pode existir sem a autoridade persistida do dono.",
        path: ["recipientStatus"],
      });
    }
    if (value.ownerStatus === "inactive" && value.ownerVersion !== 0) {
      context.addIssue({
        code: "custom",
        message: "Um dono inativo não pode possuir uma versão persistida.",
        path: ["ownerVersion"],
      });
    }
    if (value.ownerStatus === "active" && !ownerAuthorityExists) {
      context.addIssue({
        code: "custom",
        message: "Um dono ativo exige autoridade persistida.",
        path: ["ownerVersion"],
      });
    }
    if (value.recipientStatus === "not_started" && !recipientIsInitial) {
      context.addIssue({
        code: "custom",
        message: "O recebedor ainda não iniciado deve permanecer no estado inicial.",
        path: ["recipientStatus"],
      });
    }
    if (
      value.recipientStatus !== "not_started" &&
      (value.recipientVersion < 1 || value.profileVersionSynced === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Um recebedor iniciado exige versão e perfil sincronizado persistidos.",
        path: ["recipientVersion"],
      });
    }
    if (value.recipientStatus === "active" && value.requirements.length !== 0) {
      context.addIssue({
        code: "custom",
        message: "Um recebedor ativo não pode conservar requisitos pendentes.",
        path: ["requirements"],
      });
    }

    const profileIsSynced = value.profileVersionSynced === value.profileVersion;
    const eligible =
      value.ownerStatus === "active" &&
      value.ownerContractAccepted &&
      value.recipientStatus === "active" &&
      profileIsSynced;
    if (value.reservationsEligible !== eligible) {
      context.addIssue({
        code: "custom",
        message: "A elegibilidade de reserva está incoerente com o estado canônico.",
        path: ["reservationsEligible"],
      });
    }
    if (
      value.ownerContractAccepted !==
      (value.acceptedOwnerContractVersionId === value.ownerContract.id)
    ) {
      context.addIssue({
        code: "custom",
        message: "O indicador de aceite não corresponde ao contrato atual.",
        path: ["ownerContractAccepted"],
      });
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
      context.addIssue({
        code: "custom",
        message: "A próxima ação está incoerente com o estado canônico.",
        path: ["nextAction"],
      });
    }
  });

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
export type OwnerCommand = z.infer<typeof ownerCommandSchema>;
export type OwnerCommandAction = z.infer<typeof ownerCommandActionSchema>;
export type OwnerContract = z.infer<typeof ownerContractSchema>;
export type OwnerNextAction = z.infer<typeof ownerNextActionSchema>;
export type OwnerRecipientResult = z.infer<typeof ownerRecipientResultSchema>;
export type OwnerStatus = z.infer<typeof ownerStatusSchema>;
export type RecipientRequirement = z.infer<typeof recipientRequirementSchema>;
export type RecipientStatus = z.infer<typeof recipientStatusSchema>;

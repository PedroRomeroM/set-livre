import { z } from "zod";

import {
  personTypeSchema,
  profileCompleteCommandSchema,
  profileUpdateCommandSchema,
  type PersonType,
} from "./profile";

export { personTypeSchema };
export const legalDocumentKindSchema = z.enum(["terms", "privacy"]);

export const identityEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email("Informe um e-mail válido."))
  .pipe(z.string().max(254, "Informe um e-mail válido."));

export const identityPasswordSchema = z
  .string()
  .min(10, "Use pelo menos 10 caracteres.")
  .max(128, "Use no máximo 128 caracteres.")
  .regex(/[a-z]/, "Inclua uma letra minúscula.")
  .regex(/[A-Z]/, "Inclua uma letra maiúscula.")
  .regex(/[0-9]/, "Inclua um número.");

export const identityRegistrationPayloadSchema = z.strictObject({
  acceptPrivacy: z.literal(true, "Aceite a Política de Privacidade para continuar."),
  acceptTerms: z.literal(true, "Aceite os Termos de Uso para continuar."),
  email: identityEmailSchema,
  password: identityPasswordSchema,
  personType: personTypeSchema,
  privacyVersionId: z.uuid(),
  termsVersionId: z.uuid(),
});

export const identityRegistrationFormSchema = identityRegistrationPayloadSchema
  .extend({
    confirmPassword: z.string(),
  })
  .refine((value) => value.confirmPassword === value.password, {
    message: "As senhas precisam ser iguais.",
    path: ["confirmPassword"],
  });

export const identityRegisterCommandSchema = z.strictObject({
  action: z.literal("identity.register"),
  payload: identityRegistrationPayloadSchema,
});

export const identityCommandActionSchema = z.enum([
  "identity.register",
  "profile.complete",
  "profile.update",
]);

export const identityCommandSchema = z.discriminatedUnion("action", [
  identityRegisterCommandSchema,
  profileCompleteCommandSchema,
  profileUpdateCommandSchema,
]);

export const identityLoginPayloadSchema = z.strictObject({
  email: identityEmailSchema,
  password: z.string().min(1, "Informe sua senha.").max(128, "Senha inválida."),
  returnTo: z.string().optional(),
});

export const identityLogoutPayloadSchema = z.strictObject({
  expectedScope: z.uuid(),
});

export const identityRecoveryRequestPayloadSchema = z.strictObject({
  email: identityEmailSchema,
});

export const identityRecoveryUpdatePayloadSchema = z
  .strictObject({
    confirmPassword: z.string(),
    password: identityPasswordSchema,
  })
  .refine((value) => value.confirmPassword === value.password, {
    message: "As senhas precisam ser iguais.",
    path: ["confirmPassword"],
  });

export const identityCallbackPayloadSchema = z.strictObject({
  returnTo: z.string().optional(),
  tokenHash: z.string().min(20).max(512),
  type: z.enum(["signup", "recovery"]),
});

export const legalDocumentSchema = z.strictObject({
  bodyMarkdown: z.string().min(1),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  effectiveAt: z.iso.datetime(),
  id: z.uuid(),
  kind: legalDocumentKindSchema,
  source: z.enum(["local_fixture", "approved"]),
  title: z.string().min(1),
  version: z.string().min(1),
});

export const currentLegalDocumentsSchema = z.strictObject({
  privacy: legalDocumentSchema.extend({ kind: z.literal("privacy") }),
  terms: legalDocumentSchema.extend({ kind: z.literal("terms") }),
});

export const identityStatusSchema = z.enum(["active", "suspended"]);
export const identitySessionSchema = z.discriminatedUnion("authenticated", [
  z.strictObject({ authenticated: z.literal(false) }),
  z.strictObject({
    authenticated: z.literal(true),
    email: identityEmailSchema,
    personType: personTypeSchema,
    profileCompleted: z.boolean(),
    status: identityStatusSchema,
    userId: z.uuid(),
  }),
]);

export const identityRegisterResultSchema = z.strictObject({
  confirmationRequired: z.literal(true),
});

export const identityLoginResultSchema = z.strictObject({
  redirectTo: z.string(),
  session: identitySessionSchema,
});

export const identityRecoveryRequestResultSchema = z.strictObject({
  accepted: z.literal(true),
});

export const identityRecoveryUpdateResultSchema = z.strictObject({
  updated: z.literal(true),
});

export const identityRecoverySessionScopeSchema = z.union([z.literal("anonymous"), z.uuid()]);
export const identityRecoveryStatusResultSchema = z.discriminatedUnion("allowed", [
  z.strictObject({ allowed: z.literal(false), scope: identityRecoverySessionScopeSchema }),
  z.strictObject({ allowed: z.literal(true), scope: z.uuid() }),
]);

export const identityCallbackResultSchema = z.strictObject({
  redirectTo: z.string(),
});

export const apiFieldErrorsSchema = z.record(z.string(), z.string());
export const apiErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.string().min(1),
    fieldErrors: apiFieldErrorsSchema.optional(),
    message: z.string().min(1),
    requestId: z.uuid(),
  }),
});

export function apiSuccessSchema<TData extends z.ZodType>(data: TData) {
  return z.strictObject({ data, requestId: z.uuid() });
}

const defaultAuthenticatedReturnTo = "/entrar?sessao=ativa" as const;
const allowedAuthenticatedReturnTos = new Set<string>([
  defaultAuthenticatedReturnTo,
  "/conta",
  "/conta/seguranca",
  "/dono",
  "/dono/recebimentos",
]);

export function resolveAuthenticatedReturnTo(candidate: unknown) {
  return typeof candidate === "string" && allowedAuthenticatedReturnTos.has(candidate)
    ? candidate
    : defaultAuthenticatedReturnTo;
}

export type ApiError = z.infer<typeof apiErrorSchema>;
export type CurrentLegalDocuments = z.infer<typeof currentLegalDocumentsSchema>;
export type IdentityCommand = z.infer<typeof identityCommandSchema>;
export type IdentityCommandAction = z.infer<typeof identityCommandActionSchema>;
export type IdentityLoginPayload = z.infer<typeof identityLoginPayloadSchema>;
export type IdentityLogoutPayload = z.infer<typeof identityLogoutPayloadSchema>;
export type IdentityRecoverySessionScope = z.infer<typeof identityRecoverySessionScopeSchema>;
export type IdentityRecoveryStatusResult = z.infer<typeof identityRecoveryStatusResultSchema>;
export type IdentityRegistrationPayload = z.infer<typeof identityRegistrationPayloadSchema>;
export type IdentitySession = z.infer<typeof identitySessionSchema>;
export type { PersonType };

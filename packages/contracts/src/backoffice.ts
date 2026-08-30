import { z } from "zod";

import { identityEmailSchema, identityStatusSchema } from "./identity";
import { brazilianPhoneSchema, profileNameSchema } from "./profile";

export const backofficeLoginPayloadSchema = z.strictObject({
  email: identityEmailSchema,
  password: z.string().min(1).max(1_024),
});

export const backofficeLogoutPayloadSchema = z.strictObject({
  expectedScope: z.uuid(),
});

export const backofficeRuntimeUnlockPayloadSchema = z.strictObject({
  key: z.string().regex(/^[A-Za-z0-9_-]{43}$/u, "A chave local possui formato inválido."),
});

export const backofficeRuntimeUnlockResultSchema = z.strictObject({
  expiresAt: z.iso.datetime(),
});

const idempotentBackofficeCommandSchema = z.strictObject({
  expectedScope: z.uuid(),
  idempotencyKey: z.uuid(),
});

export const platformRoleSchema = z.enum(["support", "admin"]);
export const platformRolesSchema = z
  .array(platformRoleSchema)
  .max(2)
  .refine((roles) => new Set(roles).size === roles.length, "Papéis duplicados não são permitidos.");

export const backofficeSessionSchema = z.discriminatedUnion("authenticated", [
  z.strictObject({ authenticated: z.literal(false) }),
  z.strictObject({
    authenticated: z.literal(true),
    authorizationVersion: z.number().int().nonnegative().safe(),
    email: identityEmailSchema,
    expiresAt: z.iso.datetime(),
    runtimeUnlockExpiresAt: z.iso.datetime().nullable(),
    scope: z.uuid(),
    strongAuthenticationExpiresAt: z.iso.datetime(),
  }),
]);

export const backofficeUserSummarySchema = z.strictObject({
  accountVersion: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  emailMasked: z.string().min(3).max(254),
  id: z.uuid(),
  status: identityStatusSchema,
});

export const backofficeUserListSchema = z.strictObject({
  items: z.array(backofficeUserSummarySchema).max(50),
  nextCursor: z.string().min(1).max(512).nullable(),
  scope: z.uuid(),
});

export const backofficeUserQuerySchema = z.strictObject({
  cursor: z.string().min(1).max(512).nullable().optional(),
  query: z.string().trim().max(160).optional(),
});

export const backofficeUserPiiSchema = z.strictObject({
  additionalDocument: z.string().min(3).max(40).nullable(),
  email: identityEmailSchema,
  name: profileNameSchema.nullable(),
  phoneE164: brazilianPhoneSchema.nullable(),
  scope: z.uuid(),
  taxId: z.string().min(11).max(14).nullable(),
  userId: z.uuid(),
});

export const backofficePiiReasonSchema = z.enum([
  "identity_verification",
  "legal_request",
  "security_investigation",
  "support_case",
]);

export const backofficeTaxonomyKindSchema = z.enum(["studioType", "tag", "amenity"]);
export const backofficeTaxonomySlugSchema = z
  .string()
  .trim()
  .min(2, "Use pelo menos 2 caracteres.")
  .max(80, "Use no máximo 80 caracteres.")
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, "Use letras minúsculas, números e hífens.");
export const backofficeTaxonomyNameSchema = z
  .string()
  .trim()
  .min(2, "Use pelo menos 2 caracteres.")
  .max(80, "Use no máximo 80 caracteres.");
export const backofficeTaxonomySortOrderSchema = z.number().int().min(0).max(32_767);

export const backofficeTaxonomyItemSchema = z.strictObject({
  active: z.boolean(),
  id: z.uuid(),
  kind: backofficeTaxonomyKindSchema,
  name: backofficeTaxonomyNameSchema,
  slug: backofficeTaxonomySlugSchema,
  sortOrder: backofficeTaxonomySortOrderSchema,
  updatedAt: z.iso.datetime(),
  usageCount: z.number().int().nonnegative(),
  version: z.number().int().nonnegative(),
});

export const backofficeTaxonomyListSchema = z.strictObject({
  items: z.array(backofficeTaxonomyItemSchema).max(500),
  scope: z.uuid(),
});

export const backofficeTaxonomyImpactSchema = z.strictObject({
  active: z.boolean(),
  id: z.uuid(),
  kind: backofficeTaxonomyKindSchema,
  name: backofficeTaxonomyNameSchema,
  usageCount: z.number().int().nonnegative(),
});

const backofficeUserStatusPayloadSchema = z.strictObject({
  expectedAccountVersion: z.number().int().nonnegative(),
  userId: z.uuid(),
});

export const backofficeUserSuspendCommandSchema = idempotentBackofficeCommandSchema.extend({
  action: z.literal("backoffice.user.suspend"),
  payload: backofficeUserStatusPayloadSchema,
});

export const backofficeUserRestoreCommandSchema = idempotentBackofficeCommandSchema.extend({
  action: z.literal("backoffice.user.restore"),
  payload: backofficeUserStatusPayloadSchema,
});

export const backofficeUserRevealPiiCommandSchema = idempotentBackofficeCommandSchema.extend({
  action: z.literal("backoffice.user.revealPii"),
  payload: z.strictObject({
    reason: backofficePiiReasonSchema,
    userId: z.uuid(),
  }),
});

const backofficeAccessPayloadSchema = z.strictObject({
  expectedAccountVersion: z.number().int().nonnegative(),
  userId: z.uuid(),
});

export const backofficeAccessGrantSupportCommandSchema = idempotentBackofficeCommandSchema.extend({
  action: z.literal("backoffice.access.grantSupport"),
  payload: backofficeAccessPayloadSchema,
});

export const backofficeAccessRevokeSupportCommandSchema = idempotentBackofficeCommandSchema.extend({
  action: z.literal("backoffice.access.revokeSupport"),
  payload: backofficeAccessPayloadSchema,
});

export const backofficeAccessGrantAdminCommandSchema = idempotentBackofficeCommandSchema.extend({
  action: z.literal("backoffice.access.grantAdmin"),
  payload: backofficeAccessPayloadSchema,
});

export const backofficeAccessRevokeAdminCommandSchema = idempotentBackofficeCommandSchema.extend({
  action: z.literal("backoffice.access.revokeAdmin"),
  payload: backofficeAccessPayloadSchema,
});

export const backofficeTaxonomyUpsertCommandSchema = idempotentBackofficeCommandSchema.extend({
  action: z.literal("backoffice.taxonomy.upsert"),
  payload: z
    .strictObject({
      id: z.uuid().optional(),
      expectedVersion: z.number().int().nonnegative().optional(),
      kind: backofficeTaxonomyKindSchema,
      name: backofficeTaxonomyNameSchema,
      slug: backofficeTaxonomySlugSchema,
      sortOrder: backofficeTaxonomySortOrderSchema,
    })
    .refine((value) => (value.id === undefined) === (value.expectedVersion === undefined), {
      message: "Uma edição exige o item e a versão esperada.",
      path: ["expectedVersion"],
    }),
});

export const backofficeTaxonomySetActiveCommandSchema = idempotentBackofficeCommandSchema.extend({
  action: z.literal("backoffice.taxonomy.setActive"),
  payload: z.strictObject({
    active: z.boolean(),
    expectedVersion: z.number().int().nonnegative(),
    id: z.uuid(),
    kind: backofficeTaxonomyKindSchema,
  }),
});

export const backofficeCommandSchema = z.discriminatedUnion("action", [
  backofficeUserSuspendCommandSchema,
  backofficeUserRestoreCommandSchema,
  backofficeUserRevealPiiCommandSchema,
  backofficeAccessGrantSupportCommandSchema,
  backofficeAccessRevokeSupportCommandSchema,
  backofficeAccessGrantAdminCommandSchema,
  backofficeAccessRevokeAdminCommandSchema,
  backofficeTaxonomyUpsertCommandSchema,
  backofficeTaxonomySetActiveCommandSchema,
]);

export type BackofficeAccessCommand =
  | z.infer<typeof backofficeAccessGrantAdminCommandSchema>
  | z.infer<typeof backofficeAccessGrantSupportCommandSchema>
  | z.infer<typeof backofficeAccessRevokeAdminCommandSchema>
  | z.infer<typeof backofficeAccessRevokeSupportCommandSchema>;
export type BackofficeCommand = z.infer<typeof backofficeCommandSchema>;
export type BackofficeLoginPayload = z.infer<typeof backofficeLoginPayloadSchema>;
export type BackofficeLogoutPayload = z.infer<typeof backofficeLogoutPayloadSchema>;
export type BackofficePiiReason = z.infer<typeof backofficePiiReasonSchema>;
export type BackofficeRuntimeUnlockPayload = z.infer<typeof backofficeRuntimeUnlockPayloadSchema>;
export type BackofficeRuntimeUnlockResult = z.infer<typeof backofficeRuntimeUnlockResultSchema>;
export type BackofficeSession = z.infer<typeof backofficeSessionSchema>;
export type BackofficeTaxonomyImpact = z.infer<typeof backofficeTaxonomyImpactSchema>;
export type BackofficeTaxonomyItem = z.infer<typeof backofficeTaxonomyItemSchema>;
export type BackofficeTaxonomyKind = z.infer<typeof backofficeTaxonomyKindSchema>;
export type BackofficeTaxonomyList = z.infer<typeof backofficeTaxonomyListSchema>;
export type BackofficeTaxonomySetActiveCommand = z.infer<
  typeof backofficeTaxonomySetActiveCommandSchema
>;
export type BackofficeTaxonomyUpsertCommand = z.infer<typeof backofficeTaxonomyUpsertCommandSchema>;
export type BackofficeUserList = z.infer<typeof backofficeUserListSchema>;
export type BackofficeUserPii = z.infer<typeof backofficeUserPiiSchema>;
export type BackofficeUserQuery = z.infer<typeof backofficeUserQuerySchema>;
export type BackofficeUserRevealPiiCommand = z.infer<typeof backofficeUserRevealPiiCommandSchema>;
export type BackofficeUserStatusCommand =
  | z.infer<typeof backofficeUserRestoreCommandSchema>
  | z.infer<typeof backofficeUserSuspendCommandSchema>;
export type BackofficeUserSummary = z.infer<typeof backofficeUserSummarySchema>;
export type PlatformRole = z.infer<typeof platformRoleSchema>;

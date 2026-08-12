import "server-only";

import {
  parseDalDatabaseUrl,
  profileCompletePayloadSchema,
  profileVersionSchema,
  profileUpdatePayloadSchema,
  type ProfileCompletePayload,
  type ProfileUpdatePayload,
} from "@set-livre/contracts";
import { Pool } from "pg";
import { z } from "zod";

const environmentSchema = z.object({ DATABASE_URL_APP_DAL: z.string() });
const userIdSchema = z.uuid();
const databaseProfileVersionSchema = z.union([
  profileVersionSchema,
  z
    .string()
    .regex(/^(?:0|[1-9][0-9]*)$/u)
    .transform(Number)
    .pipe(profileVersionSchema),
]);
const profileRowSchema = z.strictObject({
  additional_document_masked: z.string().nullable(),
  color_scheme: z.enum(["system", "light", "dark"]),
  name: z.string().nullable(),
  person_type: z.enum(["individual", "company"]),
  phone_e164: z.string().nullable(),
  preferences_version: databaseProfileVersionSchema,
  profile_completed: z.boolean(),
  profile_version: databaseProfileVersionSchema,
  status: z.enum(["active", "suspended"]),
  tax_id_masked: z.string().nullable(),
  user_id: z.uuid(),
});

export type ProfileDalRow = z.infer<typeof profileRowSchema>;

let connection: Pool | undefined;

function profileDatabaseConnection() {
  if (connection !== undefined) {
    return connection;
  }
  const environment = environmentSchema.parse(process.env);
  const parsed = parseDalDatabaseUrl(environment.DATABASE_URL_APP_DAL);
  connection = new Pool({
    allowExitOnIdle: true,
    application_name: "set-livre-web-profile",
    connectionString: parsed.connectionString,
    connectionTimeoutMillis: 1_000,
    idleTimeoutMillis: 10_000,
    max: 4,
    query_timeout: 2_000,
    statement_timeout: 2_000,
  });
  connection.on("error", () => undefined);
  return connection;
}

function exactlyOneProfile(rows: readonly unknown[]) {
  if (rows.length !== 1) {
    throw new Error("O DAL de perfil recebeu uma cardinalidade inesperada.");
  }
  return profileRowSchema.parse(rows[0]);
}

export function parseProfileDalRow(row: unknown) {
  return profileRowSchema.parse(row);
}

export async function completeMyProfile(userId: string, input: ProfileCompletePayload) {
  const parsedUserId = userIdSchema.parse(userId);
  const payload = profileCompletePayloadSchema.parse(input);
  const result = await profileDatabaseConnection().query(
    `select
       profile.user_id,
       profile.person_type,
       profile.status,
       profile.name,
       profile.phone_e164,
       profile.tax_id_masked,
       profile.additional_document_masked,
       profile.profile_completed,
       profile.profile_version,
       profile.color_scheme,
       profile.preferences_version
     from private.complete_profile(
         $1::uuid,
         $2::bigint,
         $3::text,
         $4::text,
         $5::text,
         $6::text,
         $7::text
       ) as profile`,
    [
      parsedUserId,
      payload.expectedProfileVersion,
      payload.personType,
      payload.name,
      payload.phone,
      payload.taxId,
      payload.additionalDocument,
    ],
  );
  return exactlyOneProfile(result.rows);
}

export async function updateMyProfileIdentity(
  userId: string,
  input: Extract<ProfileUpdatePayload, { section: "identity" }>,
) {
  const parsedUserId = userIdSchema.parse(userId);
  const payload = profileUpdatePayloadSchema.parse(input);
  if (payload.section !== "identity") {
    throw new Error("O DAL recebeu uma seção de perfil inesperada.");
  }
  const replaceTaxId = payload.taxIdChange.action === "replace";
  const replaceDocument = payload.documentChange.action !== "keep";
  const taxId = payload.taxIdChange.action === "replace" ? payload.taxIdChange.value : null;
  const additionalDocument =
    payload.documentChange.action === "replace" ? payload.documentChange.value : null;
  const result = await profileDatabaseConnection().query(
    `select
       profile.user_id,
       profile.person_type,
       profile.status,
       profile.name,
       profile.phone_e164,
       profile.tax_id_masked,
       profile.additional_document_masked,
       profile.profile_completed,
       profile.profile_version,
       profile.color_scheme,
       profile.preferences_version
     from private.update_profile_identity(
         $1::uuid,
         $2::bigint,
         $3::text,
         $4::text,
         $5::boolean,
         $6::text,
         $7::boolean,
         $8::text
       ) as profile`,
    [
      parsedUserId,
      payload.expectedProfileVersion,
      payload.name,
      payload.phone,
      replaceTaxId,
      taxId,
      replaceDocument,
      additionalDocument,
    ],
  );
  return exactlyOneProfile(result.rows);
}

export async function updateMyProfileAppearance(
  userId: string,
  input: Extract<ProfileUpdatePayload, { section: "appearance" }>,
) {
  const parsedUserId = userIdSchema.parse(userId);
  const payload = profileUpdatePayloadSchema.parse(input);
  if (payload.section !== "appearance") {
    throw new Error("O DAL recebeu uma seção de preferência inesperada.");
  }
  const result = await profileDatabaseConnection().query(
    `select
       profile.user_id,
       profile.person_type,
       profile.status,
       profile.name,
       profile.phone_e164,
       profile.tax_id_masked,
       profile.additional_document_masked,
       profile.profile_completed,
       profile.profile_version,
       profile.color_scheme,
       profile.preferences_version
     from private.update_profile_appearance($1::uuid, $2::bigint, $3::text) as profile`,
    [parsedUserId, payload.expectedPreferencesVersion, payload.colorScheme],
  );
  return exactlyOneProfile(result.rows);
}

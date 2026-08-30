import "server-only";

import {
  backofficeTaxonomyItemSchema,
  backofficeTaxonomyListSchema,
  backofficeUserListSchema,
  backofficeUserPiiSchema,
  backofficeUserSummarySchema,
  platformRolesSchema,
  type BackofficeAccessSetRoleCommand,
  type BackofficeTaxonomySetActiveCommand,
  type BackofficeTaxonomyUpsertCommand,
  type BackofficeUserRevealPiiCommand,
  type BackofficeUserSetStatusCommand,
} from "@set-livre/contracts";
import { z } from "zod";

import { backofficeDalPool } from "@/lib/server/dal-pool";

import type { BackofficeAuthContext } from "./auth-context";

const timestampSchema = z.coerce.date().transform((value) => value.toISOString());
const pgSafeIntegerSchema = z
  .union([z.bigint(), z.number(), z.string().regex(/^\d+$/u)])
  .transform((value) => Number(value))
  .pipe(z.number().int().nonnegative().safe());
const sessionRowSchema = z.strictObject({
  expires_at: timestampSchema,
  roles: platformRolesSchema,
  scope: z.uuid(),
  strong_authentication_expires_at: timestampSchema,
});
const userRowSchema = z.strictObject({
  account_version: pgSafeIntegerSchema,
  created_at: timestampSchema,
  cursor_created_at: z.iso.datetime(),
  email_masked: z.string().min(3).max(254),
  id: z.uuid(),
  name: z.string().nullable(),
  roles: platformRolesSchema,
  status: z.enum(["active", "suspended"]),
});
const taxonomyRowSchema = z.strictObject({
  active: z.boolean(),
  id: z.uuid(),
  kind: z.enum(["studioType", "tag", "amenity"]),
  name: z.string(),
  slug: z.string(),
  sort_order: z.number().int(),
  taxonomy_version: pgSafeIntegerSchema,
  updated_at: timestampSchema,
  usage_count: pgSafeIntegerSchema,
});
const userMutationResultSchema = backofficeUserSummarySchema.extend({
  createdAt: timestampSchema,
});
const taxonomyMutationResultSchema = backofficeTaxonomyItemSchema.extend({
  updatedAt: timestampSchema,
});
const cursorSchema = z.strictObject({ createdAt: z.iso.datetime(), id: z.uuid() });

export type BackofficeBinding = z.infer<typeof sessionRowSchema>;

function exactlyOne<T>(rows: readonly unknown[], schema: z.ZodType<T>, boundary: string): T {
  if (rows.length !== 1) {
    throw new Error(`Cardinalidade inesperada no DAL de backoffice: ${boundary}.`);
  }
  return schema.parse(rows[0]);
}

function bindingArguments(auth: BackofficeAuthContext) {
  return [auth.userId, auth.authSessionId, auth.authExpiresAt];
}

function encodeBackofficeUserCursor(value: z.infer<typeof cursorSchema>) {
  return Buffer.from(JSON.stringify(cursorSchema.parse(value)), "utf8").toString("base64url");
}

function decodeBackofficeUserCursor(value: string | null | undefined) {
  if (value === undefined || value === null) return null;
  if (value.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error("Cursor de usuários inválido.");
  }
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw new Error("non-canonical");
    return cursorSchema.parse(JSON.parse(bytes.toString("utf8")) as unknown);
  } catch {
    throw new Error("Cursor de usuários inválido.");
  }
}

export async function openBackofficeBinding(auth: BackofficeAuthContext) {
  const result = await backofficeDalPool().query(
    `select * from private.open_backoffice_session($1::uuid, $2::uuid, $3::timestamptz)`,
    bindingArguments(auth),
  );
  return exactlyOne(result.rows, sessionRowSchema, "open_backoffice_session");
}

export async function readBackofficeBinding(auth: BackofficeAuthContext) {
  const result = await backofficeDalPool().query(
    `select * from private.get_backoffice_session($1::uuid, $2::uuid, $3::timestamptz)`,
    bindingArguments(auth),
  );
  return exactlyOne(result.rows, sessionRowSchema, "get_backoffice_session");
}

export async function closeBackofficeBinding(
  auth: Pick<BackofficeAuthContext, "authSessionId" | "userId">,
) {
  const result = await backofficeDalPool().query(
    `select private.close_backoffice_session($1::uuid, $2::uuid) as closed`,
    [auth.userId, auth.authSessionId],
  );
  return exactlyOne(
    result.rows,
    z.strictObject({ closed: z.boolean() }),
    "close_backoffice_session",
  ).closed;
}

export async function listBackofficeUsers(input: {
  auth: BackofficeAuthContext;
  cursor?: string | null | undefined;
  query?: string | undefined;
}) {
  const cursor = decodeBackofficeUserCursor(input.cursor);
  const result = await backofficeDalPool().query(
    `select
       listed.*,
       pg_catalog.to_char(
         listed.created_at at time zone 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
       ) as cursor_created_at
     from private.list_backoffice_users(
       $1::uuid, $2::uuid, $3::timestamptz, $4::text,
       $5::timestamptz, $6::uuid, $7::integer
     ) as listed`,
    [
      ...bindingArguments(input.auth),
      input.query ?? null,
      cursor?.createdAt ?? null,
      cursor?.id ?? null,
      51,
    ],
  );
  const rows = z.array(userRowSchema).max(51).parse(result.rows);
  const visibleRows = rows.slice(0, 50);
  const visible = visibleRows.map((row) =>
    backofficeUserSummarySchema.parse({
      accountVersion: row.account_version,
      createdAt: row.created_at,
      emailMasked: row.email_masked,
      id: row.id,
      name: row.name,
      roles: row.roles,
      status: row.status,
    }),
  );
  const cursorSource = rows.length > 50 ? visibleRows.at(-1) : undefined;
  return backofficeUserListSchema.parse({
    items: visible,
    nextCursor:
      cursorSource === undefined
        ? null
        : encodeBackofficeUserCursor({
            createdAt: cursorSource.cursor_created_at,
            id: cursorSource.id,
          }),
    scope: input.auth.userId,
  });
}

export async function listBackofficeTaxonomies(auth: BackofficeAuthContext) {
  const result = await backofficeDalPool().query(
    `select * from private.list_backoffice_taxonomies($1::uuid, $2::uuid, $3::timestamptz)`,
    bindingArguments(auth),
  );
  const rows = z.array(taxonomyRowSchema).max(501).parse(result.rows);
  if (rows.length > 500) {
    throw new Error("A taxonomia excedeu o limite operacional do backoffice.");
  }
  return backofficeTaxonomyListSchema.parse({
    items: rows.map((row) => ({
      active: row.active,
      id: row.id,
      kind: row.kind,
      name: row.name,
      slug: row.slug,
      sortOrder: row.sort_order,
      updatedAt: row.updated_at,
      usageCount: row.usage_count,
      version: row.taxonomy_version,
    })),
    scope: auth.userId,
  });
}

export async function setBackofficeUserStatus(input: {
  auth: BackofficeAuthContext;
  command: BackofficeUserSetStatusCommand;
  requestId: string;
}) {
  const { payload } = input.command;
  const result = await backofficeDalPool().query(
    `select private.set_backoffice_user_status(
       $1::uuid, $2::uuid, $3::timestamptz, $4::uuid, $5::bigint,
       $6::text, $7::uuid, $8::uuid
     ) as result`,
    [
      ...bindingArguments(input.auth),
      payload.userId,
      payload.expectedAccountVersion,
      payload.status,
      input.command.idempotencyKey,
      input.requestId,
    ],
  );
  return exactlyOne(
    result.rows,
    z.strictObject({ result: userMutationResultSchema }),
    "set_backoffice_user_status",
  ).result;
}

export async function revealBackofficeUserPii(input: {
  auth: BackofficeAuthContext;
  command: BackofficeUserRevealPiiCommand;
  requestId: string;
}) {
  const result = await backofficeDalPool().query(
    `select private.reveal_backoffice_user_pii(
       $1::uuid, $2::uuid, $3::timestamptz, $4::uuid, $5::text, $6::uuid, $7::uuid
     ) as result`,
    [
      ...bindingArguments(input.auth),
      input.command.payload.userId,
      input.command.payload.reason,
      input.command.idempotencyKey,
      input.requestId,
    ],
  );
  return exactlyOne(
    result.rows,
    z.strictObject({ result: backofficeUserPiiSchema }),
    "reveal_backoffice_user_pii",
  ).result;
}

export async function setBackofficeUserRole(input: {
  auth: BackofficeAuthContext;
  command: BackofficeAccessSetRoleCommand;
  requestId: string;
}) {
  const { payload } = input.command;
  const result = await backofficeDalPool().query(
    `select private.set_backoffice_user_role(
       $1::uuid, $2::uuid, $3::timestamptz, $4::uuid, $5::text[],
       $6::text, $7::boolean, $8::uuid, $9::uuid
     ) as result`,
    [
      ...bindingArguments(input.auth),
      payload.userId,
      payload.expectedRoles,
      payload.role,
      payload.enabled,
      input.command.idempotencyKey,
      input.requestId,
    ],
  );
  return exactlyOne(
    result.rows,
    z.strictObject({ result: userMutationResultSchema }),
    "set_backoffice_user_role",
  ).result;
}

export async function upsertBackofficeTaxonomy(input: {
  auth: BackofficeAuthContext;
  command: BackofficeTaxonomyUpsertCommand;
  requestId: string;
}) {
  const { payload } = input.command;
  const result = await backofficeDalPool().query(
    `select private.upsert_backoffice_taxonomy(
       $1::uuid, $2::uuid, $3::timestamptz, $4::text, $5::uuid,
       $6::bigint, $7::text, $8::text, $9::integer, $10::uuid, $11::uuid
     ) as result`,
    [
      ...bindingArguments(input.auth),
      payload.kind,
      payload.id ?? null,
      payload.expectedVersion ?? null,
      payload.slug,
      payload.name,
      payload.sortOrder,
      input.command.idempotencyKey,
      input.requestId,
    ],
  );
  return exactlyOne(
    result.rows,
    z.strictObject({ result: taxonomyMutationResultSchema }),
    "upsert_backoffice_taxonomy",
  ).result;
}

export async function setBackofficeTaxonomyActive(input: {
  auth: BackofficeAuthContext;
  command: BackofficeTaxonomySetActiveCommand;
  requestId: string;
}) {
  const { payload } = input.command;
  const result = await backofficeDalPool().query(
    `select private.set_backoffice_taxonomy_active(
       $1::uuid, $2::uuid, $3::timestamptz, $4::text, $5::uuid,
       $6::bigint, $7::boolean, $8::uuid, $9::uuid
     ) as result`,
    [
      ...bindingArguments(input.auth),
      payload.kind,
      payload.id,
      payload.expectedVersion,
      payload.active,
      input.command.idempotencyKey,
      input.requestId,
    ],
  );
  return exactlyOne(
    result.rows,
    z.strictObject({ result: taxonomyMutationResultSchema }),
    "set_backoffice_taxonomy_active",
  ).result;
}

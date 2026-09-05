import "server-only";

import {
  backofficeTaxonomyItemSchema,
  backofficeTaxonomyListSchema,
  backofficeStudioCommandResultSchema,
  backofficeStudioReviewDetailRecordSchema,
  backofficeStudioReviewQueueItemSchema,
  backofficeStudioReviewQueueSchema,
  backofficeUserListSchema,
  backofficeUserPiiSchema,
  backofficeUserSummarySchema,
  platformRolesSchema,
  type BackofficeAccessCommand,
  type BackofficeStudioCommand,
  type BackofficeStudioReviewQueueQuery,
  type BackofficeTaxonomyStatusCommand,
  type BackofficeTaxonomyUpsertCommand,
  type BackofficeUserRevealPiiCommand,
  type BackofficeUserStatusCommand,
} from "@set-livre/contracts";
import { z } from "zod";

import { backofficeDalPool } from "../../../lib/server/dal-pool";

import type { BackofficeAuthContext } from "./auth-context";
import {
  decodeBackofficeStudioReviewCursor,
  decodeBackofficeUserCursor,
  encodeBackofficeStudioReviewCursor,
  encodeBackofficeUserCursor,
} from "./backoffice-cursor";

const timestampSchema = z.coerce.date().transform((value) => value.toISOString());
const pgSafeIntegerSchema = z
  .union([z.bigint(), z.number(), z.string().regex(/^\d+$/u)])
  .transform((value) => Number(value))
  .pipe(z.number().int().nonnegative().safe());
const sessionRowSchema = z.strictObject({
  authorization_version: pgSafeIntegerSchema,
  expires_at: timestampSchema,
  roles: platformRolesSchema,
  scope: z.uuid(),
  strong_authentication_expires_at: timestampSchema,
});
const userRowSchema = z.strictObject({
  account_version: pgSafeIntegerSchema,
  created_at: timestampSchema,
  email_masked: z.string().min(3).max(254),
  id: z.uuid(),
  status: z.enum(["active", "suspended"]),
});
const listedUserRowSchema = userRowSchema.extend({ cursor_created_at: z.iso.datetime() });
const accessRowSchema = userRowSchema.extend({
  profile_completed: z.boolean(),
  roles: platformRolesSchema,
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
const studioReviewQueueRowSchema = z.strictObject({
  disabled_from_status: z.enum(["published", "changes_pending", "paused"]).nullable(),
  has_published: z.boolean(),
  name: z.string().trim().min(2).max(120),
  publication_version: pgSafeIntegerSchema.pipe(z.number().int().positive()),
  review_state: z.enum(["reviewPending", "moderation", "disabled"]),
  revision_id: z.uuid(),
  sort_sequence: pgSafeIntegerSchema,
  studio_id: z.uuid(),
  studio_status: z.enum([
    "draft",
    "pending_review",
    "published",
    "changes_pending",
    "paused",
    "rejected",
    "disabled",
  ]),
  submitted_at: timestampSchema.nullable(),
});

export type BackofficeBinding = z.infer<typeof sessionRowSchema>;

export class BackofficeCursorError extends Error {
  override readonly message = "O cursor informado não foi emitido por esta listagem.";
  override readonly name = "BackofficeCursorError";
}

function exactlyOne<T>(rows: readonly unknown[], schema: z.ZodType<T>, boundary: string): T {
  if (rows.length !== 1) {
    throw new Error(`Cardinalidade inesperada no DAL de backoffice: ${boundary}.`);
  }
  return schema.parse(rows[0]);
}

function bindingArguments(auth: BackofficeAuthContext) {
  return [auth.userId, auth.authSessionId, auth.authExpiresAt];
}

function parseBackofficeUserCursor(input: {
  auth: BackofficeAuthContext;
  query: string | null;
  value: string | null | undefined;
}) {
  const { value } = input;
  if (value === undefined || value === null) return null;
  const cursor = decodeBackofficeUserCursor({
    authSessionId: input.auth.authSessionId,
    query: input.query,
    scope: input.auth.userId,
    value,
  });
  if (cursor === undefined) throw new BackofficeCursorError();
  return cursor;
}

function parseBackofficeStudioReviewCursor(input: {
  auth: BackofficeAuthContext;
  value: string | null | undefined;
}) {
  const { value } = input;
  if (value === undefined || value === null) return null;
  const cursor = decodeBackofficeStudioReviewCursor({
    authSessionId: input.auth.authSessionId,
    scope: input.auth.userId,
    value,
  });
  if (cursor === undefined) throw new BackofficeCursorError();
  return cursor;
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
  const query = input.query?.trim().toLocaleLowerCase("pt-BR") || null;
  const cursor = parseBackofficeUserCursor({ auth: input.auth, query, value: input.cursor });
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
    [...bindingArguments(input.auth), query, cursor?.createdAt ?? null, cursor?.id ?? null, 51],
  );
  const rows = z.array(listedUserRowSchema).max(51).parse(result.rows);
  const visibleRows = rows.slice(0, 50);
  const visible = visibleRows.map((row) =>
    backofficeUserSummarySchema.parse({
      accountVersion: row.account_version,
      createdAt: row.created_at,
      emailMasked: row.email_masked,
      id: row.id,
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
            authSessionId: input.auth.authSessionId,
            createdAt: cursorSource.cursor_created_at,
            id: cursorSource.id,
            query,
            scope: input.auth.userId,
          }),
    scope: input.auth.userId,
  });
}

export async function getBackofficeUserAccess(input: {
  auth: BackofficeAuthContext;
  userId: string;
}) {
  const result = await backofficeDalPool().query(
    `select * from private.get_backoffice_user_access($1::uuid, $2::uuid, $3::timestamptz, $4::uuid)`,
    [...bindingArguments(input.auth), input.userId],
  );
  return exactlyOne(result.rows, accessRowSchema, "get_backoffice_user_access");
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
  command: BackofficeUserStatusCommand;
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
      input.command.action,
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
  command: BackofficeAccessCommand;
  requestId: string;
}) {
  const { payload } = input.command;
  const result = await backofficeDalPool().query(
    `select private.set_backoffice_user_role(
       $1::uuid, $2::uuid, $3::timestamptz, $4::uuid, $5::bigint,
       $6::text, $7::uuid, $8::uuid
     ) as result`,
    [
      ...bindingArguments(input.auth),
      payload.userId,
      payload.expectedAccountVersion,
      input.command.action,
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

export async function transitionBackofficeTaxonomy(input: {
  auth: BackofficeAuthContext;
  command: BackofficeTaxonomyStatusCommand;
  requestId: string;
}) {
  const { payload } = input.command;
  const result = await backofficeDalPool().query(
    `select private.transition_backoffice_taxonomy(
       $1::uuid, $2::uuid, $3::timestamptz, $4::text, $5::uuid,
       $6::bigint, $7::text, $8::uuid, $9::uuid
     ) as result`,
    [
      ...bindingArguments(input.auth),
      payload.kind,
      payload.id,
      payload.expectedVersion,
      input.command.action,
      input.command.idempotencyKey,
      input.requestId,
    ],
  );
  return exactlyOne(
    result.rows,
    z.strictObject({ result: taxonomyMutationResultSchema }),
    "transition_backoffice_taxonomy",
  ).result;
}

export async function listBackofficeStudioReviews(input: {
  auth: BackofficeAuthContext;
  query: BackofficeStudioReviewQueueQuery;
}) {
  const cursor = parseBackofficeStudioReviewCursor({
    auth: input.auth,
    value: input.query.cursor,
  });
  const result = await backofficeDalPool().query(
    `select
       disabled_from_status,
       has_published,
       name,
       publication_version,
       review_state,
       revision_id,
       sort_sequence,
       studio_id,
       studio_status,
       submitted_at
     from private.list_backoffice_studio_reviews(
       $1::uuid, $2::uuid, $3::timestamptz, $4::bigint, $5::uuid, $6::integer
     )`,
    [...bindingArguments(input.auth), cursor?.sequence ?? null, cursor?.studioId ?? null, 51],
  );
  const rows = z.array(studioReviewQueueRowSchema).max(51).parse(result.rows);
  const visibleRows = rows.slice(0, 50);
  const cursorSource = rows.length > 50 ? visibleRows.at(-1) : undefined;
  return backofficeStudioReviewQueueSchema.parse({
    items: visibleRows.map((row) =>
      backofficeStudioReviewQueueItemSchema.parse({
        disabledFromStatus: row.disabled_from_status,
        hasPublished: row.has_published,
        name: row.name,
        publicationVersion: row.publication_version,
        reviewState: row.review_state,
        revisionId: row.revision_id,
        studioId: row.studio_id,
        studioStatus: row.studio_status,
        submittedAt: row.submitted_at,
      }),
    ),
    nextCursor:
      cursorSource === undefined
        ? null
        : encodeBackofficeStudioReviewCursor({
            authSessionId: input.auth.authSessionId,
            scope: input.auth.userId,
            sequence: cursorSource.sort_sequence,
            studioId: cursorSource.studio_id,
          }),
    scope: input.auth.userId,
  });
}

export async function getBackofficeStudioReview(input: {
  auth: BackofficeAuthContext;
  studioId: string;
  touchActivity: boolean;
}) {
  const result = await backofficeDalPool().query(
    `select private.get_backoffice_studio_review(
       $1::uuid, $2::uuid, $3::timestamptz, $4::uuid, $5::boolean
     ) as result`,
    [...bindingArguments(input.auth), input.studioId, input.touchActivity],
  );
  return exactlyOne(
    result.rows,
    z.strictObject({ result: backofficeStudioReviewDetailRecordSchema }),
    "get_backoffice_studio_review",
  ).result;
}

export async function executeBackofficeStudioCommand(input: {
  auth: BackofficeAuthContext;
  command: BackofficeStudioCommand;
  requestId: string;
}) {
  const { command } = input;
  const expectedRevisionId =
    command.action === "backoffice.studio.approve" || command.action === "backoffice.studio.reject"
      ? command.payload.expectedRevisionId
      : null;
  const rejectionReason =
    command.action === "backoffice.studio.reject" ? command.payload.reason : null;
  const result = await backofficeDalPool().query(
    `select private.execute_backoffice_studio_command(
       $1::uuid, $2::uuid, $3::timestamptz, $4::uuid, $5::uuid,
       $6::bigint, $7::text, $8::text, $9::uuid, $10::uuid
     ) as result`,
    [
      ...bindingArguments(input.auth),
      command.payload.studioId,
      expectedRevisionId,
      command.payload.expectedPublicationVersion,
      command.action,
      rejectionReason,
      command.idempotencyKey,
      input.requestId,
    ],
  );
  return exactlyOne(
    result.rows,
    z.strictObject({ result: backofficeStudioCommandResultSchema }),
    "execute_backoffice_studio_command",
  ).result;
}

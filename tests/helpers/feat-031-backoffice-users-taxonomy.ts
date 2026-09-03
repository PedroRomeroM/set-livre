import { randomUUID } from "node:crypto";

import { expect, type Page } from "@playwright/test";
import { z } from "zod";

import {
  withE2EAdminClient,
  withE2EDalClient,
  type E2EDatabaseClient,
} from "./e2e-database-preflight";
import {
  cleanupFeat003QaIdentity,
  completeFeat003Profile,
  createFeat003ProfileSecrets,
  createFeat003QaIdentity,
  registerAndConfirmFeat003Identity,
  type Feat003ProfileSecrets,
  type Feat003QaIdentity,
} from "./feat-003-profile-account";
import {
  getFeat002PasswordControl,
  stageFeat002PasswordForSubmission,
} from "./feat-002-authentication";
import { cleanupFeat006OwnedStudioRows } from "./feat-006-studio-core-revision";
import { cleanupLocalAuthUser } from "./local-auth-cleanup";
import { assertQaAuthEmail } from "./local-auth-mailpit";
import { readSafeE2EEnvironment } from "./e2e-environment";

const directIdentitySchema = z.strictObject({
  email: z.email(),
  name: z.string().min(1),
  phone: z.string(),
  taxId: z.string(),
  userId: z.uuid(),
});
const bulkIdentitySchema = z.strictObject({ email: z.email(), id: z.uuid() });

export type Feat031Operator = Feat003QaIdentity & { secrets: Feat003ProfileSecrets };
export type Feat031DirectIdentity = z.infer<typeof directIdentitySchema>;

function safeNamespace(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
}

function decimalEntropy(length: number) {
  return [...randomUUID().replaceAll("-", "")]
    .map((character) => (Number.parseInt(character, 16) % 10).toString())
    .join("")
    .slice(0, length);
}

async function withFeat031AdminPool<T>(operation: (client: E2EDatabaseClient) => Promise<T>) {
  return withE2EAdminClient(operation);
}

async function withFeat031DalPool<T>(operation: (client: E2EDatabaseClient) => Promise<T>) {
  return withE2EDalClient(operation);
}

export function createFeat031Operator(
  testInfo: Readonly<{ project: Readonly<{ name: string }> }>,
  scenario: string,
): Feat031Operator {
  return {
    ...createFeat003QaIdentity(testInfo, `feat031_${scenario}`),
    secrets: createFeat003ProfileSecrets("individual"),
  };
}

export async function provisionFeat031Operator(
  page: Page,
  operator: Feat031Operator,
  role: "admin" | "reviewer" | "support",
  suffix: string,
) {
  await registerAndConfirmFeat003Identity(page, operator, "individual");
  const account = await page.goto("/conta");
  expect(account?.status()).toBe(200);
  await completeFeat003Profile(page, {
    name: `Operador ${role} QA ${suffix}`,
    personType: "individual",
    phone: `+55419${decimalEntropy(8)}`,
    secrets: operator.secrets,
  });
  if (operator.userId === undefined) throw new Error("O operador FEAT-031 não publicou userId.");
  await withFeat031AdminPool(async (pool) => {
    const result = await pool.query(
      `insert into public.platform_roles (user_id, role, granted_by)
       values ($1::uuid, $2::text, null)
       returning user_id`,
      [operator.userId, role],
    );
    if (result.rowCount !== 1) throw new Error("O papel operacional FEAT-031 não foi criado.");
  });
}

export async function loginFeat031Backoffice(
  page: Page,
  operator: Feat031Operator,
  options: { landing?: "/estudios" | "/usuarios"; unlockRuntime?: boolean } = {},
) {
  const safeE2EEnvironment = readSafeE2EEnvironment();
  const login = await page.goto(`${safeE2EEnvironment.backofficeBaseUrl}/entrar`);
  expect(login?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: "Operação Set Livre" })).toBeVisible();
  const emailControl = page.getByRole("textbox", { name: "E-mail" });
  const passwordControl = getFeat002PasswordControl(page, "Senha");
  const submit = page.getByRole("button", { name: "Entrar no backoffice" });
  await expect(page.getByText("Preparando o acesso seguro…", { exact: true })).toHaveCount(0);
  await expect(emailControl).toBeEnabled();
  await expect(passwordControl).toBeEnabled();
  await expect(submit).toBeEnabled();
  await emailControl.fill(operator.email);
  await stageFeat002PasswordForSubmission(passwordControl, operator.password);
  await expect(emailControl).toHaveValue(operator.email);
  await submit.click();
  const landing = options.landing ?? "/usuarios";
  await expect.poll(() => new URL(page.url()).pathname, { timeout: 15_000 }).toBe(landing);
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: landing === "/estudios" ? "Estúdios" : "Usuários",
    }),
  ).toBeVisible();
  if (options.unlockRuntime === false) return;
  await unlockFeat031Backoffice(page);
}

export async function unlockFeat031Backoffice(page: Page) {
  const safeE2EEnvironment = readSafeE2EEnvironment();
  const runtimeKeyControl = page.getByLabel("Chave local de desbloqueio");
  const submit = page.getByRole("button", { name: "Desbloquear operações" });
  await expect(runtimeKeyControl).toBeEnabled();
  await expect(submit).toBeEnabled();
  await stageFeat002PasswordForSubmission(
    runtimeKeyControl,
    safeE2EEnvironment.backofficeRuntimeUnlockKey,
    ["runtimeUnlockKey"],
  );
  await submit.click();
  await expect(
    page.getByRole("status").filter({ hasText: "Operações desbloqueadas" }),
  ).toBeVisible();
}

async function createFeat031DirectIdentityWithProfile(
  scenario: string,
  options: Readonly<{ owner: boolean; profileCompleted: boolean }>,
) {
  const userId = randomUUID();
  const namespace = `qa_f031_${safeNamespace(scenario)}_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const email = assertQaAuthEmail(`${namespace}@example.test`);
  const secrets = createFeat003ProfileSecrets("individual");
  const identity = directIdentitySchema.parse({
    email,
    name: `Pessoa QA ${scenario}`,
    phone: `+55419${decimalEntropy(8)}`,
    taxId: secrets.taxId,
    userId,
  });
  await withFeat031AdminPool(async (pool) => {
    await pool.query("begin");
    try {
      const intent = await pool.query<{ id: string }>(
        `select private.create_signup_legal_intent(
           '00000000-0000-4000-8000-000000000201'::uuid,
           '00000000-0000-4000-8000-000000000202'::uuid,
           'individual'::text, $1::uuid, '{}'::jsonb
         ) as id`,
        [randomUUID()],
      );
      const legalIntent = z
        .array(z.strictObject({ id: z.uuid() }))
        .length(1)
        .parse(intent.rows)[0];
      await pool.query(
        `insert into auth.users (
           id, aud, role, email, encrypted_password, email_confirmed_at,
           raw_app_meta_data, raw_user_meta_data, created_at, updated_at
         ) values (
           $1::uuid, 'authenticated', 'authenticated', $2::text, '', pg_catalog.now(),
           '{"provider":"email","providers":["email"]}'::jsonb,
           pg_catalog.jsonb_build_object('sl_legal_intent', $3::text),
           pg_catalog.now(), pg_catalog.now()
         )`,
        [identity.userId, identity.email, legalIntent?.id],
      );
      if (options.profileCompleted) {
        await pool.query(
          `select private.complete_profile(
             $1::uuid, 0, 'individual', $2::text, $3::text, $4::text, null
           )`,
          [identity.userId, identity.name, identity.phone, identity.taxId],
        );
      }
      if (options.owner) {
        if (!options.profileCompleted) {
          throw new Error("Uma identidade incompleta não pode ser ativada como dona.");
        }
        await pool.query(
          `select private.activate_owner(
             $1::uuid, '00000000-0000-4000-8000-000000000204'::uuid,
             $2::uuid, $3::uuid, null
           )`,
          [identity.userId, randomUUID(), randomUUID()],
        );
      }
      await pool.query("commit");
    } catch (error) {
      await pool.query("rollback");
      throw error;
    }
  });
  return identity;
}

export function createFeat031DirectIdentity(scenario: string, owner = false) {
  return createFeat031DirectIdentityWithProfile(scenario, { owner, profileCompleted: true });
}

export function createFeat031IncompleteIdentity(scenario: string) {
  return createFeat031DirectIdentityWithProfile(scenario, {
    owner: false,
    profileCompleted: false,
  });
}

export async function createFeat031BulkUsers(scenario: string, count = 52) {
  const namespace = `qa_f031_bulk_${safeNamespace(scenario)}_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  return withFeat031AdminPool(async (pool) => {
    const inserted = await pool.query(
      `with generated as materialized (
         select
           extensions.gen_random_uuid() as id,
           private.create_signup_legal_intent(
             '00000000-0000-4000-8000-000000000201'::uuid,
             '00000000-0000-4000-8000-000000000202'::uuid,
             'individual'::text,
             extensions.gen_random_uuid(),
             '{}'::jsonb
           ) as legal_intent,
           series.index
         from pg_catalog.generate_series(1, $2::integer) as series(index)
       ), inserted as (
         insert into auth.users (
           id, aud, role, email, encrypted_password, email_confirmed_at,
           raw_app_meta_data, raw_user_meta_data, created_at, updated_at
         )
         select
           generated.id,
           'authenticated',
           'authenticated',
           $1::text || '_' || pg_catalog.lpad(generated.index::text, 3, '0') || '@example.test',
           '',
           pg_catalog.now(),
           '{"provider":"email","providers":["email"]}'::jsonb,
           pg_catalog.jsonb_build_object('sl_legal_intent', generated.legal_intent::text),
           pg_catalog.clock_timestamp(),
           pg_catalog.clock_timestamp()
         from generated
         returning id, email
       )
       select id, email from inserted order by email`,
      [namespace, count],
    );
    const identities = z.array(bulkIdentitySchema).length(count).parse(inserted.rows);
    await pool.query(
      `update public.profiles as profile
       set
         completed_at = pg_catalog.clock_timestamp(),
         name = 'Pessoa Cursor ' || pg_catalog.right(auth_user.email, 20),
         phone_e164 = '+5541999999999',
         tax_id = '28001238938'
       from auth.users as auth_user
       where profile.id = auth_user.id
         and auth_user.id = any($1::uuid[])`,
      [identities.map((identity) => identity.id)],
    );
    return { identities, query: namespace };
  });
}

export async function readFeat031Audit(action: string, targetId: string) {
  return withFeat031AdminPool(async (pool) => {
    const result = await pool.query(
      `select action, actor_role, metadata, target_id
       from audit.events
       where action = $1::text and target_id = $2::uuid
       order by occurred_at desc`,
      [action, targetId],
    );
    return result.rows;
  });
}

export async function readFeat031UserStatus(userId: string) {
  return withFeat031AdminPool(async (pool) => {
    const result = await pool.query(
      `select account_version, profile_version, status
       from public.profiles where id = $1::uuid`,
      [userId],
    );
    return z
      .array(
        z.strictObject({
          account_version: z.coerce.number().int().nonnegative(),
          profile_version: z.coerce.number().int().nonnegative(),
          status: z.enum(["active", "suspended"]),
        }),
      )
      .length(1)
      .parse(result.rows)[0];
  });
}

export async function setFeat031UserStatusConcurrently(
  userId: string,
  status: "active" | "suspended",
) {
  await withFeat031AdminPool(async (pool) => {
    const result = await pool.query(
      `update public.profiles
       set status = $2::text
       where id = $1::uuid and status <> $2::text
       returning id`,
      [userId, status],
    );
    if (result.rowCount !== 1)
      throw new Error("A concorrência de status FEAT-031 não foi aplicada.");
  });
}

export async function setFeat031RolesConcurrently(
  userId: string,
  roles: readonly ("admin" | "reviewer" | "support")[],
) {
  await withFeat031AdminPool(async (pool) => {
    await pool.query("begin");
    try {
      await pool.query(`delete from public.platform_roles where user_id = $1::uuid`, [userId]);
      if (roles.length > 0) {
        await pool.query(
          `insert into public.platform_roles (user_id, role, granted_by)
           select $1::uuid, requested.role, null
           from pg_catalog.unnest($2::text[]) as requested(role)`,
          [userId, roles],
        );
      }
      const persisted = await pool.query<{ role: string }>(
        `select platform_role.role
         from public.platform_roles as platform_role
         where platform_role.user_id = $1::uuid
         order by case platform_role.role when 'support' then 1 when 'reviewer' then 2 else 3 end`,
        [userId],
      );
      const persistedRoles = z
        .array(z.strictObject({ role: z.enum(["admin", "reviewer", "support"]) }))
        .parse(persisted.rows)
        .map(({ role }) => role);
      expect(persistedRoles).toEqual([...roles]);
      await pool.query("commit");
    } catch (error) {
      await pool.query("rollback");
      throw error;
    }
  });
}

export async function updateFeat031TagConcurrently(slug: string, name: string) {
  return withFeat031AdminPool(async (pool) => {
    const result = await pool.query(
      `update public.tags as tag
       set name = $2::text, taxonomy_version = tag.taxonomy_version + 1
       where tag.slug = $1::text
       returning tag.id, tag.name, tag.taxonomy_version`,
      [slug, name],
    );
    return z
      .array(
        z.strictObject({
          id: z.uuid(),
          name: z.string(),
          taxonomy_version: z.coerce.number().int().nonnegative(),
        }),
      )
      .length(1)
      .parse(result.rows)[0];
  });
}

export async function expectFeat031OwnerCommandBlocked(userId: string) {
  return withFeat031DalPool(async (pool) => {
    await pool.query("begin");
    try {
      await pool.query(
        `select private.create_studio(
           $1::uuid, $2::uuid, $3::uuid,
           'Bloqueado QA', 'Não deve persistir', 'Rua Bloqueada', '1', null,
           'Centro', 'Curitiba', 'PR', '80010000', 1,
           '60000000-0000-4000-8000-000000000001'::uuid
         )`,
        [userId, randomUUID(), randomUUID()],
      );
      throw new Error("O comando de produto aceitou uma conta suspensa.");
    } catch (error) {
      await pool.query("rollback");
      const parsed = z.object({ code: z.string(), message: z.string() }).safeParse(error);
      if (
        !parsed.success ||
        parsed.data.code !== "42501" ||
        parsed.data.message !== "studio_owner_inactive"
      ) {
        throw error;
      }
      return parsed.data;
    }
  });
}

export async function readFeat031Roles(userId: string) {
  return withFeat031AdminPool(async (pool) => {
    const result = await pool.query(
      `select role from public.platform_roles where user_id = $1::uuid order by role`,
      [userId],
    );
    return z
      .array(z.strictObject({ role: z.enum(["admin", "reviewer", "support"]) }))
      .parse(result.rows);
  });
}

export async function linkFeat031TagToHistory(ownerUserId: string, slug: string) {
  const parsedTag = await withFeat031AdminPool(async (pool) => {
    const tag = await pool.query<{ id: string }>(
      `select id from public.tags where slug = $1::text`,
      [slug],
    );
    const item = z
      .array(z.strictObject({ id: z.uuid() }))
      .length(1)
      .parse(tag.rows)[0];
    if (item === undefined) throw new Error("A tag FEAT-031 não foi encontrada.");
    return item;
  });

  return withFeat031DalPool(async (pool) => {
    await pool.query("begin");
    try {
      const created = await pool.query<{ result: unknown }>(
        `select private.create_studio(
           $1::uuid, $2::uuid, $3::uuid,
           'Estúdio histórico QA',
           'Estúdio criado para comprovar arquivamento sem apagar o histórico.',
           'Rua da História', '31', null, 'Centro', 'Curitiba', 'PR',
           '80010000', 8, '60000000-0000-4000-8000-000000000001'::uuid
         ) as result`,
        [ownerUserId, randomUUID(), randomUUID()],
      );
      const editor = z
        .array(
          z.strictObject({
            result: z.object({
              revision: z.object({ id: z.uuid(), version: z.number().int().positive() }),
              studioId: z.uuid(),
            }),
          }),
        )
        .length(1)
        .parse(created.rows)[0];
      if (editor === undefined) throw new Error("O estúdio histórico FEAT-031 não foi criado.");
      await pool.query(
        `select private.update_studio_revision_taxonomy(
           $1::uuid, $2::uuid, $3::uuid, $4::bigint,
           $5::uuid, $6::uuid, $7::uuid[], '{}'::uuid[]
         )`,
        [
          ownerUserId,
          editor.result.studioId,
          editor.result.revision.id,
          editor.result.revision.version,
          randomUUID(),
          randomUUID(),
          [parsedTag.id],
        ],
      );
      await pool.query("commit");
      return {
        revisionId: editor.result.revision.id,
        studioId: editor.result.studioId,
        tagId: parsedTag.id,
      };
    } catch (error) {
      await pool.query("rollback");
      throw error;
    }
  });
}

export async function readFeat031TaxonomyHistory(tagId: string, revisionId: string) {
  return withFeat031AdminPool(async (pool) => {
    const result = await pool.query(
      `select
         tag.active,
         tag.taxonomy_version,
         exists (
           select 1 from public.studio_revision_tags as relation
           where relation.tag_id = tag.id and relation.revision_id = $2::uuid
         ) as historical_reference,
         not (
           public.list_active_studio_taxonomies() -> 'tags'
             @> pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id', tag.id))
         ) as absent_from_new_selection
       from public.tags as tag where tag.id = $1::uuid`,
      [tagId, revisionId],
    );
    return z
      .array(
        z.strictObject({
          absent_from_new_selection: z.boolean(),
          active: z.boolean(),
          historical_reference: z.boolean(),
          taxonomy_version: z.coerce.number().int().nonnegative(),
        }),
      )
      .length(1)
      .parse(result.rows)[0];
  });
}

export async function cleanupFeat031Taxonomy(
  tagId: string | undefined,
  fallbackSlug?: string | undefined,
) {
  if (tagId === undefined && fallbackSlug === undefined) return;
  const parsedTagId = tagId === undefined ? null : z.uuid().parse(tagId);
  const parsedFallbackSlug =
    fallbackSlug === undefined
      ? null
      : z
          .string()
          .min(1)
          .max(80)
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
          .parse(fallbackSlug);
  await withFeat031AdminPool(async (pool) => {
    await pool.query("begin");
    try {
      const target = await pool.query<{ id: string }>(
        `select tag.id
         from public.tags as tag
         where ($1::uuid is not null and tag.id = $1::uuid)
            or ($1::uuid is null and $2::text is not null and tag.slug = $2::text)
         for update`,
        [parsedTagId, parsedFallbackSlug],
      );
      const targetId = z
        .array(z.strictObject({ id: z.uuid() }))
        .max(1)
        .parse(target.rows)[0]?.id;
      if (parsedTagId !== null && targetId === undefined) {
        throw new Error("A taxonomia FEAT-031 esperada para limpeza não foi encontrada.");
      }
      if (targetId !== undefined) {
        await pool.query(`delete from audit.events where target_id = $1::uuid`, [targetId]);
        const result = await pool.query(
          `delete from public.tags where id = $1::uuid returning id`,
          [targetId],
        );
        if (result.rowCount !== 1)
          throw new Error("A limpeza da taxonomia FEAT-031 não foi exata.");
      }
      await pool.query("commit");
    } catch (error) {
      await pool.query("rollback");
      throw error;
    }
  });
}

export async function cleanupFeat031Users(input: {
  direct?: readonly Feat031DirectIdentity[] | undefined;
  bulk?: readonly z.infer<typeof bulkIdentitySchema>[] | undefined;
  operators?: readonly Feat031Operator[] | undefined;
}) {
  const direct = input.direct ?? [];
  const bulk = input.bulk ?? [];
  const operators = input.operators ?? [];
  const userIds = [
    ...new Set([
      ...direct.map((identity) => identity.userId),
      ...bulk.map((identity) => identity.id),
      ...operators.flatMap((identity) => (identity.userId === undefined ? [] : [identity.userId])),
    ]),
  ];
  if (userIds.length > 0) {
    for (const userId of userIds) await cleanupFeat006OwnedStudioRows(userId);
    await withFeat031AdminPool(async (pool) => {
      await pool.query(
        `delete from audit.events
         where actor_user_id = any($1::uuid[]) or target_id = any($1::uuid[])`,
        [userIds],
      );
    });
  }
  for (const identity of operators) await cleanupFeat003QaIdentity(identity);
  for (const identity of direct) {
    await cleanupLocalAuthUser({ email: identity.email, userId: identity.userId });
  }
  if (bulk.length > 0) {
    await withFeat031AdminPool(async (pool) => {
      const result = await pool.query(
        `delete from auth.users where id = any($1::uuid[]) returning id`,
        [bulk.map((identity) => identity.id)],
      );
      if (result.rowCount !== bulk.length)
        throw new Error("A limpeza bulk FEAT-031 não foi exata.");
    });
  }
}

import { randomUUID } from "node:crypto";

import {
  apiSuccessSchema,
  studioCommandResultSchema,
  studioCommandSchema,
  studioEditorSchema,
  type StudioEditor,
} from "@set-livre/contracts";
import { expect, type Page } from "@playwright/test";
import { z } from "zod";

import { withE2EAdminClient, type E2EDatabaseClient } from "./e2e-database-preflight";
import {
  activateFeat004Owner,
  cleanupFeat004QaIdentity,
  createFeat004QaIdentity,
  provisionFeat004Profile,
  type Feat004QaIdentity,
} from "./feat-004-owner-onboarding-recipient";
import { closePageBeforeDatabaseCleanup } from "./page-cleanup";

const studioEvidenceSchema = z.strictObject({
  draft_revision_id: z.uuid().nullable(),
  owner_user_id: z.uuid(),
  published_revision_id: z.uuid().nullable(),
  revisions: z.array(
    z.strictObject({
      description: z.string(),
      id: z.uuid(),
      name: z.string(),
      number: z.number().int().positive(),
      status: z.enum(["approved", "draft", "pending", "rejected", "superseded"]),
      version: z.number().int().positive(),
    }),
  ),
  status: z.enum([
    "changes_pending",
    "disabled",
    "draft",
    "paused",
    "pending_review",
    "published",
    "rejected",
  ]),
  studio_id: z.uuid(),
});
const studioPrerequisiteEvidenceSchema = z.strictObject({
  owner_active: z.boolean(),
  profile_active_and_complete: z.boolean(),
  studio_type_active: z.boolean(),
});

export type Feat006QaIdentity = Feat004QaIdentity;

type Feat006CoreForm = {
  addressComplement: string;
  capacity: string;
  description: string;
  name: string;
  neighborhood: string;
  postalCode: string;
  street: string;
  streetNumber: string;
  studioTypeId: string;
};

export const feat006DefaultCore: Feat006CoreForm = {
  addressComplement: "Sala 2",
  capacity: "12",
  description: "Estúdio completo para ensaios fotográficos e gravações audiovisuais.",
  name: "Estúdio Aurora QA",
  neighborhood: "Centro",
  postalCode: "80010-000",
  street: "Rua das Flores",
  streetNumber: "100",
  studioTypeId: "60000000-0000-4000-8000-000000000001",
};

export async function closeFeat006PageBeforeCleanup(page: Page) {
  await closePageBeforeDatabaseCleanup(page);
}

export function createFeat006QaIdentity(
  testInfo: Readonly<{ project: Readonly<{ name: string }> }>,
  scenario: string,
) {
  return createFeat004QaIdentity(testInfo, `feat006_${scenario}_${randomUUID().slice(0, 8)}`);
}

export async function provisionFeat006Owner(
  page: Page,
  identity: Feat006QaIdentity,
  suffix: string,
) {
  await provisionFeat004Profile(page, identity, {
    name: `Pessoa QA Estúdio ${suffix}`,
    phone: `(41) 99${suffix.padStart(3, "0").slice(-3)}-6001`,
  });
  await activateFeat004Owner(page);
  if (identity.userId === undefined) {
    throw new Error("A identidade FEAT-006 não publicou o escopo autenticado.");
  }
  const prerequisites = await readFeat006StudioPrerequisites(identity.userId);
  expect(prerequisites).toEqual({
    owner_active: true,
    profile_active_and_complete: true,
    studio_type_active: true,
  });
  const navigation = await page.goto("/dono/estudios/novo");
  expect(navigation?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: "Novo estúdio" })).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Nome do estúdio" }),
    "O editor precisa confirmar o catálogo ativo antes de preparar a fixture.",
  ).toBeEnabled({ timeout: 10_000 });
}

export async function fillFeat006Core(page: Page, input: Readonly<Partial<Feat006CoreForm>> = {}) {
  const core = { ...feat006DefaultCore, ...input };
  await page.getByRole("textbox", { name: "Nome do estúdio" }).fill(core.name);
  await page.getByRole("combobox", { name: "Tipo de estúdio" }).selectOption(core.studioTypeId);
  await page.getByRole("spinbutton", { name: "Capacidade de pessoas" }).fill(core.capacity);
  await page.getByRole("textbox", { name: "Descrição" }).fill(core.description);
  await page.getByRole("textbox", { name: "CEP" }).fill(core.postalCode);
  await page.getByRole("textbox", { name: "Rua ou avenida" }).fill(core.street);
  await page.getByRole("textbox", { name: "Número" }).fill(core.streetNumber);
  await page.getByRole("textbox", { name: "Complemento" }).fill(core.addressComplement);
  await page.getByRole("textbox", { name: "Bairro" }).fill(core.neighborhood);
}

async function expectFeat006EditorCommand(
  page: Page,
  action: "studio.create" | "studio.revision.updateCore",
  execute: () => Promise<void>,
) {
  const responsePromise = page.waitForResponse((response) => {
    if (
      response.request().method() !== "POST" ||
      new URL(response.url()).pathname !== "/api/commands"
    ) {
      return false;
    }
    const body = z.object({ action: z.string() }).safeParse(response.request().postDataJSON());
    return body.success && body.data.action === action;
  });
  await execute();
  const response = await responsePromise;
  const payload: unknown = await response.json();
  let editor: StudioEditor | undefined;
  if (response.status() === 200) {
    const result = apiSuccessSchema(studioCommandResultSchema(studioEditorSchema)).parse(
      payload,
    ).data;
    const command = studioCommandSchema.parse(response.request().postDataJSON());
    expect(result.action).toBe(action);
    expect(result.idempotencyKey).toBe(command.idempotencyKey);
    editor = result.result;
  }
  return {
    editor,
    payload,
    response,
  };
}

export async function createFeat006StudioThroughUi(page: Page) {
  const initialEditorRead = page.waitForResponse((response) => {
    const request = response.request();
    return (
      request.method() === "GET" &&
      /^\/api\/owner\/studios\/[0-9a-f-]+$/u.test(new URL(response.url()).pathname)
    );
  });
  const result = await expectFeat006EditorCommand(page, "studio.create", () =>
    page.getByRole("button", { name: "Criar estúdio em rascunho" }).click(),
  );
  expect(result.response.status()).toBe(200);
  if (result.editor === undefined) throw new Error("A criação FEAT-006 não retornou o editor.");
  await page.getByRole("button", { name: "Abrir editor criado" }).click();
  await expect(page).toHaveURL(new RegExp(`/dono/estudios/${result.editor.studioId}/dados$`, "u"));
  const editorRead = await initialEditorRead;
  expect(editorRead.status()).toBe(200);
  expect(new URL(editorRead.url()).pathname).toBe(`/api/owner/studios/${result.editor.studioId}`);
  return result.editor;
}

export function saveFeat006StudioThroughUi(page: Page) {
  return expectFeat006EditorCommand(page, "studio.revision.updateCore", () =>
    page.getByRole("button", { name: /Salvar rascunho|Criar rascunho e salvar/iu }).click(),
  );
}

export async function withFeat006AdminPool<T>(
  operation: (client: E2EDatabaseClient) => Promise<T>,
) {
  return withE2EAdminClient(operation);
}

async function withFeat006HistoricalStateSeed<T>(
  client: E2EDatabaseClient,
  operation: () => Promise<T>,
) {
  await client.query("begin");
  try {
    await client.query("set local session_replication_role = replica");
    const result = await operation();
    await client.query("set local session_replication_role = origin");
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

async function readFeat006StudioPrerequisites(userId: string) {
  const parsedUserId = z.uuid().parse(userId);
  return withFeat006AdminPool(async (pool) => {
    const result = await pool.query(
      `select
         exists (
           select 1
             from public.profiles as profile
            where profile.id = $1::uuid
              and profile.status = 'active'
              and profile.completed_at is not null
         ) as profile_active_and_complete,
         exists (
           select 1
             from public.owner_profiles as owner
            where owner.user_id = $1::uuid
              and owner.status = 'active'
         ) as owner_active,
         exists (
           select 1
             from public.studio_types as studio_type
            where studio_type.id = $2::uuid
              and studio_type.active
         ) as studio_type_active`,
      [parsedUserId, feat006DefaultCore.studioTypeId],
    );
    if (result.rows.length !== 1) {
      throw new Error("A evidência de pré-requisitos FEAT-006 não retornou uma linha exata.");
    }
    return studioPrerequisiteEvidenceSchema.parse(result.rows[0]);
  });
}

export async function publishFeat006Studio(editor: StudioEditor) {
  await withFeat006AdminPool(async (pool) => {
    const result = await withFeat006HistoricalStateSeed(pool, () =>
      pool.query(
        `with approved as (
           update public.studio_revisions as revision
              set status = 'approved',
                  revision_version = revision.revision_version + 1,
                  updated_at = pg_catalog.clock_timestamp()
            where revision.id = $2::uuid
              and revision.studio_id = $1::uuid
              and revision.status = 'draft'
              and revision.revision_version = $3::bigint
            returning revision.id
         )
         update public.studios as studio
            set status = 'published',
                published_revision_id = approved.id,
                draft_revision_id = null,
                publication_version = studio.publication_version + 1,
                updated_at = pg_catalog.clock_timestamp()
           from approved
          where studio.id = $1::uuid
            and studio.owner_user_id = $4::uuid
          returning studio.id`,
        [editor.studioId, editor.revision.id, editor.revision.version, editor.scope],
      ),
    );
    if (result.rows.length !== 1) {
      throw new Error("A fixture FEAT-006 não publicou exatamente uma revisão draft.");
    }
  });
}

export async function mutateFeat006DraftForConflict(
  editor: StudioEditor,
  input: Readonly<{ description: string; name: string; studioTypeId?: string }>,
) {
  await withFeat006AdminPool(async (pool) => {
    const result = await pool.query(
      `update public.studio_revisions as revision
          set name = $3,
              description = $4,
              studio_type_id = coalesce($5::uuid, revision.studio_type_id),
              revision_version = revision.revision_version + 1
        where revision.id = $2::uuid
          and revision.studio_id = $1::uuid
          and revision.status = 'draft'
          and revision.revision_version = $6::bigint
      returning revision.id`,
      [
        editor.studioId,
        editor.revision.id,
        input.name,
        input.description,
        input.studioTypeId ?? null,
        editor.revision.version,
      ],
    );
    if (result.rows.length !== 1) {
      throw new Error("A fixture FEAT-006 não avançou exatamente uma revisão draft.");
    }
  });
}

export async function disableFeat006PublishedStudio(studioId: string) {
  const parsedStudioId = z.uuid().parse(studioId);
  await withFeat006AdminPool(async (pool) => {
    const result = await withFeat006HistoricalStateSeed(pool, () =>
      pool.query(
        `update public.studios as studio
            set status = 'disabled',
                disabled_from_status = 'published',
                publication_version = studio.publication_version + 1,
                updated_at = pg_catalog.clock_timestamp()
          where studio.id = $1::uuid
            and studio.status = 'published'
            and studio.published_revision_id is not null
        returning studio.id`,
        [parsedStudioId],
      ),
    );
    if (result.rows.length !== 1) {
      throw new Error("A fixture FEAT-006 não desabilitou exatamente um estúdio publicado.");
    }
  });
}

export async function setFeat006ProfileStatus(userId: string, status: "active" | "suspended") {
  const parsedUserId = z.uuid().parse(userId);
  await withFeat006AdminPool(async (pool) => {
    const result = await pool.query(
      `update public.profiles as profile
          set status = $2
        where profile.id = $1::uuid
      returning profile.id`,
      [parsedUserId, status],
    );
    if (result.rows.length !== 1) {
      throw new Error("A fixture FEAT-006 não alterou exatamente um status de perfil.");
    }
  });
}

export async function setFeat006OwnerStatus(userId: string, status: "active" | "blocked") {
  const parsedUserId = z.uuid().parse(userId);
  await withFeat006AdminPool(async (pool) => {
    const result = await pool.query(
      `update public.owner_profiles as owner
          set status = $2
        where owner.user_id = $1::uuid
      returning owner.user_id`,
      [parsedUserId, status],
    );
    if (result.rows.length !== 1) {
      throw new Error("A fixture FEAT-006 não alterou exatamente um status de dono.");
    }
  });
}

export async function setFeat006StudioTypeActive(studioTypeId: string, active: boolean) {
  const parsedStudioTypeId = z.uuid().parse(studioTypeId);
  await withFeat006AdminPool(async (pool) => {
    const result = await pool.query(
      `update public.studio_types as studio_type
          set active = $2
        where studio_type.id = $1::uuid
      returning studio_type.id`,
      [parsedStudioTypeId, active],
    );
    if (result.rows.length !== 1) {
      throw new Error("A fixture FEAT-006 não alterou exatamente um tipo de estúdio.");
    }
  });
}

export async function readFeat006OwnedStudioCount(userId: string) {
  const parsedUserId = z.uuid().parse(userId);
  return withFeat006AdminPool(async (pool) => {
    const result = await pool.query(
      `select count(*)::integer as studio_count
         from public.studios
        where owner_user_id = $1::uuid`,
      [parsedUserId],
    );
    return z.strictObject({ studio_count: z.number().int().nonnegative() }).parse(result.rows[0])
      .studio_count;
  });
}

export async function readFeat006StudioEvidence(studioId: string) {
  return withFeat006AdminPool(async (pool) => {
    const result = await pool.query(
      `select
         studio.id as studio_id,
         studio.owner_user_id,
         studio.status,
         studio.published_revision_id,
         studio.draft_revision_id,
         coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'id', revision.id,
               'number', revision.revision_number,
               'version', revision.revision_version,
               'status', revision.status,
               'name', revision.name,
               'description', revision.description
             ) order by revision.revision_number
           ) filter (where revision.id is not null),
           '[]'::jsonb
         ) as revisions
       from public.studios as studio
       left join public.studio_revisions as revision on revision.studio_id = studio.id
       where studio.id = $1::uuid
       group by studio.id`,
      [studioId],
    );
    if (result.rows.length !== 1) throw new Error("A evidência FEAT-006 não encontrou o estúdio.");
    return studioEvidenceSchema.parse(result.rows[0]);
  });
}

export async function cleanupFeat006OwnedStudioRows(userId: string) {
  const parsedUserId = z.uuid().parse(userId);
  await withFeat006AdminPool(async (pool) => {
    await pool.query("begin");
    try {
      await pool.query(
        `delete from public.email_outbox as outbox
          where outbox.studio_id in (
            select studio.id from public.studios as studio where studio.owner_user_id = $1::uuid
          )`,
        [parsedUserId],
      );
      await pool.query(
        `delete from public.studio_review_events as review
          where review.studio_id in (
            select studio.id from public.studios as studio where studio.owner_user_id = $1::uuid
          )`,
        [parsedUserId],
      );
      await pool.query(
        `delete from audit.events
          where actor_user_id = $1::uuid
             or target_id in (
               select studio.id from public.studios as studio where studio.owner_user_id = $1::uuid
             )`,
        [parsedUserId],
      );
      await pool.query(
        "delete from private.studio_command_requests where owner_user_id = $1::uuid",
        [parsedUserId],
      );
      await pool.query("set local session_replication_role = replica");
      await pool.query(
        `delete from public.studio_revision_media as relation
          where relation.revision_id in (
            select revision.id
              from public.studio_revisions as revision
              join public.studios as studio on studio.id = revision.studio_id
             where studio.owner_user_id = $1::uuid
          )`,
        [parsedUserId],
      );
      await pool.query(
        `delete from public.studio_revision_tags as relation
          where relation.revision_id in (
            select revision.id
              from public.studio_revisions as revision
              join public.studios as studio on studio.id = revision.studio_id
             where studio.owner_user_id = $1::uuid
          )`,
        [parsedUserId],
      );
      await pool.query(
        `delete from public.studio_revision_amenities as relation
          where relation.revision_id in (
            select revision.id
              from public.studio_revisions as revision
              join public.studios as studio on studio.id = revision.studio_id
             where studio.owner_user_id = $1::uuid
          )`,
        [parsedUserId],
      );
      await pool.query(
        `delete from public.studio_faqs as faq
          where faq.revision_id in (
            select revision.id
              from public.studio_revisions as revision
              join public.studios as studio on studio.id = revision.studio_id
             where studio.owner_user_id = $1::uuid
          )`,
        [parsedUserId],
      );
      await pool.query(
        `update public.studio_media as media
            set prepared_revision_id = null
          where media.prepared_revision_id in (
            select revision.id
              from public.studio_revisions as revision
              join public.studios as studio on studio.id = revision.studio_id
             where studio.owner_user_id = $1::uuid
          )`,
        [parsedUserId],
      );
      await pool.query(
        `delete from public.studio_revisions as revision
          using public.studios as studio
          where studio.id = revision.studio_id
            and studio.owner_user_id = $1::uuid`,
        [parsedUserId],
      );
      await pool.query("set local session_replication_role = origin");
      await pool.query("delete from public.studios where owner_user_id = $1::uuid", [parsedUserId]);
      await pool.query("commit");
    } catch (error) {
      await pool.query("rollback");
      throw error;
    }
  });
}

export async function cleanupFeat006QaIdentity(identity: Feat006QaIdentity) {
  const failures: Error[] = [];
  if (identity.userId !== undefined) {
    try {
      await cleanupFeat006OwnedStudioRows(identity.userId);
    } catch (error) {
      failures.push(
        new Error("Não foi possível remover os fatos locais da FEAT-006.", { cause: error }),
      );
    }
  }
  try {
    await cleanupFeat004QaIdentity(identity);
  } catch (error) {
    failures.push(
      new Error("Não foi possível remover a identidade-base da FEAT-006.", { cause: error }),
    );
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "A limpeza exata do cenário FEAT-006 falhou.");
  }
}

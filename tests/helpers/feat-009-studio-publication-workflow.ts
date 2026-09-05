import { randomUUID } from "node:crypto";

import {
  apiSuccessSchema,
  studioCommandResultSchema,
  studioCommandSchema,
  studioPublicationSchema,
  type StudioCommand,
  type StudioEditor,
  type StudioPublication,
} from "@set-livre/contracts";
import { expect, type Page } from "@playwright/test";
import { z } from "zod";

import { saveFeat006StudioThroughUi, withFeat006AdminPool } from "./feat-006-studio-core-revision";
import {
  closeFeat008PageBeforeCleanup,
  cleanupFeat008QaIdentity,
  createFeat008QaIdentity,
  createFeat008StudioFixture,
  uploadFeat008Photos,
  type Feat008QaIdentity,
} from "./feat-008-studio-media";
import { expectRawHtmlScriptsUseNonce, policyNonce } from "./content-security-policy";

const studioStatusSchema = z.enum([
  "changes_pending",
  "disabled",
  "draft",
  "paused",
  "pending_review",
  "published",
  "rejected",
]);

const revisionStatusSchema = z.enum(["approved", "draft", "pending", "rejected", "superseded"]);

const publicationEvidenceSchema = z.strictObject({
  audit_actions: z.array(z.enum(["studio.paused", "studio.resumed", "studio.revision_submitted"])),
  draft_revision_id: z.uuid().nullable(),
  outbox: z.array(
    z.strictObject({
      deduplication_key: z.string(),
      revision_id: z.uuid(),
      status: z.literal("pending"),
      template_key: z.literal("studio.review.submitted"),
    }),
  ),
  owner_user_id: z.uuid(),
  publication_version: z.number().int().positive(),
  published_revision_id: z.uuid().nullable(),
  requests: z.array(
    z.strictObject({
      action: z.enum(["studio.pause", "studio.resume", "studio.revision.submit"]),
      idempotency_key: z.uuid(),
      resulting_revision_id: z.uuid(),
    }),
  ),
  reviews: z.array(
    z.strictObject({
      event_type: z.enum(["approved", "rejected", "submitted"]),
      rejection_reason: z.string().nullable(),
      revision_id: z.uuid(),
    }),
  ),
  revisions: z.array(
    z.strictObject({
      id: z.uuid(),
      name: z.string(),
      number: z.number().int().positive(),
      status: revisionStatusSchema,
      version: z.number().int().positive(),
    }),
  ),
  status: studioStatusSchema,
  studio_id: z.uuid(),
});

const publicationSeedSchema = z.strictObject({
  publication_version: z.number().int().positive(),
  revision_id: z.uuid(),
  revision_status: revisionStatusSchema,
});

const rejectedCorrectionSeedSchema = z.strictObject({
  correction_revision_id: z.uuid(),
  rejected_revision_id: z.uuid(),
});
const isolatedTaxonomyContextSchema = z.strictObject({
  amenity_ids: z.array(z.uuid()),
  revision_id: z.uuid(),
  revision_version: z.number().int().positive(),
});

type PublicationAction = "studio.pause" | "studio.resume" | "studio.revision.submit";
type PublicationCommand = Extract<StudioCommand, { action: PublicationAction }>;

export type Feat009QaIdentity = Feat008QaIdentity;
export type Feat009PublicationEvidence = z.infer<typeof publicationEvidenceSchema>;

const isolatedTagIdsByIdentity = new WeakMap<Feat009QaIdentity, Set<string>>();

function isPublicationCommand(command: StudioCommand): command is PublicationCommand {
  return (
    command.action === "studio.pause" ||
    command.action === "studio.resume" ||
    command.action === "studio.revision.submit"
  );
}

export function createFeat009QaIdentity(
  testInfo: Readonly<{ project: Readonly<{ name: string }> }>,
  scenario: string,
) {
  return createFeat008QaIdentity(testInfo, `feat009_${scenario}_${randomUUID().slice(0, 8)}`);
}

export async function closeFeat009PageBeforeCleanup(page: Page) {
  await closeFeat008PageBeforeCleanup(page);
}

export async function openFeat009Publication(page: Page, studioId: string) {
  const parsedStudioId = z.uuid().parse(studioId);
  const navigation = await page.goto(`/dono/estudios/${parsedStudioId}/publicacao`);
  expect(navigation?.status()).toBe(200);
  if (navigation === null) throw new Error("A navegação da publicação não retornou uma response.");
  const nonce = policyNonce(navigation.headers()["content-security-policy"] ?? "");
  expectRawHtmlScriptsUseNonce(await navigation.text(), nonce);
  await expect(
    page.getByRole("heading", { level: 1, name: "Publicação do estúdio" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Checklist do anúncio" })).toBeVisible();
}

export async function provisionFeat009Studio(
  page: Page,
  identity: Feat009QaIdentity,
  suffix: string,
  options: Readonly<{ complete: boolean; isolatedTag?: boolean }>,
) {
  const fixture = await createFeat008StudioFixture(page, identity, suffix);
  if (options.complete) {
    const navigation = await page.goto(`/dono/estudios/${fixture.editor.studioId}/midia`);
    expect(navigation?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name: "Fotos do estúdio" })).toBeVisible();
    await uploadFeat008Photos(page, [`feat009-${suffix}.png`]);
  }
  const isolatedTagId = options.isolatedTag
    ? await replaceFeat009FixtureTag(identity, fixture.editor.studioId, suffix)
    : undefined;
  await openFeat009Publication(page, fixture.editor.studioId);
  return { ...fixture, isolatedTagId };
}

async function replaceFeat009FixtureTag(
  identity: Feat009QaIdentity,
  studioId: string,
  suffix: string,
) {
  if (identity.userId === undefined) {
    throw new Error("A taxonomia isolada FEAT-009 exige uma identidade provisionada.");
  }
  const ownerUserId = z.uuid().parse(identity.userId);
  const parsedStudioId = z.uuid().parse(studioId);
  const isolatedTagId = randomUUID();
  const slug = `qa-feat009-${suffix}-${isolatedTagId.replaceAll("-", "").slice(0, 12)}`;

  await withFeat006AdminPool(async (client) => {
    await client.query("begin");
    try {
      await client.query(
        `insert into public.tags (id, slug, name, sort_order)
         values ($1::uuid, $2::text, 'QA FEAT 009 tag isolada', 900)`,
        [isolatedTagId, slug],
      );
      const contextResult = await client.query(
        `select
           revision.id as revision_id,
           revision.revision_version::integer,
           coalesce((
             select pg_catalog.jsonb_agg(relation.amenity_id order by relation.amenity_id)
             from public.studio_revision_amenities as relation
             where relation.revision_id = revision.id
           ), '[]'::jsonb) as amenity_ids
         from public.studios as studio
         join public.studio_revisions as revision on revision.id = studio.draft_revision_id
         where studio.id = $1::uuid
           and studio.owner_user_id = $2::uuid
           and revision.status = 'draft'
         for update of studio, revision`,
        [parsedStudioId, ownerUserId],
      );
      if (contextResult.rows.length !== 1) {
        throw new Error("A taxonomia isolada FEAT-009 não encontrou a draft esperada.");
      }
      const context = isolatedTaxonomyContextSchema.parse(contextResult.rows[0]);
      const updated = await client.query(
        `select private.update_studio_revision_taxonomy(
           $1::uuid,
           $2::uuid,
           $3::uuid,
           $4::bigint,
           $5::uuid,
           $6::uuid,
           $7::uuid[],
           $8::uuid[]
         ) as editor`,
        [
          ownerUserId,
          parsedStudioId,
          context.revision_id,
          context.revision_version,
          randomUUID(),
          randomUUID(),
          [isolatedTagId],
          context.amenity_ids,
        ],
      );
      if (updated.rows.length !== 1) {
        throw new Error("A taxonomia isolada FEAT-009 não atualizou a draft esperada.");
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });

  const registered = isolatedTagIdsByIdentity.get(identity) ?? new Set<string>();
  registered.add(isolatedTagId);
  isolatedTagIdsByIdentity.set(identity, registered);
  return isolatedTagId;
}

export async function archiveFeat009Tag(tagId: string) {
  const parsedTagId = z.uuid().parse(tagId);
  await withFeat006AdminPool(async (client) => {
    const result = await client.query(
      `update public.tags as tag
          set active = false,
              taxonomy_version = tag.taxonomy_version + 1,
              updated_at = pg_catalog.clock_timestamp()
        where tag.id = $1::uuid
          and tag.active
      returning tag.id`,
      [parsedTagId],
    );
    if (result.rows.length !== 1) {
      throw new Error("A tag isolada FEAT-009 não pôde ser arquivada exatamente uma vez.");
    }
  });
}

async function expectPublicationCommand(
  page: Page,
  action: PublicationAction,
  execute: () => Promise<void>,
) {
  const responsePromise = page.waitForResponse((response) => {
    if (
      response.request().method() !== "POST" ||
      new URL(response.url()).pathname !== "/api/commands"
    ) {
      return false;
    }
    const command = studioCommandSchema.safeParse(response.request().postDataJSON());
    return command.success && command.data.action === action;
  });
  await execute();
  const response = await responsePromise;
  const command = studioCommandSchema.parse(response.request().postDataJSON());
  if (!isPublicationCommand(command) || command.action !== action) {
    throw new Error(`A resposta observada não corresponde ao comando ${action}.`);
  }
  const payload: unknown = await response.json();
  let publication: StudioPublication | undefined;
  if (response.status() === 200) {
    const result = apiSuccessSchema(studioCommandResultSchema(studioPublicationSchema)).parse(
      payload,
    ).data;
    expect(result.action).toBe(action);
    expect(result.idempotencyKey).toBe(command.idempotencyKey);
    publication = result.result;
  }
  return {
    command,
    payload,
    publication,
    response,
  };
}

export function submitFeat009RevisionThroughUi(page: Page) {
  return expectPublicationCommand(page, "studio.revision.submit", () =>
    page.getByRole("button", { name: "Enviar revisão completa" }).click(),
  );
}

export function pauseFeat009StudioThroughUi(page: Page) {
  return expectPublicationCommand(page, "studio.pause", async () => {
    await page.getByRole("button", { name: "Pausar estúdio" }).click();
    const confirmation = page.getByRole("heading", {
      level: 3,
      name: "Confirmar pausa do estúdio",
    });
    await expect(confirmation).toBeFocused();
    await page.getByRole("button", { name: "Confirmar pausa" }).click();
  });
}

export function resumeFeat009StudioThroughUi(page: Page) {
  return expectPublicationCommand(page, "studio.resume", () =>
    page.getByRole("button", { name: "Retomar estúdio" }).click(),
  );
}

export function observeFeat009Commands(page: Page) {
  const commands: PublicationCommand[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST" || new URL(request.url()).pathname !== "/api/commands") return;
    const command = studioCommandSchema.safeParse(request.postDataJSON());
    if (command.success && isPublicationCommand(command.data)) commands.push(command.data);
  });
  return commands;
}

export async function createFeat009CandidateThroughUi(
  page: Page,
  studioId: string,
  candidateName: string,
): Promise<StudioEditor> {
  const parsedStudioId = z.uuid().parse(studioId);
  await page.goto(`/dono/estudios/${parsedStudioId}/dados`);
  await expect(page.getByRole("heading", { level: 1, name: "Dados do estúdio" })).toBeVisible();
  await page.getByRole("textbox", { name: "Nome do estúdio" }).fill(candidateName);
  const result = await saveFeat006StudioThroughUi(page);
  expect(result.response.status()).toBe(200);
  if (result.editor === undefined) {
    throw new Error("A criação da candidata FEAT-009 não retornou o editor autoritativo.");
  }
  expect(result.editor.revision).toMatchObject({ name: candidateName, status: "draft" });
  return result.editor;
}

export async function readFeat009PublicationEvidence(
  studioId: string,
): Promise<Feat009PublicationEvidence> {
  const parsedStudioId = z.uuid().parse(studioId);
  return withFeat006AdminPool(async (client) => {
    const result = await client.query(
      `select
         studio.id as studio_id,
         studio.owner_user_id,
         studio.status,
         studio.publication_version::integer,
         studio.published_revision_id,
         studio.draft_revision_id,
         coalesce((
           select pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'id', revision.id,
               'number', revision.revision_number::integer,
               'version', revision.revision_version::integer,
               'status', revision.status,
               'name', revision.name
             ) order by revision.revision_number, revision.id
           )
           from public.studio_revisions as revision
           where revision.studio_id = studio.id
         ), '[]'::jsonb) as revisions,
         coalesce((
           select pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'revision_id', review.revision_id,
               'event_type', review.event_type,
               'rejection_reason', review.rejection_reason
             ) order by review.event_sequence
           )
           from public.studio_review_events as review
           where review.studio_id = studio.id
         ), '[]'::jsonb) as reviews,
         coalesce((
           select pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'revision_id', outbox.revision_id,
               'template_key', outbox.template_key,
               'deduplication_key', outbox.deduplication_key,
               'status', outbox.status
             ) order by outbox.created_at, outbox.id
           )
           from public.email_outbox as outbox
           where outbox.studio_id = studio.id
         ), '[]'::jsonb) as outbox,
         coalesce((
           select pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'action', request.action,
               'idempotency_key', request.idempotency_key,
               'resulting_revision_id', request.resulting_revision_id
             ) order by request.created_at, request.idempotency_key
           )
           from private.studio_command_requests as request
           where request.studio_id = studio.id
             and request.action in (
               'studio.pause',
               'studio.resume',
               'studio.revision.submit'
             )
         ), '[]'::jsonb) as requests,
         coalesce((
           select pg_catalog.jsonb_agg(event.action order by event.occurred_at, event.id)
           from audit.events as event
           where event.target_type = 'studio'
             and event.target_id = studio.id
             and event.action in (
               'studio.revision_submitted',
               'studio.paused',
               'studio.resumed'
             )
         ), '[]'::jsonb) as audit_actions
       from public.studios as studio
       where studio.id = $1::uuid`,
      [parsedStudioId],
    );
    if (result.rows.length !== 1) {
      throw new Error("A evidência FEAT-009 não encontrou exatamente um estúdio.");
    }
    return publicationEvidenceSchema.parse(result.rows[0]);
  });
}

export async function seedFeat009PublishedStudio(ownerUserId: string, studioId: string) {
  const parsedOwnerUserId = z.uuid().parse(ownerUserId);
  const parsedStudioId = z.uuid().parse(studioId);
  return withFeat006AdminPool(async (client) => {
    await client.query("begin");
    try {
      const seedResult = await client.query(
        `select
           studio.draft_revision_id as revision_id,
           studio.publication_version::integer,
           revision.status as revision_status
         from public.studios as studio
         join public.studio_revisions as revision on revision.id = studio.draft_revision_id
         where studio.id = $1::uuid
           and studio.owner_user_id = $2::uuid
           and studio.status = 'draft'
           and studio.published_revision_id is null
         for update of studio, revision`,
        [parsedStudioId, parsedOwnerUserId],
      );
      if (seedResult.rows.length !== 1) {
        throw new Error("A aprovação local FEAT-009 exige exatamente uma primeira draft.");
      }
      const seed = publicationSeedSchema.parse(seedResult.rows[0]);
      if (seed.revision_status !== "draft") {
        throw new Error("A aprovação local FEAT-009 recebeu uma revisão não editável.");
      }

      const pendingRevisionUpdate = await client.query(
        `update public.studio_revisions as revision
            set status = 'pending',
                revision_version = revision.revision_version + 1,
                updated_at = pg_catalog.clock_timestamp()
          where revision.id = $1::uuid
            and revision.studio_id = $2::uuid
            and revision.status = 'draft'
        returning revision.id`,
        [seed.revision_id, parsedStudioId],
      );
      const pendingStudioUpdate = await client.query(
        `update public.studios as studio
            set status = 'pending_review'
          where studio.id = $1::uuid
            and studio.owner_user_id = $2::uuid
            and studio.publication_version = $3::integer
        returning studio.id`,
        [parsedStudioId, parsedOwnerUserId, seed.publication_version],
      );
      if (pendingRevisionUpdate.rows.length !== 1 || pendingStudioUpdate.rows.length !== 1) {
        throw new Error("A aprovação local FEAT-009 não preparou a submissão causal.");
      }

      await client.query(
        `insert into public.studio_review_events (
           studio_id, revision_id, actor_user_id, event_type, rejection_reason, occurred_at
         ) values (
           $1::uuid, $2::uuid, $3::uuid, 'submitted', null,
           pg_catalog.clock_timestamp() - interval '1 millisecond'
         )`,
        [parsedStudioId, seed.revision_id, parsedOwnerUserId],
      );
      await client.query(
        `insert into public.email_outbox (
           template_key, audience_key, studio_id, revision_id, deduplication_key, status
         ) values (
           'studio.review.submitted', 'studio_reviewers', $1::uuid, $2::uuid,
           'studio.review.submitted:' || $2::uuid::text, 'pending'
         )`,
        [parsedStudioId, seed.revision_id],
      );
      await client.query("set local session_replication_role = replica");
      const revisionUpdate = await client.query(
        `update public.studio_revisions as revision
            set status = 'approved',
                revision_version = revision.revision_version + 1,
                updated_at = pg_catalog.clock_timestamp()
          where revision.id = $1::uuid
            and revision.studio_id = $2::uuid
            and revision.status = 'pending'
        returning revision.id`,
        [seed.revision_id, parsedStudioId],
      );
      await client.query("set local session_replication_role = origin");
      const studioUpdate = await client.query(
        `update public.studios as studio
            set status = 'published',
                published_revision_id = $2::uuid,
                draft_revision_id = null
          where studio.id = $1::uuid
            and studio.owner_user_id = $3::uuid
            and studio.status = 'pending_review'
        returning studio.id`,
        [parsedStudioId, seed.revision_id, parsedOwnerUserId],
      );
      if (revisionUpdate.rows.length !== 1 || studioUpdate.rows.length !== 1) {
        throw new Error(
          "A aprovação local FEAT-009 não concluiu exatamente a revisão e o estúdio.",
        );
      }
      await client.query(
        `insert into public.studio_review_events (
           studio_id, revision_id, actor_user_id, event_type, rejection_reason
         ) values ($1::uuid, $2::uuid, $3::uuid, 'approved', null)`,
        [parsedStudioId, seed.revision_id, parsedOwnerUserId],
      );
      await client.query("commit");
      return seed.revision_id;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

export async function seedFeat009RejectedCorrection(
  ownerUserId: string,
  studioId: string,
  rejectionReason: string,
) {
  const parsedOwnerUserId = z.uuid().parse(ownerUserId);
  const parsedStudioId = z.uuid().parse(studioId);
  const parsedReason = z.string().trim().min(1).max(2000).parse(rejectionReason);
  return withFeat006AdminPool(async (client) => {
    await client.query("begin");
    try {
      const result = await client.query(
        `with published as (
           select revision.*
           from public.studios as studio
           join public.studio_revisions as revision on revision.id = studio.published_revision_id
           where studio.id = $1::uuid
             and studio.owner_user_id = $2::uuid
             and studio.status = 'published'
             and studio.draft_revision_id is null
             and revision.status = 'approved'
           for update of studio, revision
         ), rejected as (
           insert into public.studio_revisions (
             studio_id, revision_number, revision_version, status, name, description,
             street, street_number, address_complement, neighborhood, city, state,
             postal_code, capacity, studio_type_id, usage_rules, youtube_video_id
           )
           select
             published.studio_id,
             (select pg_catalog.max(existing.revision_number) + 1
                from public.studio_revisions as existing
               where existing.studio_id = published.studio_id),
             3,
             'pending',
             published.name,
             published.description,
             published.street,
             published.street_number,
             published.address_complement,
             published.neighborhood,
             published.city,
             published.state,
             published.postal_code,
             published.capacity,
             published.studio_type_id,
             published.usage_rules,
             published.youtube_video_id
           from published
           returning id, studio_id
         ), correction as (
           insert into public.studio_revisions (
             studio_id, revision_number, revision_version, status, name, description,
             street, street_number, address_complement, neighborhood, city, state,
             postal_code, capacity, studio_type_id, usage_rules, youtube_video_id
           )
           select
             published.studio_id,
             (select pg_catalog.max(existing.revision_number) + 2
                from public.studio_revisions as existing
               where existing.studio_id = published.studio_id),
             1,
             'draft',
             published.name,
             published.description,
             published.street,
             published.street_number,
             published.address_complement,
             published.neighborhood,
             published.city,
             published.state,
             published.postal_code,
             published.capacity,
             published.studio_type_id,
             published.usage_rules,
             published.youtube_video_id
           from published
           returning id, studio_id
         )
         select
           rejected.id as rejected_revision_id,
           correction.id as correction_revision_id
         from rejected
         join correction on correction.studio_id = rejected.studio_id`,
        [parsedStudioId, parsedOwnerUserId],
      );
      if (result.rows.length !== 1) {
        throw new Error("A fixture de rejeição FEAT-009 não criou as duas revisões esperadas.");
      }
      const seed = rejectedCorrectionSeedSchema.parse(result.rows[0]);
      const pendingStudioUpdate = await client.query(
        `update public.studios as studio
            set draft_revision_id = $2::uuid
          where studio.id = $1::uuid
            and studio.owner_user_id = $3::uuid
            and studio.status = 'published'
            and studio.draft_revision_id is null
        returning studio.id`,
        [parsedStudioId, seed.rejected_revision_id, parsedOwnerUserId],
      );
      if (pendingStudioUpdate.rows.length !== 1) {
        throw new Error("A fixture de rejeição FEAT-009 não apontou a candidata submetida.");
      }
      await client.query(
        `insert into public.studio_review_events (
           studio_id, revision_id, actor_user_id, event_type, rejection_reason, occurred_at
         ) values (
           $1::uuid, $2::uuid, $3::uuid, 'submitted', null,
           pg_catalog.clock_timestamp() - interval '1 millisecond'
         )`,
        [parsedStudioId, seed.rejected_revision_id, parsedOwnerUserId],
      );
      await client.query(
        `insert into public.email_outbox (
           template_key, audience_key, studio_id, revision_id, deduplication_key, status
         ) values (
           'studio.review.submitted', 'studio_reviewers', $1::uuid, $2::uuid,
           'studio.review.submitted:' || $2::uuid::text, 'pending'
         )`,
        [parsedStudioId, seed.rejected_revision_id],
      );
      await client.query("set local session_replication_role = replica");
      const rejectedRevisionUpdate = await client.query(
        `update public.studio_revisions as revision
            set status = 'rejected',
                revision_version = revision.revision_version + 1,
                updated_at = pg_catalog.clock_timestamp()
          where revision.id = $1::uuid
            and revision.studio_id = $2::uuid
            and revision.status = 'pending'
        returning revision.id`,
        [seed.rejected_revision_id, parsedStudioId],
      );
      await client.query("set local session_replication_role = origin");
      if (rejectedRevisionUpdate.rows.length !== 1) {
        throw new Error("A fixture de rejeição FEAT-009 não terminalizou a revisão submetida.");
      }
      await client.query(
        `insert into public.studio_review_events (
           studio_id, revision_id, actor_user_id, event_type, rejection_reason
         ) values ($1::uuid, $2::uuid, $3::uuid, 'rejected', $4::text)`,
        [parsedStudioId, seed.rejected_revision_id, parsedOwnerUserId, parsedReason],
      );
      const studioUpdate = await client.query(
        `update public.studios as studio
            set draft_revision_id = $2::uuid
          where studio.id = $1::uuid
            and studio.owner_user_id = $3::uuid
            and studio.status = 'changes_pending'
            and studio.draft_revision_id = $4::uuid
        returning studio.id`,
        [parsedStudioId, seed.correction_revision_id, parsedOwnerUserId, seed.rejected_revision_id],
      );
      if (studioUpdate.rows.length !== 1) {
        throw new Error("A fixture de rejeição FEAT-009 não apontou a candidata de correção.");
      }
      await client.query("commit");
      return seed;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

export async function seedFeat009RejectedUnpublishedCorrection(
  ownerUserId: string,
  studioId: string,
  rejectionReason: string,
) {
  const parsedOwnerUserId = z.uuid().parse(ownerUserId);
  const parsedStudioId = z.uuid().parse(studioId);
  const parsedReason = z.string().trim().min(1).max(2000).parse(rejectionReason);
  return withFeat006AdminPool(async (client) => {
    await client.query("begin");
    try {
      const result = await client.query(
        `with pending as (
           select revision.*
           from public.studios as studio
           join public.studio_revisions as revision on revision.id = studio.draft_revision_id
           where studio.id = $1::uuid
             and studio.owner_user_id = $2::uuid
             and studio.status = 'pending_review'
             and studio.published_revision_id is null
             and revision.status = 'pending'
           for update of studio, revision
         ), correction as (
           insert into public.studio_revisions (
             studio_id, revision_number, revision_version, status, name, description,
             street, street_number, address_complement, neighborhood, city, state,
             postal_code, capacity, studio_type_id, usage_rules, youtube_video_id
           )
           select
             pending.studio_id,
             pending.revision_number + 1,
             1,
             'draft',
             pending.name,
             pending.description,
             pending.street,
             pending.street_number,
             pending.address_complement,
             pending.neighborhood,
             pending.city,
             pending.state,
             pending.postal_code,
             pending.capacity,
             pending.studio_type_id,
             pending.usage_rules,
             pending.youtube_video_id
           from pending
           returning id, studio_id
         )
         select
           pending.id as rejected_revision_id,
           correction.id as correction_revision_id
         from pending
         join correction on correction.studio_id = pending.studio_id`,
        [parsedStudioId, parsedOwnerUserId],
      );
      if (result.rows.length !== 1) {
        throw new Error("A rejeição inicial FEAT-009 não criou a correção esperada.");
      }
      const seed = rejectedCorrectionSeedSchema.parse(result.rows[0]);

      await client.query("set local session_replication_role = replica");
      const rejectedRevisionUpdate = await client.query(
        `update public.studio_revisions as revision
            set status = 'rejected',
                revision_version = revision.revision_version + 1,
                updated_at = pg_catalog.clock_timestamp()
          where revision.id = $1::uuid
            and revision.studio_id = $2::uuid
            and revision.status = 'pending'
        returning revision.id`,
        [seed.rejected_revision_id, parsedStudioId],
      );
      await client.query("set local session_replication_role = origin");
      if (rejectedRevisionUpdate.rows.length !== 1) {
        throw new Error("A rejeição inicial FEAT-009 não terminalizou a submissão.");
      }

      await client.query(
        `insert into public.studio_review_events (
           studio_id, revision_id, actor_user_id, event_type, rejection_reason
         ) values ($1::uuid, $2::uuid, $3::uuid, 'rejected', $4::text)`,
        [parsedStudioId, seed.rejected_revision_id, parsedOwnerUserId, parsedReason],
      );
      const studioUpdate = await client.query(
        `update public.studios as studio
            set status = 'rejected',
                draft_revision_id = $2::uuid
          where studio.id = $1::uuid
            and studio.owner_user_id = $3::uuid
            and studio.status = 'pending_review'
            and studio.published_revision_id is null
            and studio.draft_revision_id = $4::uuid
        returning studio.id`,
        [parsedStudioId, seed.correction_revision_id, parsedOwnerUserId, seed.rejected_revision_id],
      );
      if (studioUpdate.rows.length !== 1) {
        throw new Error("A rejeição inicial FEAT-009 não apontou a correção editável.");
      }

      await client.query("commit");
      return seed;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

async function removeFeat009PublicationRows(userId: string) {
  const parsedUserId = z.uuid().parse(userId);
  await withFeat006AdminPool(async (client) => {
    await client.query("begin");
    try {
      await client.query(
        `delete from public.email_outbox as outbox
          where outbox.studio_id in (
            select studio.id
            from public.studios as studio
            where studio.owner_user_id = $1::uuid
          )`,
        [parsedUserId],
      );
      await client.query(
        `delete from public.studio_review_events as review
          where review.studio_id in (
            select studio.id
            from public.studios as studio
            where studio.owner_user_id = $1::uuid
          )`,
        [parsedUserId],
      );
      await client.query(
        "delete from private.studio_command_requests where owner_user_id = $1::uuid",
        [parsedUserId],
      );
      await client.query("set local session_replication_role = replica");
      await client.query(
        `delete from public.studio_revision_media as relation
          where relation.revision_id in (
            select revision.id
            from public.studio_revisions as revision
            where revision.studio_id in (
              select studio.id
              from public.studios as studio
              where studio.owner_user_id = $1::uuid
            )
          )`,
        [parsedUserId],
      );
      await client.query("set local session_replication_role = origin");
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

export async function cleanupFeat009QaIdentity(identity: Feat009QaIdentity) {
  const failures: Error[] = [];
  if (identity.userId !== undefined) {
    try {
      await removeFeat009PublicationRows(identity.userId);
    } catch (error) {
      failures.push(
        new Error("Não foi possível remover os fatos editoriais locais da FEAT-009.", {
          cause: error,
        }),
      );
    }
  }
  try {
    await cleanupFeat008QaIdentity(identity);
  } catch (error) {
    failures.push(
      new Error("Não foi possível remover a identidade e a mídia-base da FEAT-009.", {
        cause: error,
      }),
    );
  }
  const isolatedTagIds = [...(isolatedTagIdsByIdentity.get(identity) ?? [])];
  if (isolatedTagIds.length > 0) {
    try {
      await withFeat006AdminPool(async (client) => {
        await client.query("delete from public.tags where id = any($1::uuid[])", [isolatedTagIds]);
      });
      isolatedTagIdsByIdentity.delete(identity);
    } catch (error) {
      failures.push(
        new Error("Não foi possível remover a taxonomia isolada da FEAT-009.", {
          cause: error,
        }),
      );
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "A limpeza exata do cenário FEAT-009 falhou.");
  }
}

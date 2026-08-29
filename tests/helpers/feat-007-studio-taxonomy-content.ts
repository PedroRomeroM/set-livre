import { randomUUID } from "node:crypto";

import { apiSuccessSchema, studioEditorSchema, type StudioEditor } from "@set-livre/contracts";
import { expect, type Page } from "@playwright/test";
import { z } from "zod";

import {
  createFeat006QaIdentity,
  createFeat006StudioThroughUi,
  fillFeat006Core,
  provisionFeat006Owner,
  withFeat006AdminPool,
} from "./feat-006-studio-core-revision";

const feat007EvidenceSchema = z.strictObject({
  amenity_names: z.array(z.string()),
  faqs: z.array(
    z.strictObject({
      answer: z.string(),
      position: z.number().int().positive(),
      question: z.string(),
    }),
  ),
  revision_id: z.uuid(),
  revision_version: z.number().int().positive(),
  tag_names: z.array(z.string()),
  usage_rules: z.string(),
  youtube_video_id: z.string().nullable(),
});

const qaTaxonomySchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
});

type Feat007Action = "studio.revision.updateContent" | "studio.revision.updateTaxonomy";

export const feat007DefaultContent = {
  amenityName: "Wi-Fi",
  faqAnswer: "Os horários disponíveis aparecem no calendário antes da reserva.",
  faqQuestion: "Como consultar os horários?",
  tagName: "Podcast",
  usageRules: "Chegue no horário reservado e preserve os equipamentos do estúdio.",
  youtubeId: "dQw4w9WgXcQ",
} as const;

export function createFeat007QaIdentity(
  testInfo: Readonly<{ project: Readonly<{ name: string }> }>,
  scenario: string,
) {
  return createFeat006QaIdentity(testInfo, `feat007_${scenario}`);
}

export async function provisionFeat007Studio(
  page: Page,
  identity: ReturnType<typeof createFeat007QaIdentity>,
  suffix: string,
) {
  await provisionFeat006Owner(page, identity, suffix);
  await fillFeat006Core(page, { name: `Estúdio conteúdo QA ${suffix}` });
  const editor = await createFeat006StudioThroughUi(page);
  await expect(page.getByRole("heading", { level: 2, name: "Conteúdo comercial" })).toBeVisible();
  return editor;
}

async function expectFeat007Command(
  page: Page,
  action: Feat007Action,
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
  return {
    editor:
      response.status() === 200
        ? apiSuccessSchema(studioEditorSchema).parse(payload).data
        : undefined,
    payload,
    response,
  };
}

export function saveFeat007TaxonomyThroughUi(page: Page) {
  return expectFeat007Command(page, "studio.revision.updateTaxonomy", () =>
    page.getByRole("button", { name: "Salvar tags e comodidades" }).click(),
  );
}

export function saveFeat007ContentThroughUi(page: Page) {
  return expectFeat007Command(page, "studio.revision.updateContent", () =>
    page.getByRole("button", { name: "Salvar regras, FAQ e vídeo" }).click(),
  );
}

export async function readFeat007Evidence(revisionId: string) {
  const parsedRevisionId = z.uuid().parse(revisionId);
  return withFeat006AdminPool(async (pool) => {
    const result = await pool.query(
      `select
         revision.id as revision_id,
         revision.revision_version::integer,
         revision.usage_rules,
         revision.youtube_video_id,
         coalesce((
           select pg_catalog.jsonb_agg(tag.name order by tag.sort_order, tag.name, tag.id)
             from public.studio_revision_tags as relation
             join public.tags as tag on tag.id = relation.tag_id
            where relation.revision_id = revision.id
         ), '[]'::jsonb) as tag_names,
         coalesce((
           select pg_catalog.jsonb_agg(amenity.name order by amenity.sort_order, amenity.name, amenity.id)
             from public.studio_revision_amenities as relation
             join public.amenities as amenity on amenity.id = relation.amenity_id
            where relation.revision_id = revision.id
         ), '[]'::jsonb) as amenity_names,
         coalesce((
           select pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'question', faq.question,
               'answer', faq.answer,
               'position', faq.position
             ) order by faq.position
           )
             from public.studio_faqs as faq
            where faq.revision_id = revision.id
         ), '[]'::jsonb) as faqs
       from public.studio_revisions as revision
       where revision.id = $1::uuid`,
      [parsedRevisionId],
    );
    if (result.rows.length !== 1) {
      throw new Error("A evidência FEAT-007 não encontrou exatamente uma revisão.");
    }
    return feat007EvidenceSchema.parse(result.rows[0]);
  });
}

export async function createFeat007QaTag(): Promise<z.infer<typeof qaTaxonomySchema>> {
  const id = randomUUID();
  const suffix = id.slice(0, 8);
  const name = `Tag QA ${suffix}`;
  return withFeat006AdminPool(async (pool) => {
    const result = await pool.query(
      `insert into public.tags (id, slug, name, sort_order)
       values ($1::uuid, $2::text, $3::text, 900)
       returning id, name`,
      [id, `qa-${suffix}`, name],
    );
    if (result.rows.length !== 1)
      throw new Error("A taxonomia QA não foi criada exatamente uma vez.");
    return qaTaxonomySchema.parse(result.rows[0]);
  });
}

export async function deactivateFeat007Tag(tagId: string) {
  const parsedTagId = z.uuid().parse(tagId);
  await withFeat006AdminPool(async (pool) => {
    const result = await pool.query(
      `update public.tags
          set active = false,
              updated_at = pg_catalog.now()
        where id = $1::uuid
          and active
      returning id`,
      [parsedTagId],
    );
    if (result.rows.length !== 1)
      throw new Error("A taxonomia QA não foi desativada exatamente uma vez.");
  });
}

export async function activateFeat007Tag(tagId: string) {
  const parsedTagId = z.uuid().parse(tagId);
  await withFeat006AdminPool(async (pool) => {
    const result = await pool.query(
      `update public.tags
          set active = true,
              updated_at = pg_catalog.now()
        where id = $1::uuid
          and not active
      returning id`,
      [parsedTagId],
    );
    if (result.rows.length !== 1) {
      throw new Error("A taxonomia QA não foi reativada exatamente uma vez.");
    }
  });
}

export async function cleanupFeat007QaTag(tagId: string) {
  const parsedTagId = z.uuid().parse(tagId);
  await withFeat006AdminPool(async (pool) => {
    await pool.query("delete from public.studio_revision_tags where tag_id = $1::uuid", [
      parsedTagId,
    ]);
    const result = await pool.query("delete from public.tags where id = $1::uuid returning id", [
      parsedTagId,
    ]);
    if (result.rows.length > 1) throw new Error("A limpeza FEAT-007 removeu taxonomias demais.");
  });
}

export function expectFeat007EditorVersion(editor: StudioEditor | undefined, version: number) {
  expect(editor).toBeDefined();
  expect(editor?.revision).toMatchObject({ status: "draft", version });
}

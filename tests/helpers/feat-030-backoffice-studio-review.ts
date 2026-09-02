import { expect, type Page } from "@playwright/test";
import { z } from "zod";

import { withE2EAdminClient } from "./e2e-database-preflight";
import {
  cleanupFeat009QaIdentity,
  createFeat009CandidateThroughUi,
  createFeat009QaIdentity,
  openFeat009Publication,
  provisionFeat009Studio,
  seedFeat009PublishedStudio,
  submitFeat009RevisionThroughUi,
  type Feat009QaIdentity,
} from "./feat-009-studio-publication-workflow";
import {
  cleanupFeat031Users,
  createFeat031Operator,
  loginFeat031Backoffice,
  provisionFeat031Operator,
  type Feat031Operator,
} from "./feat-031-backoffice-users-taxonomy";
import { closePageBeforeDatabaseCleanup } from "./page-cleanup";

const evidenceSchema = z.strictObject({
  audit_actions: z.array(
    z.enum([
      "backoffice.studio_approved",
      "backoffice.studio_disabled",
      "backoffice.studio_rejected",
      "backoffice.studio_restored",
    ]),
  ),
  disabled_from_status: z.enum(["published", "changes_pending", "paused"]).nullable(),
  draft_revision_id: z.uuid().nullable(),
  outbox_templates: z.array(
    z.enum(["studio.review.approved", "studio.review.rejected", "studio.review.submitted"]),
  ),
  publication_version: z.number().int().positive(),
  published_revision_id: z.uuid().nullable(),
  review_events: z.array(z.enum(["approved", "rejected", "submitted"])),
  revisions: z.array(
    z.strictObject({
      id: z.uuid(),
      name: z.string(),
      status: z.enum(["approved", "draft", "pending", "rejected", "superseded"]),
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

export type Feat030Evidence = z.infer<typeof evidenceSchema>;
export type Feat030Operator = Feat031Operator;
export type Feat030Owner = Feat009QaIdentity;

export const feat030ExtremeTextFixture = {
  description: "D".repeat(5_000),
  faqAnswer: "A".repeat(2_000),
  faqQuestion: "Q".repeat(160),
  taxonomyName: "T".repeat(80),
  usageRules: "R".repeat(5_000),
} as const;

export async function triggerFeat030StaleWindowFocusRefetch(page: Page) {
  await page.evaluate(() => {
    const shiftedNow = Date.now() + 20_000;
    Date.now = () => shiftedNow;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    window.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    window.dispatchEvent(new Event("visibilitychange"));
  });
}

export function createFeat030Operator(
  testInfo: Readonly<{ project: Readonly<{ name: string }> }>,
  scenario: string,
) {
  return createFeat031Operator(testInfo, `feat030_${scenario}`);
}

export async function provisionFeat030PendingStudio(
  page: Page,
  testInfo: Readonly<{ project: Readonly<{ name: string }> }>,
  scenario: string,
  suffix: string,
) {
  const owner = createFeat009QaIdentity(testInfo, `feat030_${scenario}`);
  const fixture = await provisionFeat009Studio(page, owner, suffix, {
    complete: true,
  });
  const submission = await submitFeat009RevisionThroughUi(page);
  expect(submission.response.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 2, name: "Em revisão" })).toBeVisible();
  await page.context().clearCookies();
  return {
    name: fixture.editor.revision.name,
    owner,
    revisionId: fixture.editor.revision.id,
    studioId: fixture.editor.studioId,
  };
}

export async function provisionFeat030PublishedStudio(
  page: Page,
  testInfo: Readonly<{ project: Readonly<{ name: string }> }>,
  scenario: string,
  suffix: string,
) {
  const owner = createFeat009QaIdentity(testInfo, `feat030_${scenario}`);
  const fixture = await provisionFeat009Studio(page, owner, suffix, {
    complete: true,
  });
  if (owner.userId === undefined)
    throw new Error("A publicação FEAT-030 exige o dono provisionado.");
  await seedFeat009PublishedStudio(owner.userId, fixture.editor.studioId);
  await page.context().clearCookies();
  return {
    name: fixture.editor.revision.name,
    owner,
    revisionId: fixture.editor.revision.id,
    studioId: fixture.editor.studioId,
  };
}

export async function provisionFeat030ChangesPendingStudio(
  page: Page,
  testInfo: Readonly<{ project: Readonly<{ name: string }> }>,
  scenario: string,
  suffix: string,
) {
  const owner = createFeat009QaIdentity(testInfo, `feat030_${scenario}`);
  const fixture = await provisionFeat009Studio(page, owner, suffix, {
    complete: true,
  });
  if (owner.userId === undefined) {
    throw new Error("A alteração FEAT-030 exige o dono provisionado.");
  }
  const publishedRevisionId = await seedFeat009PublishedStudio(
    owner.userId,
    fixture.editor.studioId,
  );
  const candidateName = `${fixture.editor.revision.name} — candidata`;
  const candidate = await createFeat009CandidateThroughUi(
    page,
    fixture.editor.studioId,
    candidateName,
  );
  await openFeat009Publication(page, fixture.editor.studioId);
  const submission = await submitFeat009RevisionThroughUi(page);
  expect(submission.response.status()).toBe(200);
  await expect(
    page.getByRole("heading", { level: 2, name: "Alterações em revisão" }),
  ).toBeVisible();
  await page.context().clearCookies();
  return {
    candidateName,
    candidateRevisionId: candidate.revision.id,
    owner,
    publishedName: fixture.editor.revision.name,
    publishedRevisionId,
    studioId: fixture.editor.studioId,
  };
}

export async function provisionFeat030Operator(
  page: Page,
  operator: Feat030Operator,
  role: "admin" | "reviewer" | "support",
  suffix: string,
) {
  await provisionFeat031Operator(page, operator, role, suffix);
  await page.context().clearCookies();
}

export async function loginFeat030Operator(
  page: Page,
  operator: Feat030Operator,
  landing: "/estudios" | "/usuarios",
) {
  await loginFeat031Backoffice(page, operator, { landing });
}

export async function provisionAndLoginFeat030Operator(
  page: Page,
  operator: Feat030Operator,
  role: "admin" | "reviewer" | "support",
  suffix: string,
) {
  await provisionFeat030Operator(page, operator, role, suffix);
  await loginFeat030Operator(page, operator, role === "reviewer" ? "/estudios" : "/usuarios");
}

export async function openFeat030StudioReview(page: Page, studioId: string, name: string) {
  const card = page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name, exact: true }) });
  await expect(card).toBeVisible();
  await card.getByRole("link", { name: /Abrir (revisão|moderação)/u }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/estudios/${studioId}`);
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
}

export async function expectFeat030PreviewsInspectable(page: Page) {
  const previews = page.getByRole("img", { name: /foto \d+(?:, capa)?$/u });
  await expect.poll(() => previews.count()).toBeGreaterThan(0);
  const count = await previews.count();
  for (let index = 0; index < count; index += 1) {
    const preview = previews.nth(index);
    await preview.scrollIntoViewIfNeeded();
    await expect
      .poll(() =>
        preview.evaluate(
          (image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
        ),
      )
      .toBe(true);
  }
}

export async function prepareFeat030Decision(page: Page, action: string, reason?: string) {
  await expectFeat030PreviewsInspectable(page);
  const actionButton = page.getByRole("button", { name: action, exact: true });
  await expect(actionButton).toBeEnabled();
  await actionButton.click();
  if (reason !== undefined) {
    await page.getByRole("textbox", { name: "Motivo para o dono" }).fill(reason);
  }
  await page
    .getByRole("checkbox", {
      name:
        action === "Desativar publicação" || action === "Restaurar publicação"
          ? "Revisei a publicação, o estado editorial e o impacto desta ação"
          : "Revisei a candidata, a versão vigente e o impacto desta ação",
    })
    .check();
  await expect(page.getByRole("button", { name: "Confirmar ação", exact: true })).toBeEnabled();
}

export async function pauseFeat030PublishedStudio(studioId: string) {
  const parsedStudioId = z.uuid().parse(studioId);
  await withE2EAdminClient(async (client) => {
    const result = await client.query(
      `update public.studios
       set status = 'paused'
       where id = $1::uuid and status = 'published'
       returning id`,
      [parsedStudioId],
    );
    if (result.rowCount !== 1) throw new Error("O estúdio FEAT-030 não foi pausado para o teste.");
  });
}

export async function readFeat030Evidence(studioId: string): Promise<Feat030Evidence> {
  const parsedStudioId = z.uuid().parse(studioId);
  return withE2EAdminClient(async (client) => {
    const result = await client.query(
      `select
         studio.id as studio_id,
         studio.status,
         studio.publication_version::integer,
         studio.published_revision_id,
         studio.draft_revision_id,
         studio.disabled_from_status,
         coalesce((
           select pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'id', revision.id,
               'name', revision.name,
               'status', revision.status
             ) order by revision.revision_number, revision.id
           )
           from public.studio_revisions as revision
           where revision.studio_id = studio.id
         ), '[]'::jsonb) as revisions,
         coalesce((
           select pg_catalog.jsonb_agg(event.event_type order by event.event_sequence)
           from public.studio_review_events as event
           where event.studio_id = studio.id
         ), '[]'::jsonb) as review_events,
         coalesce((
           select pg_catalog.jsonb_agg(outbox.template_key order by outbox.created_at, outbox.id)
           from public.email_outbox as outbox
           where outbox.studio_id = studio.id
         ), '[]'::jsonb) as outbox_templates,
         coalesce((
           select pg_catalog.jsonb_agg(event.action order by event.occurred_at, event.id)
           from audit.events as event
           where event.target_type = 'studio'
             and event.target_id = studio.id
             and event.action like 'backoffice.studio_%'
         ), '[]'::jsonb) as audit_actions
       from public.studios as studio
       where studio.id = $1::uuid`,
      [parsedStudioId],
    );
    return evidenceSchema.parse(result.rows[0]);
  });
}

export async function cleanupFeat030Scenario(
  page: Page,
  input: {
    operators: readonly Feat030Operator[];
    owner?: Feat030Owner | undefined;
    owners?: readonly Feat030Owner[] | undefined;
  },
) {
  const failures: Error[] = [];
  try {
    await closePageBeforeDatabaseCleanup(page);
  } catch (error) {
    failures.push(
      new Error("A página FEAT-030 não encerrou antes da limpeza.", {
        cause: error,
      }),
    );
  }
  try {
    await cleanupFeat031Users({ operators: input.operators });
  } catch (error) {
    failures.push(
      new Error("Os operadores FEAT-030 não foram removidos.", {
        cause: error,
      }),
    );
  }
  const owners = [...(input.owner === undefined ? [] : [input.owner]), ...(input.owners ?? [])];
  for (const owner of owners) {
    try {
      await cleanupFeat009QaIdentity(owner);
    } catch (error) {
      failures.push(new Error("O estúdio FEAT-030 não foi removido.", { cause: error }));
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "A limpeza FEAT-030 falhou.");
}

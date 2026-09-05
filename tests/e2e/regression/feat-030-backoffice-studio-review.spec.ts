import {
  apiSuccessSchema,
  backofficeStudioCommandResultSchema,
  backofficeStudioRejectCommandSchema,
  backofficeStudioReviewDetailSchema,
  backofficeStudioReviewQueueSchema,
  backofficeStudioReadActivityHeader,
} from "@set-livre/contracts";
import { expect, test } from "@playwright/test";
import { z } from "zod";

import { withE2EAdminClient } from "../../helpers/e2e-database-preflight";
import {
  cleanupFeat030Scenario,
  createFeat030Operator,
  expectFeat030PreviewsInspectable,
  openFeat030StudioReview,
  pauseFeat030PublishedStudio,
  prepareFeat030Decision,
  provisionAndLoginFeat030Operator,
  provisionFeat030ChangesPendingStudio,
  provisionFeat030PendingStudio,
  provisionFeat030PublishedStudio,
  readFeat030Evidence,
  triggerFeat030StaleWindowFocusRefetch,
  type Feat030Owner,
} from "../../helpers/feat-030-backoffice-studio-review";

const queueEnvelopeSchema = apiSuccessSchema(backofficeStudioReviewQueueSchema);
const detailEnvelopeSchema = apiSuccessSchema(backofficeStudioReviewDetailSchema);
const requestId = "30000000-0000-4000-8000-000000000030";

function errorPayload(
  code: "CONFLICT" | "INTERNAL_ERROR" | "NOT_FOUND" | "STALE_STATE",
  message: string,
) {
  return { error: { code, message, requestId } };
}

test("SL-F030-E2E-005 @p1 admin restaura exatamente published, paused e changes_pending", async ({
  page,
}, testInfo) => {
  test.setTimeout(480_000);
  const admin = createFeat030Operator(testInfo, "005_disable_restore");
  const owners: Feat030Owner[] = [];
  try {
    const published = await provisionFeat030PublishedStudio(
      page,
      testInfo,
      "005_restore_published",
      "30051",
    );
    owners.push(published.owner);
    const paused = await provisionFeat030PublishedStudio(
      page,
      testInfo,
      "005_restore_paused",
      "30052",
    );
    owners.push(paused.owner);
    await pauseFeat030PublishedStudio(paused.studioId);
    const changesPending = await provisionFeat030ChangesPendingStudio(
      page,
      testInfo,
      "005_restore_changes_pending",
      "30053",
    );
    owners.push(changesPending.owner);

    await provisionAndLoginFeat030Operator(page, admin, "admin", "030005");
    await page.getByRole("link", { name: "Estúdios" }).click();

    const scenarios: ReadonlyArray<{
      destination: string;
      disabledName: string;
      expectedStatus: "changes_pending" | "paused" | "published";
      hiddenWhileDisabledName?: string;
      reviewName: string;
      studioId: string;
    }> = [
      {
        destination: "Publicado",
        disabledName: published.name,
        expectedStatus: "published" as const,
        reviewName: published.name,
        studioId: published.studioId,
      },
      {
        destination: "Publicação pausada",
        disabledName: paused.name,
        expectedStatus: "paused" as const,
        reviewName: paused.name,
        studioId: paused.studioId,
      },
      {
        destination: "Publicado com alterações em revisão",
        disabledName: changesPending.publishedName,
        expectedStatus: "changes_pending" as const,
        hiddenWhileDisabledName: changesPending.candidateName,
        reviewName: changesPending.candidateName,
        studioId: changesPending.studioId,
      },
    ];

    for (const scenario of scenarios) {
      await openFeat030StudioReview(page, scenario.studioId, scenario.reviewName);
      await prepareFeat030Decision(page, "Desativar publicação");
      await page.getByRole("button", { name: "Confirmar ação", exact: true }).click();
      await expect(
        page.getByRole("status").filter({ hasText: "Operação confirmada" }),
      ).toBeVisible();
      expect(await readFeat030Evidence(scenario.studioId)).toMatchObject({
        disabled_from_status: scenario.expectedStatus,
        status: "disabled",
      });

      await page.getByRole("link", { name: "Voltar aos estúdios" }).click();
      if (scenario.hiddenWhileDisabledName !== undefined) {
        await expect(
          page.getByRole("heading", { name: scenario.hiddenWhileDisabledName, exact: true }),
        ).toHaveCount(0);
      }
      await openFeat030StudioReview(page, scenario.studioId, scenario.disabledName);
      if (scenario.hiddenWhileDisabledName !== undefined) {
        await expect(page.getByText(scenario.hiddenWhileDisabledName, { exact: true })).toHaveCount(
          0,
        );
      }
      const state = page.getByRole("heading", { name: "Estado confirmado" }).locator("..");
      await expect(state.getByText("Destino da restauração", { exact: true })).toBeVisible();
      await expect(state.getByText(scenario.destination, { exact: true })).toBeVisible();

      await prepareFeat030Decision(page, "Restaurar publicação");
      const confirmation = page.getByRole("heading", { name: "Confirmar impacto" }).locator("..");
      await expect(confirmation.getByText("Destino exato", { exact: true })).toBeVisible();
      await expect(confirmation.getByText(scenario.destination, { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Confirmar ação", exact: true }).click();
      await expect(
        page.getByRole("status").filter({ hasText: "Operação confirmada" }),
      ).toBeVisible();

      const restored = await readFeat030Evidence(scenario.studioId);
      expect(restored).toMatchObject({
        disabled_from_status: null,
        status: scenario.expectedStatus,
      });
      expect(restored.audit_actions).toEqual([
        "backoffice.studio_disabled",
        "backoffice.studio_restored",
      ]);
      await page.getByRole("link", { name: "Voltar aos estúdios" }).click();
      const restoredCard = page
        .getByRole("article")
        .filter({ has: page.getByRole("heading", { name: scenario.reviewName, exact: true }) });
      await expect(restoredCard).toBeVisible();
    }
  } finally {
    await cleanupFeat030Scenario(page, { operators: [admin], owners });
  }
});

test("SL-F030-E2E-017 @p0 rejeição de outra tentativa e motivo não confirma a decisão pendente", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const reviewer = createFeat030Operator(testInfo, "017_attempt_identity");
  let owner: Feat030Owner | undefined;
  const commands: unknown[] = [];
  const statuses: number[] = [];
  const intendedReason = "Confirme o endereço antes de enviar novamente.";
  const otherReason = "Confirme a capacidade antes de enviar novamente.";
  const otherKey = "30000000-0000-4000-8000-000000000017";
  try {
    const pending = await provisionFeat030PendingStudio(
      page,
      testInfo,
      "017_attempt_identity",
      "3017",
    );
    owner = pending.owner;
    await provisionAndLoginFeat030Operator(page, reviewer, "reviewer", "030017");
    await openFeat030StudioReview(page, pending.studioId, pending.name);
    await prepareFeat030Decision(page, "Rejeitar e devolver para correção", intendedReason);
    await page.route("**/api/commands", async (route) => {
      const command = backofficeStudioRejectCommandSchema.parse(route.request().postDataJSON());
      commands.push(command);
      // A confirmação vem de uma tentativa realmente persistida, com outro motivo.
      const response = await route.fetch(
        commands.length === 1
          ? {
              postData: {
                ...command,
                idempotencyKey: otherKey,
                payload: { ...command.payload, reason: otherReason },
              },
            }
          : {},
      );
      statuses.push(response.status());
      if (commands.length === 1) {
        expect(response.status()).toBe(200);
        const envelope = apiSuccessSchema(backofficeStudioCommandResultSchema).parse(
          await response.json(),
        );
        expect(envelope.data).toMatchObject({
          action: command.action,
          idempotencyKey: otherKey,
          scope: command.expectedScope,
          studioId: command.payload.studioId,
          revisionId: command.payload.expectedRevisionId,
          publicationVersion: command.payload.expectedPublicationVersion + 1,
        });
        expect(envelope.data.idempotencyKey).not.toBe(command.idempotencyKey);
      }
      await route.fulfill({ response });
    });
    await page.getByRole("button", { name: "Confirmar ação", exact: true }).click();
    const retry = page.getByRole("button", { name: "Repetir mesma tentativa" });
    await expect(retry).toBeEnabled();
    await expect(page.getByRole("textbox", { name: "Motivo para o dono" })).toHaveValue(
      intendedReason,
    );
    await expect(page.getByRole("textbox", { name: "Motivo para o dono" })).toBeDisabled();
    await expect(page.getByRole("status").filter({ hasText: "Operação confirmada" })).toHaveCount(
      0,
    );
    expect(commands).toHaveLength(1);

    // Reenvia A intacta: o conflito real exige releitura, nunca atribui o sucesso de B a A.
    await retry.click();
    await expect(page.getByText("Revisão não disponível", { exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Motivo para o dono" })).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: "Operação confirmada" })).toHaveCount(
      0,
    );
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
    expect(statuses).toEqual([200, 409]);
    const evidence = await readFeat030Evidence(pending.studioId);
    expect(evidence.review_events).toEqual(["submitted", "rejected"]);
    expect(evidence.audit_actions).toEqual(["backoffice.studio_rejected"]);
    await withE2EAdminClient(async (client) => {
      const result = await client.query<{ matches: boolean }>(
        "select count(*) = 1 and bool_and(rejection_reason = $2) as matches from public.studio_review_events where studio_id = $1::uuid and event_type = 'rejected'",
        [pending.studioId, otherReason],
      );
      expect(result.rows[0]?.matches).toBe(true);
    });
  } finally {
    await page.unroute("**/api/commands");
    await cleanupFeat030Scenario(page, { operators: [reviewer], owner });
  }
});

test("SL-F030-E2E-010 @p0 resposta perdida e refetch concorrente preservam formulário e tentativa exata", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const reviewer = createFeat030Operator(testInfo, "010_lost_response");
  let owner: Feat030Owner | undefined;
  const bodies: string[] = [];
  const upstreamStatuses: number[] = [];
  let automaticDetailReads = 0;
  let concurrentReadCancelled = false;
  let concurrentReadDeliveryRejected = false;
  let detailPattern: string | undefined;
  let releaseConcurrentRead: (() => void) | undefined;
  let responseDropped = false;
  const concurrentReadReleased = new Promise<void>((resolve) => {
    releaseConcurrentRead = resolve;
  });
  let markConcurrentReadCaptured: (() => void) | undefined;
  const concurrentReadCaptured = new Promise<void>((resolve) => {
    markConcurrentReadCaptured = resolve;
  });
  try {
    const pending = await provisionFeat030PendingStudio(
      page,
      testInfo,
      "010_lost_response",
      "3010",
    );
    owner = pending.owner;
    await provisionAndLoginFeat030Operator(page, reviewer, "reviewer", "030010");
    await openFeat030StudioReview(page, pending.studioId, pending.name);
    await expectFeat030PreviewsInspectable(page);
    await expect(
      page.getByRole("button", { name: "Rejeitar e devolver para correção", exact: true }),
    ).toBeEnabled();

    detailPattern = `**/api/studios/${pending.studioId}`;
    page.on("requestfailed", (request) => {
      if (
        request.method() === "GET" &&
        request.url().endsWith(`/api/studios/${pending.studioId}`)
      ) {
        concurrentReadCancelled = true;
      }
    });
    await page.route(detailPattern, async (route) => {
      expect(route.request().headers()[backofficeStudioReadActivityHeader]).toBe("passive");
      automaticDetailReads += 1;
      const response = await route.fetch();
      if (automaticDetailReads === 1) {
        markConcurrentReadCaptured?.();
        await concurrentReadReleased;
        const envelope = detailEnvelopeSchema.parse(await response.json());
        try {
          await route.fulfill({
            json: {
              ...envelope,
              data: {
                ...envelope.data,
                publicationVersion: envelope.data.publicationVersion + 1,
              },
            },
            response,
          });
        } catch {
          concurrentReadDeliveryRejected = true;
        }
        return;
      }
      try {
        await route.fulfill({ response });
      } catch {
        concurrentReadDeliveryRejected = true;
      }
    });
    await page.route("**/api/commands", async (route) => {
      const parsed = z.object({ action: z.string() }).safeParse(route.request().postDataJSON());
      if (!parsed.success || parsed.data.action !== "backoffice.studio.reject") {
        await route.continue();
        return;
      }
      const body = route.request().postData();
      if (body === null) {
        await route.abort("failed");
        return;
      }
      bodies.push(body);
      const response = await route.fetch();
      upstreamStatuses.push(response.status());
      if (!responseDropped) {
        responseDropped = true;
        await route.abort("connectionfailed");
        return;
      }
      await route.fulfill({ response });
    });

    await triggerFeat030StaleWindowFocusRefetch(page);
    await concurrentReadCaptured;
    await expect(
      page.getByText("Atualizando o caso em segundo plano sem interromper sua revisão…", {
        exact: true,
      }),
    ).toBeVisible();

    const rejectionReason = "Confirme o endereço e envie novamente para revisão.";
    await prepareFeat030Decision(page, "Rejeitar e devolver para correção", rejectionReason);
    const reason = page.getByRole("textbox", { name: "Motivo para o dono" });
    const confirmation = page.getByRole("checkbox", {
      name: "Revisei a candidata, a versão vigente e o impacto desta ação",
    });
    await expect(confirmation).toBeFocused();
    releaseConcurrentRead?.();
    await expect.poll(() => concurrentReadCancelled || concurrentReadDeliveryRejected).toBe(true);
    await expect(
      page.getByText("Atualizando o caso em segundo plano sem interromper sua revisão…", {
        exact: true,
      }),
    ).toHaveCount(0);
    expect(automaticDetailReads).toBe(1);
    await expect(reason).toHaveValue(rejectionReason);
    await expect(confirmation).toBeChecked();
    await expect(confirmation).toBeFocused();

    const confirm = page.getByRole("button", { name: "Confirmar ação", exact: true });
    await confirm.click();
    const exactRetry = page.getByRole("button", { name: "Repetir mesma tentativa" });
    await expect(exactRetry).toBeEnabled();
    await expect(exactRetry).toBeFocused();
    await exactRetry.click();
    await expect(page.getByRole("status").filter({ hasText: "Operação confirmada" })).toBeVisible();

    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
    const firstCommand = z
      .object({ idempotencyKey: z.uuid(), payload: z.unknown() })
      .passthrough()
      .parse(JSON.parse(bodies[0] ?? "null") as unknown);
    const replayedCommand = z
      .object({ idempotencyKey: z.uuid(), payload: z.unknown() })
      .passthrough()
      .parse(JSON.parse(bodies[1] ?? "null") as unknown);
    expect(replayedCommand.idempotencyKey).toBe(firstCommand.idempotencyKey);
    expect(replayedCommand.payload).toEqual(firstCommand.payload);
    expect(upstreamStatuses).toEqual([200, 200]);

    const evidence = await readFeat030Evidence(pending.studioId);
    expect(evidence.review_events).toEqual(["submitted", "rejected"]);
    expect(evidence.audit_actions).toEqual(["backoffice.studio_rejected"]);
    expect(evidence.outbox_templates).toEqual([
      "studio.review.submitted",
      "studio.review.rejected",
    ]);
  } finally {
    releaseConcurrentRead?.();
    await page.unroute("**/api/commands");
    if (detailPattern !== undefined) await page.unroute(detailPattern);
    await cleanupFeat030Scenario(page, { operators: [reviewer], owner });
  }
});

test("SL-F030-E2E-011 @p1 imagem 403 bloqueia decisão e renovação restaura inspeção integral", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const reviewer = createFeat030Operator(testInfo, "011_preview_renewal");
  let owner: Feat030Owner | undefined;
  let failedPreview = false;
  try {
    const pending = await provisionFeat030PendingStudio(
      page,
      testInfo,
      "011_preview_renewal",
      "3011",
    );
    owner = pending.owner;
    await provisionAndLoginFeat030Operator(page, reviewer, "reviewer", "030011");
    await page.route("**/storage/v1/object/sign/**", async (route) => {
      if (!failedPreview) {
        failedPreview = true;
        await route.fulfill({ body: "", contentType: "image/png", status: 403 });
        return;
      }
      await route.continue();
    });
    await openFeat030StudioReview(page, pending.studioId, pending.name);

    await expect(
      page.getByText("Uma prévia não pôde ser inspecionada", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Aprovar e publicar" })).toBeDisabled();
    await page.getByRole("button", { name: "Renovar prévias" }).click();
    await expect(
      page.getByText("As prévias foram renovadas e o caso autoritativo foi confirmado."),
    ).toBeVisible();
    await expectFeat030PreviewsInspectable(page);
    await expect(page.getByRole("button", { name: "Aprovar e publicar" })).toBeEnabled();
    const images = page.getByRole("img", { name: /foto \d+(?:, capa)?$/u });
    for (let index = 0; index < (await images.count()); index += 1) {
      const state = await images.nth(index).evaluate((image) => ({
        height: image instanceof HTMLImageElement ? image.naturalHeight : 0,
        objectFit: getComputedStyle(image).objectFit,
        width: image instanceof HTMLImageElement ? image.naturalWidth : 0,
      }));
      expect(state.objectFit).toBe("contain");
      expect(state.width).toBeGreaterThan(0);
      expect(state.height).toBeGreaterThan(0);
    }
  } finally {
    await page.unroute("**/storage/v1/object/sign/**");
    await cleanupFeat030Scenario(page, { operators: [reviewer], owner });
  }
});

test("SL-F030-E2E-012 @p0 conflito seguido de 503 e 404 nunca reexpõe snapshot antigo", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const reviewer = createFeat030Operator(testInfo, "012_fail_closed_refetch");
  let owner: Feat030Owner | undefined;
  let detailPattern: string | undefined;
  let detailReads = 0;
  try {
    const pending = await provisionFeat030PendingStudio(
      page,
      testInfo,
      "012_fail_closed_refetch",
      "3012",
    );
    owner = pending.owner;
    await provisionAndLoginFeat030Operator(page, reviewer, "reviewer", "030012");
    await openFeat030StudioReview(page, pending.studioId, pending.name);
    await prepareFeat030Decision(page, "Aprovar e publicar");

    detailPattern = `**/api/studios/${pending.studioId}`;
    await page.route(detailPattern, async (route) => {
      expect(route.request().headers()[backofficeStudioReadActivityHeader]).toBe("interactive");
      detailReads += 1;
      await route.fulfill({
        json:
          detailReads === 1
            ? errorPayload("INTERNAL_ERROR", "A leitura autoritativa falhou.")
            : errorPayload("NOT_FOUND", "A revisão deixou de existir."),
        status: detailReads === 1 ? 503 : 404,
      });
    });
    await page.route("**/api/commands", async (route) => {
      await route.fulfill({
        json: errorPayload("CONFLICT", "A revisão mudou antes da decisão."),
        status: 409,
      });
    });

    await page.getByRole("button", { name: "Confirmar ação", exact: true }).click();
    await expect(
      page.getByText("Não foi possível confirmar o estado atual", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: pending.name })).toHaveCount(0);
    await expect(page.getByRole("img", { name: /foto/u })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Aprovar e publicar" })).toHaveCount(0);
    await expect(page.getByText(/O caso mudou|carregado novamente/u)).toHaveCount(0);

    await page.getByRole("button", { name: "Tentar carregar novamente" }).click();
    await expect(page.getByText("Revisão não disponível", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: pending.name })).toHaveCount(0);
    await expect(page.getByRole("img", { name: /foto/u })).toHaveCount(0);
    expect(detailReads).toBe(2);
  } finally {
    await page.unroute("**/api/commands");
    if (detailPattern !== undefined) await page.unroute(detailPattern);
    await cleanupFeat030Scenario(page, { operators: [reviewer], owner });
  }
});

test("SL-F030-E2E-014 @p0 404 direto do comando descarta formulário e snapshot antes da releitura", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const reviewer = createFeat030Operator(testInfo, "014_direct_command_404");
  let owner: Feat030Owner | undefined;
  let detailPattern: string | undefined;
  let releaseDetailRead: (() => void) | undefined;
  const detailReadReleased = new Promise<void>((resolve) => {
    releaseDetailRead = resolve;
  });
  let markDetailReadCaptured: (() => void) | undefined;
  const detailReadCaptured = new Promise<void>((resolve) => {
    markDetailReadCaptured = resolve;
  });
  try {
    const pending = await provisionFeat030PendingStudio(
      page,
      testInfo,
      "014_direct_command_404",
      "3014",
    );
    owner = pending.owner;
    await provisionAndLoginFeat030Operator(page, reviewer, "reviewer", "030014");
    await openFeat030StudioReview(page, pending.studioId, pending.name);
    await prepareFeat030Decision(page, "Aprovar e publicar");

    detailPattern = `**/api/studios/${pending.studioId}`;
    await page.route(detailPattern, async (route) => {
      markDetailReadCaptured?.();
      await detailReadReleased;
      await route.fulfill({
        json: errorPayload("NOT_FOUND", "A revisão deixou de existir."),
        status: 404,
      });
    });
    await page.route("**/api/commands", async (route) => {
      await route.fulfill({
        json: errorPayload("NOT_FOUND", "A revisão deixou de existir antes da decisão."),
        status: 404,
      });
    });

    await page.getByRole("button", { name: "Confirmar ação", exact: true }).click();
    await detailReadCaptured;
    await expect(page.getByRole("heading", { name: "Confirmando o estado atual" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: pending.name })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Confirmar impacto" })).toHaveCount(0);
    await expect(page.getByRole("img", { name: /foto/u })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Aprovar e publicar" })).toHaveCount(0);

    releaseDetailRead?.();
    await expect(page.getByText("Revisão não disponível", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: pending.name })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Confirmar impacto" })).toHaveCount(0);
    await expect(page.getByRole("img", { name: /foto/u })).toHaveCount(0);
  } finally {
    releaseDetailRead?.();
    await page.unroute("**/api/commands");
    if (detailPattern !== undefined) await page.unroute(detailPattern);
    await cleanupFeat030Scenario(page, { operators: [reviewer], owner });
  }
});

test("SL-F030-E2E-013 @p1 fila recupera carga inicial e página incremental preservando confirmados", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const reviewer = createFeat030Operator(testInfo, "013_queue_recovery");
  let owner: Feat030Owner | undefined;
  let firstEnvelope: z.infer<typeof queueEnvelopeSchema> | undefined;
  let failureMode: "background" | "incremental" | "initial" | undefined = "initial";
  let forceEmpty = false;
  let returnEmptyNextPage = false;
  try {
    const pending = await provisionFeat030PendingStudio(
      page,
      testInfo,
      "013_queue_recovery",
      "3013",
    );
    owner = pending.owner;
    await provisionAndLoginFeat030Operator(page, reviewer, "reviewer", "030013");
    await expect(page.getByRole("heading", { name: pending.name, exact: true })).toBeVisible();

    await page.route("**/api/studios", async (route) => {
      if (failureMode !== undefined) {
        await route.fulfill({
          json: errorPayload("INTERNAL_ERROR", "A página não pôde ser confirmada."),
          status: 503,
        });
        return;
      }
      if (returnEmptyNextPage) {
        if (firstEnvelope === undefined) {
          await route.abort("failed");
          return;
        }
        await route.fulfill({
          json: {
            ...firstEnvelope,
            data: { ...firstEnvelope.data, items: [], nextCursor: null },
          },
          status: 200,
        });
        return;
      }
      const response = await route.fetch();
      const envelope = queueEnvelopeSchema.parse(await response.json());
      if (forceEmpty) {
        await route.fulfill({
          json: { ...envelope, data: { ...envelope.data, items: [], nextCursor: null } },
          response,
        });
        return;
      }
      firstEnvelope = envelope;
      await route.fulfill({
        json: { ...envelope, data: { ...envelope.data, nextCursor: "qa-feat-030-page-2" } },
        response,
      });
    });

    await page.reload();
    await expect(page.getByText("A fila não pôde ser carregada", { exact: true })).toBeVisible();
    failureMode = undefined;
    await page.getByRole("button", { name: "Tentar carregar novamente" }).click();
    const confirmedCard = page
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { name: pending.name, exact: true }) });
    await expect(confirmedCard).toBeVisible();

    failureMode = "background";
    await triggerFeat030StaleWindowFocusRefetch(page);
    await expect(page.getByText("A atualização da fila falhou", { exact: true })).toBeVisible();
    await expect(confirmedCard).toBeVisible();
    failureMode = undefined;
    await page.getByRole("button", { name: "Tentar atualizar a fila novamente" }).click();
    await expect(page.getByText("A atualização da fila falhou", { exact: true })).toHaveCount(0);
    await expect(confirmedCard).toBeVisible();

    failureMode = "incremental";
    await page.getByRole("button", { name: "Carregar mais" }).click();
    await expect(
      page.getByText("A próxima página não pôde ser carregada", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("A atualização da fila falhou", { exact: true })).toHaveCount(0);
    await expect(confirmedCard).toBeVisible();
    failureMode = undefined;
    returnEmptyNextPage = true;
    await page.getByRole("button", { name: "Tentar próxima página novamente" }).click();
    await expect(
      page.getByText("A próxima página não pôde ser carregada", { exact: true }),
    ).toHaveCount(0);
    await expect(confirmedCard).toBeVisible();
    await expect(page.getByRole("button", { name: "Carregar mais" })).toHaveCount(0);

    returnEmptyNextPage = false;
    forceEmpty = true;
    await page.reload();
    await expect(page.getByText("Nenhum estúdio exige ação agora.", { exact: true })).toBeVisible();
    await expect(page.getByRole("article")).toHaveCount(0);
  } finally {
    await page.unroute("**/api/studios");
    await cleanupFeat030Scenario(page, { operators: [reviewer], owner });
  }
});

test("SL-F030-E2E-016 @p1 fila inicialmente offline recupera leitura sem evento online", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const admin = createFeat030Operator(testInfo, "016_offline_queue");
  let owner: Feat030Owner | undefined;
  let queueUnavailable = true;
  let queueReads = 0;
  let commandPosts = 0;
  try {
    const pending = await provisionFeat030PendingStudio(
      page,
      testInfo,
      "016_offline_queue",
      "3016",
    );
    owner = pending.owner;
    await provisionAndLoginFeat030Operator(page, admin, "admin", "030016");
    await expect(page.getByRole("button", { name: "Sair", exact: true })).toBeEnabled();

    await page.route("**/api/studios", async (route) => {
      queueReads += 1;
      if (queueUnavailable) await route.abort("failed");
      else await route.continue();
    });
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/commands") {
        commandPosts += 1;
      }
    });

    // The mounted provider is on /usuarios: no queue observer or cached page exists yet.
    // Keep HTTP/session checks available, but put TanStack offline before mounting the queue.
    await page.evaluate(() => {
      document.documentElement.dataset.qaFeat030Network = "offline";
      window.addEventListener("online", () => {
        document.documentElement.dataset.qaFeat030Network = "online";
      });
      window.dispatchEvent(new Event("offline"));
    });
    await page
      .getByRole("navigation", { name: "Backoffice", exact: true })
      .getByRole("link", { name: "Estúdios", exact: true })
      .click();
    await expect(page.getByRole("heading", { level: 1, name: "Estúdios" })).toBeVisible();
    await expect(page.getByText("A fila não pôde ser carregada", { exact: true })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Carregando estúdios…" })).toHaveCount(
      0,
    );
    await expect(page.getByRole("article")).toHaveCount(0);
    await expect(page.getByText("Nenhum estúdio exige ação agora.", { exact: true })).toHaveCount(
      0,
    );
    // Strict Mode may cancel the first mount's read; only the explicit recovery
    // below must add exactly one read after the error has settled.
    expect(queueReads).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.documentElement.dataset.qaFeat030Network)).toBe(
      "offline",
    );

    queueUnavailable = false;
    const readsBeforeRetry = queueReads;
    const retry = page.getByRole("button", { name: "Tentar carregar novamente", exact: true });
    await expect(retry).toBeEnabled();
    await retry.click();
    const confirmedCard = page
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { name: pending.name, exact: true }) });
    await expect(confirmedCard.getByRole("link", { name: "Abrir revisão" })).toBeVisible();
    await expect(page.getByText("A fila não pôde ser carregada", { exact: true })).toHaveCount(0);
    expect(queueReads).toBe(readsBeforeRetry + 1);
    expect(commandPosts).toBe(0);
    expect(await page.evaluate(() => document.documentElement.dataset.qaFeat030Network)).toBe(
      "offline",
    );
  } finally {
    await page.unroute("**/api/studios");
    await cleanupFeat030Scenario(page, { operators: [admin], owner });
  }
});

test("SL-F030-E2E-015 @p0 rota cobre loading, erro recuperável, 404 e descarte terminal", async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  const reviewer = createFeat030Operator(testInfo, "015_route_boundaries");
  let owner: Feat030Owner | undefined;
  let detailPattern: string | undefined;
  let executeRevoked = false;
  const restoreExecuteGrant = async () => {
    if (!executeRevoked) return;
    await withE2EAdminClient(async (client) => {
      await client.query(
        "grant execute on function private.get_backoffice_studio_review(uuid, uuid, timestamptz, uuid, boolean) to app_dal",
      );
    });
    executeRevoked = false;
  };

  try {
    const pending = await provisionFeat030PendingStudio(
      page,
      testInfo,
      "015_route_boundaries",
      "3015",
    );
    owner = pending.owner;
    await provisionAndLoginFeat030Operator(page, reviewer, "reviewer", "030015");
    const detailUrl = new URL(`/estudios/${pending.studioId}`, page.url()).toString();

    await withE2EAdminClient(async (client) => {
      await client.query("begin");
      try {
        await client.query("select id from public.studios where id = $1::uuid for update", [
          pending.studioId,
        ]);
        await page.goto(detailUrl, { waitUntil: "commit" });
        await expect(
          page.getByRole("heading", { name: "Confirmando o caso editorial" }),
        ).toBeVisible();
      } finally {
        await client.query("rollback");
      }
    });
    await expect(page.getByRole("heading", { level: 1, name: pending.name })).toBeVisible();

    await withE2EAdminClient(async (client) => {
      await client.query(
        "revoke execute on function private.get_backoffice_studio_review(uuid, uuid, timestamptz, uuid, boolean) from app_dal",
      );
    });
    executeRevoked = true;
    await page.goto(detailUrl);
    await expect(
      page.getByText("Não foi possível carregar esta revisão", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: pending.name })).toHaveCount(0);
    await restoreExecuteGrant();
    await page.getByRole("button", { name: "Tentar carregar novamente" }).click();
    await expect(page.getByRole("heading", { level: 1, name: pending.name })).toBeVisible();

    detailPattern = `**/api/studios/${pending.studioId}`;
    await page.route(detailPattern, async (route) => {
      await route.fulfill({
        json: errorPayload("NOT_FOUND", "A revisão deixou de estar disponível."),
        status: 404,
      });
    });
    await triggerFeat030StaleWindowFocusRefetch(page);
    await expect(page.getByText("Revisão não disponível", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: pending.name })).toHaveCount(0);
    await expect(page.getByRole("img", { name: /foto/u })).toHaveCount(0);
    await page.unroute(detailPattern);
    detailPattern = undefined;

    await page.goto(
      new URL("/estudios/30000000-0000-4000-8000-000000000404", detailUrl).toString(),
    );
    await expect(page.getByText("Revisão não encontrada", { exact: true })).toBeVisible();
    await expect(page.getByText(pending.name, { exact: true })).toHaveCount(0);
  } finally {
    await restoreExecuteGrant();
    if (detailPattern !== undefined) await page.unroute(detailPattern);
    await cleanupFeat030Scenario(page, { operators: [reviewer], owner });
  }
});

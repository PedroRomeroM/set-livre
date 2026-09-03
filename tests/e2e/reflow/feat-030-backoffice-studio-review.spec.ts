import { apiSuccessSchema, backofficeStudioReviewDetailSchema } from "@set-livre/contracts";
import { expect, test } from "@playwright/test";

import {
  cleanupFeat030Scenario,
  createFeat030Operator,
  expectFeat030PreviewsInspectable,
  feat030ExtremeTextFixture,
  openFeat030StudioReview,
  provisionAndLoginFeat030Operator,
  provisionFeat030PendingStudio,
  triggerFeat030StaleWindowFocusRefetch,
  type Feat030Owner,
} from "../../helpers/feat-030-backoffice-studio-review";

const signedPreviewPattern = "**/storage/v1/object/sign/**";
const detailEnvelopeSchema = apiSuccessSchema(backofficeStudioReviewDetailSchema);
const extremePortraitPreview =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="8192" viewBox="0 0 1 8192"><path fill="#64748b" d="M0 0h1v8192H0z"/></svg>';

test("SL-F030-E2E-008 @p1 confirmação permanece operável no reflow de 160x360", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  expect(page.viewportSize()).toEqual({ height: 360, width: 160 });
  const reviewer = createFeat030Operator(testInfo, "008_reflow");
  let owner: Feat030Owner | undefined;
  let detailPattern: string | undefined;
  try {
    const pending = await provisionFeat030PendingStudio(page, testInfo, "008_reflow", "3008");
    owner = pending.owner;
    await provisionAndLoginFeat030Operator(page, reviewer, "reviewer", "030008");
    await page.route(signedPreviewPattern, async (route) => {
      await route.fulfill({
        body: extremePortraitPreview,
        contentType: "image/svg+xml",
        status: 200,
      });
    });
    await openFeat030StudioReview(page, pending.studioId, pending.name);
    await expectFeat030PreviewsInspectable(page);

    detailPattern = `**/api/studios/${pending.studioId}`;
    await page.route(detailPattern, async (route) => {
      const response = await route.fetch();
      const envelope = detailEnvelopeSchema.parse(await response.json());
      const candidateRevision = {
        ...envelope.data.candidateRevision,
        amenities: [
          {
            active: true,
            id: "30000000-0000-4000-8000-000000000032",
            name: feat030ExtremeTextFixture.taxonomyName,
            sortOrder: 1,
          },
        ],
        description: feat030ExtremeTextFixture.description,
        faqs: [
          {
            answer: feat030ExtremeTextFixture.faqAnswer,
            id: "30000000-0000-4000-8000-000000000033",
            position: 1,
            question: feat030ExtremeTextFixture.faqQuestion,
          },
        ],
        tags: [
          {
            active: true,
            id: "30000000-0000-4000-8000-000000000031",
            name: feat030ExtremeTextFixture.taxonomyName,
            sortOrder: 1,
          },
        ],
        usageRules: feat030ExtremeTextFixture.usageRules,
      };
      const detail = backofficeStudioReviewDetailSchema.parse({
        ...envelope.data,
        candidateRevision,
      });
      await route.fulfill({ json: { ...envelope, data: detail }, response });
    });
    await triggerFeat030StaleWindowFocusRefetch(page);
    await expect(
      page.getByText(feat030ExtremeTextFixture.description, { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(feat030ExtremeTextFixture.usageRules, { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(feat030ExtremeTextFixture.faqQuestion, { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(feat030ExtremeTextFixture.faqAnswer, { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(feat030ExtremeTextFixture.taxonomyName, { exact: true }),
    ).toHaveCount(2);

    const approve = page.getByRole("button", { name: "Aprovar e publicar" });
    await approve.scrollIntoViewIfNeeded();
    await expect(approve).toBeVisible();
    await expect(approve).toBeEnabled();
    await approve.click();
    const confirmation = page.getByRole("heading", { level: 3, name: "Confirmar impacto" });
    await expect(confirmation).toBeVisible();
    await page
      .getByRole("checkbox", {
        name: "Revisei a candidata, a versão vigente e o impacto desta ação",
      })
      .scrollIntoViewIfNeeded();
    await expect(page.getByRole("button", { name: "Confirmar ação", exact: true })).toBeVisible();

    const skipLink = page.getByRole("link", { name: "Ir para o conteúdo" });
    await skipLink.focus();
    await expect(skipLink).toBeFocused();
    await expect(skipLink).toBeVisible();

    const simulatedSafeArea = { left: 24, right: 20, top: 16 };
    await skipLink.evaluate((element, safeArea) => {
      if (!(element instanceof HTMLElement)) {
        throw new Error("O link de salto não expõe estilos de elemento HTML.");
      }
      element.style.setProperty("--sl-skip-link-inset-top", `${safeArea.top}px`);
      element.style.setProperty("--sl-skip-link-inset-right", `${safeArea.right}px`);
      element.style.setProperty("--sl-skip-link-inset-left", `${safeArea.left}px`);
    }, simulatedSafeArea);

    const layout = await page.evaluate((safeArea) => {
      const clientWidth = document.documentElement.clientWidth;
      const measuredElements = [...document.querySelectorAll("body *")].map((element) => {
        const rectangle = element.getBoundingClientRect();
        return {
          className: element.getAttribute("class"),
          clientWidth: element.clientWidth,
          left: rectangle.left,
          right: rectangle.right,
          scrollWidth: element.scrollWidth,
          tag: element.tagName,
          text: element.textContent?.trim().slice(0, 80) ?? "",
        };
      });
      const skipLinkRectangle = document
        .querySelector<HTMLAnchorElement>('a[href="#conteudo-principal"]')
        ?.getBoundingClientRect();
      return {
        bodyClientWidth: document.body.clientWidth,
        bodyFits: document.body.scrollWidth <= window.innerWidth,
        bodyScrollWidth: document.body.scrollWidth,
        documentClientWidth: clientWidth,
        documentFits: document.documentElement.scrollWidth <= clientWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        images: [...document.querySelectorAll("img")].map((image) => ({
          fits: image.getBoundingClientRect().right <= clientWidth,
          frameHeight: image.parentElement?.getBoundingClientRect().height ?? 0,
          height: image.getBoundingClientRect().height,
          maximumFrameHeight: Math.min(512, Math.max(160, window.innerHeight * 0.6)) + 2,
          naturalHeight: image.naturalHeight,
          naturalWidth: image.naturalWidth,
          objectFit: getComputedStyle(image).objectFit,
        })),
        overflowing: measuredElements
          .filter((element) => element.left < 0 || element.right > clientWidth)
          .map((element) => ({
            ...element,
            left: Math.round(element.left * 1000) / 1000,
            right: Math.round(element.right * 1000) / 1000,
          }))
          .slice(0, 16),
        skipLink:
          skipLinkRectangle === undefined
            ? null
            : {
                fits: skipLinkRectangle.left >= 0 && skipLinkRectangle.right <= clientWidth,
                left: skipLinkRectangle.left,
                right: skipLinkRectangle.right,
                safeAreaCleared:
                  skipLinkRectangle.left >= safeArea.left &&
                  skipLinkRectangle.right <= clientWidth - safeArea.right &&
                  skipLinkRectangle.top >= safeArea.top,
                top: skipLinkRectangle.top,
              },
        windowInnerWidth: window.innerWidth,
      };
    }, simulatedSafeArea);
    const layoutEvidence = JSON.stringify(layout, null, 2);
    expect(layout.bodyFits, layoutEvidence).toBe(true);
    expect(layout.documentFits, layoutEvidence).toBe(true);
    expect(layout.overflowing).toEqual([]);
    expect(layout.skipLink).not.toBeNull();
    expect(layout.skipLink?.fits, layoutEvidence).toBe(true);
    expect(layout.skipLink?.safeAreaCleared, layoutEvidence).toBe(true);
    expect(layout.images.length).toBeGreaterThan(0);
    expect(
      layout.images.every(
        (image) =>
          image.fits &&
          image.objectFit === "contain" &&
          image.naturalWidth === 1 &&
          image.naturalHeight === 8192 &&
          image.frameHeight <= image.maximumFrameHeight &&
          image.height <= image.frameHeight,
      ),
    ).toBe(true);
  } finally {
    await page.unroute(signedPreviewPattern);
    if (detailPattern !== undefined) await page.unroute(detailPattern);
    await cleanupFeat030Scenario(page, { operators: [reviewer], owner });
  }
});

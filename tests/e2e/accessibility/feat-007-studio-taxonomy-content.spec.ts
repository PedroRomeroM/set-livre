import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  closeFeat006PageBeforeCleanup,
  cleanupFeat006QaIdentity,
} from "../../helpers/feat-006-studio-core-revision";
import {
  createFeat007QaIdentity,
  feat007DefaultContent,
  provisionFeat007Studio,
} from "../../helpers/feat-007-studio-taxonomy-content";

async function expectFeat007AxeClean(page: Page) {
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
}

async function expectNoHorizontalOverflow(page: Page) {
  expect(
    await page.evaluate(() => ({
      body: document.body.scrollWidth <= window.innerWidth,
      document: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    })),
  ).toEqual({ body: true, document: true });
}

async function expectTouchTarget(control: Locator) {
  const box = await control.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.height).toBeGreaterThanOrEqual(44);
  expect(box?.width).toBeGreaterThanOrEqual(44);
}

test("SL-F007-E2E-006 @p1 conteúdo comercial passa axe, teclado, toque e 320 px", async ({
  page,
}, testInfo) => {
  test.setTimeout(190_000);
  const identity = createFeat007QaIdentity(testInfo, "006_accessibility");
  try {
    await provisionFeat007Studio(page, identity, "706");
    const taxonomySave = page.getByRole("button", { name: "Salvar tags e comodidades" });
    const contentSave = page.getByRole("button", { name: "Salvar regras, FAQ e vídeo" });
    const addFaq = page.getByRole("button", { name: "Adicionar pergunta" });
    await expectTouchTarget(taxonomySave);
    await expectTouchTarget(contentSave);
    await expectTouchTarget(addFaq);
    await expectFeat007AxeClean(page);
    await expectNoHorizontalOverflow(page);

    const tagSearch = page.getByRole("searchbox", { name: "Buscar em tags" });
    await tagSearch.focus();
    await expect(tagSearch).toBeFocused();
    await tagSearch.fill("Pod");
    const podcast = page.getByRole("checkbox", { name: feat007DefaultContent.tagName });
    await podcast.focus();
    await page.keyboard.press("Space");
    await expect(podcast).toBeChecked();

    await addFaq.focus();
    await expect(addFaq).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("textbox", { name: "Pergunta 1" })).toBeVisible();
    await expectTouchTarget(page.getByRole("button", { name: "Excluir FAQ 1" }));
    await expectFeat007AxeClean(page);
    await expectNoHorizontalOverflow(page);

    if (testInfo.project.name === "axe-dark-chromium") {
      expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(
        true,
      );
    }
    if (testInfo.project.name === "axe-mobile-chromium") {
      expect(page.viewportSize()).toEqual({ height: 844, width: 390 });
    }
    if (testInfo.project.name === "axe-narrow-chromium") {
      expect(page.viewportSize()).toEqual({ height: 720, width: 320 });
    }
  } finally {
    await closeFeat006PageBeforeCleanup(page);
    await cleanupFeat006QaIdentity(identity);
  }
});

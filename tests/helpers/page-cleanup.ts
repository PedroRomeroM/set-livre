import type { Page } from "@playwright/test";

export async function closePageBeforeDatabaseCleanup(page: Page) {
  if (page.isClosed()) return;
  await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);
  await page.close();
}

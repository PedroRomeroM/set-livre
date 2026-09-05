import { expect, type Page } from "@playwright/test";

export async function expectSessionStorageValue(
  page: Page,
  key: string,
  expected: string,
  timeout = 15_000,
) {
  await expect
    .poll(
      async () => {
        if (page.isClosed()) return undefined;
        try {
          return await page.evaluate((marker) => sessionStorage.getItem(marker), key);
        } catch {
          return undefined;
        }
      },
      { timeout },
    )
    .toBe(expected);
}

export async function gotoExpectedPage(page: Page, url: string, heading: string) {
  const response = await page.goto(url);

  expect(response?.status(), `A navegação para ${url} deve responder HTTP 200.`).toBe(200);
  if (response === null) {
    throw new Error(`A navegação para ${url} não retornou uma resposta.`);
  }
  await expect(page.getByRole("heading", { exact: true, level: 1, name: heading })).toBeVisible();
  return response;
}

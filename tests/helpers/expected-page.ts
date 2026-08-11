import { expect, type Page } from "@playwright/test";

export async function gotoExpectedPage(page: Page, url: string, heading: string) {
  const response = await page.goto(url);

  expect(response?.status(), `A navegação para ${url} deve responder HTTP 200.`).toBe(200);
  if (response === null) {
    throw new Error(`A navegação para ${url} não retornou uma resposta.`);
  }
  await expect(page.getByRole("heading", { exact: true, level: 1, name: heading })).toBeVisible();
  return response;
}

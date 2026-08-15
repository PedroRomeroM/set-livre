import { expect, test } from "@playwright/test";

import { gotoExpectedPage } from "../../helpers/expected-page";

const backofficeBaseUrl = process.env.E2E_BACKOFFICE_URL ?? "http://127.0.0.1:3001";

test("FOUNDATION-E2E-008 engines críticos abrem as duas fronteiras prontas", async ({
  context,
  page,
  request,
}) => {
  await gotoExpectedPage(page, "/", "Set Livre");
  const backofficePage = await context.newPage();
  try {
    await gotoExpectedPage(backofficePage, backofficeBaseUrl, "Operação Set Livre");
  } finally {
    await backofficePage.close();
  }

  for (const url of ["/api/health/ready", `${backofficeBaseUrl}/api/health/ready`]) {
    const response = await request.get(url);

    await expect(response).toBeOK();
    await expect(response.json()).resolves.toMatchObject({ status: "ready" });
  }
});

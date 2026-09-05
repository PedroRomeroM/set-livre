import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Response } from "@playwright/test";

import { readSafeE2EEnvironment } from "../../helpers/e2e-environment";
import { withE2EAdminClient, type E2EDatabaseClient } from "../../helpers/e2e-database-preflight";
import {
  cleanupFeat031Users,
  createFeat031Operator,
  loginFeat031Backoffice,
  provisionFeat031Operator,
  setFeat031RolesConcurrently,
} from "../../helpers/feat-031-backoffice-users-taxonomy";
import { closePageBeforeDatabaseCleanup } from "../../helpers/page-cleanup";

const errorTitle = "Não foi possível carregar o backoffice";

async function expectClosedFallback(page: Page) {
  await expect(page.getByRole("heading", { level: 1, name: errorTitle })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Usuários" })).toHaveCount(0);
  await expect(page.getByRole("navigation")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Buscar usuários" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Tentar novamente", exact: true })).toBeEnabled();
}

async function expectBlockedSessionLookup(locker: E2EDatabaseClient) {
  // Observe the real DAL lookup, not an HTTP mock or an injected production failure.
  await expect
    .poll(async () => {
      await locker.query("select pg_catalog.pg_stat_clear_snapshot()");
      const result = await locker.query<{ waiting: boolean }>(
        `select exists (
           select 1 from pg_catalog.pg_stat_activity as activity
           where activity.application_name = 'set-livre-backoffice-dal'
             and activity.query like '%private.get_backoffice_session(%'
             and pg_catalog.pg_backend_pid() = any(pg_catalog.pg_blocking_pids(activity.pid))
         ) as waiting`,
      );
      return result.rows[0]?.waiting;
    })
    .toBe(true);
}

function isUsersRsc(response: Response) {
  return (
    new URL(response.url()).pathname === "/usuarios" && response.request().headers()["rsc"] === "1"
  );
}

async function failLayoutLookup(page: Page, verifyBlockedRetry: boolean) {
  const environment = readSafeE2EEnvironment();
  // Stop the old shell's polling while preserving the real Auth cookies.
  await page.goto("about:blank");
  await withE2EAdminClient(async (locker) => {
    await locker.query("begin");
    try {
      await locker.query(
        "select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('set-livre:backoffice-authorization', 0))",
      );
      const navigation = page
        .goto(`${environment.backofficeBaseUrl}/usuarios`, { waitUntil: "domcontentloaded" })
        .then(
          () => ({ failed: false }),
          () => ({ failed: true }),
        );
      await expectBlockedSessionLookup(locker);
      expect(await navigation).toEqual({ failed: false });
      // The normal two-second server statement timeout produces the actual layout error.
      await expectClosedFallback(page);
      if (verifyBlockedRetry) {
        const retried = page.waitForResponse(isUsersRsc);
        await page.getByRole("button", { name: "Tentar novamente", exact: true }).click();
        await expectBlockedSessionLookup(locker);
        await expect(page.getByRole("navigation")).toHaveCount(0);
        await expect(page.getByRole("heading", { level: 1, name: "Usuários" })).toHaveCount(0);
        const response = await retried;
        expect(await response.finished()).toBeNull();
        await expectClosedFallback(page);
      }
    } finally {
      await locker.query("rollback");
    }
  });
}

test("SL-F031-E2E-037 @p0 falha do layout fecha acesso e recovery revalida autorização", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const support = createFeat031Operator(testInfo, "037_layout_recovery");
  try {
    await provisionFeat031Operator(page, support, "support", "031037");
    await loginFeat031Backoffice(page, support, { unlockRuntime: false });
    await failLayoutLookup(page, true);

    await expect(page.getByRole("main")).not.toContainText(support.email);
    await expect(page.getByRole("main")).not.toContainText("get_backoffice_session");
    expect((await new AxeBuilder({ page }).include("main").analyze()).violations).toEqual([]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);

    const recovered = page.waitForResponse(isUsersRsc);
    const retry = page.getByRole("button", { name: "Tentar novamente", exact: true });
    await retry.focus();
    await page.keyboard.press("Enter");
    expect(await (await recovered).finished()).toBeNull();
    await expect(page.getByRole("heading", { level: 1, name: "Usuários" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Buscar usuários" })).toBeEnabled();
    await expect(page.getByRole("heading", { level: 1, name: errorTitle })).toHaveCount(0);

    await failLayoutLookup(page, false);
    if (support.userId === undefined) throw new Error("O operador QA não possui identidade.");
    await setFeat031RolesConcurrently(support.userId, []);
    await expectClosedFallback(page);

    const disclosureEvidenceKey = "qa-feat031-037-private-disclosure";
    await page.evaluate((key) => {
      sessionStorage.setItem(key, "closed");
      const observePrivateContent = () => {
        if (
          document.querySelector("nav") !== null ||
          Array.from(document.querySelectorAll("h1")).some(
            (heading) => heading.textContent?.trim() === "Usuários",
          )
        ) {
          sessionStorage.setItem(key, "private-content-rendered");
        }
      };
      new MutationObserver(observePrivateContent).observe(document.body, {
        childList: true,
        subtree: true,
      });
      observePrivateContent();
    }, disclosureEvidenceKey);
    const rechecked = page.waitForResponse(isUsersRsc);
    await page.getByRole("button", { name: "Tentar novamente", exact: true }).click();
    expect(await (await rechecked).finished()).toBeNull();
    await expect(page).toHaveURL(/\/entrar$/u);
    await expect(page.getByRole("heading", { level: 1, name: "Operação Set Livre" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Usuários" })).toHaveCount(0);
    await expect(page.getByRole("navigation")).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Buscar usuários" })).toHaveCount(0);
    expect(await page.evaluate((key) => sessionStorage.getItem(key), disclosureEvidenceKey)).toBe(
      "closed",
    );
  } finally {
    await closePageBeforeDatabaseCleanup(page);
    await cleanupFeat031Users({ operators: [support] });
  }
});

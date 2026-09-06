import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createPlaywrightOperationalEnvironment,
  createPlaywrightWebServerCommand,
  createPlaywrightWebServerEnvironmentOverlay,
  preparePlaywrightStandalone,
} from "../helpers/playwright-web-server";

function standaloneFixtureEnvironment(application: "web" | "backoffice"): NodeJS.ProcessEnv {
  return {
    ...createPlaywrightWebServerEnvironmentOverlay(
      {},
      {
        DATABASE_URL_APP_DAL:
          "postgresql://app_runtime_local:local-runtime-password@127.0.0.1:54322/postgres?options=-c%20role%3Dapp_dal",
        NEXT_PUBLIC_APP_URL: `http://127.0.0.1:${application === "web" ? "3000" : "3001"}`,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_local_contract_key",
        NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
        ...(application === "web"
          ? { SUPABASE_SECRET_KEY: "local-server-contract-key" }
          : { BACKOFFICE_RUNTIME_UNLOCK_KEY: "a".repeat(43) }),
      },
    ),
    NODE_ENV: "production",
  };
}

describe("Playwright webServer process boundary", () => {
  it("invokes the standalone runner without consulting the user npm configuration", () => {
    const userHome = mkdtempSync(resolve(tmpdir(), "set-livre-hostile-npm-"));
    try {
      writeFileSync(
        resolve(userHome, ".npmrc"),
        `script-shell=${resolve(userHome, "must-not-run-shell")}\n`,
      );
      const environment: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: userHome,
        USERPROFILE: userHome,
      };
      delete environment.NPM_CONFIG_USERCONFIG;
      delete environment.npm_config_userconfig;
      const command = createPlaywrightWebServerCommand(["--help"]);

      expect(command).not.toMatch(/(^|[\\/ ])npm(?:\.cmd)?([\\/ ]|$)/iu);
      const result = spawnSync(command, {
        encoding: "utf8",
        env: environment,
        shell: true,
        timeout: 10_000,
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("Usage: playwright-web-server <web|backoffice>");
    } finally {
      rmSync(userHome, { force: true, recursive: true });
    }
  });

  it("neutralizes inherited values and restores only operations plus the validated local app", () => {
    const inherited = {
      APP_ENV: "production",
      BASH_ENV: "/tmp/hostile-shell",
      DATABASE_URL_APP_DAL: "postgresql://cloud:database-secret@remote.example.com/production",
      DOCKER_HOST: "ssh://operator@remote.example.com",
      E2E_DATABASE_URL: "postgresql://postgres:admin-secret@127.0.0.1/postgres",
      HOME: "/home/tester",
      LD_PRELOAD: "/tmp/hostile-loader.so",
      NEXT_PUBLIC_APP_URL: "https://setlivre.example",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "host-anon-that-must-not-win",
      NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
      NODE_ENV: "development",
      NODE_OPTIONS: "--require=/tmp/hostile-loader.cjs",
      NPM_CONFIG_USERCONFIG: "/tmp/hostile.npmrc",
      PATH: `${delimiter}/opt/node/bin${delimiter}${delimiter}/usr/bin${delimiter}`,
      PGPASSWORD: "database-secret",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
      SUPABASE_SECRET_KEY: "cloud-secret-that-must-not-win",
      npm_config__authToken: "registry-secret",
    };
    const applicationEnvironment = {
      DATABASE_URL_APP_DAL:
        "postgresql://app_runtime_local:local-runtime-password@127.0.0.1:54322/postgres?options=-c%20role%3Dapp_dal",
      NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3000",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_local_contract_key",
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
      SUPABASE_SECRET_KEY: "local-server-contract-key",
    };

    const overlay = createPlaywrightWebServerEnvironmentOverlay(inherited, applicationEnvironment);
    const operational = createPlaywrightOperationalEnvironment(inherited);

    expect(overlay.NODE_ENV).toBe("production");
    expect(Object.keys(inherited).every((name) => Object.hasOwn(overlay, name))).toBe(true);
    expect(overlay).toMatchObject({
      APP_ENV: "test",
      APP_RELEASE_SHA: "local",
      BASH_ENV: "",
      DATABASE_URL_APP_DAL: applicationEnvironment.DATABASE_URL_APP_DAL,
      DOCKER_HOST: "",
      E2E_DATABASE_URL: "",
      HOME: "/home/tester",
      LD_PRELOAD: "",
      NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3000",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_local_contract_key",
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
      NODE_OPTIONS: "",
      NPM_CONFIG_USERCONFIG: "",
      PATH: ["/opt/node/bin", "/usr/bin"].join(delimiter),
      PGPASSWORD: "",
      SSH_AUTH_SOCK: "",
      SUPABASE_SERVICE_ROLE_KEY: "",
      SUPABASE_SECRET_KEY: "local-server-contract-key",
      npm_config__authToken: "",
    });
    expect(JSON.stringify(overlay)).not.toMatch(
      /admin-secret|cloud:database-secret|cloud-secret-that-must-not-win|host-anon|hostile|registry-secret|service-role-secret/u,
    );
    expect(operational.HOME).toBe("/home/tester");
    expect(operational.PATH).toBe(["/opt/node/bin", "/usr/bin"].join(delimiter));
    expect(JSON.stringify(operational)).not.toMatch(
      /admin-secret|cloud:database-secret|cloud-secret-that-must-not-win|host-anon|hostile|registry-secret|service-role-secret/u,
    );

    const backofficeApplicationEnvironment = {
      DATABASE_URL_APP_DAL: applicationEnvironment.DATABASE_URL_APP_DAL,
      NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3001",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: applicationEnvironment.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      NEXT_PUBLIC_SUPABASE_URL: applicationEnvironment.NEXT_PUBLIC_SUPABASE_URL,
    };
    const backofficeOverlay = createPlaywrightWebServerEnvironmentOverlay(
      inherited,
      backofficeApplicationEnvironment,
    );
    expect(backofficeOverlay.SUPABASE_SECRET_KEY).toBe("");
  });

  it.each(["web", "backoffice"] as const)(
    "builds %s with the validated environment before preparing its standalone assets",
    async (application) => {
      const root = mkdtempSync(resolve(tmpdir(), "set-livre-playwright-standalone-"));
      const applicationRoot = resolve(root, application === "web" ? "." : "apps/backoffice");
      const standaloneRoot = resolve(
        applicationRoot,
        ".next/standalone",
        application === "web" ? "." : "apps/backoffice",
      );
      const expectedEntrypoint = resolve(standaloneRoot, "server.js");
      const environment = standaloneFixtureEnvironment(application);
      const buildApplication = vi.fn(async () => {
        mkdirSync(standaloneRoot, { recursive: true });
        mkdirSync(resolve(applicationRoot, ".next/static/chunks"), { recursive: true });
        mkdirSync(resolve(applicationRoot, "public/images"), { recursive: true });
        writeFileSync(
          expectedEntrypoint,
          'throw new Error("fixture-entrypoint-must-not-be-imported");\n',
        );
        writeFileSync(resolve(applicationRoot, ".next/static/chunks/app.js"), `${application}-js`);
        writeFileSync(resolve(applicationRoot, "public/images/logo.svg"), `${application}-logo`);
      });

      try {
        const entrypoint = await preparePlaywrightStandalone(application, {
          buildApplication,
          environment,
          root,
        });

        expect(buildApplication).toHaveBeenCalledTimes(1);
        expect(buildApplication).toHaveBeenCalledWith({
          application,
          inheritedEnvironment: environment,
          root,
        });
        expect(entrypoint).toBe(expectedEntrypoint);
        expect(readFileSync(resolve(standaloneRoot, ".next/static/chunks/app.js"), "utf8")).toBe(
          `${application}-js`,
        );
        expect(readFileSync(resolve(standaloneRoot, "public/images/logo.svg"), "utf8")).toBe(
          `${application}-logo`,
        );
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    },
  );

  it("propagates build failure without serving or copying a previous standalone artifact", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "set-livre-playwright-build-failure-"));
    const standaloneRoot = resolve(root, ".next/standalone");
    const failure = new Error("fixture-build-failed");
    const buildApplication = vi.fn(async () => {
      throw failure;
    });

    try {
      mkdirSync(standaloneRoot, { recursive: true });
      mkdirSync(resolve(root, ".next/static"), { recursive: true });
      mkdirSync(resolve(root, "public"), { recursive: true });
      writeFileSync(
        resolve(standaloneRoot, "server.js"),
        'throw new Error("stale-entrypoint-must-not-be-imported");\n',
      );
      writeFileSync(resolve(root, ".next/static/stale.js"), "stale-js");
      writeFileSync(resolve(root, "public/stale.svg"), "stale-logo");

      await expect(
        preparePlaywrightStandalone("web", {
          buildApplication,
          environment: standaloneFixtureEnvironment("web"),
          root,
        }),
      ).rejects.toBe(failure);

      expect(buildApplication).toHaveBeenCalledTimes(1);
      expect(existsSync(resolve(standaloneRoot, ".next/static/stale.js"))).toBe(false);
      expect(existsSync(resolve(standaloneRoot, "public/stale.svg"))).toBe(false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects an invalid test environment or release before invoking the build", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "set-livre-playwright-invalid-environment-"));
    const buildApplication = vi.fn(async () => undefined);
    const validEnvironment = standaloneFixtureEnvironment("web");
    const invalidEnvironments: Partial<NodeJS.ProcessEnv>[] = [
      { APP_ENV: undefined },
      { APP_ENV: "local" },
      { APP_ENV: "production" },
      { APP_RELEASE_SHA: undefined },
      { APP_RELEASE_SHA: "a".repeat(40) },
      { NODE_ENV: "test" },
      { NODE_ENV: "development" },
    ];

    try {
      for (const invalidEnvironment of invalidEnvironments) {
        await expect(
          preparePlaywrightStandalone("web", {
            buildApplication,
            environment: { ...validEnvironment, ...invalidEnvironment },
            root,
          }),
        ).rejects.toThrow();
      }

      expect(buildApplication).not.toHaveBeenCalled();
      expect(existsSync(resolve(root, ".next"))).toBe(false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

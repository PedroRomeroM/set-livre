import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createPlaywrightNextCommand,
  createPlaywrightWebServerEnvironmentOverlay,
} from "../helpers/playwright-web-server";

describe("Playwright webServer process boundary", () => {
  it("invokes the pinned Next CLI without consulting the user npm configuration", () => {
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
      const command = createPlaywrightNextCommand(["--help"]);

      expect(command).not.toMatch(/(^|[\\/ ])npm(?:\.cmd)?([\\/ ]|$)/iu);
      const result = spawnSync(command, {
        encoding: "utf8",
        env: environment,
        shell: true,
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("Usage: next");
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
});

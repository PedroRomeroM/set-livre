import { delimiter } from "node:path";

import { describe, expect, it } from "vitest";

import { createPlaywrightWebServerEnvironmentOverlay } from "../helpers/playwright-web-server";

describe("Playwright webServer process boundary", () => {
  it("neutralizes every inherited name and restores only the operational allowlist", () => {
    const inherited = {
      APP_ENV: "production",
      BASH_ENV: "/tmp/hostile-shell",
      DATABASE_URL_APP_DAL: "postgresql://cloud:database-secret@remote.example.com/production",
      DOCKER_HOST: "ssh://operator@remote.example.com",
      E2E_DATABASE_URL: "postgresql://postgres:admin-secret@127.0.0.1/postgres",
      HOME: "/home/tester",
      LD_PRELOAD: "/tmp/hostile-loader.so",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "host-anon-that-must-not-win",
      NODE_OPTIONS: "--require=/tmp/hostile-loader.cjs",
      NPM_CONFIG_USERCONFIG: "/tmp/hostile.npmrc",
      PATH: `${delimiter}/opt/node/bin${delimiter}${delimiter}/usr/bin${delimiter}`,
      PGPASSWORD: "database-secret",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
      npm_config__authToken: "registry-secret",
    };

    const overlay = createPlaywrightWebServerEnvironmentOverlay(inherited);

    expect(Object.keys(inherited).every((name) => Object.hasOwn(overlay, name))).toBe(true);
    expect(overlay).toMatchObject({
      APP_ENV: "test",
      BASH_ENV: "",
      DATABASE_URL_APP_DAL: "",
      DOCKER_HOST: "",
      E2E_DATABASE_URL: "",
      HOME: "/home/tester",
      LD_PRELOAD: "",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "",
      NODE_OPTIONS: "",
      NPM_CONFIG_USERCONFIG: "",
      PATH: ["/opt/node/bin", "/usr/bin"].join(delimiter),
      PGPASSWORD: "",
      SSH_AUTH_SOCK: "",
      SUPABASE_SERVICE_ROLE_KEY: "",
      npm_config__authToken: "",
    });
    expect(JSON.stringify(overlay)).not.toMatch(
      /admin-secret|database-secret|host-anon|hostile|registry-secret|service-role-secret/u,
    );
  });
});

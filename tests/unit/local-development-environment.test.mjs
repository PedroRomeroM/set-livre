import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createLocalDevelopmentEnvironment,
  readLocalDevelopmentEnvironmentFile,
  validateLocalDalDatabaseUrl,
} from "../../scripts/local-development-environment.mjs";

const localDatabaseUrl =
  "postgresql://app_runtime_local:local-password@127.0.0.1:54322/postgres?options=-c%20role%3Dapp_dal";
const temporaryRoots = [];

function localEnvironment(overrides = {}) {
  return {
    APP_ENV: "local",
    APP_RELEASE_SHA: "local",
    DATABASE_URL_APP_DAL: localDatabaseUrl,
    NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3000",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "web-anon-key",
    NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
    ...overrides,
  };
}

function serializeEnvironment(environment) {
  return `${Object.entries(environment)
    .map(([name, value]) => `${name}=${value}`)
    .join("\n")}\n`;
}

function temporaryRoot() {
  const root = mkdtempSync(resolve(tmpdir(), "set-livre-dev-environment-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("local development child environment", () => {
  it("uses the app-local runtime allowlist instead of inherited cloud or secret values", () => {
    const environment = createLocalDevelopmentEnvironment(
      {
        APP_ENV: "production",
        APP_RELEASE_SHA: "a".repeat(40),
        DATABASE_URL_APP_DAL: "postgresql://cloud:secret@database.example.com:5432/production",
        E2E_DATABASE_URL: "postgresql://postgres:secret@127.0.0.1:54322/postgres",
        GIT_CONFIG_COUNT: "1",
        HOME: "/home/tester",
        LC_ALL: "C.UTF-8",
        LC_API_TOKEN: "locale-lookalike-secret",
        LD_PRELOAD: "/tmp/inject.so",
        NEXT_PUBLIC_APP_URL: "https://production.example.com",
        NEXT_PUBLIC_SUPABASE_URL: "https://cloud.supabase.co",
        NODE_OPTIONS: "--require=/tmp/inject.cjs",
        NPM_CONFIG_GLOBALCONFIG: "/tmp/hostile-global.npmrc",
        NPM_CONFIG_USERCONFIG: "/tmp/hostile-user.npmrc",
        PATH: ":/usr/local/bin::/usr/bin:",
        PGPASSWORD: "admin-secret",
        SSH_AUTH_SOCK: "/run/user/1000/agent.sock",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
        npm_config__authToken: "registry-secret",
        npm_config_script_shell: "/tmp/hostile-shell",
      },
      localEnvironment(),
      "http://127.0.0.1:3000",
    );

    expect(environment).toEqual({
      APP_ENV: "local",
      APP_RELEASE_SHA: "local",
      DATABASE_URL_APP_DAL: localDatabaseUrl,
      HOME: "/home/tester",
      LC_ALL: "C.UTF-8",
      NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3000",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "web-anon-key",
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
      PATH: "/usr/local/bin:/usr/bin",
    });
    expect(JSON.stringify(environment)).not.toContain("database.example.com");
    expect(JSON.stringify(environment)).not.toContain("cloud.supabase.co");
    expect(JSON.stringify(environment)).not.toContain("hostile-global.npmrc");
    expect(JSON.stringify(environment)).not.toContain("hostile-user.npmrc");
    expect(JSON.stringify(environment)).not.toContain("hostile-shell");
  });

  it("keeps the public and backoffice local environments separate", () => {
    const web = createLocalDevelopmentEnvironment(
      { PATH: "/usr/bin" },
      localEnvironment(),
      "http://127.0.0.1:3000",
    );
    const backoffice = createLocalDevelopmentEnvironment(
      { PATH: "/usr/bin" },
      localEnvironment({
        NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3001",
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "backoffice-anon-key",
      }),
      "http://127.0.0.1:3001",
    );

    expect(web.NEXT_PUBLIC_APP_URL).toBe("http://127.0.0.1:3000");
    expect(web.NEXT_PUBLIC_SUPABASE_ANON_KEY).toBe("web-anon-key");
    expect(backoffice.NEXT_PUBLIC_APP_URL).toBe("http://127.0.0.1:3001");
    expect(backoffice.NEXT_PUBLIC_SUPABASE_ANON_KEY).toBe("backoffice-anon-key");
  });

  it("preserves the minimum Windows operational names without host application data", () => {
    const environment = createLocalDevelopmentEnvironment(
      {
        COMSPEC: "C:\\Windows\\System32\\cmd.exe",
        Path: "C:\\Windows\\System32;C:\\Program Files\\nodejs",
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        SystemRoot: "C:\\Windows",
        TEMP: "C:\\Users\\tester\\AppData\\Local\\Temp",
        USERPROFILE: "C:\\Users\\tester",
      },
      localEnvironment(),
      "http://127.0.0.1:3000",
    );

    expect(environment).toMatchObject({
      COMSPEC: "C:\\Windows\\System32\\cmd.exe",
      Path: "C:\\Windows\\System32;C:\\Program Files\\nodejs",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      SystemRoot: "C:\\Windows",
      TEMP: "C:\\Users\\tester\\AppData\\Local\\Temp",
      USERPROFILE: "C:\\Users\\tester",
    });
  });

  it("rejects every tested deviation from the local DAL identity contract", () => {
    for (const value of [
      "postgresql://app_runtime_local:secret@database.example.com:54322/postgres?options=-c%20role%3Dapp_dal",
      "postgresql://app_runtime_local:secret@127.0.0.1:5432/postgres?options=-c%20role%3Dapp_dal",
      "postgresql://postgres:secret@127.0.0.1:54322/postgres?options=-c%20role%3Dapp_dal",
      "postgresql://app_runtime_local@127.0.0.1:54322/postgres?options=-c%20role%3Dapp_dal",
      "postgresql://app_runtime_local:secret@127.0.0.1:54322/postgres?options=-c%20role%3Dpostgres",
      `${localDatabaseUrl}&sslmode=require`,
      "https://app_runtime_local:secret@127.0.0.1:54322/postgres?options=-c%20role%3Dapp_dal",
    ]) {
      expect(() => validateLocalDalDatabaseUrl(value)).toThrow("Supabase local");
    }
    expect(validateLocalDalDatabaseUrl(localDatabaseUrl)).toBe(localDatabaseUrl);
  });

  it("rejects non-local app, release and Supabase contracts before spawn", () => {
    for (const [local, expectedApplicationUrl] of [
      [localEnvironment({ APP_ENV: "production" }), "http://127.0.0.1:3000"],
      [localEnvironment({ APP_RELEASE_SHA: "a".repeat(40) }), "http://127.0.0.1:3000"],
      [
        localEnvironment({ NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co" }),
        "http://127.0.0.1:3000",
      ],
      [
        localEnvironment({ NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321/rest/v1" }),
        "http://127.0.0.1:3000",
      ],
      [
        localEnvironment({ NEXT_PUBLIC_APP_URL: "https://set-livre.example.com" }),
        "http://127.0.0.1:3000",
      ],
      [localEnvironment({ NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3001" }), "http://127.0.0.1:3000"],
    ]) {
      expect(() =>
        createLocalDevelopmentEnvironment({ PATH: "/usr/bin" }, local, expectedApplicationUrl),
      ).toThrow();
    }
  });

  it("never falls back to an inherited database URL", () => {
    const local = localEnvironment();
    delete local.DATABASE_URL_APP_DAL;

    expect(() =>
      createLocalDevelopmentEnvironment(
        { DATABASE_URL_APP_DAL: localDatabaseUrl, PATH: "/usr/bin" },
        local,
        "http://127.0.0.1:3000",
      ),
    ).toThrow("DATABASE_URL_APP_DAL");
  });

  it("rejects unexpected runtime names", () => {
    expect(() =>
      createLocalDevelopmentEnvironment(
        { PATH: "/usr/bin" },
        localEnvironment({ NODE_OPTIONS: "--require=/tmp/inject.cjs" }),
        "http://127.0.0.1:3000",
      ),
    ).toThrow("NODE_OPTIONS");
  });

  it("reads a physical file without mutating the parent process environment", () => {
    const root = temporaryRoot();
    const environmentPath = resolve(root, ".env.local");
    const originalDatabaseUrl = process.env.DATABASE_URL_APP_DAL;
    writeFileSync(environmentPath, serializeEnvironment(localEnvironment()), { mode: 0o600 });

    const childEnvironment = readLocalDevelopmentEnvironmentFile(
      environmentPath,
      {
        DATABASE_URL_APP_DAL: "postgresql://cloud:secret@database.example.com:5432/production",
        PATH: "/usr/bin",
      },
      "http://127.0.0.1:3000",
    );

    expect(childEnvironment.DATABASE_URL_APP_DAL).toBe(localDatabaseUrl);
    expect(process.env.DATABASE_URL_APP_DAL).toBe(originalDatabaseUrl);
  });

  it("refuses a symlinked or non-regular environment without touching its target", () => {
    const root = temporaryRoot();
    const target = resolve(root, "outside.env");
    const link = resolve(root, ".env.local");
    const directory = resolve(root, "environment-directory");
    const permissive = resolve(root, "permissive.env");
    const contents = serializeEnvironment(localEnvironment());
    writeFileSync(target, contents, "utf8");
    symlinkSync(target, link);
    mkdirSync(directory);
    writeFileSync(permissive, contents, "utf8");

    expect(() =>
      readLocalDevelopmentEnvironmentFile(link, { PATH: "/usr/bin" }, "http://127.0.0.1:3000"),
    ).toThrow("arquivo físico regular");
    expect(() =>
      readLocalDevelopmentEnvironmentFile(directory, { PATH: "/usr/bin" }, "http://127.0.0.1:3000"),
    ).toThrow("arquivo físico regular");
    if (process.platform !== "win32") {
      chmodSync(permissive, 0o640);
      expect(() =>
        readLocalDevelopmentEnvironmentFile(
          permissive,
          { PATH: "/usr/bin" },
          "http://127.0.0.1:3000",
        ),
      ).toThrow("modo 0600");
    }
    expect(readFileSync(target, "utf8")).toBe(contents);
  });
});

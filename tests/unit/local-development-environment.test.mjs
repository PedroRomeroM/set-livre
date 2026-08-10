import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
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
  localDevelopmentNpmRunArguments,
  readLocalDevelopmentEnvironmentFile,
  validateLocalDalDatabaseUrl,
} from "../../scripts/local-development-environment.mjs";
import { resolveTrustedNpmCliLaunch } from "../../scripts/trusted-npm-cli.mjs";

const localDatabaseUrl =
  "postgresql://app_runtime_local:local-password@127.0.0.1:54322/postgres?options=-c%20role%3Dapp_dal";
const projectRoot = resolve(import.meta.dirname, "../..");
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

  it("rejects unexpected runtime names and isolates real npm from hostile host configs", () => {
    expect(() =>
      createLocalDevelopmentEnvironment(
        { PATH: "/usr/bin" },
        localEnvironment({ NODE_OPTIONS: "--require=/tmp/inject.cjs" }),
        "http://127.0.0.1:3000",
      ),
    ).toThrow("NODE_OPTIONS");

    const root = temporaryRoot();
    const hostileHome = resolve(root, "hostile-home");
    const packageRoot = resolve(root, "package");
    const hostileGlobalConfiguration = resolve(root, "hostile-global.npmrc");
    const loaderSentinel = resolve(packageRoot, "loader-ran");
    const preScriptSentinel = resolve(packageRoot, "pre-script-ran");
    const probeResult = resolve(packageRoot, "probe-result.json");
    mkdirSync(hostileHome);
    mkdirSync(packageRoot);
    const hostileConfiguration = [
      "ignore-scripts=false",
      "node-options=--require=./hostile-loader.cjs",
      `script-shell=${resolve(root, "shell-that-must-not-exist")}`,
      "",
    ].join("\n");
    writeFileSync(resolve(hostileHome, ".npmrc"), hostileConfiguration, "utf8");
    writeFileSync(hostileGlobalConfiguration, hostileConfiguration, "utf8");
    writeFileSync(
      resolve(packageRoot, "package.json"),
      `${JSON.stringify(
        {
          name: "set-livre-npm-isolation-probe",
          private: true,
          scripts: {
            preprobe: "node preprobe.cjs",
            "preprobe:child": "node preprobe.cjs",
            probe: "npm run probe:child",
            "probe:child": "node probe.cjs",
          },
          version: "0.0.0",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    writeFileSync(
      resolve(packageRoot, "hostile-loader.cjs"),
      `require("node:fs").writeFileSync(${JSON.stringify(loaderSentinel)}, "executed");\n`,
      "utf8",
    );
    writeFileSync(
      resolve(packageRoot, "preprobe.cjs"),
      `require("node:fs").writeFileSync(${JSON.stringify(preScriptSentinel)}, "executed");\n`,
      "utf8",
    );
    writeFileSync(
      resolve(packageRoot, "probe.cjs"),
      `require("node:fs").writeFileSync(${JSON.stringify(
        probeResult,
      )}, JSON.stringify({ globalConfig: process.env.npm_config_globalconfig ?? null, nodeOptions: process.env.NODE_OPTIONS ?? null, npmNodeOptions: process.env.npm_config_node_options ?? null, scriptShell: process.env.npm_config_script_shell ?? null, userConfig: process.env.npm_config_userconfig ?? null }));\n`,
      "utf8",
    );

    const environment = createLocalDevelopmentEnvironment(
      {
        HOME: hostileHome,
        NPM_CONFIG_GLOBALCONFIG: hostileGlobalConfiguration,
        NPM_CONFIG_USERCONFIG: resolve(hostileHome, ".npmrc"),
        NODE_OPTIONS: "--require=./hostile-loader.cjs",
        PATH: process.env.PATH,
        Path: process.env.Path,
        USERPROFILE: hostileHome,
        npm_config_script_shell: resolve(root, "shell-that-must-not-exist"),
      },
      localEnvironment(),
      "http://127.0.0.1:3000",
    );
    const argumentsList = localDevelopmentNpmRunArguments(projectRoot, "probe", environment);
    const expectedScriptShell = argumentsList
      .find((argument) => argument.startsWith("--script-shell="))
      ?.slice("--script-shell=".length);
    const trustedNpm = resolveTrustedNpmCliLaunch({ repositoryRoot: projectRoot });
    execFileSync(trustedNpm.command, [...trustedNpm.argumentPrefix, ...argumentsList], {
      cwd: packageRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });

    expect(existsSync(loaderSentinel)).toBe(false);
    expect(existsSync(preScriptSentinel)).toBe(false);
    expect(JSON.parse(readFileSync(probeResult, "utf8"))).toEqual({
      globalConfig: resolve(projectRoot, "config/npm/dev-global.npmrc"),
      nodeOptions: null,
      npmNodeOptions: "",
      scriptShell: expectedScriptShell,
      userConfig: resolve(projectRoot, "config/npm/dev-user.npmrc"),
    });

    const unsafeRepository = resolve(root, "unsafe-repository");
    const unsafeNpmDirectory = resolve(unsafeRepository, "config/npm");
    const unsafeUserConfiguration = resolve(unsafeNpmDirectory, "dev-user.npmrc");
    mkdirSync(unsafeNpmDirectory, { recursive: true });
    writeFileSync(
      resolve(unsafeRepository, ".npmrc"),
      "engine-strict=true\nfund=false\nsave-exact=true\n",
      "utf8",
    );
    writeFileSync(resolve(unsafeNpmDirectory, "dev-global.npmrc"), "# neutro\n", "utf8");
    symlinkSync(hostileGlobalConfiguration, unsafeUserConfiguration);
    expect(() => localDevelopmentNpmRunArguments(unsafeRepository, "probe", environment)).toThrow(
      "arquivo físico regular",
    );
    rmSync(unsafeUserConfiguration);
    writeFileSync(unsafeUserConfiguration, hostileConfiguration, "utf8");
    expect(() => localDevelopmentNpmRunArguments(unsafeRepository, "probe", environment)).toThrow(
      "precisa permanecer vazia",
    );

    const symbolicRepository = resolve(root, "symbolic-config-repository");
    const externalConfiguration = resolve(root, "external-configuration");
    mkdirSync(symbolicRepository);
    mkdirSync(resolve(externalConfiguration, "npm"), { recursive: true });
    writeFileSync(
      resolve(symbolicRepository, ".npmrc"),
      "engine-strict=true\nfund=false\nsave-exact=true\n",
      "utf8",
    );
    for (const name of ["dev-global.npmrc", "dev-user.npmrc"]) {
      writeFileSync(resolve(externalConfiguration, "npm", name), "# neutro\n", "utf8");
    }
    symlinkSync(externalConfiguration, resolve(symbolicRepository, "config"), "dir");
    expect(() => localDevelopmentNpmRunArguments(symbolicRepository, "probe", environment)).toThrow(
      "diretório não físico",
    );
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

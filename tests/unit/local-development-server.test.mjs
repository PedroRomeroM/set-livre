import { execFileSync } from "node:child_process";
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
  createLocalDevelopmentServerLaunch,
  resolveTrustedNextCliLaunch,
} from "../../scripts/local-development-server.mjs";

const localDatabaseUrl =
  "postgresql://app_runtime_local:local-password@127.0.0.1:54322/postgres?options=-c%20role%3Dapp_dal";
const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function localEnvironment(applicationUrl, anonKey) {
  return [
    "APP_ENV=local",
    "APP_RELEASE_SHA=local",
    `DATABASE_URL_APP_DAL=${localDatabaseUrl}`,
    `NEXT_PUBLIC_APP_URL=${applicationUrl}`,
    `NEXT_PUBLIC_SUPABASE_ANON_KEY=${anonKey}`,
    "NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321",
    "",
  ].join("\n");
}

function temporaryRepository({ nextVersion = "16.3.0", rootNextVersion = "16.3.0" } = {}) {
  const root = mkdtempSync(resolve(tmpdir(), "set-livre-local-server-"));
  temporaryRoots.push(root);
  const nextPackageRoot = resolve(root, "node_modules/next");
  const nextCliPath = resolve(nextPackageRoot, "dist/bin/next");
  mkdirSync(resolve(root, "apps/backoffice"), { recursive: true });
  mkdirSync(resolve(nextPackageRoot, "dist/bin"), { recursive: true });
  writeFileSync(
    resolve(root, ".env.local"),
    localEnvironment("http://127.0.0.1:3000", "web-anon"),
    {
      mode: 0o600,
    },
  );
  writeFileSync(
    resolve(root, "apps/backoffice/.env.local"),
    localEnvironment("http://127.0.0.1:3001", "backoffice-anon"),
    { mode: 0o600 },
  );
  writeFileSync(
    resolve(root, "package.json"),
    `${JSON.stringify({
      dependencies: { next: rootNextVersion },
      devEngines: {
        packageManager: { name: "npm", version: "11.19.0" },
        runtime: { name: "node", version: process.versions.node },
      },
      packageManager: "npm@11.19.0",
    })}\n`,
  );
  writeFileSync(
    resolve(root, "apps/backoffice/package.json"),
    `${JSON.stringify({ dependencies: { next: rootNextVersion } })}\n`,
  );
  writeFileSync(
    resolve(nextPackageRoot, "package.json"),
    `${JSON.stringify({ bin: { next: "./dist/bin/next" }, name: "next", version: nextVersion })}\n`,
  );
  writeFileSync(nextCliPath, "process.exitCode = 0;\n");
  return { nextCliPath, nextPackageRoot, root };
}

function hostileInheritedEnvironment(home) {
  return {
    BASH_ENV: resolve(home, "hostile-shell"),
    DATABASE_URL_APP_DAL: "postgresql://cloud:secret@database.example.com:5432/production",
    E2E_DATABASE_URL: "postgresql://postgres:admin@127.0.0.1:54322/postgres",
    HOME: home,
    LD_PRELOAD: resolve(home, "hostile-loader.so"),
    NEXT_PUBLIC_APP_URL: "https://cloud.example.com",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "host-anon",
    NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
    NODE_OPTIONS: `--require=${resolve(home, "hostile-loader.cjs")}`,
    NPM_CONFIG_USERCONFIG: resolve(home, ".npmrc"),
    PATH: process.env.PATH,
    PGPASSWORD: "admin-secret",
    SSH_AUTH_SOCK: resolve(home, "agent.sock"),
    SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
    npm_config__authToken: "registry-secret",
    npm_config_node_options: `--require=${resolve(home, "npm-loader.cjs")}`,
    npm_config_script_shell: resolve(home, "hostile-script-shell"),
  };
}

describe("local development server launcher", () => {
  it("starts the absolute pinned Next CLI with only the physical web environment", () => {
    const fixture = temporaryRepository();
    const resultPath = resolve(fixture.root, "web-result.json");
    writeFileSync(
      fixture.nextCliPath,
      `const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(
        resultPath,
      )}, JSON.stringify({ APP_ENV: process.env.APP_ENV, APP_RELEASE_SHA: process.env.APP_RELEASE_SHA, DATABASE_URL_APP_DAL: process.env.DATABASE_URL_APP_DAL, NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, args: process.argv.slice(2), e2eDatabase: process.env.E2E_DATABASE_URL ?? null, nodeOptions: process.env.NODE_OPTIONS ?? null, npmNodeOptions: process.env.npm_config_node_options ?? null, pgPassword: process.env.PGPASSWORD ?? null, serviceRole: process.env.SUPABASE_SERVICE_ROLE_KEY ?? null }));\n`,
    );

    const launch = createLocalDevelopmentServerLaunch({
      application: "web",
      inheritedEnvironment: hostileInheritedEnvironment(fixture.root),
      repositoryRoot: fixture.root,
    });
    execFileSync(launch.command, launch.argumentsList, {
      ...launch.options,
      stdio: ["ignore", "pipe", "pipe"],
    });

    expect(launch).toMatchObject({
      argumentsList: [fixture.nextCliPath, "dev", "--hostname", "127.0.0.1", "--port", "3000"],
      command: process.execPath,
      name: "aplicação pública",
      options: {
        cwd: fixture.root,
        shell: false,
      },
    });
    expect(JSON.parse(readFileSync(resultPath, "utf8"))).toEqual({
      APP_ENV: "local",
      APP_RELEASE_SHA: "local",
      DATABASE_URL_APP_DAL: localDatabaseUrl,
      NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3000",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "web-anon",
      args: ["dev", "--hostname", "127.0.0.1", "--port", "3000"],
      e2eDatabase: null,
      nodeOptions: null,
      npmNodeOptions: null,
      pgPassword: null,
      serviceRole: null,
    });
  });

  it("keeps the backoffice environment, cwd and test mode separate", () => {
    const fixture = temporaryRepository();
    const launch = createLocalDevelopmentServerLaunch({
      application: "backoffice",
      detached: false,
      inheritedEnvironment: hostileInheritedEnvironment(fixture.root),
      repositoryRoot: fixture.root,
      runtimeMode: "test",
    });

    expect(launch.argumentsList).toEqual([
      fixture.nextCliPath,
      "dev",
      "--hostname",
      "127.0.0.1",
      "--port",
      "3001",
    ]);
    expect(launch.options).toMatchObject({
      cwd: resolve(fixture.root, "apps/backoffice"),
      detached: false,
      shell: false,
    });
    expect(launch.options.env).toMatchObject({
      APP_ENV: "test",
      DATABASE_URL_APP_DAL: localDatabaseUrl,
      NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3001",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "backoffice-anon",
    });
    expect(JSON.stringify(launch.options.env)).not.toMatch(
      /admin-secret|cloud\.example|database\.example|host-anon|hostile|registry-secret|service-role/u,
    );
  });

  it("fails closed before launch for invalid app, mode or local runtime", () => {
    const fixture = temporaryRepository();
    expect(() =>
      createLocalDevelopmentServerLaunch({
        application: "worker",
        repositoryRoot: fixture.root,
      }),
    ).toThrow("aplicação de desenvolvimento");
    expect(() =>
      createLocalDevelopmentServerLaunch({
        application: "web",
        repositoryRoot: fixture.root,
        runtimeMode: "production",
      }),
    ).toThrow("modo");

    writeFileSync(
      resolve(fixture.root, ".env.local"),
      localEnvironment("http://127.0.0.1:3000", "web-anon").replace(
        localDatabaseUrl,
        "postgresql://cloud:secret@database.example.com:5432/production",
      ),
      { mode: 0o600 },
    );
    expect(() =>
      createLocalDevelopmentServerLaunch({
        application: "web",
        inheritedEnvironment: { DATABASE_URL_APP_DAL: localDatabaseUrl, PATH: process.env.PATH },
        repositoryRoot: fixture.root,
      }),
    ).toThrow("Supabase local");
  });

  it("accepts only the physical Next package pinned by the root manifest", () => {
    const mismatch = temporaryRepository({ nextVersion: "16.2.0" });
    expect(() => resolveTrustedNextCliLaunch({ repositoryRoot: mismatch.root })).toThrow(
      "versão fixada",
    );

    const workspaceMismatch = temporaryRepository();
    writeFileSync(
      resolve(workspaceMismatch.root, "apps/backoffice/package.json"),
      `${JSON.stringify({ dependencies: { next: "16.2.0" } })}\n`,
    );
    expect(() =>
      createLocalDevelopmentServerLaunch({
        application: "backoffice",
        repositoryRoot: workspaceMismatch.root,
      }),
    ).toThrow("aplicação não usa");

    if (process.platform !== "win32") {
      const symbolic = temporaryRepository();
      const externalCli = resolve(symbolic.root, "external-next.cjs");
      writeFileSync(externalCli, "process.exitCode = 0;\n");
      rmSync(symbolic.nextCliPath);
      symlinkSync(externalCli, symbolic.nextCliPath);
      expect(() => resolveTrustedNextCliLaunch({ repositoryRoot: symbolic.root })).toThrow(
        "arquivo físico regular",
      );

      const writable = temporaryRepository();
      chmodSync(writable.nextCliPath, 0o666);
      expect(() => resolveTrustedNextCliLaunch({ repositoryRoot: writable.root })).toThrow(
        "protegido",
      );
    }
  });

  it("routes every documented npm development entry through the same guard", () => {
    const repositoryRoot = resolve(import.meta.dirname, "../..");
    const rootManifest = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8"));
    const backofficeManifest = JSON.parse(
      readFileSync(resolve(repositoryRoot, "apps/backoffice/package.json"), "utf8"),
    );

    expect(rootManifest.scripts).toMatchObject({
      dev: "node scripts/local-development-server.mjs web",
      "dev:backoffice": "node scripts/local-development-server.mjs backoffice",
    });
    expect(backofficeManifest.scripts.dev).toBe(
      "node ../../scripts/local-development-server.mjs backoffice",
    );
    for (const lifecycleName of ["predev", "postdev", "predev:backoffice", "postdev:backoffice"]) {
      expect(rootManifest.scripts).not.toHaveProperty(lifecycleName);
      expect(backofficeManifest.scripts).not.toHaveProperty(lifecycleName);
    }
  });
});

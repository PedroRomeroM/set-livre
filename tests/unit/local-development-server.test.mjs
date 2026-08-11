import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createLocalDevelopmentServerLaunch,
  createLocalProductionPreviewLaunches,
  createLocalProductionServerLaunch,
  resolveTrustedNextCliLaunch,
  runLocalDevelopmentServer,
  runLocalProductionServer,
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

function linuxMountInformation(mountPath) {
  const encodedMountPath = mountPath.replaceAll("\\", "\\134").replaceAll(" ", "\\040");
  return `1 0 0:1 / ${encodedMountPath} rw - tmpfs tmpfs rw\n`;
}

async function waitFor(predicate, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error("O preview não atingiu o estado esperado no prazo.");
}

describe("local development server launcher", () => {
  it("returns failure when its persistent child exits naturally with code 0", async () => {
    const fixture = temporaryRepository();
    const child = new EventEmitter();
    child.exitCode = null;
    child.pid = undefined;
    child.signalCode = null;
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      const result = runLocalDevelopmentServer({
        application: "web",
        inheritedEnvironment: { PATH: process.env.PATH },
        repositoryRoot: fixture.root,
        spawnProcess: () => {
          queueMicrotask(() => {
            child.exitCode = 0;
            child.emit("close", 0, null);
          });
          return child;
        },
      });

      await expect(result).resolves.toBe(1);
      expect(stderrWrite).toHaveBeenCalledWith(
        "aplicação pública encerrou com código 0; encerrando os demais processos.\n",
      );
    } finally {
      stderrWrite.mockRestore();
    }
  });

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

  it("starts production previews through the pinned CLI with a fresh local-only environment", () => {
    const fixture = temporaryRepository();
    const resultPath = resolve(fixture.root, "production-result.json");
    writeFileSync(
      fixture.nextCliPath,
      `const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(
        resultPath,
      )}, JSON.stringify({ APP_ENV: process.env.APP_ENV, APP_RELEASE_SHA: process.env.APP_RELEASE_SHA, DATABASE_URL_APP_DAL: process.env.DATABASE_URL_APP_DAL, NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, args: process.argv.slice(2), e2eDatabase: process.env.E2E_DATABASE_URL ?? null, nodeOptions: process.env.NODE_OPTIONS ?? null, npmNodeOptions: process.env.npm_config_node_options ?? null, pgPassword: process.env.PGPASSWORD ?? null, serviceRole: process.env.SUPABASE_SERVICE_ROLE_KEY ?? null }));\n`,
    );
    const inheritedEnvironment = hostileInheritedEnvironment(fixture.root);
    inheritedEnvironment.PATH = resolve(fixture.root, "hostile-bin");

    const web = createLocalProductionServerLaunch({
      application: "web",
      inheritedEnvironment,
      repositoryRoot: fixture.root,
    });
    execFileSync(web.command, web.argumentsList, {
      ...web.options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const backoffice = createLocalProductionServerLaunch({
      application: "backoffice",
      detached: false,
      inheritedEnvironment,
      repositoryRoot: fixture.root,
    });

    expect(web).toMatchObject({
      argumentsList: [fixture.nextCliPath, "start", "--hostname", "127.0.0.1", "--port", "3000"],
      command: process.execPath,
      options: { cwd: fixture.root, shell: false },
    });
    expect(backoffice).toMatchObject({
      argumentsList: [fixture.nextCliPath, "start", "--hostname", "127.0.0.1", "--port", "3001"],
      command: process.execPath,
      options: {
        cwd: resolve(fixture.root, "apps/backoffice"),
        detached: false,
        shell: false,
      },
    });
    expect(JSON.parse(readFileSync(resultPath, "utf8"))).toEqual({
      APP_ENV: "local",
      APP_RELEASE_SHA: "local",
      DATABASE_URL_APP_DAL: localDatabaseUrl,
      NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3000",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "web-anon",
      args: ["start", "--hostname", "127.0.0.1", "--port", "3000"],
      e2eDatabase: null,
      nodeOptions: null,
      npmNodeOptions: null,
      pgPassword: null,
      serviceRole: null,
    });
    expect(JSON.stringify(backoffice.options.env)).not.toMatch(
      /admin-secret|cloud\.example|database\.example|host-anon|hostile-loader|registry-secret|service-role/u,
    );

    const workflow = createLocalProductionPreviewLaunches({
      application: "web",
      inheritedEnvironment,
      repositoryRoot: fixture.root,
    });
    expect(workflow.build.argumentsList).toEqual([fixture.nextCliPath, "build"]);
    expect(workflow.start.argumentsList).toEqual(web.argumentsList);
    expect(workflow.build.options.env).toBe(workflow.start.options.env);
    expect(workflow.buildOutputPath).toBe(resolve(fixture.root, ".next"));
  });

  it.runIf(process.platform === "linux")(
    "removes a stale cloud build and starts only the freshly built local bundle",
    async () => {
      const fixture = temporaryRepository();
      const buildOutputPath = resolve(fixture.root, ".next");
      const externalBuildOutput = resolve(fixture.root, "external-build-output");
      const externalMarkerPath = resolve(externalBuildOutput, "external-marker");
      const staleMarkerPath = resolve(buildOutputPath, "stale-cloud-bundle");
      const bundlePath = resolve(buildOutputPath, "preview-bundle.json");
      const resultPath = resolve(fixture.root, "fresh-preview-result.json");
      mkdirSync(buildOutputPath);
      mkdirSync(externalBuildOutput);
      writeFileSync(externalMarkerPath, "must-survive", "utf8");
      symlinkSync(externalBuildOutput, resolve(buildOutputPath, "external-link"), "dir");
      writeFileSync(staleMarkerPath, "https://cloud.example.com", "utf8");
      writeFileSync(
        fixture.nextCliPath,
        `const fs = require("node:fs"); const path = require("node:path"); const command = process.argv[2]; const output = ${JSON.stringify(buildOutputPath)}; const stale = ${JSON.stringify(staleMarkerPath)}; const bundle = ${JSON.stringify(bundlePath)}; if (command === "build") { if (fs.existsSync(stale)) process.exit(41); fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, "BUILD_ID"), "fresh-local-build\\n"); fs.writeFileSync(bundle, JSON.stringify({ APP_ENV: process.env.APP_ENV, DATABASE_URL_APP_DAL: process.env.DATABASE_URL_APP_DAL, NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL, nodeOptions: process.env.NODE_OPTIONS ?? null, serviceRole: process.env.SUPABASE_SERVICE_ROLE_KEY ?? null })); } else if (command === "start") { fs.writeFileSync(${JSON.stringify(resultPath)}, fs.readFileSync(bundle)); process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000); } else { process.exit(42); }\n`,
      );
      const signalSource = new EventEmitter();
      const inheritedEnvironment = hostileInheritedEnvironment(fixture.root);

      const run = runLocalProductionServer({
        application: "web",
        forceShutdownMilliseconds: 150,
        inheritedEnvironment,
        repositoryRoot: fixture.root,
        signalSource,
      });
      await waitFor(() => existsSync(resultPath));
      signalSource.emit("SIGTERM");

      await expect(run).rejects.toMatchObject({ exitCode: 143 });
      expect(existsSync(staleMarkerPath)).toBe(false);
      expect(readFileSync(externalMarkerPath, "utf8")).toBe("must-survive");
      expect(JSON.parse(readFileSync(resultPath, "utf8"))).toEqual({
        APP_ENV: "local",
        DATABASE_URL_APP_DAL: localDatabaseUrl,
        NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3000",
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "web-anon",
        NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
        nodeOptions: null,
        serviceRole: null,
      });
      expect(readFileSync(bundlePath, "utf8")).not.toMatch(
        /cloud\.example|database\.example|host-anon|service-role/u,
      );
      expect(
        readdirSync(fixture.root).filter((name) => name.startsWith(".next.preview-retired-")),
      ).toEqual([]);
    },
    10_000,
  );

  it("refuses Linux mounts at the .next root or below before rename and spawn", async () => {
    for (const mountedRelativePath of [
      "",
      "nested/mounted-output",
      "nested with space/mounted\\output",
    ]) {
      const fixture = temporaryRepository();
      const buildOutputPath = resolve(fixture.root, ".next");
      const mountedPath = resolve(buildOutputPath, mountedRelativePath);
      const markerPath = resolve(mountedPath, "must-remain");
      mkdirSync(mountedPath, { recursive: true });
      writeFileSync(markerPath, "external-volume-content", "utf8");
      let spawnAttempted = false;

      await expect(
        runLocalProductionServer({
          application: "web",
          platform: "linux",
          readLinuxMountInformation: () => linuxMountInformation(mountedPath),
          repositoryRoot: fixture.root,
          signalSource: new EventEmitter(),
          spawnProcess: () => {
            spawnAttempted = true;
            throw new Error("spawn não deveria ocorrer");
          },
        }),
      ).rejects.toThrow("não pode ser um mount nem conter mounts");

      expect(readFileSync(markerPath, "utf8")).toBe("external-volume-content");
      expect(existsSync(buildOutputPath)).toBe(true);
      expect(
        readdirSync(fixture.root).filter((name) => name.startsWith(".next.preview-retired-")),
      ).toEqual([]);
      expect(spawnAttempted).toBe(false);
    }

    for (const readLinuxMountInformation of [
      () => "",
      () => "mountinfo-malformado\n",
      () => "1 0 0:1 / caminho-relativo rw - tmpfs tmpfs rw\n",
      () => "1 0 0:1 raiz-relativa /tmp rw - tmpfs tmpfs rw\n",
      () => "1 0 0:1 /tmp/../raiz /tmp rw - tmpfs tmpfs rw\n",
      () => "1 0 0:1 / /tmp\\777 rw - tmpfs tmpfs rw\n",
      () => "1 0 0:1 / /tmp rw - tmpfs - rw\n",
      () => "1 0 0:1 / /tmp/../escape rw - tmpfs tmpfs rw\n",
      () => {
        throw new Error("mountinfo-indisponível");
      },
    ]) {
      const fixture = temporaryRepository();
      const buildOutputPath = resolve(fixture.root, ".next");
      const markerPath = resolve(buildOutputPath, "nested/must-remain");
      mkdirSync(resolve(buildOutputPath, "nested"), { recursive: true });
      writeFileSync(markerPath, "previous-build-content", "utf8");
      let spawnAttempted = false;

      await expect(
        runLocalProductionServer({
          application: "web",
          platform: "linux",
          readLinuxMountInformation,
          repositoryRoot: fixture.root,
          signalSource: new EventEmitter(),
          spawnProcess: () => {
            spawnAttempted = true;
            throw new Error("spawn não deveria ocorrer");
          },
        }),
      ).rejects.toThrow("Não foi possível comprovar");

      expect(readFileSync(markerPath, "utf8")).toBe("previous-build-content");
      expect(
        readdirSync(fixture.root).filter((name) => name.startsWith(".next.preview-retired-")),
      ).toEqual([]);
      expect(spawnAttempted).toBe(false);
    }
  });

  it("fails closed on non-Linux before retiring an existing .next tree", async () => {
    for (const platform of ["darwin", "win32", "unknown-platform"]) {
      const fixture = temporaryRepository();
      const buildOutputPath = resolve(fixture.root, ".next");
      const rootMarkerPath = resolve(buildOutputPath, "root-marker");
      const nestedMarkerPath = resolve(buildOutputPath, "nested/deep-marker");
      mkdirSync(resolve(buildOutputPath, "nested"), { recursive: true });
      writeFileSync(rootMarkerPath, `${platform}-root`, "utf8");
      writeFileSync(nestedMarkerPath, `${platform}-nested`, "utf8");
      let mountInformationRead = false;
      let spawnAttempted = false;

      await expect(
        runLocalProductionServer({
          application: "web",
          platform,
          readLinuxMountInformation: () => {
            mountInformationRead = true;
            throw new Error("mountinfo Linux não deveria ser lido");
          },
          repositoryRoot: fixture.root,
          signalSource: new EventEmitter(),
          spawnProcess: () => {
            spawnAttempted = true;
            throw new Error("spawn não deveria ocorrer");
          },
        }),
      ).rejects.toThrow("removida manualmente nesta plataforma");

      expect(readFileSync(rootMarkerPath, "utf8")).toBe(`${platform}-root`);
      expect(readFileSync(nestedMarkerPath, "utf8")).toBe(`${platform}-nested`);
      expect(
        readdirSync(fixture.root).filter((name) => name.startsWith(".next.preview-retired-")),
      ).toEqual([]);
      expect(mountInformationRead).toBe(false);
      expect(spawnAttempted).toBe(false);
    }
  });

  it("allows a non-Linux preview without previous .next to reach the build spawn", async () => {
    const fixture = temporaryRepository();
    let spawnAttempted = false;

    await expect(
      runLocalProductionServer({
        application: "web",
        platform: "darwin",
        repositoryRoot: fixture.root,
        signalSource: new EventEmitter(),
        spawnProcess: () => {
          spawnAttempted = true;
          throw new Error("synthetic-build-spawn");
        },
      }),
    ).rejects.toThrow("synthetic-build-spawn");

    expect(spawnAttempted).toBe(true);
    expect(
      readdirSync(fixture.root).filter((name) => name.startsWith(".next.preview-retired-")),
    ).toEqual([]);
  });

  it("rejects an unsafe previous build output before spawning Next", async () => {
    const regularFileFixture = temporaryRepository();
    writeFileSync(resolve(regularFileFixture.root, ".next"), "not-a-directory", "utf8");
    let spawnAttempted = false;

    await expect(
      runLocalProductionServer({
        application: "web",
        repositoryRoot: regularFileFixture.root,
        signalSource: new EventEmitter(),
        spawnProcess: () => {
          spawnAttempted = true;
          throw new Error("spawn não deveria ocorrer");
        },
      }),
    ).rejects.toThrow("diretório físico");
    expect(spawnAttempted).toBe(false);

    if (process.platform !== "win32") {
      const symbolicFixture = temporaryRepository();
      const externalBuildOutput = resolve(symbolicFixture.root, "external-build-output");
      mkdirSync(externalBuildOutput);
      symlinkSync(externalBuildOutput, resolve(symbolicFixture.root, ".next"), "dir");

      await expect(
        runLocalProductionServer({
          application: "web",
          repositoryRoot: symbolicFixture.root,
          signalSource: new EventEmitter(),
          spawnProcess: () => {
            spawnAttempted = true;
            throw new Error("spawn não deveria ocorrer");
          },
        }),
      ).rejects.toThrow("diretório físico");
      expect(readdirSync(externalBuildOutput)).toEqual([]);
      expect(spawnAttempted).toBe(false);
    }
  });

  it("rereads the physical preview environment and never falls back to inherited cloud data", () => {
    const fixture = temporaryRepository();
    const environmentPath = resolve(fixture.root, ".env.local");
    const inheritedEnvironment = hostileInheritedEnvironment(fixture.root);

    expect(
      createLocalProductionServerLaunch({
        application: "web",
        inheritedEnvironment,
        repositoryRoot: fixture.root,
      }).options.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    ).toBe("web-anon");

    writeFileSync(
      environmentPath,
      localEnvironment("http://127.0.0.1:3000", "rotated-local-anon"),
      { mode: 0o600 },
    );
    expect(
      createLocalProductionServerLaunch({
        application: "web",
        inheritedEnvironment,
        repositoryRoot: fixture.root,
      }).options.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    ).toBe("rotated-local-anon");

    writeFileSync(
      environmentPath,
      localEnvironment("http://127.0.0.1:3000", "rotated-local-anon").replace(
        localDatabaseUrl,
        "postgresql://cloud:secret@database.example.com:5432/production",
      ),
      { mode: 0o600 },
    );
    expect(() =>
      createLocalProductionServerLaunch({
        application: "web",
        inheritedEnvironment: { DATABASE_URL_APP_DAL: localDatabaseUrl, PATH: process.env.PATH },
        repositoryRoot: fixture.root,
      }),
    ).toThrow("host IPv4 literal 127.0.0.1");

    rmSync(environmentPath);
    expect(() =>
      createLocalProductionServerLaunch({
        application: "web",
        inheritedEnvironment: { DATABASE_URL_APP_DAL: localDatabaseUrl, PATH: process.env.PATH },
        repositoryRoot: fixture.root,
      }),
    ).toThrow("arquivo físico regular");
  });

  it("rejects production env overlays before Next can reload them", () => {
    const fixture = temporaryRepository();
    const webOverlay = resolve(fixture.root, ".env.production.local");
    writeFileSync(webOverlay, "DATABASE_URL_APP_DAL=postgresql://cloud.example/production\n", {
      mode: 0o600,
    });
    expect(() =>
      createLocalProductionServerLaunch({
        application: "web",
        inheritedEnvironment: { PATH: process.env.PATH },
        repositoryRoot: fixture.root,
      }),
    ).toThrow("aceita somente .env.local");

    rmSync(webOverlay);
    writeFileSync(
      resolve(fixture.root, "apps/backoffice/.env"),
      "SUPABASE_SERVICE_ROLE_KEY=cloud-secret\n",
      { mode: 0o600 },
    );
    expect(() =>
      createLocalProductionServerLaunch({
        application: "backoffice",
        inheritedEnvironment: { PATH: process.env.PATH },
        repositoryRoot: fixture.root,
      }),
    ).toThrow("aceita somente .env.local");
  });

  it("rejects every development dotenv overlay that Next would load", () => {
    for (const application of ["web", "backoffice"]) {
      for (const overlayName of [".env", ".env.development", ".env.development.local"]) {
        const fixture = temporaryRepository();
        const workingDirectory =
          application === "web" ? fixture.root : resolve(fixture.root, "apps/backoffice");
        const overlayPath = resolve(workingDirectory, overlayName);
        writeFileSync(
          overlayPath,
          [
            "NEXT_PUBLIC_APP_URL=https://cloud.example.com",
            "SUPABASE_SERVICE_ROLE_KEY=cloud-secret",
            "",
          ].join("\n"),
          { mode: 0o600 },
        );

        expect(() =>
          createLocalDevelopmentServerLaunch({
            application,
            inheritedEnvironment: { PATH: process.env.PATH },
            repositoryRoot: fixture.root,
          }),
        ).toThrow(`remova ${overlayPath}`);
      }
    }
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
    ).toThrow("host IPv4 literal 127.0.0.1");
  });

  it("rejects a URL alias that normalizes to IPv4 before any local launcher starts", () => {
    const fixture = temporaryRepository();
    writeFileSync(
      resolve(fixture.root, ".env.local"),
      localEnvironment("http://127.0.0.1:3000", "web-anon").replace(
        "http://127.0.0.1:54321",
        "http://127.1:54321",
      ),
      { mode: 0o600 },
    );

    expect(() =>
      createLocalDevelopmentServerLaunch({
        application: "web",
        inheritedEnvironment: { PATH: process.env.PATH },
        repositoryRoot: fixture.root,
      }),
    ).toThrow("host IPv4 literal 127.0.0.1");
    expect(() =>
      createLocalProductionServerLaunch({
        application: "web",
        inheritedEnvironment: { PATH: process.env.PATH },
        repositoryRoot: fixture.root,
      }),
    ).toThrow("host IPv4 literal 127.0.0.1");
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

  it("routes every documented npm development and preview entry through the same guard", () => {
    const repositoryRoot = resolve(import.meta.dirname, "../..");
    const rootManifest = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8"));
    const backofficeManifest = JSON.parse(
      readFileSync(resolve(repositoryRoot, "apps/backoffice/package.json"), "utf8"),
    );

    expect(rootManifest.scripts).toMatchObject({
      dev: "node scripts/local-development-server.mjs web",
      "dev:backoffice": "node scripts/local-development-server.mjs backoffice",
      start: "node scripts/local-production-server.mjs web",
      "start:backoffice": "node scripts/local-production-server.mjs backoffice",
    });
    expect(backofficeManifest.scripts.dev).toBe(
      "node ../../scripts/local-development-server.mjs backoffice",
    );
    expect(backofficeManifest.scripts.start).toBe(
      "node ../../scripts/local-production-server.mjs backoffice",
    );
    for (const lifecycleName of [
      "predev",
      "postdev",
      "predev:backoffice",
      "postdev:backoffice",
      "prestart",
      "poststart",
      "prestart:backoffice",
      "poststart:backoffice",
    ]) {
      expect(rootManifest.scripts).not.toHaveProperty(lifecycleName);
      expect(backofficeManifest.scripts).not.toHaveProperty(lifecycleName);
    }
  });
});

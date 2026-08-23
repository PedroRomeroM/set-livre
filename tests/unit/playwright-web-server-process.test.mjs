import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  createPlaywrightWebServerLaunch,
  runPlaywrightWebServer,
} from "../../scripts/playwright-web-server.mjs";
import { spawnSupervisedProcess } from "../../scripts/development-process-tree.mjs";

const wrapperUrl = pathToFileURL(
  resolve(import.meta.dirname, "../../scripts/playwright-web-server.mjs"),
).href;
const temporaryRoots = [];
const localDatabaseUrl =
  "postgresql://app_runtime_local:local-password@127.0.0.1:54322/postgres?options=-c%20role%3Dapp_dal";
const fixtureFileSecurityOptions = {
  assertWindowsIntegrity: () => {},
  assertWindowsPrivate: () => {},
  platform: process.platform,
};

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function localEnvironment(applicationUrl) {
  return [
    "APP_ENV=local",
    "APP_RELEASE_SHA=local",
    `DATABASE_URL_APP_DAL=${localDatabaseUrl}`,
    `NEXT_PUBLIC_APP_URL=${applicationUrl}`,
    "NEXT_PUBLIC_SUPABASE_ANON_KEY=local-anon-from-physical-file",
    "NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321",
    "",
  ].join("\n");
}

function temporaryRepository(scripts = {}) {
  const root = mkdtempSync(resolve(tmpdir(), "set-livre-playwright-server-"));
  temporaryRoots.push(root);
  mkdirSync(resolve(root, "apps/backoffice"), { recursive: true });
  mkdirSync(resolve(root, "node_modules/next/dist/bin"), { recursive: true });
  writeFileSync(resolve(root, ".env.local"), localEnvironment("http://127.0.0.1:3000"), {
    mode: 0o600,
  });
  writeFileSync(
    resolve(root, "apps/backoffice/.env.local"),
    localEnvironment("http://127.0.0.1:3001"),
    { mode: 0o600 },
  );
  writeFileSync(
    resolve(root, "package.json"),
    `${JSON.stringify({ dependencies: { next: "16.3.0" }, devEngines: { packageManager: { name: "npm", onFail: "error", version: "11.19.0" }, runtime: { name: "node", onFail: "error", version: process.versions.node } }, name: "playwright-server-probe", packageManager: "npm@11.19.0", private: true, scripts, version: "0.0.0" })}\n`,
  );
  writeFileSync(
    resolve(root, "apps/backoffice/package.json"),
    `${JSON.stringify({ dependencies: { next: "16.3.0" } })}\n`,
  );
  writeFileSync(
    resolve(root, "node_modules/next/package.json"),
    `${JSON.stringify({ bin: { next: "./dist/bin/next" }, name: "next", version: "16.3.0" })}\n`,
  );
  writeFileSync(resolve(root, "node_modules/next/dist/bin/next"), "process.exitCode = 0;\n");
  return root;
}

function hostileInheritedEnvironment(home) {
  return {
    BASH_ENV: resolve(home, "hostile-bash-env"),
    DATABASE_URL_APP_DAL: "postgresql://cloud:secret@remote.example.com/production",
    HOME: home,
    LD_PRELOAD: resolve(home, "hostile-loader.so"),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "host-anon-that-must-not-win",
    NODE_OPTIONS: `--require=${resolve(home, "hostile-loader.cjs")}`,
    NPM_CONFIG_USERCONFIG: resolve(home, ".npmrc"),
    PATH: process.env.PATH,
    PGPASSWORD: "host-postgres-secret",
    SSH_AUTH_SOCK: resolve(home, "agent.sock"),
    SUPABASE_SERVICE_ROLE_KEY: "host-service-role-secret",
    ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}),
    npm_config__authToken: "host-registry-secret",
  };
}

function minimalInheritedEnvironment(home) {
  return {
    HOME: home,
    PATH: process.env.PATH,
    ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}),
  };
}

function workerEnvironment(home) {
  const environment = minimalInheritedEnvironment(home);
  if (process.platform !== "win32") {
    return environment;
  }
  for (const name of ["LOCALAPPDATA", "TEMP", "TMP"]) {
    const value = process.env[name];
    if (typeof value === "string" && value !== "") {
      environment[name] = value;
    }
  }
  return environment;
}

function spawnDirectly(command, argumentsList, options, { spawnProcess }) {
  return spawnProcess(command, argumentsList, options);
}

function compileGuardianFixture(root) {
  const systemRoot = process.env.SystemRoot;
  if (typeof systemRoot !== "string" || systemRoot === "") {
    throw new Error("SystemRoot é obrigatório para compilar a fixture do Job Object.");
  }
  const compilerPath = resolve(systemRoot, "Microsoft.NET/Framework64/v4.0.30319/csc.exe");
  const guardianPath = resolve(root, "set-livre-job-object-guardian.exe");
  const sourcePath = resolve(import.meta.dirname, "../../scripts/windows-job-object-guardian.cs");
  const compilation = spawnSync(
    compilerPath,
    ["/nologo", "/target:exe", "/optimize+", "/warnaserror+", `/out:${guardianPath}`, sourcePath],
    {
      cwd: root,
      env: { SystemRoot: systemRoot, WINDIR: systemRoot },
      shell: false,
      stdio: "pipe",
      windowsHide: true,
    },
  );
  if (
    compilation.error !== undefined ||
    compilation.signal !== null ||
    compilation.status !== 0 ||
    !existsSync(guardianPath)
  ) {
    throw new Error("A fixture do Job Object não pôde ser compilada.", {
      cause: compilation.error,
    });
  }
  return guardianPath;
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function waitFor(predicate, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error("A prova de processo não atingiu o estado esperado no prazo.");
}

async function assertPortCanBeRebound(port) {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", resolveListen);
  });
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
  });
}

describe("isolated Playwright webServer wrapper", () => {
  it("uses the selected physical app environment and never a hostile host value", async () => {
    const resultPath = resolve(tmpdir(), `set-livre-playwright-env-${process.pid}-${Date.now()}`);
    temporaryRoots.push(resultPath);
    const repository = temporaryRepository({
      dev: "node probe.cjs",
      predev: "node prehook.cjs",
    });
    const prehookSentinel = resolve(repository, "prehook-ran");
    const hostileHome = resolve(repository, "hostile-home");
    mkdirSync(hostileHome);
    writeFileSync(
      resolve(hostileHome, ".npmrc"),
      "ignore-scripts=false\nnode-options=--require=./hostile-loader.cjs\n",
    );
    writeFileSync(
      resolve(repository, "prehook.cjs"),
      `require("node:fs").writeFileSync(${JSON.stringify(prehookSentinel)}, "executed");\n`,
    );
    writeFileSync(
      resolve(repository, "node_modules/next/dist/bin/next"),
      `require("node:fs").writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ APP_ENV: process.env.APP_ENV, APP_RELEASE_SHA: process.env.APP_RELEASE_SHA, DATABASE_URL_APP_DAL: process.env.DATABASE_URL_APP_DAL, NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, globalConfig: process.env.npm_config_globalconfig ?? null, nodeOptions: process.env.NODE_OPTIONS ?? null, npmNodeOptions: process.env.npm_config_node_options ?? null, pgPassword: process.env.PGPASSWORD ?? null, serviceRole: process.env.SUPABASE_SERVICE_ROLE_KEY ?? null, sshAgent: process.env.SSH_AUTH_SOCK ?? null, userConfig: process.env.npm_config_userconfig ?? null }));\n`,
    );

    const exitCode = await runPlaywrightWebServer({
      application: "web",
      fileSecurityOptions: fixtureFileSecurityOptions,
      inheritedEnvironment: hostileInheritedEnvironment(hostileHome),
      repositoryRoot: repository,
      spawnManagedProcess: spawnDirectly,
    });

    expect(exitCode).toBe(1);
    expect(existsSync(prehookSentinel)).toBe(false);
    expect(JSON.parse(readFileSync(resultPath, "utf8"))).toEqual({
      APP_ENV: "test",
      APP_RELEASE_SHA: "local",
      DATABASE_URL_APP_DAL: localDatabaseUrl,
      NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3000",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "local-anon-from-physical-file",
      globalConfig: null,
      nodeOptions: null,
      npmNodeOptions: null,
      pgPassword: null,
      serviceRole: null,
      sshAgent: null,
      userConfig: null,
    });
  }, 15_000);

  it("returns process failure when the persistent Next child exits naturally with code 0", () => {
    const repository = temporaryRepository({ dev: "node probe.cjs" });
    const childStartedPath = resolve(repository, "next-child-started");
    writeFileSync(
      resolve(repository, "node_modules/next/dist/bin/next"),
      `require("node:fs").writeFileSync(${JSON.stringify(childStartedPath)}, "started");\n`,
    );
    const workerSource = `import { runPlaywrightWebServer } from ${JSON.stringify(
      wrapperUrl,
    )}; process.exitCode = await runPlaywrightWebServer({ application: "web", fileSecurityOptions: { assertWindowsIntegrity: () => {}, assertWindowsPrivate: () => {}, platform: process.platform }, inheritedEnvironment: process.env, repositoryRoot: ${JSON.stringify(
      repository,
    )}, spawnManagedProcess: (command, argumentsList, options, { spawnProcess }) => spawnProcess(command, argumentsList, options) });`;
    const worker = spawnSync(process.execPath, ["--input-type=module", "--eval", workerSource], {
      env: workerEnvironment(repository),
      killSignal: "SIGKILL",
      stdio: "pipe",
      timeout: 5_000,
    });

    expect(worker.error).toBeUndefined();
    expect(worker.signal).toBeNull();
    expect(worker.status).toBe(1);
    expect(readFileSync(childStartedPath, "utf8")).toBe("started");
  });

  it.each([
    [0, null, 1],
    [17, null, 17],
    [null, null, 1],
    [null, "SIGHUP", 129],
    [null, "SIGINT", 130],
    [null, "SIGTERM", 143],
    [null, "SIGKILL", 137],
  ])("preserves an unexpected child close (%s, %s) as exit %i", async (code, signal, exitCode) => {
    const repository = temporaryRepository({ dev: "node probe.cjs" });
    const child = new EventEmitter();
    child.exitCode = null;
    child.pid = 434_343;
    child.signalCode = null;

    const completion = runPlaywrightWebServer({
      application: "web",
      fileSecurityOptions: fixtureFileSecurityOptions,
      inheritedEnvironment: { HOME: repository, PATH: process.env.PATH },
      platform: "linux",
      repositoryRoot: repository,
      signalSource: new EventEmitter(),
      spawnProcess: () => child,
    });
    child.exitCode = code;
    child.signalCode = signal;
    child.emit("close", code, signal);

    await expect(completion).resolves.toBe(exitCode);
  });

  it("accepts a closed Windows guardian without targeting any released PID", async () => {
    const repository = temporaryRepository({ dev: "node probe.cjs" });
    const child = new EventEmitter();
    const signalSource = new EventEmitter();
    child.exitCode = null;
    child.pid = 444_444;
    child.signalCode = null;

    const completion = runPlaywrightWebServer({
      application: "web",
      fileSecurityOptions: fixtureFileSecurityOptions,
      inheritedEnvironment: {
        HOME: repository,
        PATH: process.env.PATH,
        SYSTEMROOT: "C:\\Windows",
      },
      platform: "win32",
      repositoryRoot: repository,
      signalSource,
      spawnManagedProcess: (command, argumentsList, options, { spawnProcess }) =>
        spawnProcess(command, argumentsList, options),
      spawnProcess: () => child,
    });
    child.exitCode = 0;
    child.emit("close", 0, null);

    await expect(completion).resolves.toBe(1);
    expect(signalSource.listenerCount("SIGHUP")).toBe(0);
    expect(signalSource.listenerCount("SIGINT")).toBe(0);
    expect(signalSource.listenerCount("SIGTERM")).toBe(0);
  });

  it("creates distinct web and backoffice launches before spawning", () => {
    const repository = temporaryRepository({
      dev: "node web.cjs",
      "dev:backoffice": "node admin.cjs",
    });
    const inheritedEnvironment = minimalInheritedEnvironment(repository);
    const web = createPlaywrightWebServerLaunch({
      application: "web",
      fileSecurityOptions: fixtureFileSecurityOptions,
      inheritedEnvironment,
      repositoryRoot: repository,
    });
    const backoffice = createPlaywrightWebServerLaunch({
      application: "backoffice",
      fileSecurityOptions: fixtureFileSecurityOptions,
      inheritedEnvironment,
      repositoryRoot: repository,
    });

    expect(web.options.env.NEXT_PUBLIC_APP_URL).toBe("http://127.0.0.1:3000");
    expect(backoffice.options.env.NEXT_PUBLIC_APP_URL).toBe("http://127.0.0.1:3001");
    expect(web.argumentsList.slice(1)).toEqual([
      "dev",
      "--hostname",
      "127.0.0.1",
      "--port",
      "3000",
    ]);
    expect(backoffice.argumentsList.slice(1)).toEqual([
      "dev",
      "--hostname",
      "127.0.0.1",
      "--port",
      "3001",
    ]);
    expect(web.options.cwd).toBe(repository);
    expect(backoffice.options.cwd).toBe(resolve(repository, "apps/backoffice"));
    expect(web.options.shell).toBe(false);
    expect(backoffice.options.shell).toBe(false);
    expect(web.options.env.APP_ENV).toBe("test");
    expect(backoffice.options.env.APP_ENV).toBe("test");
  });

  it.each([
    ["SIGHUP", 129],
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ])(
    "preserves requested %s when invoked outside a dedicated process group",
    async (requestedSignal, exitCode) => {
      const repository = temporaryRepository({ dev: "node probe.cjs" });
      const signalSource = new EventEmitter();
      const child = new EventEmitter();
      const receivedSignals = [];
      child.pid = 424_242;
      child.exitCode = null;
      child.signalCode = null;
      child.kill = (signal) => {
        receivedSignals.push(signal);
        child.signalCode = signal;
        queueMicrotask(() => child.emit("close", null, signal));
      };

      const completion = runPlaywrightWebServer({
        application: "web",
        fileSecurityOptions: fixtureFileSecurityOptions,
        inheritedEnvironment: { HOME: repository, PATH: process.env.PATH },
        platform: "linux",
        repositoryRoot: repository,
        signalProcessGroup: () => {
          const error = new Error("group unavailable");
          error.code = "ESRCH";
          throw error;
        },
        signalSource,
        spawnProcess: () => child,
      });
      signalSource.emit(requestedSignal);

      await expect(completion).resolves.toBe(exitCode);
      expect(receivedSignals).toEqual([requestedSignal]);
    },
  );

  it("closes the Windows guardian without forwarding the app environment to another tool", async () => {
    const repository = temporaryRepository({ dev: "node probe.cjs" });
    const signalSource = new EventEmitter();
    const child = new EventEmitter();
    const receivedSignals = [];
    child.pid = 515_151;
    child.exitCode = null;
    child.signalCode = null;
    child.kill = (signal) => {
      receivedSignals.push(signal);
      queueMicrotask(() => {
        child.signalCode = signal;
        child.emit("close", null, signal);
      });
      return true;
    };

    const completion = runPlaywrightWebServer({
      application: "web",
      fileSecurityOptions: fixtureFileSecurityOptions,
      inheritedEnvironment: {
        ...hostileInheritedEnvironment(repository),
      },
      platform: "win32",
      repositoryRoot: repository,
      signalSource,
      spawnManagedProcess: (command, argumentsList, options, { spawnProcess }) =>
        spawnProcess(command, argumentsList, options),
      spawnProcess: () => child,
    });
    signalSource.emit("SIGTERM");

    await expect(completion).resolves.toBe(143);
    expect(receivedSignals).toEqual(["SIGKILL"]);
  });

  it.runIf(process.platform === "win32")(
    "closes the Job Object when the Next root exits before its descendant",
    async () => {
      const repository = temporaryRepository({ dev: "node tree-parent.cjs" });
      const guardianPath = compileGuardianFixture(repository);
      const leafPidPath = resolve(repository, "windows-tree-leaf.pid");
      const leafPortPath = resolve(repository, "windows-tree-leaf.port");
      writeFileSync(
        resolve(repository, "windows-tree-leaf.cjs"),
        `const fs = require("node:fs"); const { createServer } = require("node:net"); fs.writeFileSync(${JSON.stringify(leafPidPath)}, String(process.pid)); const server = createServer(); server.listen(0, "127.0.0.1", () => { fs.writeFileSync(${JSON.stringify(leafPortPath)}, String(server.address().port)); if (process.send) process.send("ready"); });\n`,
      );
      writeFileSync(
        resolve(repository, "node_modules/next/dist/bin/next"),
        `const { spawn } = require("node:child_process"); const leaf = spawn(process.execPath, [${JSON.stringify(resolve(repository, "windows-tree-leaf.cjs"))}], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true }); leaf.once("message", () => process.exit(0));\n`,
      );

      let leafPid;
      try {
        const completion = runPlaywrightWebServer({
          application: "web",
          fileSecurityOptions: fixtureFileSecurityOptions,
          inheritedEnvironment: process.env,
          repositoryRoot: repository,
          signalSource: new EventEmitter(),
          spawnManagedProcess: (command, argumentsList, options, { platform, spawnProcess }) =>
            spawnSupervisedProcess(command, argumentsList, options, {
              platform,
              resolveWindowsGuardian: () => guardianPath,
              spawnProcess,
            }),
        });
        await waitFor(() => existsSync(leafPidPath) && existsSync(leafPortPath));
        leafPid = Number(readFileSync(leafPidPath, "utf8"));
        const leafPort = Number(readFileSync(leafPortPath, "utf8"));

        await expect(completion).resolves.toBe(1);
        await waitFor(() => !processExists(leafPid));
        await assertPortCanBeRebound(leafPort);
      } finally {
        if (leafPid !== undefined && processExists(leafPid)) {
          process.kill(leafPid, "SIGKILL");
        }
      }
    },
    15_000,
  );

  it.runIf(process.platform !== "win32")(
    "forwards termination to the isolated Next process group without leaving descendants",
    async () => {
      const repository = temporaryRepository({ dev: "node tree-parent.cjs" });
      const parentPidPath = resolve(repository, "tree-parent.pid");
      const leafPidPath = resolve(repository, "tree-leaf.pid");
      const parentStoppedPath = resolve(repository, "tree-parent.stopped");
      const leafStoppedPath = resolve(repository, "tree-leaf.stopped");
      const leafPortPath = resolve(repository, "tree-leaf.port");
      writeFileSync(
        resolve(repository, "tree-leaf.cjs"),
        `const fs = require("node:fs"); const { createServer } = require("node:net"); fs.writeFileSync(${JSON.stringify(leafPidPath)}, String(process.pid)); const server = createServer(); server.listen(0, "127.0.0.1", () => fs.writeFileSync(${JSON.stringify(leafPortPath)}, String(server.address().port))); process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(leafStoppedPath)}, "term-seen"); });\n`,
      );
      writeFileSync(
        resolve(repository, "node_modules/next/dist/bin/next"),
        `const { spawn } = require("node:child_process"); const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(parentPidPath)}, String(process.pid)); spawn(process.execPath, [${JSON.stringify(resolve(repository, "tree-leaf.cjs"))}], { stdio: "ignore" }); process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(parentStoppedPath)}, "term-seen"); }); setInterval(() => {}, 1000);\n`,
      );

      const workerSource = `import { runPlaywrightWebServer } from ${JSON.stringify(
        wrapperUrl,
      )}; process.exitCode = await runPlaywrightWebServer({ application: "web", fileSecurityOptions: { assertWindowsPrivate: () => {}, platform: process.platform }, inheritedEnvironment: process.env, repositoryRoot: ${JSON.stringify(
        repository,
      )} });`;
      const worker = spawn(process.execPath, ["--input-type=module", "--eval", workerSource], {
        detached: true,
        env: { HOME: repository, PATH: process.env.PATH },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let parentPid;
      let leafPid;
      let leafPort;
      try {
        const completion = new Promise((resolveCompletion, rejectCompletion) => {
          worker.once("error", rejectCompletion);
          worker.once("close", (code, signal) => resolveCompletion({ code, signal }));
        });
        await waitFor(
          () => existsSync(parentPidPath) && existsSync(leafPidPath) && existsSync(leafPortPath),
        );
        parentPid = Number(readFileSync(parentPidPath, "utf8"));
        leafPid = Number(readFileSync(leafPidPath, "utf8"));
        leafPort = Number(readFileSync(leafPortPath, "utf8"));
        expect(processExists(parentPid)).toBe(true);
        expect(processExists(leafPid)).toBe(true);

        worker.kill("SIGTERM");
        await expect(completion).resolves.toEqual({ code: null, signal: "SIGKILL" });
        await waitFor(() => !processExists(parentPid) && !processExists(leafPid));
        await assertPortCanBeRebound(leafPort);
        expect(readFileSync(parentStoppedPath, "utf8")).toBe("term-seen");
        expect(readFileSync(leafStoppedPath, "utf8")).toBe("term-seen");
      } finally {
        if (worker.exitCode === null && worker.signalCode === null) {
          worker.kill("SIGKILL");
        }
        for (const pid of [parentPid, leafPid]) {
          if (pid !== undefined && processExists(pid)) {
            process.kill(pid, "SIGKILL");
          }
        }
      }
    },
    15_000,
  );
});

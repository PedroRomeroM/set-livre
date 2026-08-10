import { spawn } from "node:child_process";
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

const wrapperUrl = pathToFileURL(
  resolve(import.meta.dirname, "../../scripts/playwright-web-server.mjs"),
).href;
const temporaryRoots = [];
const localDatabaseUrl =
  "postgresql://app_runtime_local:local-password@127.0.0.1:54322/postgres?options=-c%20role%3Dapp_dal";

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

function temporaryRepository(scripts) {
  const root = mkdtempSync(resolve(tmpdir(), "set-livre-playwright-server-"));
  temporaryRoots.push(root);
  mkdirSync(resolve(root, "apps/backoffice"), { recursive: true });
  mkdirSync(resolve(root, "config/npm"), { recursive: true });
  writeFileSync(resolve(root, ".env.local"), localEnvironment("http://127.0.0.1:3000"), {
    mode: 0o600,
  });
  writeFileSync(
    resolve(root, "apps/backoffice/.env.local"),
    localEnvironment("http://127.0.0.1:3001"),
    { mode: 0o600 },
  );
  writeFileSync(resolve(root, ".npmrc"), "engine-strict=true\nfund=false\nsave-exact=true\n");
  writeFileSync(resolve(root, "config/npm/dev-user.npmrc"), "# neutral\n");
  writeFileSync(resolve(root, "config/npm/dev-global.npmrc"), "# neutral\n");
  writeFileSync(
    resolve(root, "package.json"),
    `${JSON.stringify({ devEngines: { packageManager: { name: "npm", onFail: "error", version: "11.19.0" }, runtime: { name: "node", onFail: "error", version: process.versions.node } }, name: "playwright-server-probe", packageManager: "npm@11.19.0", private: true, scripts, version: "0.0.0" })}\n`,
  );
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
    npm_config__authToken: "host-registry-secret",
  };
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
      resolve(repository, "probe.cjs"),
      `require("node:fs").writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ APP_ENV: process.env.APP_ENV, APP_RELEASE_SHA: process.env.APP_RELEASE_SHA, DATABASE_URL_APP_DAL: process.env.DATABASE_URL_APP_DAL, NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, globalConfig: process.env.npm_config_globalconfig ?? null, nodeOptions: process.env.NODE_OPTIONS ?? null, npmNodeOptions: process.env.npm_config_node_options ?? null, pgPassword: process.env.PGPASSWORD ?? null, serviceRole: process.env.SUPABASE_SERVICE_ROLE_KEY ?? null, sshAgent: process.env.SSH_AUTH_SOCK ?? null, userConfig: process.env.npm_config_userconfig ?? null }));\n`,
    );

    const exitCode = await runPlaywrightWebServer({
      application: "web",
      inheritedEnvironment: hostileInheritedEnvironment(hostileHome),
      repositoryRoot: repository,
    });

    expect(exitCode).toBe(0);
    expect(existsSync(prehookSentinel)).toBe(false);
    expect(JSON.parse(readFileSync(resultPath, "utf8"))).toEqual({
      APP_ENV: "test",
      APP_RELEASE_SHA: "local",
      DATABASE_URL_APP_DAL: localDatabaseUrl,
      NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3000",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "local-anon-from-physical-file",
      globalConfig: resolve(repository, "config/npm/dev-global.npmrc"),
      nodeOptions: null,
      npmNodeOptions: "",
      pgPassword: null,
      serviceRole: null,
      sshAgent: null,
      userConfig: resolve(repository, "config/npm/dev-user.npmrc"),
    });
  });

  it("creates distinct web and backoffice launches before spawning", () => {
    const repository = temporaryRepository({
      dev: "node web.cjs",
      "dev:backoffice": "node admin.cjs",
    });
    const inheritedEnvironment = { HOME: repository, PATH: process.env.PATH };
    const web = createPlaywrightWebServerLaunch({
      application: "web",
      inheritedEnvironment,
      repositoryRoot: repository,
    });
    const backoffice = createPlaywrightWebServerLaunch({
      application: "backoffice",
      inheritedEnvironment,
      repositoryRoot: repository,
    });

    expect(web.options.env.NEXT_PUBLIC_APP_URL).toBe("http://127.0.0.1:3000");
    expect(backoffice.options.env.NEXT_PUBLIC_APP_URL).toBe("http://127.0.0.1:3001");
    expect(web.argumentsList.at(-1)).toBe("dev");
    expect(backoffice.argumentsList.at(-1)).toBe("dev");
    expect(backoffice.argumentsList).toContain("--workspace=@set-livre/backoffice");
    expect(web.options.env.APP_ENV).toBe("test");
    expect(backoffice.options.env.APP_ENV).toBe("test");
  });

  it("falls back to the direct child when invoked outside a dedicated process group", async () => {
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
      inheritedEnvironment: { HOME: repository, PATH: process.env.PATH },
      repositoryRoot: repository,
      signalProcessGroup: () => {
        const error = new Error("group unavailable");
        error.code = "ESRCH";
        throw error;
      },
      signalSource,
      spawnProcess: () => child,
    });
    signalSource.emit("SIGTERM");

    await expect(completion).resolves.toBe(143);
    expect(receivedSignals).toEqual(["SIGTERM"]);
  });

  it.runIf(process.platform !== "win32")(
    "forwards termination to the isolated npm process group without leaving descendants",
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
        resolve(repository, "tree-parent.cjs"),
        `const { spawn } = require("node:child_process"); const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(parentPidPath)}, String(process.pid)); spawn(process.execPath, [${JSON.stringify(resolve(repository, "tree-leaf.cjs"))}], { stdio: "ignore" }); process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(parentStoppedPath)}, "term-seen"); }); setInterval(() => {}, 1000);\n`,
      );

      const workerSource = `import { runPlaywrightWebServer } from ${JSON.stringify(
        wrapperUrl,
      )}; process.exitCode = await runPlaywrightWebServer({ application: "web", inheritedEnvironment: process.env, repositoryRoot: ${JSON.stringify(
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

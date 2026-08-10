import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runPackagedReleaseSmokeWithProcessCleanup } from "../../scripts/release-process-tree.mjs";

const temporaryRoots = [];
const processGroups = [];
const descendantPids = [];

afterEach(() => {
  for (const processGroupId of processGroups.splice(0)) {
    try {
      process.kill(-processGroupId, "SIGKILL");
    } catch {
      // O supervisor deve ter removido o grupo completo.
    }
  }
  for (const pid of descendantPids.splice(0)) {
    if (processExists(pid)) {
      process.kill(pid, "SIGKILL");
    }
  }
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

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
  throw new Error("A árvore empacotada não atingiu o estado esperado no prazo.");
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

function packagedProcessFixture(root, application) {
  const parentPidPath = resolve(root, `${application}.parent.pid`);
  const leafPidPath = resolve(root, `${application}.leaf.pid`);
  const portPath = resolve(root, `${application}.leaf.port`);
  const parentSignalPath = resolve(root, `${application}.parent.sighup`);
  const leafSignalPath = resolve(root, `${application}.leaf.sighup`);
  const leafScriptPath = resolve(root, `${application}.leaf.cjs`);
  const parentScriptPath = resolve(root, `${application}.parent.cjs`);
  writeFileSync(
    leafScriptPath,
    `const fs = require("node:fs"); const { createServer } = require("node:net"); fs.writeFileSync(${JSON.stringify(leafPidPath)}, String(process.pid)); const server = createServer(); server.listen(0, "127.0.0.1", () => fs.writeFileSync(${JSON.stringify(portPath)}, String(server.address().port))); process.on("SIGHUP", () => fs.writeFileSync(${JSON.stringify(leafSignalPath)}, "seen"));\n`,
  );
  writeFileSync(
    parentScriptPath,
    `const fs = require("node:fs"); const { spawn } = require("node:child_process"); fs.writeFileSync(${JSON.stringify(parentPidPath)}, String(process.pid)); spawn(process.execPath, [${JSON.stringify(leafScriptPath)}], { stdio: "ignore" }); process.on("SIGHUP", () => { fs.writeFileSync(${JSON.stringify(parentSignalPath)}, "seen"); process.exit(0); }); setInterval(() => {}, 1000);\n`,
  );
  return {
    application,
    leafPidPath,
    leafSignalPath,
    parentPidPath,
    parentScriptPath,
    parentSignalPath,
    portPath,
  };
}

describe("packaged release process cleanup", () => {
  it("fails when a packaged process exits cleanly before the smoke operation finishes", async () => {
    const child = new EventEmitter();
    child.exitCode = null;
    child.pid = 616_161;
    child.signalCode = null;
    let smokeStarted = false;

    await expect(
      runPackagedReleaseSmokeWithProcessCleanup({
        platform: "linux",
        signalProcessGroup: () => {
          const error = new Error("missing process group");
          error.code = "ESRCH";
          throw error;
        },
        signalSource: new EventEmitter(),
        smokeOperation: async () => {
          smokeStarted = true;
          queueMicrotask(() => {
            child.exitCode = 0;
            child.emit("close", 0, null);
          });
          await new Promise(() => {});
        },
        startProcesses: (registerState) => {
          registerState({ application: "web", child });
        },
      }),
    ).rejects.toThrow("encerrou durante o smoke (código 0)");
    expect(smokeStarted).toBe(true);
  });

  it("cleans a partially started process group and preserves the factory failure", async () => {
    const child = new EventEmitter();
    child.exitCode = null;
    child.pid = 515_151;
    child.signalCode = null;
    let smokeStarted = false;
    const signals = [];

    await expect(
      runPackagedReleaseSmokeWithProcessCleanup({
        platform: "linux",
        signalProcessGroup: (pid, signal) => {
          signals.push([pid, signal]);
          if (signal === 0) {
            const error = new Error("missing process group");
            error.code = "ESRCH";
            throw error;
          }
          queueMicrotask(() => {
            child.exitCode = 0;
            child.emit("close", 0, null);
          });
        },
        signalSource: new EventEmitter(),
        smokeOperation: async () => {
          smokeStarted = true;
        },
        startProcesses: (registerState) => {
          registerState({ application: "web", child });
          throw new Error("falha controlada no segundo spawn");
        },
      }),
    ).rejects.toThrow("falha controlada no segundo spawn");
    expect(smokeStarted).toBe(false);
    expect(signals).toEqual([
      [-515_151, "SIGTERM"],
      [-515_151, 0],
    ]);
  });

  it("preserves a SIGHUP received inside the process factory before the first spawn", async () => {
    const signalSource = new EventEmitter();
    const child = new EventEmitter();
    child.exitCode = null;
    child.pid = 717_171;
    child.signalCode = null;
    let smokeStarted = false;
    const signals = [];
    let interruptionError;

    try {
      await runPackagedReleaseSmokeWithProcessCleanup({
        forceShutdownMilliseconds: 100,
        platform: "linux",
        signalProcessGroup: (pid, signal) => {
          signals.push([pid, signal]);
          if (signal === 0) {
            const error = new Error("missing process group");
            error.code = "ESRCH";
            throw error;
          }
          queueMicrotask(() => {
            child.exitCode = 0;
            child.emit("close", 0, null);
          });
        },
        signalSource,
        smokeOperation: async () => {
          smokeStarted = true;
        },
        startProcesses: (registerState) => {
          signalSource.emit("SIGHUP");
          registerState({ application: "web", child });
        },
      });
    } catch (error) {
      interruptionError = error;
    }

    expect(interruptionError).toMatchObject({ exitCode: 129 });
    expect(smokeStarted).toBe(false);
    expect(signals).toEqual([
      [-717_171, "SIGHUP"],
      [-717_171, 0],
    ]);
    expect(signalSource.listenerCount("SIGHUP")).toBe(0);
  });

  it.runIf(process.platform !== "win32")(
    "installs handlers before spawning and removes both PGIDs on SIGHUP with exit 129",
    async () => {
      const root = mkdtempSync(resolve(tmpdir(), "set-livre-release-processes-"));
      temporaryRoots.push(root);
      const fixtures = ["web", "backoffice"].map((application) =>
        packagedProcessFixture(root, application),
      );
      const signalSource = new EventEmitter();
      let handlersWereInstalledBeforeSpawn = false;
      let interruptionError;

      try {
        await runPackagedReleaseSmokeWithProcessCleanup({
          forceShutdownMilliseconds: 150,
          signalSource,
          smokeOperation: async () => {
            await waitFor(() =>
              fixtures.every(
                ({ leafPidPath, parentPidPath, portPath }) =>
                  existsSync(leafPidPath) && existsSync(parentPidPath) && existsSync(portPath),
              ),
            );
            for (const fixture of fixtures) {
              descendantPids.push(Number(readFileSync(fixture.leafPidPath, "utf8")));
            }
            signalSource.emit("SIGHUP");
            await new Promise(() => {});
          },
          startProcesses: (registerState) => {
            handlersWereInstalledBeforeSpawn = signalSource.listenerCount("SIGHUP") > 0;
            for (const fixture of fixtures) {
              const child = spawn(process.execPath, [fixture.parentScriptPath], {
                detached: true,
                stdio: "ignore",
              });
              processGroups.push(child.pid);
              registerState({ application: fixture.application, child });
            }
          },
        });
      } catch (error) {
        interruptionError = error;
      }

      expect(handlersWereInstalledBeforeSpawn).toBe(true);
      expect(interruptionError).toMatchObject({ exitCode: 129 });
      expect(interruptionError.message).toContain("SIGHUP (código 129)");
      expect(signalSource.listenerCount("SIGHUP")).toBe(0);
      for (const fixture of fixtures) {
        const parentPid = Number(readFileSync(fixture.parentPidPath, "utf8"));
        const leafPid = Number(readFileSync(fixture.leafPidPath, "utf8"));
        const port = Number(readFileSync(fixture.portPath, "utf8"));
        await waitFor(() => !processExists(parentPid) && !processExists(leafPid));
        await assertPortCanBeRebound(port);
        expect(readFileSync(fixture.parentSignalPath, "utf8")).toBe("seen");
        expect(readFileSync(fixture.leafSignalPath, "utf8")).toBe("seen");
      }
    },
    10_000,
  );
});

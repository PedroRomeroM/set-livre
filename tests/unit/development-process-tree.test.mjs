import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  spawnSupervisedProcess,
  superviseDevelopmentProcesses,
} from "../../scripts/development-process-tree.mjs";

const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function fakeChild(pid) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.receivedSignals = [];
  child.kill = (signal) => {
    child.receivedSignals.push(signal);
    return true;
  };
  child.pid = pid;
  child.signalCode = null;
  return child;
}

function controlledTimeouts() {
  const callbacks = [];
  const cleared = [];
  return {
    callbacks,
    clearShutdownTimeout: (timer) => cleared.push(timer),
    cleared,
    scheduleShutdownTimeout: (callback, milliseconds) => {
      const timer = { milliseconds };
      callbacks.push({ callback, timer });
      return timer;
    },
  };
}

function closeChild(child, code, signal) {
  child.exitCode = code;
  child.signalCode = signal;
  child.emit("close", code, signal);
}

function missingProcessGroup() {
  const error = new Error("missing process group");
  error.code = "ESRCH";
  return error;
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
  throw new Error("A árvore de processos não atingiu o estado esperado no prazo.");
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

describe("development process tree supervisor", () => {
  it.each([
    ["SIGHUP", 129],
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ])("preserves an explicitly requested %s shutdown as exit %i", async (signal, exitCode) => {
    const child = fakeChild(1001);
    const exitTarget = {};
    const signalSource = new EventEmitter();
    const signals = [];
    const supervisor = superviseDevelopmentProcesses({
      children: [{ child, name: "aplicação pública" }],
      exitTarget,
      platform: "linux",
      signalProcessGroup: (pid, receivedSignal) => {
        signals.push([pid, receivedSignal]);
        if (receivedSignal === 0) {
          throw missingProcessGroup();
        }
      },
      signalSource,
      writeError: () => {},
    });

    signalSource.emit(signal);
    closeChild(child, null, signal);

    await expect(supervisor.completion).resolves.toBe(exitCode);
    expect(exitTarget.exitCode).toBe(exitCode);
    expect(signals).toEqual([
      [-1001, signal],
      [-1001, 0],
    ]);
  });

  it("closes every Windows Job Object guardian during a normal launcher shutdown", async () => {
    const children = [fakeChild(101), fakeChild(202)];
    const exitTarget = {};
    const signalSource = new EventEmitter();
    const timeouts = controlledTimeouts();
    const supervisor = superviseDevelopmentProcesses({
      children: [
        { child: children[0], name: "aplicação pública" },
        { child: children[1], name: "backoffice" },
      ],
      exitTarget,
      platform: "win32",
      signalSource,
      ...timeouts,
    });

    signalSource.emit("SIGINT");

    expect(children.map((child) => child.receivedSignals)).toEqual([["SIGKILL"], ["SIGKILL"]]);
    expect(timeouts.callbacks[0].timer.milliseconds).toBe(5_000);
    closeChild(children[0], null, "SIGKILL");
    closeChild(children[1], null, "SIGKILL");
    await expect(supervisor.completion).resolves.toBe(130);
    expect(exitTarget.exitCode).toBe(130);
    expect(timeouts.cleared).toEqual([timeouts.callbacks[0].timer]);
  });

  it("closes the remaining Windows Job Object when either application fails", async () => {
    const failedApplication = fakeChild(303);
    const remainingApplication = fakeChild(404);
    const exitTarget = {};
    const timeouts = controlledTimeouts();
    const supervisor = superviseDevelopmentProcesses({
      children: [
        { child: failedApplication, name: "aplicação pública" },
        { child: remainingApplication, name: "backoffice" },
      ],
      exitTarget,
      platform: "win32",
      signalSource: new EventEmitter(),
      writeError: () => {},
      ...timeouts,
    });

    closeChild(failedApplication, 17, null);

    expect(failedApplication.receivedSignals).toEqual([]);
    expect(remainingApplication.receivedSignals).toEqual(["SIGKILL"]);
    closeChild(remainingApplication, null, "SIGKILL");
    await expect(supervisor.completion).resolves.toBe(17);
    expect(exitTarget.exitCode).toBe(17);
  });

  it("maps an unexpected clean exit to failure and closes the other Windows Job Object", async () => {
    const cleanExit = fakeChild(505);
    const remainingApplication = fakeChild(606);
    const exitTarget = {};
    const errors = [];
    const timeouts = controlledTimeouts();
    const supervisor = superviseDevelopmentProcesses({
      children: [
        { child: cleanExit, name: "aplicação pública" },
        { child: remainingApplication, name: "backoffice" },
      ],
      exitTarget,
      platform: "win32",
      signalSource: new EventEmitter(),
      writeError: (message) => errors.push(message),
      ...timeouts,
    });

    closeChild(cleanExit, 0, null);

    expect(cleanExit.receivedSignals).toEqual([]);
    expect(remainingApplication.receivedSignals).toEqual(["SIGKILL"]);
    expect(exitTarget.exitCode).toBe(1);
    expect(errors).toEqual([
      "aplicação pública encerrou com código 0; encerrando os demais processos.\n",
    ]);
    closeChild(remainingApplication, null, "SIGKILL");
    await expect(supervisor.completion).resolves.toBe(1);
  });

  it("does not signal a Windows guardian after its Job Object was already closed", async () => {
    const child = fakeChild(616);
    child.exitCode = 0;
    const timeouts = controlledTimeouts();
    const supervisor = superviseDevelopmentProcesses({
      children: [{ child, name: "build finito" }],
      exitTarget: {},
      platform: "win32",
      signalSource: new EventEmitter(),
      writeError: () => {},
      ...timeouts,
    });

    supervisor.beginShutdown("SIGTERM", 0);
    expect(child.receivedSignals).toEqual([]);
    child.emit("close", 0, null);
    await expect(supervisor.completion).resolves.toBe(0);
  });

  it("launches Windows targets only through the compiled Job Object guardian", () => {
    const child = fakeChild(717);
    const control = new PassThrough();
    child.stdio = [null, null, null, control];
    let receivedLaunch;

    const result = spawnSupervisedProcess(
      "C:\\Program Files\\nodejs\\node.exe",
      ["C:\\Set Livre\\server.mjs", "argument with spaces"],
      { cwd: "C:\\Set Livre", detached: true, env: {}, shell: false, stdio: "inherit" },
      {
        platform: "win32",
        resolveWindowsGuardian: () => "C:\\guardian\\set-livre-job-object-guardian.exe",
        spawnProcess: (command, argumentsList, options) => {
          receivedLaunch = { argumentsList, command, options };
          return child;
        },
      },
    );

    expect(result).toBe(child);
    expect(receivedLaunch).toEqual({
      argumentsList: [
        "--control-fd=3",
        "C:\\Program Files\\nodejs\\node.exe",
        "C:\\Set Livre\\server.mjs",
        "argument with spaces",
      ],
      command: "C:\\guardian\\set-livre-job-object-guardian.exe",
      options: {
        cwd: "C:\\Set Livre",
        detached: false,
        env: {},
        shell: false,
        stdio: ["inherit", "inherit", "inherit", "pipe"],
        windowsHide: true,
      },
    });
    expect(control.read()).toEqual(Buffer.from([1]));
  });

  it.runIf(process.platform === "win32")(
    "kills descendants and releases their port when the target root exits first",
    async () => {
      const root = mkdtempSync(resolve(tmpdir(), "set-livre-windows-job-root-exit-"));
      temporaryRoots.push(root);
      const leafPidPath = resolve(root, "leaf.pid");
      const portPath = resolve(root, "leaf.port");
      const leafScriptPath = resolve(root, "leaf.cjs");
      const parentScriptPath = resolve(root, "parent.cjs");
      writeFileSync(
        leafScriptPath,
        `const fs = require("node:fs"); const { createServer } = require("node:net"); fs.writeFileSync(${JSON.stringify(leafPidPath)}, String(process.pid)); const server = createServer(); server.listen(0, "127.0.0.1", () => { fs.writeFileSync(${JSON.stringify(portPath)}, String(server.address().port)); if (process.send) process.send("ready"); });\n`,
      );
      writeFileSync(
        parentScriptPath,
        `const { spawn } = require("node:child_process"); const leaf = spawn(process.execPath, [${JSON.stringify(leafScriptPath)}], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true }); leaf.once("message", () => process.exit(0));\n`,
      );

      let leafPid;
      try {
        const child = spawnSupervisedProcess(
          process.execPath,
          [parentScriptPath],
          { cwd: root, env: process.env, shell: false, stdio: "inherit" },
          { platform: "win32" },
        );
        const supervisor = superviseDevelopmentProcesses({
          children: [{ child, name: "raiz Windows" }],
          exitTarget: {},
          platform: "win32",
          signalSource: new EventEmitter(),
          writeError: () => {},
        });
        await waitFor(() => existsSync(leafPidPath) && existsSync(portPath));
        leafPid = Number(readFileSync(leafPidPath, "utf8"));
        const port = Number(readFileSync(portPath, "utf8"));

        await expect(supervisor.completion).resolves.toBe(1);
        await waitFor(() => !processExists(leafPid));
        await assertPortCanBeRebound(port);
      } finally {
        if (leafPid !== undefined && processExists(leafPid)) {
          process.kill(leafPid, "SIGKILL");
        }
      }
    },
    15_000,
  );

  it.runIf(process.platform === "win32")(
    "closes the Job Object when the supervising Node process exits abruptly",
    async () => {
      const root = mkdtempSync(resolve(tmpdir(), "set-livre-windows-supervisor-exit-"));
      temporaryRoots.push(root);
      const guardianPidPath = resolve(root, "guardian.pid");
      const rootPidPath = resolve(root, "root.pid");
      const leafPidPath = resolve(root, "leaf.pid");
      const portPath = resolve(root, "leaf.port");
      const leafScriptPath = resolve(root, "leaf.cjs");
      const parentScriptPath = resolve(root, "parent.cjs");
      const workerScriptPath = resolve(root, "worker.mjs");
      const processTreeUrl = pathToFileURL(
        resolve(import.meta.dirname, "../../scripts/development-process-tree.mjs"),
      ).href;
      writeFileSync(
        leafScriptPath,
        `const fs = require("node:fs"); const { createServer } = require("node:net"); fs.writeFileSync(${JSON.stringify(leafPidPath)}, String(process.pid)); const server = createServer(); server.listen(0, "127.0.0.1", () => fs.writeFileSync(${JSON.stringify(portPath)}, String(server.address().port)));\n`,
      );
      writeFileSync(
        parentScriptPath,
        `const fs = require("node:fs"); const { spawn } = require("node:child_process"); fs.writeFileSync(${JSON.stringify(rootPidPath)}, String(process.pid)); spawn(process.execPath, [${JSON.stringify(leafScriptPath)}], { detached: true, stdio: "ignore", windowsHide: true }); setInterval(() => {}, 1000);\n`,
      );
      writeFileSync(
        workerScriptPath,
        `import { existsSync, writeFileSync } from "node:fs"; import { spawnSupervisedProcess } from ${JSON.stringify(processTreeUrl)}; const child = spawnSupervisedProcess(process.execPath, [${JSON.stringify(parentScriptPath)}], { cwd: ${JSON.stringify(root)}, env: process.env, shell: false, stdio: "inherit" }, { platform: "win32" }); while (!existsSync(${JSON.stringify(rootPidPath)}) || !existsSync(${JSON.stringify(leafPidPath)}) || !existsSync(${JSON.stringify(portPath)})) await new Promise((resolveWait) => setTimeout(resolveWait, 20)); writeFileSync(${JSON.stringify(guardianPidPath)}, String(child.pid)); process.exit(0);\n`,
      );

      let guardianPid;
      let rootPid;
      let leafPid;
      try {
        const worker = spawn(process.execPath, [workerScriptPath], {
          cwd: root,
          env: process.env,
          stdio: "ignore",
        });
        await new Promise((resolveClose, rejectClose) => {
          worker.once("error", rejectClose);
          worker.once("close", (code, signal) =>
            code === 0 && signal === null
              ? resolveClose()
              : rejectClose(new Error("O worker do Job Object falhou.")),
          );
        });
        guardianPid = Number(readFileSync(guardianPidPath, "utf8"));
        rootPid = Number(readFileSync(rootPidPath, "utf8"));
        leafPid = Number(readFileSync(leafPidPath, "utf8"));
        const port = Number(readFileSync(portPath, "utf8"));

        await waitFor(() =>
          [guardianPid, rootPid, leafPid].every((processId) => !processExists(processId)),
        );
        await assertPortCanBeRebound(port);
      } finally {
        for (const processId of [guardianPid, rootPid, leafPid]) {
          if (processId !== undefined && processExists(processId)) {
            process.kill(processId, "SIGKILL");
          }
        }
      }
    },
    15_000,
  );

  it("maps an unexpected clean exit to failure and signals every POSIX group", async () => {
    const cleanExit = fakeChild(707);
    const remainingApplication = fakeChild(808);
    const exitTarget = {};
    const signals = [];
    const timeouts = controlledTimeouts();
    const supervisor = superviseDevelopmentProcesses({
      children: [
        { child: cleanExit, name: "aplicação pública" },
        { child: remainingApplication, name: "backoffice" },
      ],
      exitTarget,
      platform: "linux",
      signalProcessGroup: (pid, signal) => {
        signals.push([pid, signal]);
        if (pid === -707 || signal === 0) {
          throw missingProcessGroup();
        }
      },
      signalSource: new EventEmitter(),
      writeError: () => {},
      ...timeouts,
    });

    closeChild(cleanExit, 0, null);

    expect(signals).toEqual([
      [-707, "SIGTERM"],
      [-808, "SIGTERM"],
    ]);
    expect(exitTarget.exitCode).toBe(1);
    closeChild(remainingApplication, null, "SIGTERM");
    await expect(supervisor.completion).resolves.toBe(1);
    expect(signals).toEqual([
      [-707, "SIGTERM"],
      [-808, "SIGTERM"],
      [-808, 0],
    ]);
  });

  it("allows code 0 only when the caller explicitly requests shutdown", async () => {
    const child = fakeChild(909);
    const exitTarget = {};
    const supervisor = superviseDevelopmentProcesses({
      children: [{ child, name: "serviço controlado" }],
      exitTarget,
      platform: "linux",
      signalProcessGroup: () => {
        throw missingProcessGroup();
      },
      signalSource: new EventEmitter(),
      writeError: () => {},
    });

    supervisor.beginShutdown("SIGTERM", 0);
    closeChild(child, 0, null);

    await expect(supervisor.completion).resolves.toBe(0);
    expect(exitTarget.exitCode).toBe(0);
  });

  it.runIf(process.platform !== "win32")(
    "returns failure and removes the other real POSIX tree after a natural code 0 exit",
    async () => {
      const root = mkdtempSync(resolve(tmpdir(), "set-livre-dev-tree-clean-exit-"));
      temporaryRoots.push(root);
      const releaseCleanExitPath = resolve(root, "release-clean-exit");
      const leafPidPath = resolve(root, "leaf.pid");
      const portPath = resolve(root, "leaf.port");
      const cleanScriptPath = resolve(root, "clean.cjs");
      const leafScriptPath = resolve(root, "leaf.cjs");
      const parentScriptPath = resolve(root, "parent.cjs");
      writeFileSync(
        cleanScriptPath,
        `const fs = require("node:fs"); const gate = ${JSON.stringify(releaseCleanExitPath)}; const timer = setInterval(() => { if (fs.existsSync(gate)) { clearInterval(timer); process.exit(0); } }, 10);\n`,
      );
      writeFileSync(
        leafScriptPath,
        `const fs = require("node:fs"); const { createServer } = require("node:net"); fs.writeFileSync(${JSON.stringify(leafPidPath)}, String(process.pid)); const server = createServer(); server.listen(0, "127.0.0.1", () => fs.writeFileSync(${JSON.stringify(portPath)}, String(server.address().port)));\n`,
      );
      writeFileSync(
        parentScriptPath,
        `const { spawn } = require("node:child_process"); spawn(process.execPath, [${JSON.stringify(leafScriptPath)}], { stdio: "ignore" }); setInterval(() => {}, 1000);\n`,
      );

      const cleanChild = spawn(process.execPath, [cleanScriptPath], {
        detached: true,
        stdio: "ignore",
      });
      const remainingChild = spawn(process.execPath, [parentScriptPath], {
        detached: true,
        stdio: "ignore",
      });
      let leafPid;
      let leafPort;
      try {
        const supervisor = superviseDevelopmentProcesses({
          children: [
            { child: cleanChild, name: "aplicação pública" },
            { child: remainingChild, name: "backoffice" },
          ],
          exitTarget: {},
          forceShutdownMilliseconds: 250,
          platform: process.platform,
          signalSource: new EventEmitter(),
          writeError: () => {},
        });
        await waitFor(() => existsSync(leafPidPath) && existsSync(portPath));
        leafPid = Number(readFileSync(leafPidPath, "utf8"));
        leafPort = Number(readFileSync(portPath, "utf8"));

        writeFileSync(releaseCleanExitPath, "exit", "utf8");

        await expect(supervisor.completion).resolves.toBe(1);
        await waitFor(() => !processExists(leafPid));
        await assertPortCanBeRebound(leafPort);
      } finally {
        for (const child of [cleanChild, remainingChild]) {
          if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              // A árvore já pode ter sido completamente encerrada pelo supervisor.
            }
          }
        }
        if (leafPid !== undefined && processExists(leafPid)) {
          process.kill(leafPid, "SIGKILL");
        }
      }
    },
    10_000,
  );

  it.runIf(process.platform !== "win32")(
    "handles SIGHUP across a detached POSIX process group without orphaning descendants",
    async () => {
      const root = mkdtempSync(resolve(tmpdir(), "set-livre-dev-tree-"));
      temporaryRoots.push(root);
      const parentPidPath = resolve(root, "parent.pid");
      const leafPidPath = resolve(root, "leaf.pid");
      const portPath = resolve(root, "leaf.port");
      const parentTerminatedPath = resolve(root, "parent.terminated");
      const leafTerminatedPath = resolve(root, "leaf.terminated");
      const leafScriptPath = resolve(root, "leaf.cjs");
      const parentScriptPath = resolve(root, "parent.cjs");
      writeFileSync(
        leafScriptPath,
        `const fs = require("node:fs"); const { createServer } = require("node:net"); fs.writeFileSync(${JSON.stringify(leafPidPath)}, String(process.pid)); const server = createServer(); server.listen(0, "127.0.0.1", () => fs.writeFileSync(${JSON.stringify(portPath)}, String(server.address().port))); process.on("SIGHUP", () => fs.writeFileSync(${JSON.stringify(leafTerminatedPath)}, "seen"));\n`,
      );
      writeFileSync(
        parentScriptPath,
        `const fs = require("node:fs"); const { spawn } = require("node:child_process"); fs.writeFileSync(${JSON.stringify(parentPidPath)}, String(process.pid)); spawn(process.execPath, [${JSON.stringify(leafScriptPath)}], { stdio: "ignore" }); process.on("SIGHUP", () => fs.writeFileSync(${JSON.stringify(parentTerminatedPath)}, "seen")); setInterval(() => {}, 1000);\n`,
      );

      const child = spawn(process.execPath, [parentScriptPath], {
        detached: true,
        stdio: "ignore",
      });
      const signalSource = new EventEmitter();
      let leafPid;
      let leafPort;
      try {
        const supervisor = superviseDevelopmentProcesses({
          children: [{ child, name: "aplicação pública" }],
          exitTarget: {},
          forceShutdownMilliseconds: 100,
          platform: process.platform,
          signalSource,
          writeError: () => {},
        });
        await waitFor(
          () => existsSync(parentPidPath) && existsSync(leafPidPath) && existsSync(portPath),
        );
        leafPid = Number(readFileSync(leafPidPath, "utf8"));
        leafPort = Number(readFileSync(portPath, "utf8"));

        signalSource.emit("SIGHUP");

        await expect(supervisor.completion).resolves.toBe(129);
        await waitFor(() => !processExists(leafPid));
        await assertPortCanBeRebound(leafPort);
        expect(readFileSync(parentTerminatedPath, "utf8")).toBe("seen");
        expect(readFileSync(leafTerminatedPath, "utf8")).toBe("seen");
      } finally {
        if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            // A árvore já pode ter sido completamente encerrada pelo supervisor.
          }
        }
        if (leafPid !== undefined && processExists(leafPid)) {
          process.kill(leafPid, "SIGKILL");
        }
      }
    },
    10_000,
  );

  it.runIf(process.platform !== "win32")(
    "retains the POSIX process group until a surviving descendant is forcefully removed",
    async () => {
      const root = mkdtempSync(resolve(tmpdir(), "set-livre-dev-tree-root-exit-"));
      temporaryRoots.push(root);
      const leafPidPath = resolve(root, "leaf.pid");
      const portPath = resolve(root, "leaf.port");
      const leafTerminatedPath = resolve(root, "leaf.terminated");
      const leafScriptPath = resolve(root, "leaf.cjs");
      const parentScriptPath = resolve(root, "parent.cjs");
      writeFileSync(
        leafScriptPath,
        `const fs = require("node:fs"); const { createServer } = require("node:net"); fs.writeFileSync(${JSON.stringify(leafPidPath)}, String(process.pid)); const server = createServer(); server.listen(0, "127.0.0.1", () => fs.writeFileSync(${JSON.stringify(portPath)}, String(server.address().port))); process.on("SIGTERM", () => fs.writeFileSync(${JSON.stringify(leafTerminatedPath)}, "seen"));\n`,
      );
      writeFileSync(
        parentScriptPath,
        `const { spawn } = require("node:child_process"); spawn(process.execPath, [${JSON.stringify(leafScriptPath)}], { stdio: "ignore" }); setInterval(() => {}, 1000);\n`,
      );

      const child = spawn(process.execPath, [parentScriptPath], {
        detached: true,
        stdio: "ignore",
      });
      const signalSource = new EventEmitter();
      let leafPid;
      let leafPort;
      try {
        const supervisor = superviseDevelopmentProcesses({
          children: [{ child, name: "aplicação pública" }],
          exitTarget: {},
          forceShutdownMilliseconds: 750,
          platform: process.platform,
          signalSource,
          writeError: () => {},
        });
        const rootClosed = new Promise((resolveClose) => child.once("close", resolveClose));
        let completionSettled = false;
        void supervisor.completion.then(() => {
          completionSettled = true;
        });
        await waitFor(() => existsSync(leafPidPath) && existsSync(portPath));
        leafPid = Number(readFileSync(leafPidPath, "utf8"));
        leafPort = Number(readFileSync(portPath, "utf8"));

        signalSource.emit("SIGTERM");

        await rootClosed;
        await waitFor(() => existsSync(leafTerminatedPath));
        await Promise.resolve();
        expect(child.signalCode).toBe("SIGTERM");
        expect(processExists(leafPid)).toBe(true);
        expect(completionSettled).toBe(false);

        await expect(supervisor.completion).resolves.toBe(143);
        await waitFor(() => !processExists(leafPid));
        await assertPortCanBeRebound(leafPort);
        expect(readFileSync(leafTerminatedPath, "utf8")).toBe("seen");
      } finally {
        if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            // A árvore já pode ter sido completamente encerrada pelo supervisor.
          }
        }
        if (leafPid !== undefined && processExists(leafPid)) {
          process.kill(leafPid, "SIGKILL");
        }
      }
    },
    10_000,
  );
});

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { superviseDevelopmentProcesses } from "../../scripts/development-process-tree.mjs";

const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function fakeChild(pid) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.kill = () => {
    throw new Error("O supervisor não deve sinalizar somente o processo raiz.");
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
  it("terminates every Windows tree during a normal launcher shutdown", async () => {
    const children = [fakeChild(101), fakeChild(202)];
    const exitTarget = {};
    const signalSource = new EventEmitter();
    const terminated = [];
    const timeouts = controlledTimeouts();
    const supervisor = superviseDevelopmentProcesses({
      children: [
        { child: children[0], name: "aplicação pública" },
        { child: children[1], name: "backoffice" },
      ],
      exitTarget,
      platform: "win32",
      signalSource,
      systemRoot: "C:\\Windows",
      terminateWindowsTree: (pid, options) => terminated.push({ options, pid }),
      ...timeouts,
    });

    signalSource.emit("SIGINT");

    expect(terminated).toEqual([
      { options: { systemRoot: "C:\\Windows" }, pid: 101 },
      { options: { systemRoot: "C:\\Windows" }, pid: 202 },
    ]);
    expect(timeouts.callbacks[0].timer.milliseconds).toBe(5_000);
    closeChild(children[0], null, "SIGKILL");
    closeChild(children[1], null, "SIGKILL");
    await expect(supervisor.completion).resolves.toBe(130);
    expect(exitTarget.exitCode).toBe(130);
    expect(timeouts.cleared).toEqual([timeouts.callbacks[0].timer]);
  });

  it("terminates the remaining Windows tree when either application fails", async () => {
    const failedApplication = fakeChild(303);
    const remainingApplication = fakeChild(404);
    const exitTarget = {};
    const terminated = [];
    const timeouts = controlledTimeouts();
    const supervisor = superviseDevelopmentProcesses({
      children: [
        { child: failedApplication, name: "aplicação pública" },
        { child: remainingApplication, name: "backoffice" },
      ],
      exitTarget,
      platform: "win32",
      signalSource: new EventEmitter(),
      systemRoot: "C:\\Windows",
      terminateWindowsTree: (pid) => terminated.push(pid),
      writeError: () => {},
      ...timeouts,
    });

    closeChild(failedApplication, 17, null);

    expect(terminated).toEqual([404]);
    closeChild(remainingApplication, null, "SIGKILL");
    await expect(supervisor.completion).resolves.toBe(17);
    expect(exitTarget.exitCode).toBe(17);
  });

  it.runIf(process.platform !== "win32")(
    "preserves POSIX process-group signaling and forcefully removes descendants",
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
        `const fs = require("node:fs"); const { createServer } = require("node:net"); fs.writeFileSync(${JSON.stringify(leafPidPath)}, String(process.pid)); const server = createServer(); server.listen(0, "127.0.0.1", () => fs.writeFileSync(${JSON.stringify(portPath)}, String(server.address().port))); process.on("SIGTERM", () => fs.writeFileSync(${JSON.stringify(leafTerminatedPath)}, "seen"));\n`,
      );
      writeFileSync(
        parentScriptPath,
        `const fs = require("node:fs"); const { spawn } = require("node:child_process"); fs.writeFileSync(${JSON.stringify(parentPidPath)}, String(process.pid)); spawn(process.execPath, [${JSON.stringify(leafScriptPath)}], { stdio: "ignore" }); process.on("SIGTERM", () => fs.writeFileSync(${JSON.stringify(parentTerminatedPath)}, "seen")); setInterval(() => {}, 1000);\n`,
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

        signalSource.emit("SIGTERM");

        await expect(supervisor.completion).resolves.toBe(143);
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

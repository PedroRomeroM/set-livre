import { describe, expect, it } from "vitest";

import { terminateWindowsProcessTree } from "../../scripts/windows-process-tree.mjs";

describe("Windows process tree termination", () => {
  it("invokes the absolute taskkill without a shell or inherited app environment", () => {
    const calls = [];

    terminateWindowsProcessTree(42_424, {
      runTaskkill: (command, argumentsList, options) => {
        calls.push({ argumentsList, command, options });
        return { error: undefined, signal: null, status: 0 };
      },
      systemRoot: "C:\\Windows",
    });

    expect(calls).toEqual([
      {
        argumentsList: ["/PID", "42424", "/T", "/F"],
        command: "C:\\Windows\\System32\\taskkill.exe",
        options: {
          env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" },
          killSignal: "SIGKILL",
          shell: false,
          stdio: "ignore",
          timeout: 5_000,
          windowsHide: true,
        },
      },
    ]);

    for (const systemRoot of [
      "\\\\attacker\\share",
      "Windows",
      "C:\\",
      " C:\\Windows",
      "C:\\Windows\0attacker",
    ]) {
      expect(() =>
        terminateWindowsProcessTree(42_424, {
          runTaskkill: () => ({ error: undefined, signal: null, status: 0 }),
          systemRoot,
        }),
      ).toThrow("não é confiável");
    }
  });

  it("bounds taskkill and treats a timeout or invalid PID as a termination failure", () => {
    let receivedOptions;
    const timedOut = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });

    expect(() =>
      terminateWindowsProcessTree(42_424, {
        runTaskkill: (_command, _argumentsList, options) => {
          receivedOptions = options;
          return { error: timedOut, signal: "SIGKILL", status: null };
        },
        systemRoot: "C:\\Windows",
      }),
    ).toThrow("A árvore de processos não pôde ser encerrada no Windows.");
    expect(receivedOptions).toMatchObject({
      killSignal: "SIGKILL",
      timeout: 5_000,
    });
    expect(() => terminateWindowsProcessTree(0, { systemRoot: "C:\\Windows" })).toThrow(
      "PID da árvore de processos é inválido",
    );
  });
});

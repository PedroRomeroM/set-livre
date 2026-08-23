import { dirname, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { canonicalDockerCliPath } from "../../scripts/docker-local-context.mjs";
import {
  canonicalSupabaseNativeCliPath,
  executeSupabaseLocalCommand,
  resolveTrustedSupabaseNativeCli,
} from "../../scripts/supabase-command-executor.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");

function pathInformation({ directory = false, file = false, ino = 1 } = {}) {
  return {
    dev: 7,
    ino,
    isDirectory: () => directory,
    isFile: () => file,
    isSymbolicLink: () => false,
    mode: directory ? 0o40755 : 0o100755,
  };
}

function virtualWindowsInstallation({ nativeVersion = "2.115.0" } = {}) {
  const root = String.raw`C:\repository`;
  const executable = canonicalSupabaseNativeCliPath({
    architecture: "x64",
    platform: "win32",
    root,
  });
  const files = new Map([
    [
      String.raw`C:\repository\package.json`,
      JSON.stringify({ devDependencies: { supabase: "2.115.0" } }),
    ],
    [
      String.raw`C:\repository\node_modules\supabase\package.json`,
      JSON.stringify({
        name: "supabase",
        optionalDependencies: { "@supabase/cli-windows-x64": "2.115.0" },
        version: "2.115.0",
      }),
    ],
    [
      String.raw`C:\repository\node_modules\@supabase\cli-windows-x64\package.json`,
      JSON.stringify({
        cpu: ["x64"],
        name: "@supabase/cli-windows-x64",
        os: ["win32"],
        version: nativeVersion,
      }),
    ],
    [executable, undefined],
  ]);
  const fileInformation = new Map(
    [...files.keys()].map((path, index) => [
      path,
      pathInformation({ file: true, ino: index + 20 }),
    ]),
  );
  const descriptors = new Map();
  let nextDescriptor = 100;
  const assertWindowsIntegrity = vi.fn();
  const closeFile = vi.fn((descriptor) => descriptors.delete(descriptor));
  const inspectDescriptor = vi.fn((descriptor) => fileInformation.get(descriptors.get(descriptor)));
  const inspectPath = vi.fn((path) =>
    files.has(path) ? fileInformation.get(path) : pathInformation({ directory: true, ino: 3 }),
  );
  const openFile = vi.fn((path) => {
    if (!files.has(path)) {
      throw new Error("missing virtual file");
    }
    const descriptor = nextDescriptor;
    nextDescriptor += 1;
    descriptors.set(descriptor, path);
    return descriptor;
  });
  const readFile = vi.fn((descriptor) => files.get(descriptors.get(descriptor)));

  return {
    assertWindowsIntegrity,
    closeFile,
    executable,
    inspectDescriptor,
    inspectPath,
    openFile,
    readFile,
    root,
  };
}

describe("Supabase local command executor", () => {
  it("resolves the exact native package binary after physical and manifest validation", () => {
    const installation = virtualWindowsInstallation();

    expect(
      resolveTrustedSupabaseNativeCli({
        ...installation,
        architecture: "x64",
        platform: "win32",
      }),
    ).toBe(installation.executable);
    expect(installation.openFile).toHaveBeenCalledTimes(4);
    expect(installation.openFile).toHaveBeenLastCalledWith(
      String.raw`C:\repository\node_modules\@supabase\cli-windows-x64\bin\supabase.exe`,
      expect.any(Number),
    );
    expect(installation.assertWindowsIntegrity).toHaveBeenCalledTimes(4);
    expect(installation.closeFile).toHaveBeenCalledTimes(4);
  });

  it("rejects native package version drift before accepting its executable", () => {
    const installation = virtualWindowsInstallation({ nativeVersion: "2.112.0" });

    expect(() =>
      resolveTrustedSupabaseNativeCli({
        ...installation,
        architecture: "x64",
        platform: "win32",
      }),
    ).toThrow("diverge de plataforma, CPU ou versão");
    expect(installation.openFile).not.toHaveBeenCalledWith(
      installation.executable,
      expect.any(Number),
    );
  });

  it("executes only the validated native binary with direct arguments and a closed environment", () => {
    let invocation;
    const command = canonicalSupabaseNativeCliPath({
      architecture: "x64",
      platform: "win32",
    });
    const environment = {
      ComSpec: String.raw`C:\attacker\cmd.exe`,
      docker_host: "npipe:////./pipe/dockerDesktopLinuxEngine",
      nOdE_oPtIoNs: String.raw`--require=C:\attacker\loader.cjs`,
      node_path: String.raw`C:\attacker\modules`,
      Path: String.raw`C:\attacker;C:\Windows\System32`,
      supabase_cli_binary_override: String.raw`C:\attacker\supabase.exe`,
      SUPABASE_SERVICE_ROLE_KEY: "must-not-cross",
      UserProfile: String.raw`C:\Users\qa`,
    };

    const output = executeSupabaseLocalCommand(["status", "--output", "env"], {
      architecture: "x64",
      capture: true,
      environment,
      executeCommand: (executedCommand, argumentsList, options) => {
        invocation = { argumentsList, command: executedCommand, options };
        return "captured output";
      },
      platform: "win32",
      resolveCli: () => command,
      resolveDockerCli: () => canonicalDockerCliPath("win32"),
    });

    expect(output).toBe("captured output");
    expect(invocation).toMatchObject({
      argumentsList: [
        "--workdir",
        repositoryRoot,
        "status",
        "--output",
        "env",
        "--network-id",
        "set-livre-loopback",
      ],
      command,
      options: {
        cwd: dirname(canonicalDockerCliPath("win32")),
        encoding: "utf8",
        env: {
          DOCKER_HOST: "npipe:////./pipe/dockerDesktopLinuxEngine",
          PATH: dirname(canonicalDockerCliPath("win32")),
          USERPROFILE: String.raw`C:\Users\qa`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    });
    expect(invocation.command).not.toBe(process.execPath);
    expect(JSON.stringify(invocation)).not.toMatch(
      /attacker|SERVICE_ROLE|SUPABASE_CLI_BINARY_OVERRIDE|dist[\\/]supabase\.js/u,
    );
    expect(environment.supabase_cli_binary_override).toContain("supabase.exe");
  });

  it("refuses a resolver result that is not the canonical package executable", () => {
    let calls = 0;
    expect(() =>
      executeSupabaseLocalCommand(["status"], {
        architecture: "x64",
        executeCommand: () => {
          calls += 1;
        },
        platform: "win32",
        resolveCli: () => String.raw`C:\attacker\supabase.exe`,
      }),
    ).toThrow("falhou sem diagnóstico público");
    expect(calls).toBe(0);
  });

  it("keeps only exact allowlisted names in the closed Linux environment", () => {
    const command = canonicalSupabaseNativeCliPath({
      architecture: "x64",
      platform: "linux",
    });
    let childEnvironment;

    executeSupabaseLocalCommand(["status"], {
      architecture: "x64",
      environment: {
        DOCKER_HOST: "unix:///var/run/docker.sock",
        HOME: "/home/qa",
        PATH: "/attacker:/usr/bin",
        home: "/attacker",
      },
      executeCommand: (_command, _argumentsList, options) => {
        childEnvironment = options.env;
        return "";
      },
      platform: "linux",
      resolveCli: () => command,
      resolveDockerCli: () => canonicalDockerCliPath("linux"),
    });

    expect(childEnvironment).toEqual({
      DOCKER_HOST: "unix:///var/run/docker.sock",
      HOME: "/home/qa",
      PATH: dirname(canonicalDockerCliPath("linux")),
    });
  });

  it("rethrows captured failures without original buffers, cause or secrets", () => {
    const secret = "service-role-secret-that-must-not-escape";
    const originalError = Object.assign(new Error(`command failed: ${secret}`), {
      command: `supabase status ${secret}`,
      status: 23,
      stderr: Buffer.from(`stderr=${secret}`),
      stdout: Buffer.from(`SERVICE_ROLE_KEY=${secret}`),
    });
    const command = canonicalSupabaseNativeCliPath();

    let failure;
    try {
      executeSupabaseLocalCommand(["status", "--output", "env"], {
        capture: true,
        executeCommand: () => {
          throw originalError;
        },
        resolveCli: () => command,
        resolveDockerCli: () => canonicalDockerCliPath(process.platform),
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBe(originalError);
    expect(failure.message).toBe("O comando Supabase local falhou com código 23.");
    expect(failure).not.toHaveProperty("cause");
    expect(failure).not.toHaveProperty("stdout");
    expect(failure).not.toHaveProperty("stderr");
    expect(String(failure.stack)).not.toContain(secret);
  });

  it("always captures stderr while preserving inherited stdout for interactive output", () => {
    const secret = "stderr-secret-that-must-not-be-printed";
    const command = canonicalSupabaseNativeCliPath();
    let invocation;

    expect(() =>
      executeSupabaseLocalCommand(["test", "db", "--local"], {
        capture: false,
        executeCommand: (executedCommand, argumentsList, options) => {
          invocation = { argumentsList, command: executedCommand, options };
          throw Object.assign(new Error("command failed"), {
            status: 19,
            stderr: Buffer.from(secret),
          });
        },
        resolveCli: () => command,
        resolveDockerCli: () => canonicalDockerCliPath(process.platform),
      }),
    ).toThrow("O comando Supabase local falhou com código 19.");
    expect(invocation).toMatchObject({
      argumentsList: [
        "--workdir",
        repositoryRoot,
        "test",
        "db",
        "--local",
        "--network-id",
        "set-livre-loopback",
      ],
      command,
      options: { stdio: ["ignore", "inherit", "pipe"] },
    });
    expect(JSON.stringify(invocation)).not.toContain(secret);
  });

  it("reports only a safe signal or generic diagnosis for other failures", () => {
    const command = canonicalSupabaseNativeCliPath();
    for (const [originalError, expectedMessage] of [
      [
        Object.assign(new Error("secret signal output"), { signal: "SIGTERM", stderr: "secret" }),
        "O comando Supabase local falhou com sinal SIGTERM.",
      ],
      [
        new Error("database-password-and-service-role-key"),
        "O comando Supabase local falhou sem diagnóstico público.",
      ],
    ]) {
      expect(() =>
        executeSupabaseLocalCommand(["start"], {
          capture: true,
          executeCommand: () => {
            throw originalError;
          },
          resolveCli: () => command,
          resolveDockerCli: () => canonicalDockerCliPath(process.platform),
        }),
      ).toThrow(expectedMessage);
    }
  });
});

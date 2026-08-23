import { readFileSync } from "node:fs";
import { posix, resolve, win32 } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  assertLocalDockerContext,
  assertLocalDockerDaemon,
  assertLocalDockerEngineInspection,
  assertLocalDockerEnvironment,
  canonicalDockerCliPath,
  localDockerDaemonEndpoint,
  resolveTrustedDockerCli,
} from "../../scripts/docker-local-context.mjs";

const supabaseLocalCommand = resolve(
  import.meta.dirname,
  "../../scripts/supabase-local-command.mjs",
);

function safeInspection(platform = "linux", contextName = "default") {
  return {
    Endpoints: { docker: { Host: localDockerDaemonEndpoint(platform, contextName) } },
    Name: contextName,
  };
}

function contextExecutor({
  activeContext = "default",
  engineInspection = { OSType: "linux" },
  inspection = safeInspection(),
} = {}) {
  const calls = [];
  const environments = [];
  const executeDocker = (command, argumentsList, options) => {
    calls.push([command, argumentsList]);
    environments.push(options.env);
    if (argumentsList[1] === "show") {
      return `${activeContext}\n`;
    }
    if (argumentsList[0] === "info") {
      return JSON.stringify(engineInspection);
    }
    return JSON.stringify(inspection);
  };
  return { calls, environments, executeDocker };
}

function assertDaemon(options = {}) {
  const platform = options.platform ?? process.platform;
  return assertLocalDockerDaemon({
    ...options,
    resolveDockerCli: options.resolveDockerCli ?? (() => canonicalDockerCliPath(platform)),
  });
}

function pathInformation({
  directory = false,
  file = false,
  ino = 1,
  mode = directory ? 0o40755 : 0o100755,
  symbolicLink = false,
  uid = 0,
} = {}) {
  return {
    dev: 1,
    ino,
    isDirectory: () => directory,
    isFile: () => file,
    isSymbolicLink: () => symbolicLink,
    mode,
    uid,
  };
}

function trustedDockerFilesystem(platform, overrides = new Map()) {
  const executable = canonicalDockerCliPath(platform);
  const pathApi = platform === "win32" ? win32 : posix;
  const pathCalls = [];
  const fileInformation = pathInformation({ file: true, ino: 91 });
  const inspectPath = (path) => {
    pathCalls.push(path);
    const overridden = overrides.get(path);
    if (overridden !== undefined) {
      return overridden;
    }
    return path === executable ? fileInformation : pathInformation({ directory: true });
  };
  return {
    closeFile: vi.fn(),
    executable,
    inspectDescriptor: vi.fn(() => fileInformation),
    inspectPath,
    openFile: vi.fn(() => 19),
    pathApi,
    pathCalls,
  };
}

describe("local Docker daemon guard", () => {
  it("resolves the physical Windows Docker Desktop CLI and validates its owner/DACL chain", () => {
    const filesystem = trustedDockerFilesystem("win32");
    const assertWindowsIntegrity = vi.fn();

    expect(
      resolveTrustedDockerCli({
        ...filesystem,
        assertWindowsIntegrity,
        platform: "win32",
      }),
    ).toBe(String.raw`C:\Program Files\Docker\Docker\resources\bin\docker.exe`);
    expect(new Set(filesystem.pathCalls)).toEqual(
      new Set([
        "C:\\",
        String.raw`C:\Program Files`,
        String.raw`C:\Program Files\Docker`,
        String.raw`C:\Program Files\Docker\Docker`,
        String.raw`C:\Program Files\Docker\Docker\resources`,
        String.raw`C:\Program Files\Docker\Docker\resources\bin`,
        String.raw`C:\Program Files\Docker\Docker\resources\bin\docker.exe`,
      ]),
    );
    expect(assertWindowsIntegrity).toHaveBeenCalledWith(filesystem.executable, {
      systemRoot: String.raw`C:\Windows`,
      trustedRoot: String.raw`C:\Program Files`,
    });
    expect(filesystem.closeFile).toHaveBeenCalledWith(19);
  });

  it("resolves only the root-owned, non-writable physical Linux CLI contract", () => {
    const filesystem = trustedDockerFilesystem("linux");
    const assertWindowsIntegrity = vi.fn();

    expect(
      resolveTrustedDockerCli({
        ...filesystem,
        assertWindowsIntegrity,
        platform: "linux",
      }),
    ).toBe("/usr/bin/docker");
    expect(new Set(filesystem.pathCalls)).toEqual(
      new Set(["/", "/usr", "/usr/bin", "/usr/bin/docker"]),
    );
    expect(assertWindowsIntegrity).not.toHaveBeenCalled();

    for (const unsafeInformation of [
      pathInformation({ directory: true, mode: 0o40777 }),
      pathInformation({ directory: true, uid: 1000 }),
      pathInformation({ symbolicLink: true }),
    ]) {
      const unsafeFilesystem = trustedDockerFilesystem(
        "linux",
        new Map([["/usr/bin", unsafeInformation]]),
      );
      expect(() => resolveTrustedDockerCli({ ...unsafeFilesystem, platform: "linux" })).toThrow();
      expect(unsafeFilesystem.openFile).not.toHaveBeenCalled();
    }
  });

  it("fails before Docker execution when Windows owner/DACL integrity is not proven", () => {
    const filesystem = trustedDockerFilesystem("win32");
    let dockerCalls = 0;

    expect(() =>
      assertLocalDockerDaemon({
        environment: {},
        executeDocker: () => {
          dockerCalls += 1;
          return "";
        },
        platform: "win32",
        resolveDockerCli: () =>
          resolveTrustedDockerCli({
            ...filesystem,
            assertWindowsIntegrity: () => {
              throw new Error("untrusted-dacl");
            },
            platform: "win32",
          }),
      }),
    ).toThrow("untrusted-dacl");
    expect(dockerCalls).toBe(0);
  });

  it("accepts and pins the documented default local context without mutating the input", () => {
    const environment = {
      DOCKER_CONTEXT: "default",
      DOCKER_HOST: "unix:///var/run/docker.sock",
      PATH: "/usr/bin",
    };
    const { calls, environments, executeDocker } = contextExecutor();

    const commandEnvironment = assertDaemon({
      environment,
      executeDocker,
      platform: "linux",
    });

    expect(calls).toEqual([
      ["/usr/bin/docker", ["context", "show"]],
      ["/usr/bin/docker", ["context", "inspect", "default", "--format", "{{json .}}"]],
      ["/usr/bin/docker", ["info", "--format", "{{json .}}"]],
    ]);
    expect(environments).toHaveLength(3);
    for (const inspectionEnvironment of environments.slice(0, 2)) {
      expect(inspectionEnvironment.DOCKER_CONTEXT).toBe("default");
      expect(inspectionEnvironment).not.toHaveProperty("DOCKER_HOST");
    }
    expect(environments[2]).toMatchObject({
      DOCKER_HOST: "unix:///var/run/docker.sock",
    });
    expect(environments.every((environment) => !("PATH" in environment))).toBe(true);
    expect(environments[2]).not.toHaveProperty("DOCKER_CONTEXT");
    expect(commandEnvironment).toMatchObject({
      DOCKER_HOST: "unix:///var/run/docker.sock",
    });
    expect(commandEnvironment).not.toHaveProperty("PATH");
    expect(commandEnvironment).not.toHaveProperty("DOCKER_CONTEXT");
    expect(environment.DOCKER_HOST).toBe("unix:///var/run/docker.sock");
  });

  it("rejects remote or non-default shell overrides before invoking Docker", () => {
    for (const environment of [
      { DOCKER_HOST: "tcp://docker.example.com:2376" },
      { DOCKER_HOST: "ssh://operator@docker.example.com" },
      { DOCKER_HOST: "unix:///tmp/unapproved-docker.sock" },
      { DOCKER_CONTEXT: "production" },
    ]) {
      let calls = 0;
      expect(() =>
        assertDaemon({
          environment,
          executeDocker: () => {
            calls += 1;
            return "";
          },
          platform: "linux",
        }),
      ).toThrow();
      expect(calls).toBe(0);
    }
  });

  it("rejects a non-default active context before inspecting its endpoint", () => {
    const { calls, executeDocker } = contextExecutor({ activeContext: "remote-production" });

    expect(() => assertDaemon({ environment: {}, executeDocker, platform: "linux" })).toThrow(
      "contexto Docker ativo",
    );
    expect(calls).toEqual([["/usr/bin/docker", ["context", "show"]]]);
  });

  it("rejects a default context whose configured daemon endpoint is not local", () => {
    for (const inspection of [
      { ...safeInspection(), Endpoints: { docker: { Host: "tcp://docker.example.com:2376" } } },
      { ...safeInspection(), Endpoints: { docker: { Host: "ssh://operator@docker.example.com" } } },
      { ...safeInspection(), Endpoints: { docker: { Host: "unix:///tmp/other.sock" } } },
      { ...safeInspection(), Name: "production" },
    ]) {
      expect(() => assertLocalDockerContext("default", inspection, "linux")).toThrow();
    }
  });

  it("recognizes both Windows Linux-engine named-pipe contracts", () => {
    expect(() =>
      assertLocalDockerEnvironment(
        {
          DOCKER_CONTEXT: "default",
          DOCKER_HOST: "npipe:////./pipe/docker_engine",
        },
        "win32",
      ),
    ).not.toThrow();
    expect(() =>
      assertLocalDockerContext("default", safeInspection("win32"), "win32"),
    ).not.toThrow();

    expect(() =>
      assertLocalDockerEnvironment(
        {
          DOCKER_CONTEXT: "desktop-linux",
          DOCKER_HOST: "npipe:////./pipe/dockerDesktopLinuxEngine",
        },
        "win32",
      ),
    ).not.toThrow();
    expect(() =>
      assertLocalDockerContext("desktop-linux", safeInspection("win32", "desktop-linux"), "win32"),
    ).not.toThrow();
  });

  it("accepts desktop-linux only when Docker Desktop reports a Linux engine", () => {
    const { calls, executeDocker } = contextExecutor({
      activeContext: "desktop-linux",
      inspection: safeInspection("win32", "desktop-linux"),
    });
    const commandEnvironment = assertDaemon({
      environment: { DOCKER_CONTEXT: "desktop-linux" },
      executeDocker,
      platform: "win32",
    });

    expect(calls).toEqual([
      [String.raw`C:\Program Files\Docker\Docker\resources\bin\docker.exe`, ["context", "show"]],
      [
        String.raw`C:\Program Files\Docker\Docker\resources\bin\docker.exe`,
        ["context", "inspect", "desktop-linux", "--format", "{{json .}}"],
      ],
      [
        String.raw`C:\Program Files\Docker\Docker\resources\bin\docker.exe`,
        ["info", "--format", "{{json .}}"],
      ],
    ]);
    expect(commandEnvironment.DOCKER_HOST).toBe("npipe:////./pipe/dockerDesktopLinuxEngine");
    expect(commandEnvironment).not.toHaveProperty("DOCKER_CONTEXT");
  });

  it("rejects Windows context/pipe mismatches and Windows-container engines", () => {
    expect(() =>
      assertLocalDockerEnvironment(
        {
          DOCKER_CONTEXT: "default",
          DOCKER_HOST: "npipe:////./pipe/dockerDesktopLinuxEngine",
        },
        "win32",
      ),
    ).toThrow("contratos locais diferentes");
    expect(() => assertLocalDockerEngineInspection({ OSType: "windows" })).toThrow(
      "containers Linux",
    );

    const { executeDocker } = contextExecutor({
      engineInspection: { OSType: "windows" },
      inspection: safeInspection("win32"),
    });
    expect(() => assertDaemon({ environment: {}, executeDocker, platform: "win32" })).toThrow(
      "containers Linux",
    );
  });

  it("ignores a hostile PATH and resolves the trusted CLI before the first Docker inspection", () => {
    const events = [];
    const { calls, executeDocker } = contextExecutor({
      activeContext: "desktop-linux",
      inspection: safeInspection("win32", "desktop-linux"),
    });

    assertLocalDockerDaemon({
      environment: { PATH: String.raw`C:\attacker;C:\Windows\System32` },
      executeDocker: (...argumentsList) => {
        events.push("execute");
        return executeDocker(...argumentsList);
      },
      platform: "win32",
      resolveDockerCli: () => {
        events.push("resolve");
        return canonicalDockerCliPath("win32");
      },
    });

    expect(events[0]).toBe("resolve");
    expect(calls).toHaveLength(3);
    expect(calls.every(([command]) => win32.isAbsolute(command))).toBe(true);
    expect(calls.every(([command]) => command === canonicalDockerCliPath("win32"))).toBe(true);
    expect(calls.some(([command]) => command === "docker")).toBe(false);
  });

  it("keeps the Supabase wrapper bound to the validated absolute Docker executable", () => {
    const source = readFileSync(supabaseLocalCommand, "utf8");

    expect(source).toContain("resolveTrustedDockerCli()");
    expect(source).toContain("canonicalDockerCliPath()");
    expect(source).not.toMatch(/execFileSync\(["']docker["']/u);
  });
});

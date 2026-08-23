import { readFileSync } from "node:fs";
import { posix, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { canonicalDockerCliPath } from "../../scripts/docker-local-context.mjs";

import {
  assertLoopbackContainerInspections,
  assertLoopbackNetworkInspection,
  assertSupabaseLoopbackBindings,
  assertWindowsDockerDesktopLocalPortBinding,
  assertWindowsDockerDesktopSettingsPayload,
  describeSupabaseLocalPublication,
  ensureSupabaseLoopbackNetwork,
  supabaseProjectContainersAreRunning,
  supabaseLocalNetworkName,
} from "../../scripts/supabase-local-network.mjs";

const safeNetworkInspection = [
  {
    Driver: "bridge",
    Internal: false,
    Name: supabaseLocalNetworkName,
    Options: { "com.docker.network.bridge.host_binding_ipv4": "127.0.0.1" },
    Scope: "local",
  },
];

const safeContainerInspections = [
  containerInspection("supabase_kong_set-livre", "8000/tcp", "54321"),
  containerInspection("supabase_db_set-livre", "5432/tcp", "54322"),
  containerInspection("supabase_studio_set-livre", "3000/tcp", "54323"),
  containerInspection("supabase_inbucket_set-livre", "8025/tcp", "54324"),
];

const safeWindowsEnvironment = {
  APPDATA: "C:\\Users\\qa\\AppData\\Roaming",
  USERPROFILE: "C:\\Users\\qa",
};
const safeWindowsSettings = '{"PortBindingBehavior":"local-only-port-binding"}';

function windowsSettingsReader(payload = safeWindowsSettings) {
  const information = {
    dev: 7,
    ino: 11,
    isFile: () => true,
    isSymbolicLink: () => false,
    size: Buffer.byteLength(payload),
  };
  return {
    assertPhysicalPath: vi.fn(),
    closeFile: vi.fn(),
    inspectDescriptor: vi.fn(() => information),
    inspectPath: vi.fn(() => information),
    openFile: vi.fn(() => 42),
    platform: "win32",
    readFile: vi.fn(() => payload),
  };
}

function windowsOperationSettings(payload = safeWindowsSettings) {
  const reader = windowsSettingsReader(payload);
  return {
    assertWindowsDockerSettingsPath: reader.assertPhysicalPath,
    closeDockerSettingsFile: reader.closeFile,
    inspectDockerSettingsDescriptor: reader.inspectDescriptor,
    inspectDockerSettingsPath: reader.inspectPath,
    openDockerSettingsFile: reader.openFile,
    readDockerSettingsFile: reader.readFile,
  };
}

function containerInspection(name, containerPort, hostPort, hostIp = "127.0.0.1") {
  const bindings = Array.isArray(hostIp)
    ? hostIp.map((candidate) => ({ HostIp: candidate, HostPort: hostPort }))
    : [{ HostIp: hostIp, HostPort: hostPort }];
  return {
    Config: {
      Labels: { "com.supabase.cli.project": "set-livre" },
    },
    HostConfig: {
      PortBindings: { [containerPort]: [{ HostIp: "", HostPort: hostPort }] },
    },
    Name: `/${name}`,
    NetworkSettings: {
      Networks: { [supabaseLocalNetworkName]: {} },
      Ports: { [containerPort]: bindings },
    },
  };
}

describe("Supabase local loopback contract", () => {
  it("uses the canonical absolute Docker CLI before every network inspection", () => {
    const events = [];
    const calls = [];
    const executeDocker = vi.fn((command, argumentsList) => {
      events.push("execute");
      calls.push([command, argumentsList]);
      if (argumentsList[1] === "ls") {
        return `${supabaseLocalNetworkName}\n`;
      }
      return JSON.stringify(safeNetworkInspection);
    });

    ensureSupabaseLoopbackNetwork(
      { PATH: "/tmp/hostile:/usr/bin" },
      {
        executeDocker,
        platform: "linux",
        resolveDockerCli: () => {
          events.push("resolve");
          return canonicalDockerCliPath("linux");
        },
      },
    );

    expect(events[0]).toBe("resolve");
    expect(calls).toEqual([
      [
        "/usr/bin/docker",
        [
          "network",
          "ls",
          "--filter",
          `name=^${supabaseLocalNetworkName}$`,
          "--format",
          "{{.Name}}",
        ],
      ],
      ["/usr/bin/docker", ["network", "inspect", supabaseLocalNetworkName]],
    ]);
    expect(calls.every(([command]) => posix.isAbsolute(command))).toBe(true);
    expect(calls.some(([command]) => command === "docker")).toBe(false);
  });

  it("uses the same trusted path for project discovery and container inspection", () => {
    const calls = [];
    const options = {
      executeDocker: vi.fn((command, argumentsList) => {
        calls.push([command, argumentsList]);
        return argumentsList[0] === "ps"
          ? "container-a\ncontainer-b\n"
          : JSON.stringify(safeContainerInspections);
      }),
      platform: "linux",
      resolveDockerCli: () => canonicalDockerCliPath("linux"),
    };

    expect(supabaseProjectContainersAreRunning({ PATH: "/tmp/hostile" }, options)).toBe(true);
    assertSupabaseLoopbackBindings({ PATH: "/tmp/hostile" }, options);

    expect(calls).toHaveLength(3);
    expect(calls.every(([command]) => command === "/usr/bin/docker")).toBe(true);
    expect(calls.map(([, argumentsList]) => argumentsList[0])).toEqual(["ps", "ps", "inspect"]);
  });

  it("rejects a non-canonical resolver before any Docker command", () => {
    const executeDocker = vi.fn();

    expect(() =>
      ensureSupabaseLoopbackNetwork(
        {},
        {
          executeDocker,
          platform: "linux",
          resolveDockerCli: () => "/tmp/docker",
        },
      ),
    ).toThrow("caminho canônico permitido");
    expect(executeDocker).not.toHaveBeenCalled();
  });

  it("reports the official Docker Desktop localhost boundary without weakening Linux", () => {
    expect(describeSupabaseLocalPublication("win32")).toContain(
      "port binding oficial do Docker Desktop",
    );
    expect(describeSupabaseLocalPublication("linux")).toBe("restrita a 127.0.0.1");
  });

  it("accepts only the supported Docker Desktop Localhost only setting", () => {
    expect(() => assertWindowsDockerDesktopSettingsPayload(safeWindowsSettings)).not.toThrow();
    for (const unsafe of [
      "{}",
      '{"PortBindingBehavior":"default-port-binding"}',
      '{"PortBindingBehavior":"default-local-port-binding"}',
      '{"PortBindingBehavior":"local-only-port-binding","PortBindingBehavior":"default-port-binding"}',
      "not-json",
    ]) {
      expect(() => assertWindowsDockerDesktopSettingsPayload(unsafe)).toThrow();
    }
  });

  it("reads the physical Docker Desktop setting from the canonical Windows profile", () => {
    const reader = windowsSettingsReader();
    expect(() =>
      assertWindowsDockerDesktopLocalPortBinding(safeWindowsEnvironment, reader),
    ).not.toThrow();
    expect(reader.assertPhysicalPath).toHaveBeenCalledWith(
      "C:\\Users\\qa\\AppData\\Roaming\\Docker\\settings-store.json",
      {
        description: "A configuração do Docker Desktop",
        leafKind: "file",
      },
    );
    expect(reader.openFile).toHaveBeenCalledOnce();
    expect(reader.readFile).toHaveBeenCalledWith(42, "utf8");
    expect(reader.closeFile).toHaveBeenCalledWith(42);
  });

  it("rejects redirected Windows profiles and settings that change during inspection", () => {
    expect(() =>
      assertWindowsDockerDesktopLocalPortBinding(
        { ...safeWindowsEnvironment, APPDATA: "C:\\Temp" },
        windowsSettingsReader(),
      ),
    ).toThrow("APPDATA não corresponde");

    const changed = windowsSettingsReader();
    const initialInformation = changed.inspectPath();
    changed.inspectPath.mockClear();
    changed.inspectPath
      .mockReturnValueOnce(initialInformation)
      .mockReturnValueOnce({ ...initialInformation, ino: 12 });
    expect(() =>
      assertWindowsDockerDesktopLocalPortBinding(safeWindowsEnvironment, changed),
    ).toThrow("mudou durante a validação");
  });

  it.each([
    ["antes do start", ensureSupabaseLoopbackNetwork],
    ["na validação pós-start", assertSupabaseLoopbackBindings],
  ])("fails closed %s when Docker Desktop is not localhost-only", (_phase, operation) => {
    const executeDocker = vi.fn();

    expect(() =>
      operation(safeWindowsEnvironment, {
        executeDocker,
        platform: "win32",
        resolveDockerCli: () => canonicalDockerCliPath("win32"),
        ...windowsOperationSettings('{"PortBindingBehavior":"default-port-binding"}'),
      }),
    ).toThrow("Localhost only");
    expect(executeDocker).not.toHaveBeenCalled();
  });

  it("does not retain the retired firewall workaround", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../../scripts/supabase-local-network.mjs"),
      "utf8",
    );

    expect(source).toContain("settings.PortBindingBehavior !== windowsDockerPortBindingBehavior");
    expect(source).not.toContain("Get-NetFirewallRule");
    expect(source).not.toContain("SetLivre-SupabaseLocal-Block-LAN");
    expect(source).not.toContain("ExecutionPolicy");
  });

  it("accepts the dedicated bridge and exact local port matrix", () => {
    expect(() => assertLoopbackNetworkInspection(safeNetworkInspection)).not.toThrow();
    expect(() => assertLoopbackContainerInspections(safeContainerInspections)).not.toThrow();
  });

  it("rejects UDP and an internal-port swap even when host ports are unchanged", () => {
    const udp = [
      containerInspection("supabase_kong_set-livre", "8000/udp", "54321"),
      ...safeContainerInspections.slice(1),
    ];
    expect(() => assertLoopbackContainerInspections(udp)).toThrow("matriz exata");

    const swapped = [
      containerInspection("supabase_kong_set-livre", "5432/tcp", "54321"),
      containerInspection("supabase_db_set-livre", "8000/tcp", "54322"),
      ...safeContainerInspections.slice(2),
    ];
    expect(() => assertLoopbackContainerInspections(swapped)).toThrow("matriz exata");
  });

  it("rejects duplicate, extra, missing, and service-divergent publications", () => {
    const duplicateHostPort = structuredClone(safeContainerInspections);
    duplicateHostPort[2].NetworkSettings.Ports["3000/tcp"][0].HostPort = "54322";
    duplicateHostPort[2].HostConfig.PortBindings["3000/tcp"][0].HostPort = "54322";
    expect(() => assertLoopbackContainerInspections(duplicateHostPort)).toThrow("matriz exata");

    const extra = structuredClone(safeContainerInspections);
    extra[0].NetworkSettings.Ports["8443/tcp"] = [{ HostIp: "127.0.0.1", HostPort: "54325" }];
    extra[0].HostConfig.PortBindings["8443/tcp"] = [{ HostIp: "", HostPort: "54325" }];
    expect(() => assertLoopbackContainerInspections(extra)).toThrow("matriz exata");

    expect(() => assertLoopbackContainerInspections(safeContainerInspections.slice(0, 3))).toThrow(
      "matriz local completa",
    );

    const divergentService = structuredClone(safeContainerInspections);
    divergentService[2].Name = "/supabase_pg_meta_set-livre";
    expect(() => assertLoopbackContainerInspections(divergentService)).toThrow("matriz exata");
  });

  it.each(["0.0.0.0", "::", "[::]"])("rejects a published port bound to %s", (hostIp) => {
    const unsafe = [
      ...safeContainerInspections.slice(0, 3),
      containerInspection("supabase_inbucket_set-livre", "8025/tcp", "54324", hostIp),
    ];

    expect(() => assertLoopbackContainerInspections(unsafe)).toThrow("contrato local permitido");
  });

  it("accepts the exact localhost-only pair only for canonical Windows Docker Desktop", () => {
    const desktop = safeContainerInspections.map((inspection) => {
      const [[containerPort, bindings]] = Object.entries(inspection.NetworkSettings.Ports);
      return {
        ...inspection,
        NetworkSettings: {
          ...inspection.NetworkSettings,
          Ports: {
            [containerPort]: [
              { HostIp: "127.0.0.1", HostPort: bindings[0].HostPort },
              { HostIp: "::", HostPort: bindings[0].HostPort },
            ],
          },
        },
      };
    });

    expect(() =>
      assertLoopbackContainerInspections(desktop, {
        platform: "win32",
        windowsDockerDesktop: true,
      }),
    ).not.toThrow();
    expect(() =>
      assertLoopbackContainerInspections(desktop, {
        platform: "win32",
        windowsDockerDesktop: false,
      }),
    ).toThrow("contrato local permitido");
    expect(() =>
      assertLoopbackContainerInspections(desktop, {
        platform: "linux",
        windowsDockerDesktop: true,
      }),
    ).toThrow("contrato local permitido");
  });

  it("rejects a partial localhost pair or a HostConfig that requests a public address", () => {
    const partial = [
      ...safeContainerInspections.slice(0, 3),
      containerInspection("supabase_inbucket_set-livre", "8025/tcp", "54324", ["::"]),
    ];
    expect(() =>
      assertLoopbackContainerInspections(partial, {
        platform: "win32",
        windowsDockerDesktop: true,
      }),
    ).toThrow("contrato local permitido");

    const explicitPublic = structuredClone(partial);
    explicitPublic[3].NetworkSettings.Ports["8025/tcp"] = [
      { HostIp: "127.0.0.1", HostPort: "54324" },
      { HostIp: "::", HostPort: "54324" },
    ];
    explicitPublic[3].HostConfig.PortBindings["8025/tcp"][0].HostIp = "0.0.0.0";
    expect(() =>
      assertLoopbackContainerInspections(explicitPublic, {
        platform: "win32",
        windowsDockerDesktop: true,
      }),
    ).toThrow("contrato local permitido");
  });

  it("rejects a mixed literal and Docker Desktop localhost-only publication matrix", () => {
    const mixed = structuredClone(safeContainerInspections);
    mixed[3].NetworkSettings.Ports["8025/tcp"] = [
      { HostIp: "127.0.0.1", HostPort: "54324" },
      { HostIp: "::", HostPort: "54324" },
    ];

    expect(() =>
      assertLoopbackContainerInspections(mixed, {
        platform: "win32",
        windowsDockerDesktop: true,
      }),
    ).toThrow("misturou modos");
  });

  it("rejects a pre-existing bridge with an unsafe default bind", () => {
    const unsafe = [
      {
        ...safeNetworkInspection[0],
        Options: { "com.docker.network.bridge.host_binding_ipv4": "0.0.0.0" },
      },
    ];

    expect(() => assertLoopbackNetworkInspection(unsafe)).toThrow("configuração insegura");
  });
});

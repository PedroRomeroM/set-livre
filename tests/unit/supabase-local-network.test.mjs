import { describe, expect, it } from "vitest";

import {
  assertLoopbackContainerInspections,
  assertLoopbackNetworkInspection,
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

function containerInspection(name, containerPort, hostPort, hostIp = "127.0.0.1") {
  return {
    Name: name,
    NetworkSettings: {
      Networks: { [supabaseLocalNetworkName]: {} },
      Ports: { [containerPort]: [{ HostIp: hostIp, HostPort: hostPort }] },
    },
  };
}

describe("Supabase local loopback contract", () => {
  it("accepts the dedicated bridge and exact local port matrix", () => {
    expect(() => assertLoopbackNetworkInspection(safeNetworkInspection)).not.toThrow();
    expect(() => assertLoopbackContainerInspections(safeContainerInspections)).not.toThrow();
  });

  it.each(["0.0.0.0", "::", "[::]"])("rejects a published port bound to %s", (hostIp) => {
    const unsafe = [
      ...safeContainerInspections.slice(0, 3),
      containerInspection("supabase_inbucket_set-livre", "8025/tcp", "54324", hostIp),
    ];

    expect(() => assertLoopbackContainerInspections(unsafe)).toThrow("fora do loopback IPv4");
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

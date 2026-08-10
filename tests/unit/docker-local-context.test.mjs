import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertLocalDockerContext,
  assertLocalDockerDaemon,
  assertLocalDockerEnvironment,
  localDockerDaemonEndpoint,
} from "../../scripts/docker-local-context.mjs";

const localSetup = resolve(import.meta.dirname, "../../scripts/local-setup.mjs");
const supabaseLocalCommand = resolve(
  import.meta.dirname,
  "../../scripts/supabase-local-command.mjs",
);

function safeInspection(platform = "linux") {
  return {
    Endpoints: { docker: { Host: localDockerDaemonEndpoint(platform) } },
    Name: "default",
  };
}

function contextExecutor({ activeContext = "default", inspection = safeInspection() } = {}) {
  const calls = [];
  const environments = [];
  const executeDocker = (command, argumentsList, options) => {
    calls.push([command, argumentsList]);
    environments.push(options.env);
    if (argumentsList[1] === "show") {
      return `${activeContext}\n`;
    }
    return JSON.stringify(inspection);
  };
  return { calls, environments, executeDocker };
}

describe("local Docker daemon guard", () => {
  it("accepts and pins the documented default local context without mutating the input", () => {
    const environment = {
      DOCKER_CONTEXT: "default",
      DOCKER_HOST: "unix:///var/run/docker.sock",
      PATH: "/usr/bin",
    };
    const { calls, environments, executeDocker } = contextExecutor();

    const commandEnvironment = assertLocalDockerDaemon({
      environment,
      executeDocker,
      platform: "linux",
    });

    expect(calls).toEqual([
      ["docker", ["context", "show"]],
      ["docker", ["context", "inspect", "default", "--format", "{{json .}}"]],
    ]);
    expect(environments).toHaveLength(2);
    for (const inspectionEnvironment of environments) {
      expect(inspectionEnvironment).not.toHaveProperty("DOCKER_CONTEXT");
      expect(inspectionEnvironment).not.toHaveProperty("DOCKER_HOST");
    }
    expect(commandEnvironment).toMatchObject({
      DOCKER_HOST: "unix:///var/run/docker.sock",
      PATH: "/usr/bin",
    });
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
        assertLocalDockerDaemon({
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

    expect(() =>
      assertLocalDockerDaemon({ environment: {}, executeDocker, platform: "linux" }),
    ).toThrow("contexto Docker ativo");
    expect(calls).toEqual([["docker", ["context", "show"]]]);
  });

  it("rejects a default context whose configured daemon endpoint is not local", () => {
    for (const inspection of [
      { ...safeInspection(), Endpoints: { docker: { Host: "tcp://docker.example.com:2376" } } },
      { ...safeInspection(), Endpoints: { docker: { Host: "ssh://operator@docker.example.com" } } },
      { ...safeInspection(), Endpoints: { docker: { Host: "unix:///tmp/other.sock" } } },
      { ...safeInspection(), Name: "production" },
    ]) {
      expect(() => assertLocalDockerContext("default", inspection, "linux")).toThrow(
        "daemon local documentado",
      );
    }
  });

  it("recognizes the Windows default named-pipe contract", () => {
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
  });

  it("makes local-setup fail before Docker when a remote host is exported", () => {
    const result = spawnSync(process.execPath, [localSetup], {
      encoding: "utf8",
      env: {
        ...process.env,
        DOCKER_CONTEXT: "",
        DOCKER_HOST: "ssh://operator@docker.example.com",
      },
      timeout: 5_000,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("DOCKER_HOST");
    expect(result.stderr).not.toContain("operator@docker.example.com");
  });

  it.runIf(process.platform !== "win32")(
    "makes the stop wrapper reject a remote host before invoking Docker or Supabase",
    () => {
      const temporaryRoot = mkdtempSync(resolve(tmpdir(), "set-livre-docker-guard-"));
      const invocationSentinel = resolve(temporaryRoot, "cli-invoked");
      const fakeCli = `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(
        invocationSentinel,
      )}, process.argv.join(" "));\n`;

      try {
        for (const executable of ["docker", "supabase"]) {
          const executablePath = resolve(temporaryRoot, executable);
          writeFileSync(executablePath, fakeCli, { mode: 0o700 });
          chmodSync(executablePath, 0o700);
        }

        const result = spawnSync(process.execPath, [supabaseLocalCommand, "stop"], {
          encoding: "utf8",
          env: {
            ...process.env,
            DOCKER_CONTEXT: "",
            DOCKER_HOST: "ssh://operator@docker.example.com",
            PATH: `${temporaryRoot}${delimiter}${process.env.PATH ?? ""}`,
          },
          timeout: 5_000,
        });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("DOCKER_HOST");
        expect(result.stderr).not.toContain("operator@docker.example.com");
        expect(existsSync(invocationSentinel)).toBe(false);
      } finally {
        rmSync(temporaryRoot, { force: true, recursive: true });
      }
    },
  );
});

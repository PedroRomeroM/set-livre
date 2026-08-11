import { describe, expect, it } from "vitest";

import { executeSupabaseLocalCommand } from "../../scripts/supabase-command-executor.mjs";

describe("Supabase local command executor", () => {
  it("captures a successful command with the dedicated local network", () => {
    let invocation;
    const environment = { DOCKER_HOST: "unix:///var/run/docker.sock", PATH: "/usr/bin" };
    const output = executeSupabaseLocalCommand(["status", "--output", "env"], {
      capture: true,
      environment,
      executeCommand: (argumentsList, options) => {
        invocation = { argumentsList, options };
        return "captured output";
      },
    });

    expect(output).toBe("captured output");
    expect(invocation).toMatchObject({
      argumentsList: ["status", "--output", "env", "--network-id", "set-livre-loopback"],
      options: { encoding: "utf8", env: environment, stdio: ["ignore", "pipe", "pipe"] },
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

    let failure;
    try {
      executeSupabaseLocalCommand(["status", "--output", "env"], {
        capture: true,
        executeCommand: () => {
          throw originalError;
        },
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
    let invocation;

    expect(() =>
      executeSupabaseLocalCommand(["test", "db", "--local"], {
        capture: false,
        executeCommand: (argumentsList, options) => {
          invocation = { argumentsList, options };
          throw Object.assign(new Error("command failed"), {
            status: 19,
            stderr: Buffer.from(secret),
          });
        },
      }),
    ).toThrow("O comando Supabase local falhou com código 19.");
    expect(invocation).toMatchObject({
      argumentsList: ["test", "db", "--local", "--network-id", "set-livre-loopback"],
      options: { stdio: ["ignore", "inherit", "pipe"] },
    });
    expect(JSON.stringify(invocation)).not.toContain(secret);
  });

  it("reports only a safe signal or generic diagnosis for other failures", () => {
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
        }),
      ).toThrow(expectedMessage);
    }
  });
});

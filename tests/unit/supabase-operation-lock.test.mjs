import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, resolve, win32 } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { acquireSupabaseOperationLock } from "../../scripts/supabase-operation-lock.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const lockModulePath = resolve(repositoryRoot, "scripts/supabase-operation-lock.mjs");
const lockModuleUrl = pathToFileURL(lockModulePath).href;
const localSetup = resolve(repositoryRoot, "scripts/local-setup.mjs");
const supabaseLocalCommand = resolve(repositoryRoot, "scripts/supabase-local-command.mjs");
const processIntegrationTestTimeout = process.platform === "win32" ? 20_000 : 5_000;
const holderSource = `
import { acquireSupabaseOperationLock } from ${JSON.stringify(lockModuleUrl)};
const lock = await acquireSupabaseOperationLock();
process.stdout.write(JSON.stringify({ guardianPid: lock.guardianPid, pid: process.pid }) + "\\n");
await new Promise((resolvePromise, rejectPromise) => {
  process.stdin.on("end", resolvePromise);
  process.stdin.on("error", rejectPromise);
  process.stdin.resume();
});
await lock.release();
`;
const activeHolders = new Set();

function windowsTaskkillPath() {
  const systemRoot = Object.entries(process.env).find(
    ([name]) => name.toUpperCase() === "SYSTEMROOT",
  )?.[1];
  if (typeof systemRoot !== "string" || systemRoot === "") {
    throw new Error("SystemRoot ausente no teste Windows.");
  }
  return win32.resolve(systemRoot, "System32/taskkill.exe");
}

function waitForClose(child, timeoutMilliseconds = 15_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new Error("Processo de teste não encerrou no prazo esperado."));
    }, timeoutMilliseconds);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal });
    });
  });
}

function waitForHolderHandshake(child) {
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  return new Promise((resolvePromise, rejectPromise) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      rejectPromise(new Error("Holder não adquiriu o lock no prazo esperado."));
    }, 15_000);
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const lineEnd = stdout.indexOf("\n");
      if (lineEnd === -1) {
        return;
      }
      clearTimeout(timer);
      try {
        resolvePromise(JSON.parse(stdout.slice(0, lineEnd)));
      } catch {
        rejectPromise(new Error(`Handshake inválido do holder: ${stderr}`));
      }
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      rejectPromise(
        new Error(`Holder encerrou antes do handshake: code=${code} signal=${signal} ${stderr}`),
      );
    });
  });
}

async function startHolder() {
  const child = spawn(process.execPath, ["--input-type=module", "-e", holderSource], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      SET_LIVRE_LOCK_TEST_SECRET: "must-not-reach-the-native-helper",
    },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  activeHolders.add(child);
  child.once("close", () => activeHolders.delete(child));
  const handshake = await waitForHolderHandshake(child);
  return { child, handshake };
}

function killProcessTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (process.platform === "win32") {
    execFileSync(windowsTaskkillPath(), ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } else {
    child.kill("SIGKILL");
  }
}

afterEach(async () => {
  const holders = [...activeHolders];
  for (const holder of holders) {
    try {
      killProcessTree(holder);
    } catch {
      // A corrida aceitável aqui é o processo já ter encerrado entre a inspeção e o kill.
    }
  }
  await Promise.allSettled(holders.map((holder) => waitForClose(holder)));
});

describe("host-global Supabase operation lock", () => {
  it("fails fast while another native owner holds the host-global lock", async () => {
    const { child } = await startHolder();

    await expect(acquireSupabaseOperationLock()).rejects.toThrow(
      "Outra operação administrativa do Supabase local já está em andamento neste host.",
    );

    child.stdin.end();
    await expect(waitForClose(child)).resolves.toMatchObject({ code: 0, signal: null });
  }, 30_000);

  it("releases normally and permits the next native owner", async () => {
    const first = await acquireSupabaseOperationLock();
    await first.release();
    await first.release();

    const second = await acquireSupabaseOperationLock();
    await second.release();
  }, 30_000);

  it("recovers after the native owner is killed without a stale-file heuristic", async () => {
    const { child, handshake } = await startHolder();

    if (process.platform === "win32") {
      expect(handshake.guardianPid).toBeTypeOf("number");
      execFileSync(windowsTaskkillPath(), ["/PID", String(handshake.guardianPid), "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      await expect(waitForClose(child)).resolves.toMatchObject({ code: 70 });
    } else {
      expect(handshake.guardianPid).toBeUndefined();
      child.kill("SIGKILL");
      await expect(waitForClose(child)).resolves.toMatchObject({ signal: "SIGKILL" });
    }

    const recovered = await acquireSupabaseOperationLock();
    await recovered.release();
  }, 30_000);

  it("blocks both administrative wrappers before hostile Docker input can be inspected", async () => {
    const { child } = await startHolder();
    const hostileEnvironment = {
      ...process.env,
      DOCKER_HOST: "tcp://production.invalid:2375",
      SUPABASE_ACCESS_TOKEN: "must-not-appear-in-diagnostics",
    };

    for (const [script, argumentsList] of [
      ["scripts/local-setup.mjs", []],
      ["scripts/supabase-local-command.mjs", ["status"]],
    ]) {
      const result = spawnSync(
        process.execPath,
        [resolve(repositoryRoot, script), ...argumentsList],
        {
          cwd: repositoryRoot,
          encoding: "utf8",
          env: hostileEnvironment,
          shell: false,
          timeout: 15_000,
          windowsHide: true,
        },
      );
      const diagnostics = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      expect(result.status).not.toBe(0);
      expect(result.error).toBeUndefined();
      expect(diagnostics).toContain(
        "Outra operação administrativa do Supabase local já está em andamento neste host.",
      );
      expect(diagnostics).not.toContain("production.invalid");
      expect(diagnostics).not.toContain("must-not-appear-in-diagnostics");
    }

    child.stdin.end();
    await expect(waitForClose(child)).resolves.toMatchObject({ code: 0, signal: null });
  }, 45_000);

  it(
    "rejects a remote Docker host before local-setup invokes Docker",
    () => {
      const result = spawnSync(process.execPath, [localSetup], {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          DOCKER_CONTEXT: "",
          DOCKER_HOST: "ssh://operator@docker.example.com",
        },
        shell: false,
        timeout: processIntegrationTestTimeout,
        windowsHide: true,
      });

      expect(result.status).not.toBe(0);
      expect(result.error).toBeUndefined();
      expect(result.stderr).toContain("DOCKER_HOST");
      expect(result.stderr).not.toContain("operator@docker.example.com");
    },
    processIntegrationTestTimeout,
  );

  it.runIf(process.platform !== "win32")(
    "rejects a remote Docker host before the stop wrapper invokes Docker or Supabase",
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
          cwd: repositoryRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            DOCKER_CONTEXT: "",
            DOCKER_HOST: "ssh://operator@docker.example.com",
            PATH: `${temporaryRoot}${delimiter}${process.env.PATH ?? ""}`,
          },
          shell: false,
          timeout: 5_000,
        });

        expect(result.status).not.toBe(0);
        expect(result.error).toBeUndefined();
        expect(result.stderr).toContain("DOCKER_HOST");
        expect(result.stderr).not.toContain("operator@docker.example.com");
        expect(existsSync(invocationSentinel)).toBe(false);
      } finally {
        rmSync(temporaryRoot, { force: true, recursive: true });
      }
    },
  );

  it("pins the supported native primitives and forbids policy bypass or lockfile deletion", () => {
    const source = readFileSync(lockModulePath, "utf8");

    expect(source).toContain('const windowsMutexName = "SetLivre.SupabaseLocal.v1";');
    expect(source).toContain('const posixFlockExecutable = "/usr/bin/flock";');
    expect(source).toContain('const posixLockPath = "/tmp/set-livre-supabase-local-v1.lock";');
    expect(source).toContain("[System.Threading.AbandonedMutexException]");
    expect(source).toContain("[Console]::In.ReadToEnd() | Out-Null");
    expect(source).toContain('stdio: ["ignore", "pipe", "pipe", descriptor]');
    expect(source).not.toMatch(/ExecutionPolicy|Bypass/u);
    expect(source).not.toMatch(/(?:rm|unlink)Sync\(posixLockPath/u);
  });
});

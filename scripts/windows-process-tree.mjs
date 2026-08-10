import { spawnSync } from "node:child_process";
import { win32 } from "node:path";

const windowsTaskkillTimeoutMilliseconds = 5_000;

function validatedWindowsSystemRoot(systemRoot) {
  if (
    typeof systemRoot !== "string" ||
    systemRoot.length === 0 ||
    systemRoot.includes("\0") ||
    systemRoot.trim() !== systemRoot
  ) {
    throw new Error("O diretório de sistema do Windows não é confiável.");
  }

  const normalizedRoot = win32.normalize(systemRoot);
  const parsedRoot = win32.parse(normalizedRoot).root;
  if (!/^[A-Za-z]:\\$/u.test(parsedRoot) || normalizedRoot === parsedRoot) {
    throw new Error("O diretório de sistema do Windows não é confiável.");
  }

  return normalizedRoot.replace(/[\\/]+$/u, "");
}

export function terminateWindowsProcessTree(
  pid,
  { runTaskkill = spawnSync, systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT } = {},
) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("O PID da árvore de processos é inválido.");
  }

  const trustedSystemRoot = validatedWindowsSystemRoot(systemRoot);
  const result = runTaskkill(
    win32.join(trustedSystemRoot, "System32", "taskkill.exe"),
    ["/PID", String(pid), "/T", "/F"],
    {
      env: {
        SystemRoot: trustedSystemRoot,
        WINDIR: trustedSystemRoot,
      },
      killSignal: "SIGKILL",
      shell: false,
      stdio: "ignore",
      timeout: windowsTaskkillTimeoutMilliseconds,
      windowsHide: true,
    },
  );

  if (result.error !== undefined || result.signal !== null || result.status !== 0) {
    throw new Error("A árvore de processos não pôde ser encerrada no Windows.");
  }
}

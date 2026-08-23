import { spawn, spawnSync } from "node:child_process";
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync } from "node:fs";
import { win32 } from "node:path";

import { assertWindowsTrustedPathIntegrity } from "./trusted-npm-cli.mjs";

const lockConflictExitCode = 73;
const lockHelperFailureExitCode = 74;
const lockHandshakeTimeoutMilliseconds = 10_000;
const lockReleaseTimeoutMilliseconds = 10_000;
const posixFlockExecutable = "/usr/bin/flock";
const posixLockPath = "/tmp/set-livre-supabase-local-v1.lock";
const windowsMutexName = "SetLivre.SupabaseLocal.v1";
const windowsSystemRoot = String.raw`C:\Windows`;
const windowsPowerShellExecutable = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;

const windowsMutexHelperScript = String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$mutex = $null
$ownsMutex = $false
$recoveredAbandonedMutex = $false

try {
  if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) {
    throw 'unsupported Windows PowerShell version'
  }
  $createdNew = $false
  $mutex = New-Object System.Threading.Mutex($false, '${windowsMutexName}', [ref]$createdNew)
  try {
    $ownsMutex = $mutex.WaitOne(0)
  } catch [System.Threading.AbandonedMutexException] {
    $ownsMutex = $true
    $recoveredAbandonedMutex = $true
  }

  if (-not $ownsMutex) {
    [Console]::Out.WriteLine('busy')
    [Console]::Out.Flush()
    exit ${lockConflictExitCode}
  }

  if ($recoveredAbandonedMutex) {
    [Console]::Out.WriteLine('acquired-recovered')
  } else {
    [Console]::Out.WriteLine('acquired')
  }
  [Console]::Out.Flush()
  [Console]::In.ReadToEnd() | Out-Null
} catch {
  [Console]::Error.Write('mutex helper failed')
  exit ${lockHelperFailureExitCode}
} finally {
  if ($ownsMutex -and $null -ne $mutex) {
    try {
      $mutex.ReleaseMutex()
    } catch [System.ApplicationException] {
      # O kernel já liberou a posse; o helper ainda encerra sem expor detalhes.
    }
  }
  if ($null -ne $mutex) {
    $mutex.Dispose()
  }
}
`;

function operationInProgressError() {
  return new Error(
    "Outra operação administrativa do Supabase local já está em andamento neste host.",
  );
}

function lockAcquisitionError() {
  return new Error("Não foi possível adquirir a exclusão host-global do Supabase local.");
}

function lockReleaseError() {
  return new Error(
    "Não foi possível comprovar a liberação da exclusão host-global do Supabase local.",
  );
}

function createLockHandle({ guardianPid, recoveredAfterCrash = false, release }) {
  let releasePromise;
  const releaseOnce = () => {
    releasePromise ??= Promise.resolve().then(release);
    return releasePromise;
  };

  return Object.freeze({
    guardianPid,
    recoveredAfterCrash,
    release: releaseOnce,
    [Symbol.asyncDispose]: releaseOnce,
  });
}

function samePhysicalFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertTrustedPosixFlock() {
  const information = lstatSync(posixFlockExecutable, { throwIfNoEntry: false });
  if (
    information === undefined ||
    !information.isFile() ||
    information.isSymbolicLink() ||
    information.uid !== 0 ||
    (information.mode & 0o022) !== 0
  ) {
    throw lockAcquisitionError();
  }
}

function acquirePosixLock() {
  assertTrustedPosixFlock();

  let descriptor;
  try {
    descriptor = openSync(
      posixLockPath,
      constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const descriptorInformation = fstatSync(descriptor);
    const pathInformation = lstatSync(posixLockPath, { throwIfNoEntry: false });
    if (
      !descriptorInformation.isFile() ||
      descriptorInformation.uid !== process.getuid() ||
      pathInformation === undefined ||
      !pathInformation.isFile() ||
      pathInformation.isSymbolicLink() ||
      !samePhysicalFile(descriptorInformation, pathInformation)
    ) {
      throw lockAcquisitionError();
    }
    fchmodSync(descriptor, 0o600);

    const result = spawnSync(
      posixFlockExecutable,
      ["--exclusive", "--nonblock", "--conflict-exit-code", String(lockConflictExitCode), "3"],
      {
        encoding: "utf8",
        env: { LANG: "C", LC_ALL: "C" },
        shell: false,
        stdio: ["ignore", "pipe", "pipe", descriptor],
      },
    );
    if (result.status === lockConflictExitCode) {
      throw operationInProgressError();
    }
    if (result.error !== undefined || result.signal !== null || result.status !== 0) {
      throw lockAcquisitionError();
    }

    const heldDescriptor = descriptor;
    descriptor = undefined;
    return createLockHandle({
      release: () => {
        closeSync(heldDescriptor);
      },
    });
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function resolveTrustedWindowsPowerShell() {
  if (
    !win32.isAbsolute(windowsPowerShellExecutable) ||
    win32.resolve(windowsPowerShellExecutable) !== windowsPowerShellExecutable ||
    win32.resolve(windowsSystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe") !==
      windowsPowerShellExecutable
  ) {
    throw lockAcquisitionError();
  }
  const information = lstatSync(windowsPowerShellExecutable, { throwIfNoEntry: false });
  if (information === undefined || !information.isFile() || information.isSymbolicLink()) {
    throw lockAcquisitionError();
  }
  assertWindowsTrustedPathIntegrity(windowsPowerShellExecutable, {
    systemRoot: windowsSystemRoot,
    trustedRoot: windowsSystemRoot,
  });
  return windowsPowerShellExecutable;
}

function acquireWindowsLock() {
  const executable = resolveTrustedWindowsPowerShell();
  const encodedCommand = Buffer.from(windowsMutexHelperScript, "utf16le").toString("base64");

  return new Promise((resolve, reject) => {
    const child = spawn(
      executable,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand],
      {
        env: { SystemRoot: windowsSystemRoot, WINDIR: windowsSystemRoot },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    child.stdin.on("error", () => {});
    child.stderr.resume();
    child.stdout.setEncoding("utf8");

    let acquired = false;
    let handshakeBuffer = "";
    let releaseRequested = false;
    let settled = false;
    const closed = new Promise((closeResolve) => {
      child.once("close", (code, signal) => closeResolve({ code, signal }));
    });

    const rejectAcquisition = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(handshakeTimer);
      child.stdin.end();
      reject(error);
    };

    const handshakeTimer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectAcquisition(lockAcquisitionError());
    }, lockHandshakeTimeoutMilliseconds);

    child.once("error", () => {
      rejectAcquisition(lockAcquisitionError());
    });

    child.stdout.on("data", (chunk) => {
      if (settled) {
        return;
      }
      handshakeBuffer += chunk;
      if (handshakeBuffer.length > 64) {
        child.kill("SIGKILL");
        rejectAcquisition(lockAcquisitionError());
        return;
      }
      const lineEnd = handshakeBuffer.indexOf("\n");
      if (lineEnd === -1) {
        return;
      }
      const handshake = handshakeBuffer.slice(0, lineEnd).trim();
      if (handshake === "busy") {
        rejectAcquisition(operationInProgressError());
        return;
      }
      if (handshake !== "acquired" && handshake !== "acquired-recovered") {
        child.kill("SIGKILL");
        rejectAcquisition(lockAcquisitionError());
        return;
      }

      settled = true;
      acquired = true;
      clearTimeout(handshakeTimer);
      const recoveredAfterCrash = handshake === "acquired-recovered";
      const release = async () => {
        releaseRequested = true;
        child.stdin.end();
        let releaseTimer;
        try {
          const outcome = await Promise.race([
            closed,
            new Promise((_, timeoutReject) => {
              releaseTimer = setTimeout(() => {
                child.kill("SIGKILL");
                timeoutReject(lockReleaseError());
              }, lockReleaseTimeoutMilliseconds);
            }),
          ]);
          if (outcome.code !== 0 || outcome.signal !== null) {
            throw lockReleaseError();
          }
        } finally {
          clearTimeout(releaseTimer);
        }
      };
      resolve(
        createLockHandle({
          guardianPid: child.pid,
          recoveredAfterCrash,
          release,
        }),
      );
    });

    closed.then(({ code }) => {
      if (!acquired) {
        if (code === lockConflictExitCode && handshakeBuffer.trim() === "busy") {
          rejectAcquisition(operationInProgressError());
        } else {
          rejectAcquisition(lockAcquisitionError());
        }
        return;
      }
      if (!releaseRequested) {
        process.stderr.write(
          "O guardião da exclusão host-global do Supabase local encerrou inesperadamente.\n",
        );
        process.exit(70);
      }
    });
  });
}

export async function acquireSupabaseOperationLock({ platform = process.platform } = {}) {
  if (platform === "win32") {
    return acquireWindowsLock();
  }
  if (platform === "linux") {
    return acquirePosixLock();
  }
  throw new Error("A exclusão host-global do Supabase local só suporta Windows e Linux.");
}

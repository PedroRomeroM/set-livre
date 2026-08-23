import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { resolve, win32 } from "node:path";

import { assertWindowsTrustedPathIntegrity } from "./trusted-npm-cli.mjs";
import {
  assertWindowsPathWithoutReparse,
  assertWindowsPrivateFile,
  protectWindowsPrivateFile,
} from "./windows-filesystem-security.mjs";

const defaultGuardianSourcePath = resolve(import.meta.dirname, "windows-job-object-guardian.cs");
const defaultRepositoryRoot = resolve(import.meta.dirname, "..");
const defaultSupervisorSourcePath = import.meta.filename;
const guardianControlArgument = "--control-fd=3";
const signalExitCodes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

function isMissingProcessError(error) {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}

function assertPhysicalRegularFile(path, label) {
  const information = lstatSync(path, { throwIfNoEntry: false });
  if (information === undefined || !information.isFile() || information.isSymbolicLink()) {
    throw new Error(`${label} precisa ser um arquivo físico regular.`);
  }
}

function resolveCanonicalWindowsRoot(value, label) {
  if (
    typeof value !== "string" ||
    value === "" ||
    value.includes("\0") ||
    !win32.isAbsolute(value) ||
    win32.resolve(value) !== value
  ) {
    throw new Error(`${label} precisa ser um caminho Windows local absoluto canônico.`);
  }
  return value;
}

function compilerEnvironment(inheritedEnvironment, systemRoot) {
  const environment = { SystemRoot: systemRoot, WINDIR: systemRoot };
  for (const name of ["TEMP", "TMP"]) {
    const value = inheritedEnvironment[name];
    if (typeof value === "string" && value !== "" && !value.includes("\0")) {
      environment[name] = value;
    }
  }
  return environment;
}

function removeCandidate(path) {
  const information = lstatSync(path, { throwIfNoEntry: false });
  if (information === undefined) {
    return;
  }
  if (!information.isFile() || information.isSymbolicLink()) {
    throw new Error("O candidato compilado do guardian deixou de ser um arquivo físico regular.");
  }
  unlinkSync(path);
}

function ensurePhysicalWindowsDirectory(path, assertWindowsPath) {
  const information = lstatSync(path, { throwIfNoEntry: false });
  if (information === undefined) {
    try {
      mkdirSync(path);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
        throw error;
      }
    }
  }
  assertWindowsPath(path, {
    description: "O diretório de cache do guardian",
    leafKind: "directory",
  });
}

function resolveWindowsJobObjectGuardian({
  assertPrivateFile = assertWindowsPrivateFile,
  assertTrustedPath = assertWindowsTrustedPathIntegrity,
  assertWindowsPath = assertWindowsPathWithoutReparse,
  cacheRoot,
  compile = spawnSync,
  guardianSourcePath = defaultGuardianSourcePath,
  inheritedEnvironment = process.env,
  protectPrivateFile = protectWindowsPrivateFile,
  repositoryRoot = defaultRepositoryRoot,
  supervisorSourcePath = defaultSupervisorSourcePath,
  systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT,
} = {}) {
  const trustedSystemRoot = resolveCanonicalWindowsRoot(systemRoot, "SystemRoot");
  const trustedRepositoryRoot = resolveCanonicalWindowsRoot(
    repositoryRoot,
    "A raiz do repositório",
  );
  const trustedSourcePath = resolveCanonicalWindowsRoot(guardianSourcePath, "A fonte do guardian");
  const trustedSupervisorPath = resolveCanonicalWindowsRoot(
    supervisorSourcePath,
    "A fonte do supervisor",
  );
  const localApplicationData = resolveCanonicalWindowsRoot(
    cacheRoot ?? process.env.LOCALAPPDATA,
    "O cache local do guardian",
  );
  const compilerPath = win32.resolve(
    trustedSystemRoot,
    "Microsoft.NET/Framework64/v4.0.30319/csc.exe",
  );

  assertPhysicalRegularFile(compilerPath, "O compilador C# do Windows");
  assertPhysicalRegularFile(trustedSourcePath, "A fonte versionada do guardian");
  assertPhysicalRegularFile(trustedSupervisorPath, "A fonte versionada do supervisor");
  assertTrustedPath(compilerPath, {
    systemRoot: trustedSystemRoot,
    trustedRoot: trustedSystemRoot,
  });
  assertTrustedPath(trustedSourcePath, {
    systemRoot: trustedSystemRoot,
    trustedRoot: trustedRepositoryRoot,
  });
  assertTrustedPath(trustedSupervisorPath, {
    systemRoot: trustedSystemRoot,
    trustedRoot: trustedRepositoryRoot,
  });

  const sourceBefore = readFileSync(trustedSourcePath);
  const supervisorBefore = readFileSync(trustedSupervisorPath);
  const compilerBefore = readFileSync(compilerPath);
  const version = createHash("sha256")
    .update("set-livre-windows-job-object-guardian\0")
    .update(sourceBefore)
    .update("\0node-supervisor\0")
    .update(supervisorBefore)
    .update("\0microsoft-csharp-compiler\0")
    .update(compilerBefore)
    .digest("hex");
  const guardianRoot = win32.resolve(localApplicationData, "SetLivre/windows-job-object-guardian");
  const setLivreCacheRoot = win32.dirname(guardianRoot);
  const versionRoot = win32.resolve(guardianRoot, version);
  const executablePath = win32.resolve(versionRoot, "set-livre-job-object-guardian.exe");

  ensurePhysicalWindowsDirectory(localApplicationData, assertWindowsPath);
  ensurePhysicalWindowsDirectory(setLivreCacheRoot, assertWindowsPath);
  ensurePhysicalWindowsDirectory(guardianRoot, assertWindowsPath);
  ensurePhysicalWindowsDirectory(versionRoot, assertWindowsPath);
  assertWindowsPath(guardianRoot, {
    description: "O cache do guardian",
    leafKind: "directory",
    recursive: true,
  });
  const existing = lstatSync(executablePath, { throwIfNoEntry: false });
  if (existing === undefined) {
    const candidatePath = win32.resolve(
      versionRoot,
      `.set-livre-job-object-guardian-${process.pid}-${randomUUID()}.exe`,
    );
    try {
      const compilation = compile(
        compilerPath,
        [
          "/nologo",
          "/target:exe",
          "/optimize+",
          "/warnaserror+",
          `/out:${candidatePath}`,
          trustedSourcePath,
        ],
        {
          cwd: versionRoot,
          env: compilerEnvironment(inheritedEnvironment, trustedSystemRoot),
          shell: false,
          stdio: "pipe",
          windowsHide: true,
        },
      );
      if (
        compilation.error !== undefined ||
        compilation.signal !== null ||
        compilation.status !== 0
      ) {
        throw new Error("A fonte versionada do guardian não pôde ser compilada pelo Windows.", {
          cause: compilation.error,
        });
      }
      if (
        !sourceBefore.equals(readFileSync(trustedSourcePath)) ||
        !supervisorBefore.equals(readFileSync(trustedSupervisorPath)) ||
        !compilerBefore.equals(readFileSync(compilerPath))
      ) {
        throw new Error("As fontes ou o compilador do guardian mudaram durante a compilação.");
      }
      assertPhysicalRegularFile(candidatePath, "O candidato compilado do guardian");
      protectPrivateFile(candidatePath, { description: "O candidato compilado do guardian" });
      try {
        renameSync(candidatePath, executablePath);
      } catch (error) {
        if (lstatSync(executablePath, { throwIfNoEntry: false }) === undefined) {
          throw error;
        }
        removeCandidate(candidatePath);
      }
    } catch (error) {
      removeCandidate(candidatePath);
      throw error;
    }
  }

  assertPhysicalRegularFile(executablePath, "O guardian compilado");
  assertPrivateFile(executablePath, { description: "O guardian compilado" });
  assertTrustedPath(executablePath, {
    systemRoot: trustedSystemRoot,
    trustedRoot: guardianRoot,
  });
  if (
    !sourceBefore.equals(readFileSync(trustedSourcePath)) ||
    !supervisorBefore.equals(readFileSync(trustedSupervisorPath)) ||
    !compilerBefore.equals(readFileSync(compilerPath))
  ) {
    throw new Error("As fontes ou o compilador do guardian mudaram antes da execução.");
  }
  return executablePath;
}

export function spawnSupervisedProcess(
  command,
  argumentsList,
  options,
  {
    platform = process.platform,
    resolveWindowsGuardian = resolveWindowsJobObjectGuardian,
    spawnProcess = spawn,
  } = {},
) {
  if (platform !== "win32") {
    return spawnProcess(command, argumentsList, options);
  }
  if (
    typeof command !== "string" ||
    command === "" ||
    command.includes("\0") ||
    !win32.isAbsolute(command) ||
    win32.resolve(command) !== command ||
    !Array.isArray(argumentsList) ||
    argumentsList.some((argument) => typeof argument !== "string" || argument.includes("\0")) ||
    options?.shell !== false ||
    options.stdio !== "inherit"
  ) {
    throw new Error("O Job Object exige launch direto, absoluto, sem shell e com stdio herdado.");
  }

  const guardianPath = resolveWindowsGuardian();
  const child = spawnProcess(guardianPath, [guardianControlArgument, command, ...argumentsList], {
    ...options,
    detached: false,
    stdio: ["inherit", "inherit", "inherit", "pipe"],
    windowsHide: true,
  });
  const control = child.stdio?.[3];
  if (
    control === undefined ||
    control === null ||
    typeof control.destroy !== "function" ||
    typeof control.on !== "function" ||
    typeof control.write !== "function"
  ) {
    child.kill("SIGKILL");
    throw new Error("O canal de lifecycle do Job Object não foi criado.");
  }
  control.on("error", () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  });
  control.write(Buffer.from([1]));
  child.once("close", () => control.destroy());
  return child;
}

export function superviseDevelopmentProcesses({
  children,
  clearShutdownTimeout = clearTimeout,
  exitTarget = process,
  forceShutdownMilliseconds = 5_000,
  platform = process.platform,
  scheduleShutdownTimeout = setTimeout,
  signalProcessGroup = process.kill,
  signalSource = process,
  writeError = (message) => process.stderr.write(message),
} = {}) {
  if (!Array.isArray(children) || children.length === 0) {
    throw new Error("Ao menos um processo de desenvolvimento deve ser supervisionado.");
  }

  const processTrees = children.map(({ child }) => ({
    child,
    processGroupId: Number.isSafeInteger(child.pid) && child.pid > 0 ? child.pid : undefined,
  }));
  const processTreeByChild = new Map(processTrees.map((tree) => [tree.child, tree]));
  const pendingPosixProcessGroups = new Set(
    platform === "win32"
      ? []
      : processTrees
          .map(({ processGroupId }) => processGroupId)
          .filter((processGroupId) => processGroupId !== undefined),
  );
  const runningChildren = new Set(children.map(({ child }) => child));
  let completionResolved = false;
  let forceShutdownTimer;
  let resolveCompletion;
  let shuttingDown = false;
  const completion = new Promise((resolveCompletionPromise) => {
    resolveCompletion = resolveCompletionPromise;
  });

  function reportTerminationFailure() {
    writeError("Não foi possível encerrar uma árvore de processos de desenvolvimento.\n");
  }

  function signalPosixProcessGroup(processGroupId, signal) {
    try {
      signalProcessGroup(-processGroupId, signal);
    } catch (error) {
      if (isMissingProcessError(error)) {
        pendingPosixProcessGroups.delete(processGroupId);
        return;
      }
      reportTerminationFailure();
    }
  }

  function signalProcessTree({ child, processGroupId }, signal) {
    if (platform !== "win32") {
      if (processGroupId !== undefined) {
        signalPosixProcessGroup(processGroupId, signal);
      }
      return;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    try {
      if (!child.kill("SIGKILL")) {
        reportTerminationFailure();
      }
    } catch (error) {
      if (!isMissingProcessError(error)) {
        reportTerminationFailure();
      }
    }
  }

  function forgetStoppedPosixProcessGroup(child) {
    if (platform === "win32") {
      return;
    }
    const processGroupId = processTreeByChild.get(child)?.processGroupId;
    if (processGroupId === undefined || !pendingPosixProcessGroups.has(processGroupId)) {
      return;
    }
    try {
      signalProcessGroup(-processGroupId, 0);
    } catch (error) {
      if (isMissingProcessError(error)) {
        pendingPosixProcessGroups.delete(processGroupId);
        return;
      }
      reportTerminationFailure();
    }
  }

  function removeSignalHandlers() {
    signalSource.removeListener("SIGHUP", handleSighup);
    signalSource.removeListener("SIGINT", handleSigint);
    signalSource.removeListener("SIGTERM", handleSigterm);
  }

  function finishIfStopped() {
    if (completionResolved || runningChildren.size !== 0 || pendingPosixProcessGroups.size !== 0) {
      return;
    }
    if (forceShutdownTimer !== undefined) {
      clearShutdownTimeout(forceShutdownTimer);
    }
    removeSignalHandlers();
    completionResolved = true;
    resolveCompletion(exitTarget.exitCode ?? 0);
  }

  function beginShutdown(signal, exitCode) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    exitTarget.exitCode = exitCode;
    for (const processTree of processTrees) {
      signalProcessTree(processTree, signal);
    }
    forceShutdownTimer = scheduleShutdownTimeout(() => {
      if (platform === "win32") {
        for (const processTree of processTrees) {
          if (runningChildren.has(processTree.child)) {
            signalProcessTree(processTree, "SIGKILL");
          }
        }
      } else {
        for (const processGroupId of pendingPosixProcessGroups) {
          signalPosixProcessGroup(processGroupId, "SIGKILL");
        }
        pendingPosixProcessGroups.clear();
      }
      forceShutdownTimer = undefined;
      finishIfStopped();
    }, forceShutdownMilliseconds);
  }

  function handleSigint() {
    beginShutdown("SIGINT", signalExitCodes.SIGINT);
  }
  function handleSighup() {
    beginShutdown("SIGHUP", signalExitCodes.SIGHUP);
  }
  function handleSigterm() {
    beginShutdown("SIGTERM", signalExitCodes.SIGTERM);
  }

  signalSource.on("SIGHUP", handleSighup);
  signalSource.on("SIGINT", handleSigint);
  signalSource.on("SIGTERM", handleSigterm);

  for (const { child, name } of children) {
    child.once("error", (error) => {
      writeError(`Falha ao iniciar ${name}: ${error.message}\n`);
      beginShutdown("SIGTERM", 1);
    });
    child.once("close", (code, signal) => {
      runningChildren.delete(child);
      if (!shuttingDown) {
        const reportedExitCode = code ?? 1;
        const exitCode = reportedExitCode === 0 ? 1 : reportedExitCode;
        const reason = signal === null ? `código ${reportedExitCode}` : `sinal ${signal}`;
        writeError(`${name} encerrou com ${reason}; encerrando os demais processos.\n`);
        beginShutdown("SIGTERM", exitCode);
      }
      forgetStoppedPosixProcessGroup(child);
      finishIfStopped();
    });
  }

  return { beginShutdown, completion };
}

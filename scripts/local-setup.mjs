import { spawn, spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { randomBytes, randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

import { Client } from "pg";
import { createClient } from "@supabase/supabase-js";

import { databaseMigrationHead } from "../packages/contracts/src/database-contract.ts";
import { createCleanupRequestHandler } from "../supabase/functions/media-cleanup/index.ts";

import { generateDatabaseArtifacts, verifyDatabaseArtifacts } from "./database-artifacts.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const localApplicationContracts = Object.freeze({
  backoffice: Object.freeze({
    environmentPath: "apps/backoffice/.env.local",
    expectedApplicationUrl: "http://127.0.0.1:3001",
    port: "3001",
    workingDirectory: "apps/backoffice",
  }),
  web: Object.freeze({
    environmentPath: ".env.local",
    expectedApplicationUrl: "http://127.0.0.1:3000",
    port: "3000",
    workingDirectory: ".",
  }),
});
const commonLocalRuntimeEnvironmentNames = Object.freeze([
  "APP_ENV",
  "APP_RELEASE_SHA",
  "DATABASE_URL_APP_DAL",
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "NEXT_PUBLIC_SUPABASE_URL",
]);
const backofficeLocalRuntimeEnvironmentNames = Object.freeze([
  ...commonLocalRuntimeEnvironmentNames,
  "BACKOFFICE_RUNTIME_UNLOCK_KEY",
]);
const webLocalRuntimeEnvironmentNames = Object.freeze([
  ...commonLocalRuntimeEnvironmentNames,
  "SUPABASE_SECRET_KEY",
]);
export const applicationDatabaseSchemas = Object.freeze(["public", "private", "audit"]);
const inheritedOperationalEnvironmentNames = Object.freeze([
  "CI",
  "COMSPEC",
  "HOME",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "NEXT_TELEMETRY_DISABLED",
  "PATH",
  "PATHEXT",
  "Path",
  "SYSTEMROOT",
  "SystemRoot",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "TZ",
  "USERPROFILE",
  "WINDIR",
]);
const publicSupabaseKeyPattern = /^sb_publishable_[A-Za-z0-9_-]{12,}$/u;
const jwtSegmentPattern = /^[A-Za-z0-9_-]+$/u;
const supabasePackagePath = require.resolve("supabase/package.json");
const supabasePackage = JSON.parse(readFileSync(supabasePackagePath, "utf8"));
const supabaseBin = supabasePackage.bin?.supabase;

if (typeof supabaseBin !== "string" || supabaseBin === "") {
  throw new Error("O pacote Supabase instalado não declara sua CLI.");
}

const supabaseCliPath = resolve(dirname(supabasePackagePath), supabaseBin);
const nextCliPath = require.resolve("next/dist/bin/next");

function rawUrlHostname(value) {
  const schemeSeparator = value.indexOf("://");
  if (schemeSeparator <= 0) return undefined;
  const authorityStart = schemeSeparator + 3;
  const authorityEndOffset = value.slice(authorityStart).search(/[/?#]/u);
  const authorityEnd =
    authorityEndOffset === -1 ? value.length : authorityStart + authorityEndOffset;
  const authority = value.slice(authorityStart, authorityEnd);
  const hostAndPort = authority.slice(authority.lastIndexOf("@") + 1);
  if (hostAndPort.startsWith("[")) return undefined;
  const portSeparator = hostAndPort.lastIndexOf(":");
  return portSeparator === -1 ? hostAndPort : hostAndPort.slice(0, portSeparator);
}

function assertPublicSupabaseKey(value) {
  if (
    typeof value !== "string" ||
    value === "" ||
    value.length > 8_192 ||
    value.includes("\0") ||
    value.includes("\n") ||
    value.includes("\r")
  ) {
    throw new Error("NEXT_PUBLIC_SUPABASE_ANON_KEY local possui formato inválido.");
  }
  if (publicSupabaseKeyPattern.test(value)) return;
  const segments = value.split(".");
  if (segments.length !== 3 || segments.some((segment) => !jwtSegmentPattern.test(segment))) {
    throw new Error("NEXT_PUBLIC_SUPABASE_ANON_KEY local não é uma chave pública Supabase válida.");
  }
  try {
    const payload = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
    if (payload?.role !== "anon") throw new Error("role inesperada");
  } catch {
    throw new Error("NEXT_PUBLIC_SUPABASE_ANON_KEY local precisa usar a role pública anon.");
  }
}

function assertServerSupabaseKey(value) {
  if (typeof value !== "string" || value === "" || value.length > 8_192) {
    throw new Error("SUPABASE_SECRET_KEY local possui formato inválido.");
  }
  const segments = value.split(".");
  if (segments.length !== 3 || segments.some((segment) => !jwtSegmentPattern.test(segment))) {
    throw new Error("SUPABASE_SECRET_KEY local não é uma chave server-only válida.");
  }
  try {
    const payload = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
    if (payload?.role !== "service_role") throw new Error("role inesperada");
  } catch {
    throw new Error("SUPABASE_SECRET_KEY local precisa usar a role service_role.");
  }
}

function assertLocalApplicationEnvironment(localEnvironment, expectedApplicationUrl) {
  if (localEnvironment === null || typeof localEnvironment !== "object") {
    throw new Error("O ambiente local da aplicação é inválido.");
  }
  const expectedNames =
    expectedApplicationUrl === localApplicationContracts.backoffice.expectedApplicationUrl
      ? backofficeLocalRuntimeEnvironmentNames
      : webLocalRuntimeEnvironmentNames;
  const expectedNameSet = new Set(expectedNames);
  const unexpectedNames = Object.keys(localEnvironment).filter(
    (name) => !expectedNameSet.has(name),
  );
  const missingNames = expectedNames.filter(
    (name) =>
      typeof localEnvironment[name] !== "string" ||
      localEnvironment[name] === "" ||
      localEnvironment[name].includes("\0"),
  );
  if (unexpectedNames.length > 0 || missingNames.length > 0) {
    throw new Error("O arquivo .env.local não contém exatamente o contrato runtime gerado.");
  }
  if (localEnvironment.APP_ENV !== "local" || localEnvironment.APP_RELEASE_SHA !== "local") {
    throw new Error("APP_ENV e APP_RELEASE_SHA precisam identificar o runtime local.");
  }
  if (localEnvironment.NEXT_PUBLIC_APP_URL !== expectedApplicationUrl) {
    throw new Error("NEXT_PUBLIC_APP_URL não corresponde à aplicação local solicitada.");
  }
  if (localEnvironment.NEXT_PUBLIC_SUPABASE_URL !== "http://127.0.0.1:54321") {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL não corresponde ao Supabase local.");
  }
  if (
    expectedNames === backofficeLocalRuntimeEnvironmentNames &&
    !/^[A-Za-z0-9_-]{43}$/u.test(localEnvironment.BACKOFFICE_RUNTIME_UNLOCK_KEY)
  ) {
    throw new Error("BACKOFFICE_RUNTIME_UNLOCK_KEY local possui formato inválido.");
  }
  assertPublicSupabaseKey(localEnvironment.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  if (expectedNames === webLocalRuntimeEnvironmentNames) {
    assertServerSupabaseKey(localEnvironment.SUPABASE_SECRET_KEY);
  }

  let dalDatabaseUrl;
  try {
    dalDatabaseUrl = new URL(localEnvironment.DATABASE_URL_APP_DAL);
  } catch {
    throw new Error("DATABASE_URL_APP_DAL local é inválida.");
  }
  if (
    !new Set(["postgres:", "postgresql:"]).has(dalDatabaseUrl.protocol) ||
    dalDatabaseUrl.hostname !== "127.0.0.1" ||
    rawUrlHostname(localEnvironment.DATABASE_URL_APP_DAL) !== "127.0.0.1" ||
    dalDatabaseUrl.port !== "54322" ||
    dalDatabaseUrl.username !== "app_runtime_local" ||
    dalDatabaseUrl.password === "" ||
    dalDatabaseUrl.pathname !== "/postgres" ||
    dalDatabaseUrl.hash !== "" ||
    dalDatabaseUrl.searchParams.size !== 1 ||
    dalDatabaseUrl.searchParams.get("options") !== "-c role=app_dal"
  ) {
    throw new Error("DATABASE_URL_APP_DAL não usa a identidade DAL local restrita.");
  }
  return localEnvironment;
}

export function createLocalApplicationEnvironment({
  expectedApplicationUrl,
  inheritedEnvironment = {},
  localEnvironment,
}) {
  const validated = assertLocalApplicationEnvironment(localEnvironment, expectedApplicationUrl);
  const environment = {};
  for (const name of inheritedOperationalEnvironmentNames) {
    const value = inheritedEnvironment[name];
    if (typeof value === "string" && value !== "" && !value.includes("\0")) {
      environment[name] = value;
    }
  }
  for (const name of Object.keys(validated)) environment[name] = validated[name];
  return environment;
}

function readLocalApplicationEnvironment(
  environmentPath,
  expectedApplicationUrl,
  inheritedEnvironment,
) {
  const before = lstatSync(environmentPath, { throwIfNoEntry: false });
  if (
    before === undefined ||
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    (process.platform !== "win32" && (before.mode & 0o7777) !== 0o600)
  ) {
    throw new Error("Execute npm run supabase:reset para gerar um .env.local privado e regular.");
  }
  const source = readFileSync(environmentPath, "utf8");
  const after = lstatSync(environmentPath, { throwIfNoEntry: false });
  if (
    after === undefined ||
    !after.isFile() ||
    after.isSymbolicLink() ||
    after.nlink !== 1 ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    (process.platform !== "win32" && (after.mode & 0o7777) !== 0o600)
  ) {
    throw new Error("O arquivo .env.local mudou durante a leitura.");
  }
  let localEnvironment;
  try {
    localEnvironment = parseEnv(source);
  } catch {
    throw new Error("O arquivo .env.local gerado não pôde ser interpretado.");
  }
  return createLocalApplicationEnvironment({
    expectedApplicationUrl,
    inheritedEnvironment,
    localEnvironment,
  });
}

export function assertNoUnexpectedNextEnvironmentFiles(workingDirectory, mode) {
  if (mode !== "dev" && mode !== "start") {
    throw new Error("O modo local solicitado é inválido.");
  }
  const names =
    mode === "dev"
      ? [".env", ".env.development", ".env.development.local"]
      : [".env", ".env.production", ".env.production.local"];
  for (const name of names) {
    if (lstatSync(resolve(workingDirectory, name), { throwIfNoEntry: false }) !== undefined) {
      throw new Error(`O runtime local aceita somente .env.local; remova ${name}.`);
    }
  }
}

export function createLocalApplicationLaunch({
  application,
  inheritedEnvironment = process.env,
  mode,
  root = repositoryRoot,
}) {
  const contract = localApplicationContracts[application];
  if (contract === undefined || (mode !== "dev" && mode !== "start")) {
    throw new Error("A aplicação ou o modo local solicitado é inválido.");
  }
  const workingDirectory = resolve(root, contract.workingDirectory);
  assertNoUnexpectedNextEnvironmentFiles(workingDirectory, mode);
  const environment = readLocalApplicationEnvironment(
    resolve(root, contract.environmentPath),
    contract.expectedApplicationUrl,
    inheritedEnvironment,
  );
  return {
    argumentsList: [nextCliPath, mode, "--hostname", "127.0.0.1", "--port", contract.port],
    command: process.execPath,
    options: { cwd: workingDirectory, env: environment, shell: false, stdio: "inherit" },
  };
}

async function runLocalApplication(application, mode) {
  const launch = createLocalApplicationLaunch({ application, mode });
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(launch.command, launch.argumentsList, launch.options);
    child.once("error", () => rejectPromise(new Error("A CLI Next local não pôde ser iniciada.")));
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`A CLI Next local encerrou sem sucesso (${code ?? signal}).`));
    });
  });
}

async function removeNextBuildCache(applicationRoot, removeCache = rm) {
  const nextDirectory = resolve(applicationRoot, ".next");
  const cacheDirectory = resolve(nextDirectory, "cache");
  const nextEntry = lstatSync(nextDirectory, { throwIfNoEntry: false });
  if (nextEntry === undefined) return;
  if (!nextEntry.isDirectory() || nextEntry.isSymbolicLink()) {
    throw new Error("O diretório de build Next precisa ser uma árvore física.");
  }
  const cacheEntry = lstatSync(cacheDirectory, { throwIfNoEntry: false });
  if (cacheEntry === undefined) return;
  if (!cacheEntry.isDirectory() || cacheEntry.isSymbolicLink()) {
    throw new Error("O cache transitório do build Next precisa ser um diretório físico.");
  }

  const retiredCache = resolve(
    nextDirectory,
    `.cache.build-retired-${process.pid}-${randomUUID()}`,
  );
  if (lstatSync(retiredCache, { throwIfNoEntry: false }) !== undefined) {
    throw new Error("O staging da limpeza de cache Next já existe.");
  }
  await rename(cacheDirectory, retiredCache);
  const retiredEntry = lstatSync(retiredCache, { throwIfNoEntry: false });
  if (retiredEntry === undefined || !retiredEntry.isDirectory() || retiredEntry.isSymbolicLink()) {
    throw new Error("O cache Next retirado não preservou uma árvore física.");
  }
  await removeCache(retiredCache, { force: false, recursive: true });
  if (lstatSync(retiredCache, { throwIfNoEntry: false }) !== undefined) {
    throw new Error("O cache transitório do build Next permaneceu após a limpeza.");
  }
}

export async function runNextBuildWithCacheCleanup({
  application,
  executeBuild = spawnSync,
  inheritedEnvironment = process.env,
  removeCache = removeNextBuildCache,
  root = repositoryRoot,
} = {}) {
  const contract = localApplicationContracts[application];
  if (contract === undefined) throw new Error("A aplicação solicitada para build é inválida.");
  const workingDirectory = resolve(root, contract.workingDirectory);
  let buildFailure;
  try {
    const result = executeBuild(process.execPath, [nextCliPath, "build"], {
      cwd: workingDirectory,
      env: inheritedEnvironment,
      shell: false,
      stdio: "inherit",
    });
    if (result?.error !== undefined) {
      throw new Error("A CLI Next não pôde ser iniciada para o build.", { cause: result.error });
    }
    if (result?.status !== 0) {
      throw new Error(
        `A CLI Next encerrou o build sem sucesso (${result?.status ?? result?.signal ?? "sem código"}).`,
      );
    }
  } catch (error) {
    buildFailure = error;
  }

  let cleanupFailure;
  try {
    await removeCache(workingDirectory);
  } catch (error) {
    cleanupFailure = error;
  }
  if (buildFailure !== undefined && cleanupFailure !== undefined) {
    throw new AggregateError(
      [buildFailure, cleanupFailure],
      "O build Next falhou e o cache transitório também não pôde ser removido.",
    );
  }
  if (cleanupFailure !== undefined) throw cleanupFailure;
  if (buildFailure !== undefined) throw buildFailure;
}

const localDockerContracts = {
  linux: new Map([["default", "unix:///var/run/docker.sock"]]),
  win32: new Map([["set-livre-wsl", "tcp://127.0.0.1:2375"]]),
};
const windowsDockerDistribution = "SetLivreDocker";
const windowsSupabaseCliPath = "/usr/bin/supabase";
const windowsWslEnvironment = Object.freeze([
  "HOME=/root",
  "LANG=C.UTF-8",
  "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
]);
export const supabaseLocalNetworkName = "set-livre-loopback";
const supabaseLocalProjectId = "set-livre";
const loopbackBindingOption = "com.docker.network.bridge.host_binding_ipv4";
const expectedPublishedPorts = new Set(["54321", "54322", "54323", "54324"]);

export function withSupabaseLocalNetwork(argumentsList) {
  return [...argumentsList, "--network-id", supabaseLocalNetworkName];
}

function runDocker(argumentsList, environment = process.env) {
  const result = spawnSync("docker", argumentsList, {
    encoding: "utf8",
    env: environment,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error("A CLI Docker não comprovou o daemon local esperado.");
  }
  return (result.stdout ?? "").trim();
}

function assertDockerOverridesAbsent(dockerHostOverride, dockerContextOverride) {
  if (
    (typeof dockerHostOverride === "string" && dockerHostOverride.trim() !== "") ||
    (typeof dockerContextOverride === "string" && dockerContextOverride.trim() !== "")
  ) {
    throw new Error("DOCKER_HOST e DOCKER_CONTEXT precisam estar ausentes para operações locais.");
  }
}

export function assertLoopbackNetworkInspection(inspections) {
  const inspection =
    Array.isArray(inspections) && inspections.length === 1 ? inspections[0] : undefined;
  if (
    inspection?.Name !== supabaseLocalNetworkName ||
    inspection.Driver !== "bridge" ||
    inspection.Scope !== "local" ||
    inspection.Internal !== false ||
    inspection.Options?.[loopbackBindingOption] !== "127.0.0.1"
  ) {
    throw new Error(`A rede Docker ${supabaseLocalNetworkName} não está restrita ao loopback.`);
  }
}

export function assertLoopbackContainerInspections(inspections) {
  if (!Array.isArray(inspections) || inspections.length === 0) {
    throw new Error("Nenhum container Supabase local em execução foi encontrado.");
  }

  const publishedPorts = new Map();
  for (const inspection of inspections) {
    if (inspection?.NetworkSettings?.Networks?.[supabaseLocalNetworkName] === undefined) {
      throw new Error("Um container Supabase não pertence à rede local restrita.");
    }
    for (const bindings of Object.values(inspection.NetworkSettings.Ports ?? {})) {
      if (bindings === null) continue;
      if (!Array.isArray(bindings)) throw new Error("O Docker retornou portas locais inválidas.");
      for (const binding of bindings) {
        const hostIp = binding?.HostIp;
        const hostPort = binding?.HostPort;
        if (typeof hostPort !== "string" || hostIp !== "127.0.0.1") {
          throw new Error("Um container Supabase publicou porta fora da fronteira local.");
        }
        const addresses = publishedPorts.get(hostPort) ?? new Set();
        if (addresses.has(hostIp)) throw new Error(`A porta local ${hostPort} foi duplicada.`);
        addresses.add(hostIp);
        publishedPorts.set(hostPort, addresses);
      }
    }
  }

  if (
    publishedPorts.size !== expectedPublishedPorts.size ||
    [...expectedPublishedPorts].some(
      (port) => !publishedPorts.has(port) || !publishedPorts.get(port).has("127.0.0.1"),
    )
  ) {
    throw new Error("A stack Supabase não publicou exatamente as portas locais esperadas.");
  }
}

function ensureSupabaseLoopbackNetwork(environment) {
  const existingNames = runDocker(
    ["network", "ls", "--filter", `name=^${supabaseLocalNetworkName}$`, "--format", "{{.Name}}"],
    environment,
  )
    .split("\n")
    .filter(Boolean);
  if (existingNames.length === 0) {
    runDocker(
      [
        "network",
        "create",
        "--driver",
        "bridge",
        "--opt",
        `${loopbackBindingOption}=127.0.0.1`,
        supabaseLocalNetworkName,
      ],
      environment,
    );
  } else if (existingNames.length !== 1 || existingNames[0] !== supabaseLocalNetworkName) {
    throw new Error(`A rede Docker ${supabaseLocalNetworkName} não pôde ser identificada.`);
  }
  assertLoopbackNetworkInspection(
    JSON.parse(runDocker(["network", "inspect", supabaseLocalNetworkName], environment)),
  );
}

function supabaseProjectContainerIds(environment, { includeStopped = false } = {}) {
  return runDocker(
    [
      "ps",
      ...(includeStopped ? ["--all"] : []),
      "--filter",
      `label=com.supabase.cli.project=${supabaseLocalProjectId}`,
      "--format",
      "{{.ID}}",
    ],
    environment,
  )
    .split("\n")
    .filter(Boolean);
}

export function classifySupabaseProjectStartup(inspections) {
  if (!Array.isArray(inspections)) {
    throw new Error("O Docker retornou um estado inválido para a stack Supabase local.");
  }
  if (inspections.length === 0) return "absent";
  for (const inspection of inspections) {
    const status = inspection?.State?.Status;
    const health = inspection?.State?.Health?.Status;
    if (typeof status !== "string" || (health !== undefined && typeof health !== "string")) {
      throw new Error("O Docker retornou um estado inválido para a stack Supabase local.");
    }
    if (status !== "running" || (health !== undefined && health !== "healthy")) return "starting";
  }
  return "ready";
}

const supabaseStartupWaitBuffer = new Int32Array(new SharedArrayBuffer(4));

export function waitForSupabaseProjectStartup({
  maxAttempts = 90,
  pause = (milliseconds) => Atomics.wait(supabaseStartupWaitBuffer, 0, 0, milliseconds),
  readState,
} = {}) {
  if (typeof readState !== "function" || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("A espera da stack Supabase local recebeu configuração inválida.");
  }
  let state = readState();
  if (state === "absent") return false;
  for (let attempt = 0; state === "starting" && attempt < maxAttempts; attempt += 1) {
    pause(500);
    state = readState();
    if (state === "absent") {
      throw new Error("A stack Supabase local desapareceu durante a inicialização.");
    }
  }
  if (state !== "ready") {
    throw new Error("A stack Supabase local não ficou saudável após o Docker Engine iniciar.");
  }
  return true;
}

function supabaseProjectStartupState(environment) {
  const containerIds = supabaseProjectContainerIds(environment, { includeStopped: true });
  if (containerIds.length === 0) return "absent";
  return classifySupabaseProjectStartup(
    JSON.parse(runDocker(["inspect", ...containerIds], environment)),
  );
}

function supabaseProjectContainersAreRunning(environment) {
  return supabaseProjectContainerIds(environment).length > 0;
}

function assertSupabaseProjectStopped(environment) {
  if (supabaseProjectContainersAreRunning(environment)) {
    throw new Error("A stack Supabase fora do contrato não pôde ser encerrada.");
  }
}

function assertSupabaseLoopbackBindings(environment) {
  const containerIds = supabaseProjectContainerIds(environment);
  assertLoopbackNetworkInspection(
    JSON.parse(runDocker(["network", "inspect", supabaseLocalNetworkName], environment)),
  );
  assertLoopbackContainerInspections(
    JSON.parse(runDocker(["inspect", ...containerIds], environment)),
  );
}

export function validateLocalDockerContext({
  contextName,
  dockerContextOverride,
  dockerHostOverride,
  endpoint,
  engineOperatingSystem,
  platform,
}) {
  assertDockerOverridesAbsent(dockerHostOverride, dockerContextOverride);

  const contracts = localDockerContracts[platform];
  if (contracts === undefined) {
    throw new Error("O Supabase local possui contrato Docker somente para Windows e Linux.");
  }
  if (contracts.get(contextName) !== endpoint) {
    throw new Error("O contexto Docker ativo não aponta para o daemon local permitido.");
  }
  if (engineOperatingSystem !== "linux") {
    throw new Error("O daemon Docker local precisa executar containers Linux.");
  }
  return endpoint;
}

export function windowsPathToWslPath(value) {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error("O caminho Windows para o WSL é inválido.");
  }
  const match = /^([A-Za-z]):[\\/](.+)$/u.exec(value);
  if (match === null) throw new Error("O caminho Windows para o WSL precisa ser absoluto.");
  return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}`;
}

function mapWindowsArgumentToWsl(value) {
  if (/^[A-Za-z]:[\\/]/u.test(value)) return windowsPathToWslPath(value);
  const assignment = /^([^=]+=)([A-Za-z]:[\\/].+)$/u.exec(value);
  return assignment === null ? value : `${assignment[1]}${windowsPathToWslPath(assignment[2])}`;
}

function windowsWslSupabaseArguments(argumentsList, root = repositoryRoot) {
  return [
    "--distribution",
    windowsDockerDistribution,
    "--user",
    "root",
    "--cd",
    windowsPathToWslPath(root),
    "--exec",
    "/usr/bin/env",
    "-i",
    ...windowsWslEnvironment,
    windowsSupabaseCliPath,
    ...argumentsList.map(mapWindowsArgumentToWsl),
  ];
}

function localWslLauncherEnvironment(environment) {
  const launcher = {};
  for (const name of [
    "PATH",
    "Path",
    "PATHEXT",
    "SYSTEMROOT",
    "SystemRoot",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "WINDIR",
  ]) {
    const value = environment[name];
    if (typeof value === "string" && value !== "") launcher[name] = value;
  }
  return launcher;
}

export function ensureWindowsDockerEngine({
  environment = process.env,
  execute = spawnSync,
  platform = process.platform,
} = {}) {
  if (platform !== "win32") return false;
  const result = execute(
    "wsl.exe",
    [
      "--distribution",
      windowsDockerDistribution,
      "--user",
      "root",
      "--exec",
      "/usr/bin/systemctl",
      "start",
      "docker.service",
    ],
    {
      encoding: "utf8",
      env: localWslLauncherEnvironment(environment),
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `A distro ${windowsDockerDistribution} não iniciou o Docker Engine local esperado.`,
    );
  }
  return true;
}

export function assertLocalDockerDaemon(environment = process.env, platform = process.platform) {
  const dockerHostOverride = environment.DOCKER_HOST;
  const dockerContextOverride = environment.DOCKER_CONTEXT;
  assertDockerOverridesAbsent(dockerHostOverride, dockerContextOverride);
  ensureWindowsDockerEngine({ environment, platform });

  const contextName = runDocker(["context", "show"], environment);
  if (!/^[A-Za-z0-9_.-]{1,128}$/u.test(contextName)) {
    throw new Error("O nome do contexto Docker ativo é inválido.");
  }

  let endpoint;
  try {
    endpoint = JSON.parse(
      runDocker(
        ["context", "inspect", contextName, "--format", "{{json .Endpoints.docker.Host}}"],
        environment,
      ),
    );
  } catch {
    throw new Error("Não foi possível inspecionar o endpoint Docker local.");
  }
  if (typeof endpoint !== "string") {
    throw new Error("O endpoint Docker inspecionado é inválido.");
  }

  const localEnvironment = { ...environment, DOCKER_HOST: endpoint };
  delete localEnvironment.DOCKER_CONTEXT;
  delete localEnvironment.DOCKER_CERT_PATH;
  delete localEnvironment.DOCKER_TLS_VERIFY;

  let engineOperatingSystem;
  try {
    engineOperatingSystem = JSON.parse(
      runDocker(["info", "--format", "{{json .OSType}}"], localEnvironment),
    );
  } catch {
    throw new Error("Não foi possível inspecionar o daemon Docker local.");
  }

  validateLocalDockerContext({
    contextName,
    dockerContextOverride,
    dockerHostOverride,
    endpoint,
    engineOperatingSystem,
    platform,
  });
  return localEnvironment;
}

export function runSupabase(
  argumentsList,
  {
    capture = false,
    execute = spawnSync,
    network = false,
    platform = process.platform,
    resolveLocalDockerEnvironment = assertLocalDockerDaemon,
    root = repositoryRoot,
  } = {},
) {
  const localDockerEnvironment = resolveLocalDockerEnvironment();
  const commandArguments = network ? withSupabaseLocalNetwork(argumentsList) : argumentsList;
  let executable = process.execPath;
  let executableArguments = [supabaseCliPath, ...commandArguments];
  let invocationEnvironment = localDockerEnvironment;

  if (platform === "win32") {
    executable = "wsl.exe";
    invocationEnvironment = localWslLauncherEnvironment(localDockerEnvironment);
    const version = execute(executable, windowsWslSupabaseArguments(["--version"], root), {
      cwd: root,
      encoding: "utf8",
      env: invocationEnvironment,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    if (
      version.error !== undefined ||
      version.status !== 0 ||
      (version.stdout ?? "").trim() !== supabasePackage.version
    ) {
      throw new Error(
        `A distro ${windowsDockerDistribution} precisa da Supabase CLI ${supabasePackage.version}.`,
      );
    }
    executableArguments = windowsWslSupabaseArguments(commandArguments, root);
  }

  const result = execute(executable, executableArguments, {
    cwd: root,
    encoding: "utf8",
    env: invocationEnvironment,
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["ignore", capture ? "pipe" : "inherit", "pipe"],
    windowsHide: platform === "win32",
  });
  if (result.error !== undefined || result.status !== 0) {
    const status = result.status === null ? "sem código" : `código ${result.status}`;
    const diagnostic = parseSupabaseCliError(`${result.stderr ?? ""}\n${result.stdout ?? ""}`);
    const suffix = diagnostic === undefined ? "" : `: ${diagnostic}`;
    throw new Error(
      `Supabase CLI falhou em ${argumentsList.slice(0, 2).join(" ")} (${status})${suffix}.`,
    );
  }
  return result.stdout ?? "";
}

const pgProveImage = "public.ecr.aws/supabase/pg_prove:3.36";
const pgTapDiagnosticLimit = 16_384;

function knownSecretVariants(secrets) {
  const variants = new Set();
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret === "" || secret === "[REDACTED]") continue;
    const encoded = encodeURIComponent(secret);
    const jsonEscaped = JSON.stringify(secret).slice(1, -1);
    for (const variant of [
      secret,
      encoded,
      encoded.replaceAll(/%[0-9A-F]{2}/gu, (match) => match.toLowerCase()),
      encoded.replaceAll("%20", "+"),
      jsonEscaped,
    ]) {
      if (variant !== "") variants.add(variant);
    }
  }
  return [...variants].sort((left, right) => right.length - left.length);
}

function redactDiagnostic(rawDiagnostic, secrets = []) {
  let redacted = String(rawDiagnostic ?? "");
  for (const secret of knownSecretVariants(secrets)) {
    redacted = redacted.replaceAll(secret, "[REDACTED]");
  }
  return redacted
    .replaceAll(/postgres(?:ql)?:\/\/[^\s@]+@/giu, "postgresql://[REDACTED]@")
    .replaceAll(
      /((?:"(?:PGPASSWORD|password)"|'(?:PGPASSWORD|password)'|\b(?:PGPASSWORD|password)\b)\s*(?:=|:)\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}&]+)/giu,
      (_match, prefix, value) => {
        const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : "";
        return `${prefix}${quote}[REDACTED]${quote}`;
      },
    )
    .trim();
}

function truncateDiagnosticStream(redacted, label) {
  if (redacted.length <= pgTapDiagnosticLimit) return redacted;
  const marker = `\n...[${label} truncado; início e fim preservados]...\n`;
  const available = pgTapDiagnosticLimit - marker.length;
  const headLength = Math.ceil(available / 2);
  const tailLength = Math.floor(available / 2);
  return `${redacted.slice(0, headLength)}${marker}${redacted.slice(-tailLength)}`;
}

function formatPgTapDiagnostic({ errorMessage, stderr, stdout }, secrets) {
  return [
    ["stderr", stderr],
    ["stdout", stdout],
    ["runner-error", errorMessage],
  ]
    .map(([label, raw]) => {
      const redacted = redactDiagnostic(raw, secrets);
      return redacted === "" ? "" : `[${label}]\n${truncateDiagnosticStream(redacted, label)}`;
    })
    .filter(Boolean)
    .join("\n");
}

export function runWindowsDatabaseTests(
  values,
  {
    containerName = `set-livre-pgtap-${process.pid}-${randomUUID()}`,
    execute = spawnSync,
    resolveLocalDockerEnvironment = assertLocalDockerDaemon,
  } = {},
) {
  const databaseUrl = new URL(values.DB_URL);
  const databasePassword = decodeURIComponent(databaseUrl.password);
  const diagnosticSecrets = [databasePassword, databaseUrl.password];
  const environment = {
    ...resolveLocalDockerEnvironment(),
    PGDATABASE: decodeURIComponent(databaseUrl.pathname.slice(1)),
    PGHOST: `supabase_db_${supabaseLocalProjectId}`,
    PGPASSWORD: databasePassword,
    PGPORT: "5432",
    PGUSER: decodeURIComponent(databaseUrl.username),
  };
  const invoke = (argumentsList, { label, readLogsOnEmptyFailure = false }) => {
    const result = execute("docker", argumentsList, {
      encoding: "utf8",
      env: environment,
      maxBuffer: 128 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error !== undefined || result.status !== 0) {
      const status = result.status === null ? "sem código" : `código ${result.status}`;
      let diagnostic = formatPgTapDiagnostic(
        {
          errorMessage: result.error?.message,
          stderr: result.stderr,
          stdout: result.stdout,
        },
        diagnosticSecrets,
      );
      if (diagnostic === "" && readLogsOnEmptyFailure) {
        const logs = execute("docker", ["logs", containerName], {
          encoding: "utf8",
          env: environment,
          maxBuffer: 128 * 1024 * 1024,
          stdio: ["ignore", "pipe", "pipe"],
        });
        diagnostic = formatPgTapDiagnostic(
          {
            errorMessage: logs.error?.message,
            stderr: logs.stderr,
            stdout: logs.stdout,
          },
          diagnosticSecrets,
        );
      }
      const suffix = diagnostic === "" ? "" : `\n${diagnostic}`;
      throw new Error(`${label} falhou no runner pgTAP efêmero do Windows (${status}).${suffix}`);
    }
    return result.stdout ?? "";
  };

  let containerCreated = false;
  let failure;
  try {
    invoke(
      [
        "create",
        "--name",
        containerName,
        "--network",
        supabaseLocalNetworkName,
        "-e",
        "PGHOST",
        "-e",
        "PGPORT",
        "-e",
        "PGUSER",
        "-e",
        "PGPASSWORD",
        "-e",
        "PGDATABASE",
        "-w",
        "/tests",
        pgProveImage,
        "pg_prove",
        "--ext",
        ".pg",
        "--ext",
        ".sql",
        "-r",
        "/tests",
      ],
      { label: "A criação" },
    );
    containerCreated = true;
    invoke(
      ["cp", `${resolve(repositoryRoot, "supabase/tests")}${sep}.`, `${containerName}:/tests`],
      { label: "A cópia dos testes" },
    );
    invoke(["start", "--attach", containerName], {
      label: "A execução dos testes SQL",
      readLogsOnEmptyFailure: true,
    });
  } catch (error) {
    failure = error;
  } finally {
    if (containerCreated) {
      try {
        invoke(["rm", "--force", containerName], { label: "A limpeza" });
      } catch (cleanupError) {
        failure ??= cleanupError;
      }
    }
  }
  if (failure !== undefined) throw failure;
}

function runDatabaseTests(values) {
  if (process.platform === "win32") {
    runWindowsDatabaseTests(values);
    return;
  }
  runSupabase(["test", "db", "--local"], { network: true });
}

export function parseSupabaseCliError(rawError) {
  if (typeof rawError !== "string" || rawError.trim() === "") return undefined;
  const lines = rawError.trim().split(/\r?\n/u).reverse();
  for (const line of lines) {
    try {
      const payload = JSON.parse(line);
      const message = payload?.error?.message ?? payload?.message;
      if (typeof message === "string" && message !== "") {
        return redactDiagnostic(message);
      }
    } catch {
      // A CLI mistura progresso textual e um erro JSON final; somente o JSON é seguro para diagnóstico.
    }
  }
  return undefined;
}

function assertLocalEndpoint(value, label, protocol, port) {
  const parsed = new URL(value);
  if (
    parsed.protocol !== protocol ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.port !== port ||
    parsed.hash !== ""
  ) {
    throw new Error(`${label} não corresponde ao endpoint local esperado.`);
  }
  return parsed;
}

export function parseSupabaseStatus(rawStatus) {
  const values = JSON.parse(rawStatus);
  for (const name of ["ANON_KEY", "API_URL", "DB_URL", "SERVICE_ROLE_KEY"]) {
    if (typeof values[name] !== "string" || values[name] === "") {
      throw new Error(`Supabase local não retornou ${name}.`);
    }
  }
  assertPublicSupabaseKey(values.ANON_KEY);
  assertServerSupabaseKey(values.SERVICE_ROLE_KEY);

  const apiUrl = assertLocalEndpoint(values.API_URL, "API_URL", "http:", "54321");
  if (
    apiUrl.username !== "" ||
    apiUrl.password !== "" ||
    apiUrl.pathname !== "/" ||
    apiUrl.search !== ""
  ) {
    throw new Error("API_URL local precisa ser uma origem sem credenciais ou path.");
  }

  const databaseUrl = assertLocalEndpoint(values.DB_URL, "DB_URL", "postgresql:", "54322");
  if (
    decodeURIComponent(databaseUrl.username) !== "postgres" ||
    databaseUrl.password === "" ||
    databaseUrl.pathname !== "/postgres" ||
    databaseUrl.search !== ""
  ) {
    throw new Error("DB_URL local não usa a identidade administrativa esperada.");
  }

  return values;
}

export function assertLocalStatusOrStopRunningStack({
  assertBindings,
  isStackRunning,
  readStatus,
  stopStack,
}) {
  try {
    const values = readStatus();
    assertBindings();
    return values;
  } catch (error) {
    if (isStackRunning()) stopStack();
    throw error;
  }
}

function localStatus() {
  const environment = assertLocalDockerDaemon();
  return assertLocalStatusOrStopRunningStack({
    assertBindings: () => assertSupabaseLoopbackBindings(environment),
    isStackRunning: () => supabaseProjectContainersAreRunning(environment),
    readStatus: () =>
      parseSupabaseStatus(
        runSupabase(["status", "--output", "json"], { capture: true, network: true }),
      ),
    stopStack: () => stopScopedSupabaseStack(environment),
  });
}

async function writePrivateEnvironment(destination, contents) {
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

function runtimeRoleSql(password, marker) {
  if (!/^[A-Za-z0-9_-]{32,128}$/u.test(password) || !/^[A-Za-z0-9_-]{32,128}$/u.test(marker)) {
    throw new Error("As credenciais locais geradas não atendem ao formato seguro.");
  }

  return `
begin;

do $block$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'app_runtime_local') then
    create role app_runtime_local;
  end if;
end
$block$;

do $block$
declare
  owner_role text;
begin
  if pg_catalog.to_regnamespace('net') is not null then
    execute 'revoke all on schema net from public, anon, authenticated, service_role, app_dal, app_runtime_local, app_runtime_production';
    execute 'revoke all on all tables in schema net from public, anon, authenticated, service_role, app_dal, app_runtime_local, app_runtime_production';
    execute 'revoke all on all sequences in schema net from public, anon, authenticated, service_role, app_dal, app_runtime_local, app_runtime_production';
    execute 'revoke all on all functions in schema net from public, anon, authenticated, service_role, app_dal, app_runtime_local, app_runtime_production';
    execute 'grant usage on schema net to postgres';
    execute 'grant all on all tables in schema net to postgres';
    execute 'grant all on all sequences in schema net to postgres';
    execute 'grant execute on all functions in schema net to postgres';

    foreach owner_role in array array['supabase_admin', 'postgres']
    loop
      execute pg_catalog.format(
        'alter default privileges for role %I in schema net revoke all on tables from public, anon, authenticated, service_role, app_dal, app_runtime_local, app_runtime_production',
        owner_role
      );
      execute pg_catalog.format(
        'alter default privileges for role %I in schema net revoke all on sequences from public, anon, authenticated, service_role, app_dal, app_runtime_local, app_runtime_production',
        owner_role
      );
      execute pg_catalog.format(
        'alter default privileges for role %I in schema net revoke execute on functions from public, anon, authenticated, service_role, app_dal, app_runtime_local, app_runtime_production',
        owner_role
      );
      execute pg_catalog.format(
        'alter default privileges for role %I in schema net revoke usage on types from public, anon, authenticated, service_role, app_dal, app_runtime_local, app_runtime_production',
        owner_role
      );
    end loop;
  end if;
end
$block$;

revoke all privileges on table
  pg_catalog.pg_db_role_setting,
  pg_catalog.pg_roles,
  pg_catalog.pg_user
from public, anon, authenticated, service_role, app_dal,
  app_runtime_local, app_runtime_production;

do $block$
declare
  catalog_name text;
  column_list text;
begin
  foreach catalog_name in array array['pg_db_role_setting', 'pg_roles', 'pg_user']
  loop
    select pg_catalog.string_agg(
        pg_catalog.format('%I', attribute.attname),
        ', ' order by attribute.attnum
      )
      into column_list
    from pg_catalog.pg_attribute as attribute
    where attribute.attrelid = pg_catalog.to_regclass(
        pg_catalog.format('pg_catalog.%I', catalog_name)
      )
      and attribute.attnum > 0
      and not attribute.attisdropped;

    execute pg_catalog.format(
      'revoke all privileges (%s) on table pg_catalog.%I from public, anon, authenticated, service_role, app_dal, app_runtime_local, app_runtime_production',
      column_list,
      catalog_name
    );
  end loop;
end
$block$;

grant all privileges on table
  pg_catalog.pg_db_role_setting,
  pg_catalog.pg_roles,
  pg_catalog.pg_user
to supabase_admin;
grant select on table
  pg_catalog.pg_db_role_setting,
  pg_catalog.pg_roles,
  pg_catalog.pg_user
to postgres, supabase_admin;
grant select on table pg_catalog.pg_roles to supabase_storage_admin;

do $block$
declare
  membership record;
begin
  for membership in
    select granted.rolname as granted_role, member.rolname as member_role,
      grantor.rolname as grantor_role
    from pg_catalog.pg_auth_members as relation
    join pg_catalog.pg_roles as granted on granted.oid = relation.roleid
    join pg_catalog.pg_roles as member on member.oid = relation.member
    join pg_catalog.pg_roles as grantor on grantor.oid = relation.grantor
    where member.rolname = 'app_runtime_local'
       or granted.rolname = 'app_runtime_local'
       or (granted.rolname = 'app_dal' and member.rolname = 'postgres')
  loop
    execute pg_catalog.format(
      'revoke %I from %I granted by %I cascade',
      membership.granted_role,
      membership.member_role,
      membership.grantor_role
    );
  end loop;
end
$block$;

alter role app_runtime_local
  login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls
  connection limit 10 valid until 'infinity' password '${password}';
alter role app_runtime_local reset all;
alter role app_runtime_local in database postgres reset all;
alter role app_runtime_local in database postgres set "app.settings.jwt_secret" = '';

revoke all privileges on database postgres from app_runtime_local;
grant connect on database postgres to app_runtime_local;
grant app_dal to app_runtime_local with admin false, inherit false, set true;
grant app_dal to postgres with admin true, inherit false, set false;
grant app_dal to app_runtime_production with admin false, inherit false, set true;
grant app_runtime_local to postgres with admin true, inherit false, set false;

comment on database postgres is 'set-livre-e2e:${marker}';

commit;
`;
}

async function provisionLocalRuntime(values) {
  const runtimePassword = randomBytes(32).toString("base64url");
  const databaseMarker = randomBytes(32).toString("base64url");
  const administratorUrl = new URL(values.DB_URL);
  administratorUrl.username = "supabase_admin";
  const administrator = new Client({ connectionString: administratorUrl.toString() });
  await administrator.connect();
  try {
    await administrator.query(runtimeRoleSql(runtimePassword, databaseMarker));
  } finally {
    await administrator.end();
  }

  const dalDatabaseUrl = new URL(values.DB_URL);
  dalDatabaseUrl.username = "app_runtime_local";
  dalDatabaseUrl.password = runtimePassword;
  dalDatabaseUrl.searchParams.set("options", "-c role=app_dal");

  const runtime = new Client({ connectionString: dalDatabaseUrl.toString() });
  await runtime.connect();
  try {
    const result = await runtime.query(
      `select current_user, session_user,
        private.check_readiness($1::text) as ready,
        private.check_runtime_readiness($2::text) as runtime_ready`,
      [databaseMigrationHead, "app_runtime_local"],
    );
    const identity = result.rows[0];
    if (
      identity?.current_user !== "app_dal" ||
      identity?.session_user !== "app_runtime_local" ||
      identity?.ready !== true ||
      identity?.runtime_ready !== true
    ) {
      throw new Error(
        `A role DAL local não satisfez o contrato de readiness (role=${identity?.current_user}, session=${identity?.session_user}, database=${String(identity?.ready)}, runtime=${String(identity?.runtime_ready)}).`,
      );
    }
  } finally {
    await runtime.end();
  }

  return { dalDatabaseUrl: dalDatabaseUrl.toString(), databaseMarker };
}

function isHealthyLocalCleanupResult(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === "claimed\0deleted\0failed" &&
    Number.isSafeInteger(value.claimed) &&
    value.claimed >= 0 &&
    Number.isSafeInteger(value.deleted) &&
    value.deleted >= 0 &&
    value.failed === 0 &&
    value.claimed === value.deleted
  );
}

export async function runLocalMediaCleanup(
  values,
  {
    createHandler = createCleanupRequestHandler,
    createSupabaseClient = createClient,
    runId = randomUUID(),
  } = {},
) {
  const functionSlug = `media-cleanup-${databaseMigrationHead.padEnd(40, "0")}`;
  const handler = createHandler({
    createSupabaseClient,
    readConfiguration: () => ({ secretKey: values.SERVICE_ROLE_KEY, url: values.API_URL }),
  });
  const response = await handler(
    new Request(`${values.API_URL}/functions/v1/${functionSlug}`, {
      body: JSON.stringify({ runId }),
      headers: {
        apikey: values.SERVICE_ROLE_KEY,
        "content-type": "application/json",
      },
      method: "POST",
    }),
  );
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("O cleanup local não retornou JSON terminal válido.");
  }
  if (response.status !== 200 || !isHealthyLocalCleanupResult(result)) {
    throw new Error("O cleanup local não comprovou uma execução terminal saudável.");
  }
  return result;
}

async function verifyProductionRoleStartupAssumption(values) {
  const runtimePassword = randomBytes(32).toString("base64url");
  const administratorUrl = new URL(values.DB_URL);
  administratorUrl.username = "supabase_admin";
  const administrator = new Client({ connectionString: administratorUrl.toString() });
  const runtimeUrl = new URL(values.DB_URL);
  runtimeUrl.username = "app_runtime_production";
  runtimeUrl.password = runtimePassword;
  runtimeUrl.search = "";
  runtimeUrl.hash = "";

  await administrator.connect();
  let credentialChangeAttempted = false;
  let runtime;
  try {
    const passwordCommandResult = await administrator.query(
      "select pg_catalog.format('alter role app_runtime_production login password %L', $1::text) as command",
      [runtimePassword],
    );
    const passwordCommand = passwordCommandResult.rows[0]?.command;
    if (typeof passwordCommand !== "string" || passwordCommand === "") {
      throw new Error("O PostgreSQL não produziu o comando seguro para a credencial temporária.");
    }
    credentialChangeAttempted = true;
    await administrator.query(passwordCommand);
    runtime = new Client({ connectionString: runtimeUrl.toString() });
    await runtime.connect();
    const result = await runtime.query(
      `select current_user, session_user,
        pg_catalog.current_setting('role', true) as role_setting,
        private.check_runtime_readiness($1::text) as runtime_ready`,
      ["app_runtime_production"],
    );
    const identity = result.rows[0];
    if (
      identity?.current_user !== "app_dal" ||
      identity?.session_user !== "app_runtime_production" ||
      identity?.role_setting !== "app_dal" ||
      identity?.runtime_ready !== true
    ) {
      throw new Error(
        `A configuração canônica não assumiu a role DAL em uma conexão nova (role=${identity?.current_user}, session=${identity?.session_user}, setting=${identity?.role_setting}, runtime=${String(identity?.runtime_ready)}).`,
      );
    }
  } finally {
    try {
      if (runtime !== undefined) await runtime.end();
    } finally {
      try {
        if (credentialChangeAttempted) {
          await administrator.query("alter role app_runtime_production nologin password null");
        }
      } finally {
        await administrator.end();
      }
    }
  }
}

function applicationEnvironment(values, dalDatabaseUrl, appUrl, backofficeRuntimeUnlockKey) {
  return [
    "APP_ENV=local",
    "APP_RELEASE_SHA=local",
    ...(backofficeRuntimeUnlockKey === undefined
      ? []
      : [`BACKOFFICE_RUNTIME_UNLOCK_KEY=${backofficeRuntimeUnlockKey}`]),
    `NEXT_PUBLIC_APP_URL=${appUrl}`,
    `NEXT_PUBLIC_SUPABASE_URL=${values.API_URL}`,
    `NEXT_PUBLIC_SUPABASE_ANON_KEY=${values.ANON_KEY}`,
    ...(appUrl === localApplicationContracts.web.expectedApplicationUrl
      ? [`SUPABASE_SECRET_KEY=${values.SERVICE_ROLE_KEY}`]
      : []),
    `DATABASE_URL_APP_DAL=${dalDatabaseUrl}`,
    "",
  ].join("\n");
}

async function resetLocalEnvironment() {
  process.stdout.write("Iniciando a stack Supabase local...\n");
  startLocalSupabase();
  process.stdout.write("Reaplicando migrations e seed...\n");
  runSupabase(["db", "reset", "--local"], { capture: true, network: true });
  reconcileSupabaseNetworkAfterReset();
  const values = localStatus();
  process.stdout.write("Executando o cleanup local real...\n");
  await runLocalMediaCleanup(values);
  process.stdout.write("Provisionando a role DAL local...\n");
  const { dalDatabaseUrl, databaseMarker } = await provisionLocalRuntime(values);
  const backofficeRuntimeUnlockKey = randomBytes(32).toString("base64url");

  await Promise.all([
    writePrivateEnvironment(
      resolve(repositoryRoot, ".env.local"),
      applicationEnvironment(values, dalDatabaseUrl, "http://127.0.0.1:3000"),
    ),
    writePrivateEnvironment(
      resolve(repositoryRoot, "apps/backoffice/.env.local"),
      applicationEnvironment(
        values,
        dalDatabaseUrl,
        "http://127.0.0.1:3001",
        backofficeRuntimeUnlockKey,
      ),
    ),
    writePrivateEnvironment(
      resolve(repositoryRoot, ".env.e2e.local"),
      [
        "E2E_ALLOW_LOCAL=1",
        "E2E_BASE_URL=http://127.0.0.1:3000",
        "E2E_BACKOFFICE_URL=http://127.0.0.1:3001",
        `BACKOFFICE_RUNTIME_UNLOCK_KEY=${backofficeRuntimeUnlockKey}`,
        `E2E_DATABASE_MARKER=${databaseMarker}`,
        `NEXT_PUBLIC_SUPABASE_URL=${values.API_URL}`,
        `NEXT_PUBLIC_SUPABASE_ANON_KEY=${values.ANON_KEY}`,
        `SUPABASE_SECRET_KEY=${values.SERVICE_ROLE_KEY}`,
        `DATABASE_URL_APP_DAL=${dalDatabaseUrl}`,
        `E2E_DATABASE_URL=${values.DB_URL}`,
        "",
      ].join("\n"),
    ),
  ]);
  process.stdout.write("Supabase local reiniciado e ambientes de desenvolvimento atualizados.\n");
}

function stopScopedSupabaseStack(environment = assertLocalDockerDaemon()) {
  runSupabase(["stop", "--project-id", supabaseLocalProjectId], { capture: true });
  assertSupabaseProjectStopped(environment);
}

function startLocalSupabase() {
  const environment = assertLocalDockerDaemon();
  const stackIsRunning = waitForSupabaseProjectStartup({
    readState: () => supabaseProjectStartupState(environment),
  });
  if (stackIsRunning) {
    try {
      assertSupabaseLoopbackBindings(environment);
    } catch {
      stopScopedSupabaseStack(environment);
    }
  }
  ensureSupabaseLoopbackNetwork(environment);
  try {
    runSupabase(["start"], { capture: true, network: true });
    assertSupabaseLoopbackBindings(environment);
  } catch (error) {
    if (supabaseProjectContainersAreRunning(environment)) stopScopedSupabaseStack(environment);
    throw error;
  }
}

export function reconcileSupabaseNetworkAfterReset({
  assertBindings = assertSupabaseLoopbackBindings,
  environment = assertLocalDockerDaemon(),
  startStack = startLocalSupabase,
  stopStack = stopScopedSupabaseStack,
} = {}) {
  try {
    assertBindings(environment);
    return false;
  } catch {
    stopStack(environment);
    startStack();
    return true;
  }
}

export async function main(command = "reset") {
  const nextBuildCommand = /^build-(web|backoffice)$/u.exec(command);
  if (nextBuildCommand !== null) {
    await runNextBuildWithCacheCleanup({ application: nextBuildCommand[1] });
    return;
  }
  const localApplicationCommand = /^(dev|start)-(web|backoffice)$/u.exec(command);
  if (localApplicationCommand !== null) {
    await runLocalApplication(localApplicationCommand[2], localApplicationCommand[1]);
    return;
  }
  if (command === "start") {
    startLocalSupabase();
    localStatus();
    process.stdout.write("Supabase local ativo em 127.0.0.1:54321.\n");
    return;
  }
  if (command === "stop") {
    stopScopedSupabaseStack();
    return;
  }
  if (command === "status") {
    localStatus();
    process.stdout.write("Supabase local ativo em 127.0.0.1:54321.\n");
    return;
  }
  if (command === "reset") {
    await resetLocalEnvironment();
    return;
  }

  const values = localStatus();
  if (command === "cleanup") {
    await runLocalMediaCleanup(values);
    process.stdout.write("Cleanup local concluído em estado terminal saudável.\n");
  } else if (command === "generate-schema") {
    await generateDatabaseArtifacts(runSupabase, { schema: true, types: false });
  } else if (command === "generate-types") {
    await generateDatabaseArtifacts(runSupabase, { schema: false, types: true });
  } else if (command === "generate") {
    await generateDatabaseArtifacts(runSupabase);
  } else if (command === "lint") {
    runSupabase(
      [
        "db",
        "lint",
        "--local",
        "--schema",
        applicationDatabaseSchemas.join(","),
        "--level",
        "warning",
        "--fail-on",
        "warning",
      ],
      { network: true },
    );
  } else if (command === "test") {
    runDatabaseTests(values);
    await verifyProductionRoleStartupAssumption(values);
    await verifyDatabaseArtifacts(runSupabase);
    process.stdout.write("Testes SQL e artefatos gerados estão consistentes.\n");
  } else {
    throw new Error(`Comando local desconhecido: ${command}.`);
  }
}

const executedPath = process.argv[1];
if (executedPath !== undefined && pathToFileURL(resolve(executedPath)).href === import.meta.url) {
  await main(process.argv[2]);
}

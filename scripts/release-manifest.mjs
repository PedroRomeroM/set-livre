import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  collectCleanupFailures,
  deterministicReleaseTarArguments,
  ensurePhysicalArtifactsRoot,
  operationalEnvironment,
  readReleaseRuntimeEnvironmentFile,
  redactEnvironmentSecrets,
  releaseBuildEnvironment,
  releaseSmokeEnvironment,
  secretEnvironmentEntries,
  throwIfPrimaryOrCleanupFailed,
  withExclusiveReleaseLock,
} from "./release-guards.mjs";
import { runPackagedReleaseSmokeWithProcessCleanup } from "./release-process-tree.mjs";
import { removePhysicalTree } from "./physical-tree-removal.mjs";
import { resolveTrustedNpmCliLaunch } from "./trusted-npm-cli.mjs";

const root = resolve(import.meta.dirname, "..");
const artifactsRoot = resolve(root, ".artifacts");
const releaseRoot = resolve(artifactsRoot, "release");
const manifestPath = resolve(releaseRoot, "manifest.json");
const migrationsSource = resolve(root, "supabase/migrations");
const nextExecutable = resolve(root, "node_modules/next/dist/bin/next");
const applications = [
  {
    application: "web",
    buildIdDestination: ".next/BUILD_ID",
    buildIdSource: resolve(root, ".next/BUILD_ID"),
    entrypoint: "server.js",
    expectedApplicationUrl: "http://127.0.0.1:3000",
    packageRoot: resolve(releaseRoot, "web"),
    projectRoot: root,
    publicDestination: "public",
    publicSource: resolve(root, "public"),
    runtimeEnvironmentSource: resolve(root, ".env.local"),
    standaloneSource: resolve(root, ".next/standalone"),
    staticDestination: ".next/static",
    staticSource: resolve(root, ".next/static"),
  },
  {
    application: "backoffice",
    buildIdDestination: "apps/backoffice/.next/BUILD_ID",
    buildIdSource: resolve(root, "apps/backoffice/.next/BUILD_ID"),
    entrypoint: "apps/backoffice/server.js",
    expectedApplicationUrl: "http://127.0.0.1:3001",
    packageRoot: resolve(releaseRoot, "backoffice"),
    projectRoot: resolve(root, "apps/backoffice"),
    publicDestination: "apps/backoffice/public",
    publicSource: resolve(root, "apps/backoffice/public"),
    runtimeEnvironmentSource: resolve(root, "apps/backoffice/.env.local"),
    standaloneSource: resolve(root, "apps/backoffice/.next/standalone"),
    staticDestination: "apps/backoffice/.next/static",
    staticSource: resolve(root, "apps/backoffice/.next/static"),
  },
];

function git(arguments_) {
  return execFileSync("git", arguments_, {
    cwd: root,
    encoding: "utf8",
    env: operationalEnvironment(process.env),
  }).trim();
}

function assertCleanWorktree(stage) {
  const status = git(["status", "--porcelain", "--untracked-files=all"]);
  if (status !== "") {
    throw new Error(`O checkout precisa permanecer limpo ${stage}.`);
  }
}

function currentCommit() {
  const commit = git(["rev-parse", "--verify", "HEAD^{commit}"]);
  if (!/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error("Não foi possível capturar um SHA Git completo para a release.");
  }
  return commit;
}

function currentCommitTimestamp(commit) {
  const timestamp = git(["show", "-s", "--format=%ct", commit]);
  if (!/^\d+$/u.test(timestamp)) {
    throw new Error("Não foi possível capturar o timestamp do commit da release.");
  }
  return timestamp;
}

function currentNpmVersion() {
  return resolveTrustedNpmCliLaunch({ repositoryRoot: root }).npmVersion;
}

function assertSameCommit(expectedCommit, stage) {
  if (currentCommit() !== expectedCommit) {
    throw new Error(`O SHA do checkout mudou ${stage}; a release foi interrompida.`);
  }
}

function isInside(parent, child) {
  const pathFromParent = relative(parent, child);
  return (
    pathFromParent === "" ||
    (pathFromParent !== ".." &&
      !pathFromParent.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromParent))
  );
}

function normalizedRelative(parent, child) {
  const pathFromParent = relative(parent, child);
  if (!isInside(parent, child) || pathFromParent === "") {
    throw new Error(`Caminho inválido fora da raiz esperada: ${child}`);
  }
  return pathFromParent.split(sep).join("/");
}

function compareDirectoryEntries(left, right) {
  if (left.name === right.name) {
    return 0;
  }
  return left.name < right.name ? -1 : 1;
}

function nodes(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .sort(compareDirectoryEntries)
    .flatMap((entry) => {
      const child = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        return [child, ...nodes(child)];
      }
      if (entry.isFile() || entry.isSymbolicLink()) {
        return [child];
      }
      throw new Error(`Artefato com tipo não suportado: ${child}`);
    });
}

function pathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function requireDirectory(path, description) {
  if (!pathExists(path) || !lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) {
    throw new Error(`${description} não é um diretório regular: ${path}`);
  }
}

function requireRegularFile(path, description) {
  if (!pathExists(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
    throw new Error(`${description} não é um arquivo regular: ${path}`);
  }
  if (lstatSync(path).size === 0) {
    throw new Error(`${description} está vazio: ${path}`);
  }
}

function assertSafeTree(directory, description) {
  requireDirectory(directory, description);
  for (const path of nodes(directory)) {
    if (basename(path).startsWith(".env")) {
      throw new Error(`${description} contém configuração local proibida: ${path}`);
    }

    const information = lstatSync(path);
    if (information.isSymbolicLink()) {
      let target;
      try {
        target = realpathSync(path);
      } catch {
        throw new Error(`${description} contém link simbólico quebrado: ${path}`);
      }
      if (!isInside(directory, target)) {
        throw new Error(`${description} contém link simbólico que escapa do pacote: ${path}`);
      }
    }
  }
}

function assertNoUnexpectedNextEnvironmentFiles(application) {
  const applicationRoot = dirname(application.runtimeEnvironmentSource);
  for (const name of [".env", ".env.production", ".env.production.local"]) {
    const path = resolve(applicationRoot, name);
    if (pathExists(path)) {
      throw new Error(
        `${application.application} contém ${name}; a release local aceita somente .env.local.`,
      );
    }
  }
}

function runtimeEnvironment(application, commit, port, localEnvironment) {
  return releaseSmokeEnvironment(process.env, localEnvironment, {
    APP_RELEASE_SHA: commit,
    HOSTNAME: "127.0.0.1",
    NODE_ENV: "production",
    PORT: String(port),
  });
}

function assertKnownSecretsAbsent(directory, description, environments) {
  const sensitiveValues = secretEnvironmentEntries(...environments);
  if (sensitiveValues.length === 0) {
    return;
  }

  for (const path of nodes(directory)) {
    if (!lstatSync(path).isFile()) {
      continue;
    }
    const contents = readFileSync(path);
    for (const [name, value] of sensitiveValues) {
      if (contents.includes(Buffer.from(value))) {
        throw new Error(`${description} incorporou o secret ${name} em ${path}.`);
      }
    }
  }
}

function prepareDestination(sourceInformation, destination) {
  if (!pathExists(destination)) {
    return;
  }

  const destinationInformation = lstatSync(destination);
  if (sourceInformation.isDirectory()) {
    if (!destinationInformation.isDirectory() || destinationInformation.isSymbolicLink()) {
      throw new Error(`Colisão insegura ao criar diretório de release: ${destination}`);
    }
    return;
  }
  if (destinationInformation.isDirectory() && !destinationInformation.isSymbolicLink()) {
    throw new Error(`Colisão insegura ao criar arquivo de release: ${destination}`);
  }
  unlinkSync(destination);
}

function copyNode(source, destination, sourceRoot, destinationRoot) {
  if (basename(source).startsWith(".env")) {
    throw new Error(`Tentativa de empacotar configuração local proibida: ${source}`);
  }

  const information = lstatSync(source);
  prepareDestination(information, destination);

  if (information.isDirectory()) {
    mkdirSync(destination, { recursive: true });
    for (const entry of readdirSync(source, { withFileTypes: true }).sort(
      compareDirectoryEntries,
    )) {
      copyNode(
        resolve(source, entry.name),
        resolve(destination, entry.name),
        sourceRoot,
        destinationRoot,
      );
    }
    return;
  }

  mkdirSync(dirname(destination), { recursive: true });
  if (information.isFile()) {
    copyFileSync(source, destination);
    return;
  }

  if (information.isSymbolicLink()) {
    const resolvedSourceTarget = realpathSync(source);
    if (!isInside(sourceRoot, resolvedSourceTarget)) {
      throw new Error(`Link simbólico de origem escapa do pacote: ${source}`);
    }
    const destinationTarget = resolve(destinationRoot, relative(sourceRoot, resolvedSourceTarget));
    if (!isInside(destinationRoot, destinationTarget)) {
      throw new Error(`Link simbólico de destino escaparia do pacote: ${destination}`);
    }
    const linkTarget = relative(dirname(destination), destinationTarget) || ".";
    const targetInformation = lstatSync(resolvedSourceTarget);
    symlinkSync(linkTarget, destination, targetInformation.isDirectory() ? "dir" : "file");
    return;
  }

  throw new Error(`Tipo de artefato não suportado: ${source}`);
}

function copyTree(source, destination, description) {
  assertSafeTree(source, description);
  copyNode(source, destination, source, destination);
  assertSafeTree(destination, `${description} empacotado`);
}

function copyRequiredFile(source, destination, description) {
  requireRegularFile(source, description);
  if (basename(source).startsWith(".env") || basename(destination).startsWith(".env")) {
    throw new Error(`Tentativa de empacotar configuração local proibida: ${source}`);
  }
  mkdirSync(dirname(destination), { recursive: true });
  prepareDestination(lstatSync(source), destination);
  copyFileSync(source, destination);
}

function readBuildId(path, description) {
  requireRegularFile(path, description);
  const buildId = readFileSync(path, "utf8").trim();
  if (buildId === "" || buildId.includes("\n") || buildId.includes("\r")) {
    throw new Error(`${description} é inválido.`);
  }
  return buildId;
}

function removeGeneratedPath(path, allowedPaths) {
  ensurePhysicalArtifactsRoot(root, artifactsRoot);
  if (!allowedPaths.has(path) || !isInside(artifactsRoot, path)) {
    throw new Error(`Recusa de remoção fora do artefato exato autorizado: ${path}`);
  }
  removePhysicalTree(path, {
    allowRegularFile: true,
    description: `O caminho gerado de release ${path}`,
    messages: {
      directoryRequiredMessage: `O caminho gerado de release não é removível com segurança: ${path}`,
      mountDetectedMessage: `O caminho gerado de release não pode conter mounts: ${path}`,
      mountUnverifiedMessage: `Não foi possível comprovar que o caminho gerado de release não contém mounts: ${path}`,
      unsupportedPlatformMessage: `O diretório gerado de release precisa ser removido manualmente nesta plataforma: ${path}`,
    },
    retiredNamePrefix: `.${basename(path)}.release-retired-`,
  });
}

function sha256Buffer(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(path) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectHash);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

async function artifactEntry(base, path) {
  const information = lstatSync(path);
  const entryPath = normalizedRelative(base, path);
  if (information.isFile()) {
    return {
      path: entryPath,
      sha256: await sha256File(path),
      size: information.size,
      type: "file",
    };
  }
  if (information.isSymbolicLink()) {
    const target = readlinkSync(path);
    return {
      path: entryPath,
      sha256: sha256Buffer(Buffer.from(target)),
      size: Buffer.byteLength(target),
      target,
      type: "symlink",
    };
  }
  throw new Error(`Artefato não manifestável: ${path}`);
}

async function artifactEntries(base) {
  const entries = [];
  for (const path of nodes(base)) {
    const information = lstatSync(path);
    if (information.isFile() || information.isSymbolicLink()) {
      entries.push(await artifactEntry(base, path));
    }
  }
  return entries;
}

function treeShape(base) {
  return nodes(base)
    .map((path) => {
      const information = lstatSync(path);
      const type = information.isDirectory()
        ? "directory"
        : information.isSymbolicLink()
          ? "symlink"
          : "file";
      return `${type}:${normalizedRelative(base, path)}`;
    })
    .sort();
}

function assertTreeShape(base, expectedShape, description) {
  if (JSON.stringify(treeShape(base)) !== JSON.stringify(expectedShape)) {
    throw new Error(`${description} contém nó ausente, extra ou com tipo divergente.`);
  }
}

async function verifyEntries(base, entries, description) {
  const expectedPaths = entries.map((entry) => `${entry.type}:${entry.path}`).sort();
  const actualPaths = nodes(base)
    .filter((path) => {
      const information = lstatSync(path);
      return information.isFile() || information.isSymbolicLink();
    })
    .map((path) => {
      const information = lstatSync(path);
      return `${information.isSymbolicLink() ? "symlink" : "file"}:${normalizedRelative(base, path)}`;
    })
    .sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error(`${description} contém artefato ausente, extra ou com tipo divergente.`);
  }

  for (const entry of entries) {
    const path = resolve(base, entry.path);
    if (!isInside(base, path) || normalizedRelative(base, path) !== entry.path) {
      throw new Error(`${description} possui caminho inseguro no manifesto: ${entry.path}`);
    }
    if (!pathExists(path)) {
      throw new Error(`${description} perdeu o artefato: ${entry.path}`);
    }

    const information = lstatSync(path);
    if (entry.type === "file") {
      if (!information.isFile() || information.isSymbolicLink()) {
        throw new Error(`${description} mudou o tipo de ${entry.path}.`);
      }
      if (information.size !== entry.size || (await sha256File(path)) !== entry.sha256) {
        throw new Error(`${description} falhou na verificação de ${entry.path}.`);
      }
      continue;
    }

    if (entry.type !== "symlink" || !information.isSymbolicLink()) {
      throw new Error(`${description} mudou o tipo de ${entry.path}.`);
    }
    const target = readlinkSync(path);
    if (
      target !== entry.target ||
      Buffer.byteLength(target) !== entry.size ||
      sha256Buffer(Buffer.from(target)) !== entry.sha256 ||
      !isInside(base, realpathSync(path))
    ) {
      throw new Error(`${description} falhou na verificação do link ${entry.path}.`);
    }
  }
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function listen(server) {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
}

function close(server) {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
  });
}

async function availablePorts(count) {
  const reservations = Array.from({ length: count }, () => createServer());
  try {
    await Promise.all(reservations.map((server) => listen(server)));
    return reservations.map((server) => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Não foi possível reservar uma porta local para o smoke test.");
      }
      return address.port;
    });
  } finally {
    await Promise.all(
      reservations.filter((server) => server.listening).map((server) => close(server)),
    );
  }
}

function startPackagedServer(application, environment) {
  const entrypoint = resolve(application.packageRoot, application.entrypoint);
  requireRegularFile(entrypoint, `Entrypoint empacotado de ${application.application}`);
  const child = spawn(process.execPath, [entrypoint], {
    cwd: dirname(entrypoint),
    detached: process.platform !== "win32",
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const state = {
    application: application.application,
    child,
    exited: false,
    logs: "",
    runtimeEnvironment: environment,
    spawnError: undefined,
  };
  const capture = (chunk) => {
    state.logs = `${state.logs}${chunk.toString("utf8")}`.slice(-16_384);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  child.once("error", (error) => {
    state.exited = true;
    state.spawnError = error;
  });
  child.once("exit", () => {
    state.exited = true;
  });
  return state;
}

async function waitUntilListening(state, baseUrl) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (state.exited) {
      throw new Error(
        `O processo ${state.application} encerrou antes do smoke test${
          state.spawnError === undefined ? "" : `: ${state.spawnError.message}`
        }.\n${redactEnvironmentSecrets(state.logs, state.runtimeEnvironment)}`,
      );
    }
    try {
      const response = await fetch(baseUrl, { signal: AbortSignal.timeout(1_000) });
      if (response.status === 200) {
        await response.body?.cancel();
        return;
      }
      await response.body?.cancel();
    } catch {
      // A porta ainda não está aceitando conexões.
    }
    await delay(200);
  }
  throw new Error(
    `Timeout ao iniciar o processo empacotado ${state.application}.\n${redactEnvironmentSecrets(state.logs, state.runtimeEnvironment)}`,
  );
}

async function expectPage(url, description, expectedStatus = 200, headers = {}) {
  const response = await fetch(url, {
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(5_000),
  });
  const body = await response.text();
  if (response.status !== expectedStatus) {
    throw new Error(`${description} retornou HTTP ${response.status}, esperado ${expectedStatus}.`);
  }
  if (!response.headers.get("content-type")?.includes("text/html") || body.trim() === "") {
    throw new Error(`${description} não apresentou um documento HTML válido.`);
  }
  return { body, response };
}

async function expectHealth(baseUrl, application, status, commit) {
  const path = `/api/health/${status === "live" ? "live" : "ready"}`;
  const requestId = randomUUID();
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { "x-request-id": requestId },
    redirect: "manual",
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status !== 200) {
    throw new Error(`${application}${path} retornou HTTP ${response.status}, esperado 200.`);
  }
  const payload = await response.json();
  if (
    payload?.application !== application ||
    payload?.status !== status ||
    payload?.release !== commit ||
    payload?.requestId !== requestId
  ) {
    throw new Error(`${application}${path} violou o contrato de health da release.`);
  }
  if (response.headers.get("x-request-id") !== payload.requestId) {
    throw new Error(`${application}${path} não preservou o requestId autoritativo.`);
  }
}

function staticAssetPath(application) {
  const staticRoot = resolve(application.packageRoot, application.staticDestination);
  const staticFile = nodes(staticRoot).find((path) => lstatSync(path).isFile());
  if (staticFile === undefined) {
    throw new Error(`${application.application} não possui asset estático empacotado.`);
  }
  return `/_next/static/${normalizedRelative(staticRoot, staticFile)
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
}

async function expectStaticAsset(baseUrl, application) {
  const path = staticAssetPath(application);
  const response = await fetch(`${baseUrl}${path}`, {
    redirect: "manual",
    signal: AbortSignal.timeout(5_000),
  });
  const body = await response.arrayBuffer();
  if (
    response.status !== 200 ||
    body.byteLength === 0 ||
    !(response.headers.get("cache-control") ?? "").includes("immutable")
  ) {
    throw new Error(`${application.application}${path} não serviu o asset empacotado.`);
  }
  return {
    nonce: expectProductionPolicy(application.application, response),
    path,
  };
}

function scriptSourceDirective(contentSecurityPolicy) {
  return (
    contentSecurityPolicy
      .split(";")
      .map((directive) => directive.trim())
      .find((directive) => directive.startsWith("script-src ")) ?? ""
  );
}

function expectProductionPolicy(application, response) {
  const contentSecurityPolicy = response.headers.get("content-security-policy") ?? "";
  const scriptSource = scriptSourceDirective(contentSecurityPolicy);
  const nonceMatches = [...scriptSource.matchAll(/'nonce-([a-f0-9]{32})'/gu)];
  if (
    response.headers.has("x-powered-by") ||
    response.headers.get("x-content-type-options") !== "nosniff" ||
    response.headers.get("x-frame-options") !== "DENY" ||
    !contentSecurityPolicy.includes("frame-ancestors 'none'") ||
    !contentSecurityPolicy.includes("object-src 'none'") ||
    nonceMatches.length !== 1 ||
    !scriptSource.includes("'strict-dynamic'") ||
    scriptSource.includes("'unsafe-inline'") ||
    scriptSource.includes("'unsafe-eval'") ||
    contentSecurityPolicy.includes("127.0.0.1") ||
    contentSecurityPolicy.includes("ws:")
  ) {
    throw new Error(`${application} não serviu a CSP de produção esperada.`);
  }
  return nonceMatches[0]?.[1] ?? "";
}

function expectProductionSecurityDocument(application, { body, response }) {
  const nonce = expectProductionPolicy(application, response);
  const scriptTags = body.match(/<script(?:\s[^>]*)?>/gu) ?? [];
  if (
    !(response.headers.get("cache-control") ?? "").includes("no-store") ||
    scriptTags.length === 0 ||
    scriptTags.some((scriptTag) => !scriptTag.includes(`nonce="${nonce}"`))
  ) {
    throw new Error(
      `${application} não serviu HTML e headers CSP de produção coerentes com nonce.`,
    );
  }
  return nonce;
}

function expectProductionGlobalErrorDocument(application, { body, response }) {
  const nonce = expectProductionPolicy(application, response);
  const scriptTags = body.match(/<script(?:\s[^>]*)?>/gu) ?? [];
  if (
    !(response.headers.get("cache-control") ?? "").includes("no-store") ||
    scriptTags.length !== 0 ||
    !body.includes("Tente novamente")
  ) {
    throw new Error(`${application} não serviu o fallback global seguro de produção.`);
  }
  return nonce;
}

async function expectStaticAssetErrorsCannotBypassProductionPolicy(
  baseUrl,
  application,
  assetPath,
  assetNonce,
) {
  const assetUrl = `${baseUrl}${assetPath}`;
  const probes = [
    { description: "método inválido", init: { method: "POST" }, url: assetUrl },
    {
      description: "range inválido",
      init: { headers: { range: "bytes=999999999999999999-" } },
      url: assetUrl,
    },
    {
      description: "path inválido",
      init: {},
      url: `${baseUrl}/_next/static/%2F`,
    },
  ];
  const nonces = [assetNonce];
  for (const probe of probes) {
    const response = await fetch(probe.url, {
      ...probe.init,
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
    });
    const body = await response.text();
    if (response.status < 400) {
      throw new Error(
        `${application} aceitou ${probe.description} no asset com HTTP ${response.status}.`,
      );
    }
    const nonce = expectProductionPolicy(application, response);
    nonces.push(nonce);
    if ((response.headers.get("content-type") ?? "").includes("text/html")) {
      const scriptTags = body.match(/<script(?:\s[^>]*)?>/gu) ?? [];
      if (
        !(response.headers.get("cache-control") ?? "").includes("no-store") ||
        scriptTags.some((scriptTag) => !scriptTag.includes(`nonce="${nonce}"`))
      ) {
        throw new Error(`${application} serviu erro HTML de asset sem nonce e no-store.`);
      }
    }
  }
  if (new Set(nonces).size !== nonces.length) {
    throw new Error(`${application} reutilizou nonce CSP entre asset e respostas adversariais.`);
  }
}

async function smokePackagedApplications(commit, localEnvironments) {
  const ports = await availablePorts(applications.length);
  await runPackagedReleaseSmokeWithProcessCleanup({
    smokeOperation: async (states) => {
      await Promise.all(
        states.map((state, index) => waitUntilListening(state, `http://127.0.0.1:${ports[index]}`)),
      );
      const rootPages = [];
      for (const [index, application] of applications.entries()) {
        const baseUrl = `http://127.0.0.1:${ports[index]}`;
        const firstDocument = await expectPage(baseUrl, `${application.application}/`);
        const secondDocument = await expectPage(baseUrl, `${application.application}/ novamente`);
        const purposePrefetchDocument = await expectPage(
          baseUrl,
          `${application.application}/ com Purpose: prefetch`,
          200,
          { purpose: "prefetch" },
        );
        const routerPrefetchDocument = await expectPage(
          baseUrl,
          `${application.application}/ com next-router-prefetch`,
          200,
          { "next-router-prefetch": "1" },
        );
        const lookalikeDocument = await expectPage(
          `${baseUrl}/apiary`,
          `${application.application}/apiary`,
          404,
        );
        const globalErrorDocument = await expectPage(
          `${baseUrl}/_global-error`,
          `${application.application}/_global-error`,
          500,
        );
        const firstNonce = expectProductionSecurityDocument(application.application, firstDocument);
        const secondNonce = expectProductionSecurityDocument(
          application.application,
          secondDocument,
        );
        const purposePrefetchNonce = expectProductionSecurityDocument(
          application.application,
          purposePrefetchDocument,
        );
        const routerPrefetchNonce = expectProductionSecurityDocument(
          application.application,
          routerPrefetchDocument,
        );
        const lookalikeNonce = expectProductionSecurityDocument(
          application.application,
          lookalikeDocument,
        );
        const globalErrorNonce = expectProductionGlobalErrorDocument(
          application.application,
          globalErrorDocument,
        );
        const requestNonces = [
          firstNonce,
          secondNonce,
          purposePrefetchNonce,
          routerPrefetchNonce,
          lookalikeNonce,
          globalErrorNonce,
        ];
        if (new Set(requestNonces).size !== requestNonces.length) {
          throw new Error(`${application.application} reutilizou o nonce CSP entre requests.`);
        }
        rootPages.push(firstDocument.body);
        await expectHealth(baseUrl, application.application, "live", commit);
        await expectHealth(baseUrl, application.application, "ready", commit);
        const staticAsset = await expectStaticAsset(baseUrl, application);
        await expectStaticAssetErrorsCannotBypassProductionPolicy(
          baseUrl,
          application.application,
          staticAsset.path,
          staticAsset.nonce,
        );
      }
      if (rootPages[0] === rootPages[1]) {
        throw new Error("Web e backoffice serviram o mesmo documento na raiz.");
      }
      await expectPage(`http://127.0.0.1:${ports[0]}/admin`, "web/admin", 404);
    },
    startProcesses: (registerState) => {
      for (const [index, application] of applications.entries()) {
        const port = ports[index];
        if (port === undefined) {
          throw new Error(`Porta local ausente para ${application.application}.`);
        }
        registerState(
          startPackagedServer(
            application,
            runtimeEnvironment(
              application,
              commit,
              port,
              localEnvironments[application.application],
            ),
          ),
        );
      }
    },
  });
}

function expectedArchiveListing() {
  return [
    `${basename(releaseRoot)}/`,
    ...nodes(releaseRoot).map((path) => {
      const suffix = lstatSync(path).isDirectory() ? "/" : "";
      return `${basename(releaseRoot)}/${normalizedRelative(releaseRoot, path)}${suffix}`;
    }),
  ].sort();
}

async function validateExistingArchive(archivePath, checksumPath) {
  const archiveExists = pathExists(archivePath);
  const checksumExists = pathExists(checksumPath);
  if (archiveExists !== checksumExists) {
    throw new Error("A release existente possui arquivo ou checksum órfão.");
  }
  if (!archiveExists) {
    return undefined;
  }
  requireRegularFile(archivePath, "Arquivo global existente da release");
  requireRegularFile(checksumPath, "Checksum existente da release");
  const sha256 = await sha256File(archivePath);
  if (readFileSync(checksumPath, "utf8").trim() !== `${sha256}  ${basename(archivePath)}`) {
    throw new Error("O checksum da release imutável existente é inválido.");
  }
  return { sha256, size: lstatSync(archivePath).size };
}

async function createArchive(
  commit,
  commitTimestamp,
  archivePath,
  checksumPath,
  incomingArchivePath,
  incomingChecksumPath,
  archiveVerificationRoot,
  expectedReleaseArtifacts,
  expectedReleaseShape,
) {
  let tarVersion;
  try {
    tarVersion = execFileSync("tar", ["--version"], {
      encoding: "utf8",
      env: operationalEnvironment(process.env),
    });
  } catch {
    throw new Error("GNU tar é obrigatório para criar o pacote global da release.");
  }
  if (!tarVersion.includes("GNU tar")) {
    throw new Error("A release reproduzível exige GNU tar.");
  }

  const existingArchive = await validateExistingArchive(archivePath, checksumPath);
  execFileSync(
    "tar",
    deterministicReleaseTarArguments({
      archivePath: incomingArchivePath,
      artifactsRoot,
      commitTimestamp,
      releaseRoot,
    }),
    {
      cwd: root,
      env: { ...operationalEnvironment(process.env), SOURCE_DATE_EPOCH: commitTimestamp },
      stdio: "inherit",
    },
  );
  requireRegularFile(incomingArchivePath, "Arquivo global candidato da release");
  const sha256 = await sha256File(incomingArchivePath);
  const size = lstatSync(incomingArchivePath).size;
  writeFileSync(incomingChecksumPath, `${sha256}  ${basename(archivePath)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  if (
    readFileSync(incomingChecksumPath, "utf8").trim() !== `${sha256}  ${basename(archivePath)}` ||
    (await sha256File(incomingArchivePath)) !== sha256
  ) {
    throw new Error("A verificação SHA-256 do arquivo global candidato falhou.");
  }

  const listing = execFileSync("tar", ["-tzf", incomingArchivePath], {
    cwd: root,
    encoding: "utf8",
    env: operationalEnvironment(process.env),
    maxBuffer: 128 * 1024 * 1024,
  })
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort();
  if (JSON.stringify(listing) !== JSON.stringify(expectedArchiveListing())) {
    throw new Error("O conteúdo do arquivo global da release é inseguro ou incompleto.");
  }

  mkdirSync(archiveVerificationRoot, { mode: 0o700 });
  execFileSync(
    "tar",
    [
      "-xzf",
      incomingArchivePath,
      "-C",
      archiveVerificationRoot,
      "--no-same-owner",
      "--no-same-permissions",
    ],
    {
      cwd: root,
      env: operationalEnvironment(process.env),
      stdio: "inherit",
    },
  );
  const extractedReleaseRoot = resolve(archiveVerificationRoot, basename(releaseRoot));
  assertSafeTree(extractedReleaseRoot, "Release reextraída do arquivo global");
  assertTreeShape(
    extractedReleaseRoot,
    expectedReleaseShape,
    "Release reextraída do arquivo global",
  );
  await verifyEntries(
    extractedReleaseRoot,
    expectedReleaseArtifacts,
    "Release reextraída do arquivo global",
  );

  if (existingArchive !== undefined) {
    if (existingArchive.sha256 !== sha256 || existingArchive.size !== size) {
      throw new Error(`A release imutável ${commit} já existe com conteúdo diferente.`);
    }
    unlinkSync(incomingArchivePath);
    unlinkSync(incomingChecksumPath);
  } else {
    renameSync(incomingArchivePath, archivePath);
    renameSync(incomingChecksumPath, checksumPath);
  }

  return {
    path: relative(root, archivePath).split(sep).join("/"),
    sha256,
    size,
  };
}

async function generateRelease(commit) {
  ensurePhysicalArtifactsRoot(root, artifactsRoot);
  const npmVersion = currentNpmVersion();
  const commitTimestamp = currentCommitTimestamp(commit);
  const archivePath = resolve(artifactsRoot, `set-livre-${commit}.tar.gz`);
  const checksumPath = `${archivePath}.sha256`;
  const incomingArchivePath = `${archivePath}.incoming`;
  const incomingChecksumPath = `${checksumPath}.incoming`;
  const archiveVerificationRoot = resolve(artifactsRoot, `archive-verification-${commit}.incoming`);
  const generatedPaths = new Set([
    releaseRoot,
    incomingArchivePath,
    incomingChecksumPath,
    archiveVerificationRoot,
  ]);
  for (const application of applications) {
    assertNoUnexpectedNextEnvironmentFiles(application);
  }
  const localEnvironments = Object.fromEntries(
    applications.map((application) => [
      application.application,
      readReleaseRuntimeEnvironmentFile(
        application.runtimeEnvironmentSource,
        application.expectedApplicationUrl,
      ),
    ]),
  );
  const secretSourceEnvironments = [process.env, ...Object.values(localEnvironments)];

  requireRegularFile(nextExecutable, "CLI Next.js fixada pelo lockfile");
  for (const application of applications) {
    execFileSync(process.execPath, [nextExecutable, "build"], {
      cwd: application.projectRoot,
      env: releaseBuildEnvironment(process.env, localEnvironments[application.application], commit),
      stdio: "inherit",
    });
  }
  assertSameCommit(commit, "durante o build");
  assertCleanWorktree("após o build");

  for (const application of applications) {
    requireDirectory(
      application.standaloneSource,
      `Standalone atual de ${application.application}`,
    );
    requireDirectory(application.staticSource, `Static atual de ${application.application}`);
    requireRegularFile(
      resolve(application.standaloneSource, application.entrypoint),
      `Entrypoint atual de ${application.application}`,
    );
    readBuildId(application.buildIdSource, `BUILD_ID atual de ${application.application}`);
  }
  assertSafeTree(migrationsSource, "Migrations atuais");

  for (const path of generatedPaths) {
    removeGeneratedPath(path, generatedPaths);
  }
  mkdirSync(releaseRoot, { recursive: true });

  const applicationManifests = {};
  for (const application of applications) {
    copyTree(
      application.standaloneSource,
      application.packageRoot,
      `Standalone de ${application.application}`,
    );
    copyTree(
      application.staticSource,
      resolve(application.packageRoot, application.staticDestination),
      `Static de ${application.application}`,
    );
    const publicDestination = resolve(application.packageRoot, application.publicDestination);
    if (existsSync(application.publicSource)) {
      copyTree(application.publicSource, publicDestination, `Public de ${application.application}`);
    } else {
      mkdirSync(publicDestination, { recursive: true });
    }
    copyRequiredFile(
      application.buildIdSource,
      resolve(application.packageRoot, application.buildIdDestination),
      `BUILD_ID de ${application.application}`,
    );

    const sourceBuildId = readBuildId(
      application.buildIdSource,
      `BUILD_ID atual de ${application.application}`,
    );
    const packagedBuildId = readBuildId(
      resolve(application.packageRoot, application.buildIdDestination),
      `BUILD_ID empacotado de ${application.application}`,
    );
    if (sourceBuildId !== commit || packagedBuildId !== commit) {
      throw new Error(
        `BUILD_ID de ${application.application} precisa ser igual ao SHA da release.`,
      );
    }
    requireRegularFile(
      resolve(application.packageRoot, application.entrypoint),
      `Entrypoint empacotado de ${application.application}`,
    );
    assertSafeTree(application.packageRoot, `Pacote ${application.application}`);
    assertKnownSecretsAbsent(
      application.packageRoot,
      `Pacote ${application.application}`,
      secretSourceEnvironments,
    );
    applicationManifests[application.application] = {
      artifacts: await artifactEntries(application.packageRoot),
      buildId: packagedBuildId,
      entrypoint: application.entrypoint,
      publicRoot: application.publicDestination,
      staticRoot: application.staticDestination,
    };
  }

  const packagedMigrationsRoot = resolve(releaseRoot, "supabase/migrations");
  copyTree(migrationsSource, packagedMigrationsRoot, "Migrations");
  const migrationArtifacts = await artifactEntries(packagedMigrationsRoot);
  const migrationFiles = migrationArtifacts.filter(
    (entry) => entry.type === "file" && entry.path.endsWith(".sql"),
  );
  if (migrationFiles.length === 0) {
    throw new Error("A release precisa conter ao menos uma migration SQL.");
  }
  for (const migration of migrationFiles) {
    if (!/^\d{14}_[a-z0-9_]+\.sql$/u.test(migration.path)) {
      throw new Error(`Nome de migration inválido no pacote: ${migration.path}`);
    }
  }

  const packageLockPath = resolve(root, "package-lock.json");
  requireRegularFile(packageLockPath, "Lockfile da release");
  const packagedLockPath = resolve(releaseRoot, "package-lock.json");
  copyRequiredFile(packageLockPath, packagedLockPath, "Lockfile da release");
  const packageLock = {
    path: "package-lock.json",
    sha256: await sha256File(packagedLockPath),
    size: lstatSync(packagedLockPath).size,
  };
  const manifest = {
    applications: applicationManifests,
    commit,
    migrations: {
      artifacts: migrationArtifacts,
      head: migrationFiles.at(-1).path,
      headVersion: migrationFiles.at(-1).path.slice(0, 14),
      root: "supabase/migrations",
    },
    packageLock,
    runtime: {
      arch: process.arch,
      node: process.version,
      npm: npmVersion,
      platform: process.platform,
    },
    schemaVersion: 1,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  for (const application of applications) {
    await verifyEntries(
      application.packageRoot,
      manifest.applications[application.application].artifacts,
      `Pacote ${application.application}`,
    );
  }
  await verifyEntries(packagedMigrationsRoot, manifest.migrations.artifacts, "Migrations");
  if (
    lstatSync(packagedLockPath).size !== manifest.packageLock.size ||
    (await sha256File(packagedLockPath)) !== manifest.packageLock.sha256
  ) {
    throw new Error("O lockfile mudou durante a geração da release.");
  }
  assertSafeTree(releaseRoot, "Release completa");
  assertKnownSecretsAbsent(releaseRoot, "Release completa", secretSourceEnvironments);
  const releaseArtifactsBeforeSmoke = await artifactEntries(releaseRoot);
  const releaseShapeBeforeSmoke = treeShape(releaseRoot);

  await smokePackagedApplications(commit, localEnvironments);
  for (const application of applications) {
    await verifyEntries(
      application.packageRoot,
      manifest.applications[application.application].artifacts,
      `Pacote ${application.application} após smoke`,
    );
  }
  await verifyEntries(
    packagedMigrationsRoot,
    manifest.migrations.artifacts,
    "Migrations após smoke",
  );
  if (
    lstatSync(packagedLockPath).size !== manifest.packageLock.size ||
    (await sha256File(packagedLockPath)) !== manifest.packageLock.sha256
  ) {
    throw new Error("O lockfile empacotado mudou durante o smoke.");
  }
  assertSafeTree(releaseRoot, "Release completa após smoke");
  assertKnownSecretsAbsent(releaseRoot, "Release completa após smoke", secretSourceEnvironments);
  assertTreeShape(releaseRoot, releaseShapeBeforeSmoke, "Release completa após smoke");
  await verifyEntries(releaseRoot, releaseArtifactsBeforeSmoke, "Release completa após smoke");

  let archive;
  let archiveFailure;
  try {
    ensurePhysicalArtifactsRoot(root, artifactsRoot);
    archive = await createArchive(
      commit,
      commitTimestamp,
      archivePath,
      checksumPath,
      incomingArchivePath,
      incomingChecksumPath,
      archiveVerificationRoot,
      releaseArtifactsBeforeSmoke,
      releaseShapeBeforeSmoke,
    );
  } catch (error) {
    archiveFailure = error;
  }

  const cleanupFailures = collectCleanupFailures(
    [incomingArchivePath, incomingChecksumPath, archiveVerificationRoot],
    pathExists,
    (path) => removeGeneratedPath(path, generatedPaths),
  );
  throwIfPrimaryOrCleanupFailed(archiveFailure, cleanupFailures, {
    combinedMessage:
      "A criação do arquivo global falhou e o cleanup físico também foi interrompido.",
    multipleCleanupMessage: "O cleanup físico de múltiplos caminhos gerados foi interrompido.",
  });
  assertSameCommit(commit, "durante o empacotamento");
  assertCleanWorktree("após o empacotamento");

  const fileCount = releaseArtifactsBeforeSmoke.length;
  process.stdout.write(
    `Release ${commit} validada em ${relative(root, releaseRoot)} com ${fileCount} artefatos; arquivo global ${archive.path} (${archive.sha256}).\n`,
  );
}

ensurePhysicalArtifactsRoot(root, artifactsRoot);
await withExclusiveReleaseLock(artifactsRoot, async () => {
  assertCleanWorktree("antes da release");
  const releaseCommit = currentCommit();
  let generationFailure;
  try {
    await generateRelease(releaseCommit);
  } catch (error) {
    generationFailure = error;
  }

  let finalStateFailure;
  try {
    assertSameCommit(releaseCommit, "ao finalizar a release");
    assertCleanWorktree("ao finalizar a release");
  } catch (error) {
    finalStateFailure = error;
  }

  if (generationFailure !== undefined && finalStateFailure !== undefined) {
    throw new AggregateError(
      [generationFailure, finalStateFailure],
      "A release falhou e o estado final do checkout também é inválido.",
    );
  }
  if (generationFailure !== undefined) {
    if (generationFailure.exitCode !== undefined) {
      process.stderr.write(`${generationFailure.message}\n`);
      process.exitCode = generationFailure.exitCode;
    } else {
      throw generationFailure;
    }
  }
  if (finalStateFailure !== undefined) {
    throw finalStateFailure;
  }
});

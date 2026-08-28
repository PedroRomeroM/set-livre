import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const repositoryRoot = resolve(import.meta.dirname, "..");
export const hostConfigurationFiles = Object.freeze([
  "ops/bootstrap-host.sh",
  "ops/certificates/supabase-root-2021-ca.crt",
  "ops/deploy-release.sh",
  "ops/deploy-ssh-command.sh",
  "ops/deploy-lock.py",
  "ops/nginx/set-livre-http.conf",
  "ops/nginx/set-livre-tls.conf",
  "ops/systemd/set-livre-application-start.service",
  "ops/systemd/set-livre-backoffice.service",
  "ops/systemd/set-livre-release-recovery.path",
  "ops/systemd/set-livre-release-recovery.service",
  "ops/systemd/set-livre-web.service",
]);

function gitCommit(root) {
  return execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
}

function requireDirectory(path, label) {
  const metadata = lstatSync(path, { throwIfNoEntry: false });
  if (metadata === undefined) {
    throw new Error(`${label} não existe. Execute o build antes de empacotar a release.`);
  }
  if (metadata.isSymbolicLink()) {
    throw new Error(`${label} não pode ser link simbólico ou junction.`);
  }
  if (!metadata.isDirectory()) {
    throw new Error(`${label} não existe. Execute o build antes de empacotar a release.`);
  }
  return realpathSync(path);
}

function requireContainedDirectory(path, label, boundary) {
  const canonicalPath = requireDirectory(path, label);
  if (!isWithinDirectory(boundary, canonicalPath)) {
    throw new Error(`${label} saiu da raiz física do repositório.`);
  }
  return canonicalPath;
}

function requireFile(path, label, boundary) {
  const metadata = lstatSync(path, { throwIfNoEntry: false });
  if (metadata === undefined || !metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} não existe. Execute o build antes de empacotar a release.`);
  }
  const canonicalPath = realpathSync(path);
  if (boundary !== undefined && !isWithinDirectory(boundary, canonicalPath)) {
    throw new Error(`${label} saiu da raiz física do repositório.`);
  }
  return canonicalPath;
}

export function hostConfigurationDigest(root = repositoryRoot) {
  const canonicalRoot = requireDirectory(resolve(root), "raiz do repositório");
  const hash = createHash("sha256");
  for (const path of hostConfigurationFiles) {
    const absolutePath = resolve(canonicalRoot, path);
    requireFile(absolutePath, path, canonicalRoot);
    hash.update(path.slice("ops/".length), "utf8");
    hash.update("\0", "utf8");
    hash.update(readFileSync(absolutePath));
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

function isWithinDirectory(directory, candidate) {
  const path = relative(directory, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function copyMaterializedEntry(source, destination, allowedRoots, ancestorDirectories) {
  const sourceMetadata = lstatSync(source);
  let materializedSource = source;

  if (sourceMetadata.isSymbolicLink()) {
    materializedSource = realpathSync(source);
    if (!allowedRoots.some((root) => isWithinDirectory(root, materializedSource))) {
      throw new Error(`Link do standalone saiu da raiz permitida: ${source}.`);
    }
  }

  const materializedMetadata = statSync(materializedSource);
  if (materializedMetadata.isFile()) {
    mkdirSync(resolve(destination, ".."), { recursive: true });
    copyFileSync(materializedSource, destination);
    chmodSync(destination, materializedMetadata.mode & 0o777);
    return;
  }
  if (!materializedMetadata.isDirectory()) {
    throw new Error(`Entrada especial não autorizada na release: ${source}.`);
  }

  const canonicalDirectory = realpathSync(materializedSource);
  if (ancestorDirectories.has(canonicalDirectory)) {
    throw new Error(`Ciclo de links detectado na release: ${source}.`);
  }

  mkdirSync(destination, { recursive: true });
  const nextAncestors = new Set(ancestorDirectories).add(canonicalDirectory);
  for (const entry of readdirSync(materializedSource, { withFileTypes: true })) {
    copyMaterializedEntry(
      resolve(materializedSource, entry.name),
      resolve(destination, entry.name),
      allowedRoots,
      nextAncestors,
    );
  }
  chmodSync(destination, materializedMetadata.mode & 0o777);
}

function copyDirectory(source, destination, label, boundary, additionalAllowedRoots = []) {
  const sourceRoot = requireContainedDirectory(source, label, boundary);
  const allowedRoots = [
    sourceRoot,
    ...additionalAllowedRoots.map((root) =>
      requireContainedDirectory(root, `${label} dependency root`, boundary),
    ),
  ];
  copyMaterializedEntry(sourceRoot, destination, allowedRoots, new Set());
}

function copyOptionalDirectory(source, destination, boundary) {
  if (lstatSync(source, { throwIfNoEntry: false }) !== undefined) {
    copyDirectory(source, destination, source, boundary);
  }
}

function assertReleaseDestination(root, destination) {
  const resolvedRoot = resolve(root);
  const expected = resolve(resolvedRoot, ".artifacts/release");
  if (resolve(destination) !== expected) {
    throw new Error("A release só pode ser publicada em .artifacts/release.");
  }
  const pathFromRoot = relative(resolvedRoot, destination);
  if (pathFromRoot.startsWith(`..${sep}`) || pathFromRoot === "..") {
    throw new Error("O destino da release saiu do repositório.");
  }

  const canonicalRoot = realpathSync(resolvedRoot);
  let current = resolvedRoot;
  for (const segment of pathFromRoot.split(sep)) {
    current = resolve(current, segment);
    const metadata = lstatSync(current, { throwIfNoEntry: false });
    if (metadata === undefined) break;
    if (metadata.isSymbolicLink()) {
      throw new Error("O destino da release possui um ancestral simbólico ou junction.");
    }
    if (!metadata.isDirectory()) {
      throw new Error("O destino existente da release não é um diretório regular.");
    }
    if (!isWithinDirectory(canonicalRoot, realpathSync(current))) {
      throw new Error("O destino físico da release saiu do repositório.");
    }
  }
}

function releaseFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return releaseFiles(path);
    if (entry.isFile()) return [path];
    throw new Error(`A release contém entrada não materializada: ${path}.`);
  });
}

function assertNoSensitiveReleaseContent(directory, sensitiveValues) {
  const values = [...new Set(sensitiveValues.filter((value) => value.length >= 8))].map((value) =>
    Buffer.from(value),
  );
  for (const path of releaseFiles(directory)) {
    if (/^\.env(?:\.|$)/u.test(basename(path))) {
      throw new Error(`A release contém arquivo de ambiente: ${relative(directory, path)}.`);
    }
    if (values.length === 0) continue;
    const contents = readFileSync(path);
    if (values.some((value) => contents.includes(value))) {
      throw new Error(`A release contém valor sensível em ${relative(directory, path)}.`);
    }
  }
}

export function releaseSensitiveValues(environment = process.env) {
  const values = [
    environment.DATABASE_URL_APP_DAL,
    environment.PRD_DATABASE_URL_APP_DAL,
    environment.SUPABASE_DB_PASSWORD,
  ].filter((value) => typeof value === "string" && value !== "");

  for (const name of ["DATABASE_URL_APP_DAL", "PRD_DATABASE_URL_APP_DAL"]) {
    const value = environment[name];
    if (typeof value !== "string" || value === "") continue;
    try {
      const password = new URL(value).password;
      if (password !== "") values.push(password, decodeURIComponent(password));
    } catch {
      // A validação canônica da URL pertence ao build; a release ainda procura seu valor literal.
    }
  }
  return values;
}

export function packageRelease({
  commit,
  outputDirectory = resolve(repositoryRoot, ".artifacts/release"),
  root = repositoryRoot,
  sensitiveValues = [],
} = {}) {
  const sourceRoot = requireDirectory(resolve(root), "raiz do repositório");
  const releaseCommit = commit ?? gitCommit(sourceRoot);
  if (!/^[a-f0-9]{40}$/u.test(releaseCommit)) {
    throw new Error("A release exige um SHA Git completo.");
  }

  const output = resolve(outputDirectory);
  assertReleaseDestination(sourceRoot, output);
  const hostDigest = hostConfigurationDigest(sourceRoot);

  const applications = [
    {
      buildId: resolve(sourceRoot, ".next/BUILD_ID"),
      dependencyRoot: resolve(sourceRoot, "node_modules"),
      entrypoint: "server.js",
      name: "web",
      publicDirectory: resolve(sourceRoot, "public"),
      standalone: resolve(sourceRoot, ".next/standalone"),
      staticDirectory: resolve(sourceRoot, ".next/static"),
      staticTarget: ".next/static",
    },
    {
      buildId: resolve(sourceRoot, "apps/backoffice/.next/BUILD_ID"),
      dependencyRoot: resolve(sourceRoot, "node_modules"),
      entrypoint: "apps/backoffice/server.js",
      name: "backoffice",
      publicDirectory: resolve(sourceRoot, "apps/backoffice/public"),
      standalone: resolve(sourceRoot, "apps/backoffice/.next/standalone"),
      staticDirectory: resolve(sourceRoot, "apps/backoffice/.next/static"),
      staticTarget: "apps/backoffice/.next/static",
    },
  ];

  for (const application of applications) {
    requireFile(application.buildId, `${application.name} BUILD_ID`, sourceRoot);
    const buildId = readFileSync(application.buildId, "utf8").trim();
    if (buildId !== releaseCommit) {
      throw new Error(
        `${application.name} foi construído para ${buildId || "um SHA vazio"}, não ${releaseCommit}.`,
      );
    }
    requireContainedDirectory(application.standalone, `${application.name} standalone`, sourceRoot);
    requireContainedDirectory(
      application.staticDirectory,
      `${application.name} static`,
      sourceRoot,
    );
    requireContainedDirectory(
      application.dependencyRoot,
      `${application.name} dependency root`,
      sourceRoot,
    );
    if (lstatSync(application.publicDirectory, { throwIfNoEntry: false }) !== undefined) {
      requireContainedDirectory(
        application.publicDirectory,
        `${application.name} public`,
        sourceRoot,
      );
    }
  }

  rmSync(output, { force: true, recursive: true });
  mkdirSync(output, { recursive: true });

  try {
    for (const application of applications) {
      const destination = resolve(output, application.name);
      copyDirectory(
        application.standalone,
        destination,
        `${application.name} standalone`,
        sourceRoot,
        [application.dependencyRoot],
      );
      copyDirectory(
        application.staticDirectory,
        resolve(destination, application.staticTarget),
        `${application.name} static`,
        sourceRoot,
      );
      copyOptionalDirectory(
        application.publicDirectory,
        resolve(destination, application.name === "web" ? "public" : "apps/backoffice/public"),
        sourceRoot,
      );
      requireFile(resolve(destination, application.entrypoint), `${application.name} server.js`);
    }

    assertNoSensitiveReleaseContent(output, sensitiveValues);
    const manifest = {
      applications: Object.fromEntries(
        applications.map((application) => [
          application.name,
          { entrypoint: application.entrypoint, health: "/api/health/ready" },
        ]),
      ),
      commit: releaseCommit,
      hostConfiguration: { sha256: hostDigest },
      node: process.versions.node,
      version: 2,
    };
    writeFileSync(
      resolve(output, "release-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    return manifest;
  } catch (error) {
    rmSync(output, { force: true, recursive: true });
    throw error;
  }
}

const executedPath = process.argv[1];
if (executedPath !== undefined && pathToFileURL(resolve(executedPath)).href === import.meta.url) {
  const manifest = packageRelease({
    commit: process.env.APP_RELEASE_SHA,
    sensitiveValues: releaseSensitiveValues(),
  });
  process.stdout.write(`Release ${manifest.commit} preparada em .artifacts/release.\n`);
}

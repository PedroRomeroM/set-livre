import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
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
  "ops/nginx/set-livre-http.conf",
  "ops/nginx/set-livre-tls.conf",
  "ops/systemd/set-livre-backoffice.service",
  "ops/systemd/set-livre-release-recovery.path",
  "ops/systemd/set-livre-release-recovery@.service",
  "ops/systemd/set-livre-web.service",
]);

function gitCommit(root) {
  return execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
}

function requireDirectory(path, label) {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error(`${label} não existe. Execute o build antes de empacotar a release.`);
  }
}

function requireFile(path, label) {
  if (!existsSync(path) || !statSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
    throw new Error(`${label} não existe. Execute o build antes de empacotar a release.`);
  }
}

export function hostConfigurationDigest(root = repositoryRoot) {
  const hash = createHash("sha256");
  for (const path of hostConfigurationFiles) {
    const absolutePath = resolve(root, path);
    requireFile(absolutePath, path);
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

function copyDirectory(source, destination, label, additionalAllowedRoots = []) {
  requireDirectory(source, label);
  const sourceRoot = realpathSync(source);
  const allowedRoots = [sourceRoot, ...additionalAllowedRoots.map((root) => realpathSync(root))];
  copyMaterializedEntry(sourceRoot, destination, allowedRoots, new Set());
}

function copyOptionalDirectory(source, destination) {
  if (existsSync(source)) copyDirectory(source, destination, source);
}

function assertReleaseDestination(root, destination) {
  const expected = resolve(root, ".artifacts/release");
  if (resolve(destination) !== expected) {
    throw new Error("A release só pode ser publicada em .artifacts/release.");
  }
  const pathFromRoot = relative(root, destination);
  if (pathFromRoot.startsWith(`..${sep}`) || pathFromRoot === "..") {
    throw new Error("O destino da release saiu do repositório.");
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
  const releaseCommit = commit ?? gitCommit(root);
  if (!/^[a-f0-9]{40}$/u.test(releaseCommit)) {
    throw new Error("A release exige um SHA Git completo.");
  }

  const output = resolve(outputDirectory);
  assertReleaseDestination(root, output);
  const hostDigest = hostConfigurationDigest(root);

  const applications = [
    {
      buildId: resolve(root, ".next/BUILD_ID"),
      dependencyRoot: resolve(root, "node_modules"),
      entrypoint: "server.js",
      name: "web",
      publicDirectory: resolve(root, "public"),
      standalone: resolve(root, ".next/standalone"),
      staticDirectory: resolve(root, ".next/static"),
      staticTarget: ".next/static",
    },
    {
      buildId: resolve(root, "apps/backoffice/.next/BUILD_ID"),
      dependencyRoot: resolve(root, "node_modules"),
      entrypoint: "apps/backoffice/server.js",
      name: "backoffice",
      publicDirectory: resolve(root, "apps/backoffice/public"),
      standalone: resolve(root, "apps/backoffice/.next/standalone"),
      staticDirectory: resolve(root, "apps/backoffice/.next/static"),
      staticTarget: "apps/backoffice/.next/static",
    },
  ];

  for (const application of applications) {
    requireFile(application.buildId, `${application.name} BUILD_ID`);
    const buildId = readFileSync(application.buildId, "utf8").trim();
    if (buildId !== releaseCommit) {
      throw new Error(
        `${application.name} foi construído para ${buildId || "um SHA vazio"}, não ${releaseCommit}.`,
      );
    }
    requireDirectory(application.standalone, `${application.name} standalone`);
    requireDirectory(application.staticDirectory, `${application.name} static`);
  }

  rmSync(output, { force: true, recursive: true });
  mkdirSync(output, { recursive: true });

  try {
    for (const application of applications) {
      const destination = resolve(output, application.name);
      copyDirectory(application.standalone, destination, `${application.name} standalone`, [
        application.dependencyRoot,
      ]);
      copyDirectory(
        application.staticDirectory,
        resolve(destination, application.staticTarget),
        `${application.name} static`,
      );
      copyOptionalDirectory(
        application.publicDirectory,
        resolve(destination, application.name === "web" ? "public" : "apps/backoffice/public"),
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

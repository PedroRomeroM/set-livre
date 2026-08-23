import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import ts from "typescript";

export function collectMatches(content, pattern) {
  return [...content.matchAll(pattern)].map((match) => match[1]).filter(Boolean);
}

export function findDuplicates(values) {
  const seen = new Set();
  const duplicates = new Set();

  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }

  return [...duplicates].sort();
}

const dependencyMapFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const bundledDependencyFields = ["bundleDependencies", "bundledDependencies"];
const canonicalPackageManifestPaths = [
  "package.json",
  "apps/backoffice/package.json",
  "packages/contracts/package.json",
  "packages/ui/package.json",
];
const canonicalWorkspacePatterns = ["apps/*", "packages/*"];
const canonicalWorkspacePackagePaths = [
  "apps/backoffice/package.json",
  "packages/contracts/package.json",
  "packages/ui/package.json",
];
const dependencyRegistryColumns = [
  "Pacote",
  "Versão",
  "Superfície/finalidade",
  "Licença",
  "Justificativa",
  "Avaliação de supply chain",
];
const exactRegistryVersionPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const npmPackageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const migrationDirectoryPrefix = "supabase/migrations/";
const migrationFilePattern = /^(\d{14})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/u;
const controlledGitEnvironment = {
  GIT_ATTR_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  LANG: "C",
  LC_ALL: "C",
};
const canonicalNpmConfiguration = [
  "engine-strict=true",
  "fund=false",
  "save-exact=true",
  "strict-allow-scripts=true",
  "ignore-scripts=true",
  "dangerously-allow-all-scripts=false",
  "",
].join("\n");
const forbiddenInstallDependencyExactNames = new Set([
  "@apollo/client",
  "@directus/sdk",
  "@keyv/redis",
  "@shadcn/ui",
  "@supabase/auth-helpers-nextjs",
  "@upstash/redis",
  "agenda",
  "aphrodite",
  "bee-queue",
  "bookshelf",
  "bull",
  "bullmq",
  "caddy",
  "cache-manager-ioredis-yet",
  "cache-manager-redis-yet",
  "connect-redis",
  "contentful",
  "daisyui",
  "directus",
  "dockerode",
  "drizzle-kit",
  "drizzle-orm",
  "fela",
  "flowbite",
  "flowbite-react",
  "goober",
  "handy-redis",
  "ioredis",
  "jss",
  "kafkajs",
  "kafka-node",
  "knex",
  "kubernetes-client",
  "kysely",
  "mikro-orm",
  "node-docker-api",
  "node-rdkafka",
  "no-kafka",
  "objection",
  "payload",
  "pg-boss",
  "prisma",
  "react-jss",
  "react-fela",
  "react-redux",
  "rate-limit-redis",
  "redis",
  "redis-om",
  "redux",
  "relay-runtime",
  "rsmq",
  "sanity",
  "sequelize",
  "sequelize-typescript",
  "shadcn",
  "shadcn-ui",
  "strapi",
  "styled-components",
  "styled-jsx",
  "styletron-engine-atomic",
  "styletron-react",
  "swr",
  "tailwind-merge",
  "tailwindcss",
  "tailwindcss-animate",
  "typeorm",
  "urql",
  "waterline",
  "zustand",
]);
const forbiddenInstallDependencyPrefixes = [
  "@compiled/",
  "@confluentinc/",
  "@contentful/",
  "@directus/",
  "@emotion/",
  "@griffel/",
  "@kubernetes/",
  "@linaria/",
  "@mikro-orm/",
  "@mui/",
  "@pandacss/",
  "@payloadcms/",
  "@prisma/",
  "@prismicio/",
  "@redis/",
  "@reduxjs/",
  "@sanity/",
  "@sequelize/",
  "@shadcn/",
  "@storyblok/",
  "@stitches/",
  "@strapi/",
  "@stylexjs/",
  "@tailwindcss/",
  "@urql/",
  "@vanilla-extract/",
  "drizzle-",
  "fela-",
  "kafka-",
  "redis-",
];
const installLifecycleScriptNames = new Set([
  "dependencies",
  "install",
  "postdependencies",
  "postinstall",
  "postprepare",
  "predependencies",
  "preinstall",
  "prepare",
  "preprepare",
  "prepublish",
]);

export function validateWorkspacePatterns(packageJson) {
  const workspaces = packageJson.workspaces;
  if (!Array.isArray(workspaces) || workspaces.some((workspace) => typeof workspace !== "string")) {
    throw new TypeError("A seção workspaces precisa ser uma lista textual.");
  }

  const normalizedWorkspaces = [...new Set(workspaces)].sort();
  if (
    normalizedWorkspaces.length !== canonicalWorkspacePatterns.length ||
    normalizedWorkspaces.some((workspace, index) => workspace !== canonicalWorkspacePatterns[index])
  ) {
    throw new TypeError(
      `A seção workspaces precisa conter exatamente ${canonicalWorkspacePatterns.join(", ")}.`,
    );
  }

  return normalizedWorkspaces;
}

export function validateNpmProjectConfiguration(source) {
  if (source !== canonicalNpmConfiguration) {
    throw new Error(".npmrc precisa preservar a configuração estrita canônica.");
  }
}

export function validateAllowedInstallScripts(packageJson) {
  if (packageJson.allowScripts !== undefined) {
    throw new TypeError(
      "allowScripts é proibido porque nenhum lifecycle de instalação é executado.",
    );
  }
}

export function readCanonicalPackageManifests(repositoryRoot) {
  const resolvedRoot = resolve(repositoryRoot);
  validateNpmProjectConfiguration(readPhysicalRepositoryFile(resolvedRoot, ".npmrc"));
  const canonicalWorkspaceDirectories = new Set(
    canonicalWorkspacePackagePaths.map((packagePath) => dirname(packagePath)),
  );

  for (const workspaceRoot of canonicalWorkspacePatterns.map((pattern) => pattern.slice(0, -2))) {
    const absoluteWorkspaceRoot = resolve(resolvedRoot, workspaceRoot);
    const rootInformation = lstatSync(absoluteWorkspaceRoot, { throwIfNoEntry: false });
    if (
      rootInformation === undefined ||
      !rootInformation.isDirectory() ||
      rootInformation.isSymbolicLink()
    ) {
      throw new Error(`A raiz de workspaces ${workspaceRoot} precisa ser um diretório físico.`);
    }

    for (const entry of readdirSync(absoluteWorkspaceRoot)) {
      const workspacePath = `${workspaceRoot}/${entry}`;
      const information = lstatSync(resolve(absoluteWorkspaceRoot, entry), {
        throwIfNoEntry: false,
      });
      if (information === undefined || information.isSymbolicLink()) {
        throw new Error(`O workspace ${workspacePath} precisa ser físico.`);
      }
      if (information.isDirectory() && !canonicalWorkspaceDirectories.has(workspacePath)) {
        throw new Error(`O workspace ${workspacePath} não pertence ao conjunto canônico.`);
      }
    }
  }

  return canonicalPackageManifestPaths.map((packagePath) => {
    const packageDirectory = resolve(resolvedRoot, dirname(packagePath));
    if (lstatSync(resolve(packageDirectory, "npm-shrinkwrap.json"), { throwIfNoEntry: false })) {
      throw new Error(`${packagePath} não pode introduzir npm-shrinkwrap.json.`);
    }
    if (
      packagePath !== "package.json" &&
      lstatSync(resolve(packageDirectory, "package-lock.json"), { throwIfNoEntry: false })
    ) {
      throw new Error(`${packagePath} não pode introduzir um lockfile paralelo.`);
    }
    const implicitNodeGypPath = resolve(resolvedRoot, dirname(packagePath), "binding.gyp");
    if (lstatSync(implicitNodeGypPath, { throwIfNoEntry: false }) !== undefined) {
      throw new Error(`${packagePath} não pode ativar install implícito por binding.gyp.`);
    }
    return {
      packagePath,
      source: readPhysicalRepositoryFile(resolvedRoot, packagePath),
    };
  });
}

function assertNoInstallLifecycleScripts(packageJson) {
  const scripts = packageJson.scripts;
  if (scripts === undefined) {
    return;
  }
  if (scripts === null || typeof scripts !== "object" || Array.isArray(scripts)) {
    throw new TypeError("A seção scripts precisa ser um mapa textual.");
  }

  for (const [scriptName, command] of Object.entries(scripts)) {
    if (typeof command !== "string") {
      throw new TypeError("A seção scripts precisa conter somente comandos textuais.");
    }
    if (installLifecycleScriptNames.has(scriptName)) {
      throw new TypeError(`A seção scripts não pode declarar o lifecycle ${scriptName}.`);
    }
  }
}

function dependencyNameFromVersionedKey(value) {
  if (value === "." || value === "") {
    return undefined;
  }
  if (value.startsWith("@")) {
    const scopeSeparator = value.indexOf("/");
    if (scopeSeparator === -1) {
      return value;
    }
    const versionSeparator = value.indexOf("@", scopeSeparator);
    return (versionSeparator === -1 ? value : value.slice(0, versionSeparator)).toLowerCase();
  }
  const versionSeparator = value.indexOf("@");
  return (versionSeparator === -1 ? value : value.slice(0, versionSeparator)).toLowerCase();
}

function dependencyAliasTarget(value) {
  if (typeof value !== "string" || value.slice(0, "npm:".length).toLowerCase() !== "npm:") {
    return undefined;
  }
  return dependencyNameFromVersionedKey(value.slice("npm:".length));
}

function assertRegistryVersionSpec(value, field, { allowReference = false } = {}) {
  if (allowReference && /^\$(?:@[^/\s]+\/)?[^/\s]+$/u.test(value)) {
    return;
  }

  if (value.startsWith("$")) {
    throw new TypeError(`A seção ${field} aceita referências $ somente em overrides.`);
  }

  const aliasPrefix = value.slice(0, "npm:".length).toLowerCase() === "npm:";
  const registrySpec = aliasPrefix ? value.slice("npm:".length) : value;
  if (registrySpec === "") {
    throw new TypeError(`A seção ${field} contém uma spec vazia.`);
  }

  let versionSpec = registrySpec;
  if (aliasPrefix) {
    const targetName = dependencyNameFromVersionedKey(registrySpec);
    if (targetName === undefined || targetName === "") {
      throw new TypeError(`A seção ${field} contém um alias npm inválido.`);
    }
    const versionOffset = registrySpec.startsWith("@")
      ? registrySpec.indexOf("@", registrySpec.indexOf("/"))
      : registrySpec.indexOf("@");
    versionSpec = versionOffset === -1 ? "*" : registrySpec.slice(versionOffset + 1);
  }

  if (
    versionSpec === "" ||
    versionSpec.includes(":") ||
    versionSpec.includes("/") ||
    versionSpec.includes("\\") ||
    versionSpec.includes("#") ||
    /\.(?:tar|tar\.gz|tgz)$/iu.test(versionSpec) ||
    versionSpec.startsWith(".")
  ) {
    throw new TypeError(
      `A seção ${field} aceita somente versões do registry, aliases npm ou referências permitidas.`,
    );
  }
}

function collectOverrideDependencyNames(overrides, dependencyNames) {
  if (overrides === undefined) {
    return;
  }
  if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new TypeError("A seção overrides precisa ser um objeto de specs ou regras aninhadas.");
  }

  for (const [key, value] of Object.entries(overrides)) {
    const dependencyName = dependencyNameFromVersionedKey(key);
    if (dependencyName !== undefined) {
      dependencyNames.add(dependencyName);
    }
    const aliasTarget = dependencyAliasTarget(value);
    if (aliasTarget !== undefined) {
      dependencyNames.add(aliasTarget);
    }
    if (typeof value === "string") {
      assertRegistryVersionSpec(value, "overrides", { allowReference: true });
      continue;
    }
    collectOverrideDependencyNames(value, dependencyNames);
  }
}

export function installDependencyNames(packageJson) {
  assertNoInstallLifecycleScripts(packageJson);
  const dependencyNames = new Set();

  for (const field of dependencyMapFields) {
    const dependencies = packageJson[field];
    if (dependencies === undefined) {
      continue;
    }
    if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies)) {
      throw new TypeError(`A seção ${field} precisa ser um mapa de specs.`);
    }
    for (const [dependency, version] of Object.entries(dependencies)) {
      if (typeof version !== "string") {
        throw new TypeError(`A seção ${field} precisa conter somente specs textuais.`);
      }
      assertRegistryVersionSpec(version, field);
      dependencyNames.add(dependency.toLowerCase());
      const aliasTarget = dependencyAliasTarget(version);
      if (aliasTarget !== undefined) {
        dependencyNames.add(aliasTarget);
      }
    }
  }

  for (const field of bundledDependencyFields) {
    const dependencies = packageJson[field];
    if (dependencies === undefined || typeof dependencies === "boolean") {
      continue;
    }
    if (!Array.isArray(dependencies)) {
      throw new TypeError(`A seção ${field} precisa ser uma lista ou booleano.`);
    }
    for (const dependency of dependencies) {
      if (typeof dependency !== "string") {
        throw new TypeError(`A seção ${field} precisa conter somente nomes textuais.`);
      }
      dependencyNames.add(dependency.toLowerCase());
    }
  }

  collectOverrideDependencyNames(packageJson.overrides, dependencyNames);

  return [...dependencyNames].sort();
}

function isForbiddenInstallDependency(dependency) {
  return (
    forbiddenInstallDependencyExactNames.has(dependency) ||
    forbiddenInstallDependencyPrefixes.some((prefix) => dependency.startsWith(prefix))
  );
}

export function findForbiddenInstallDependencies(packageJson) {
  return installDependencyNames(packageJson).filter(isForbiddenInstallDependency);
}

function parseMarkdownTableRow(line, expectedColumnCount) {
  if (!line.startsWith("|") || !line.endsWith("|")) {
    throw new TypeError("A tabela de dependências precisa usar linhas Markdown completas.");
  }

  const columns = line
    .slice(1, -1)
    .split("|")
    .map((column) => column.trim());
  if (columns.length !== expectedColumnCount) {
    throw new TypeError(
      `A tabela de dependências precisa conter exatamente ${expectedColumnCount} colunas.`,
    );
  }
  return columns;
}

function assertMeaningfulRegistryField(value, field, packageName) {
  const normalized = value.trim();
  if (normalized.length < 3 || /^(?:-|\u2014|n\/?a|none|pendente|tbd)$/iu.test(normalized)) {
    throw new TypeError(`${packageName} não possui ${field} explícita no registro.`);
  }
}

function parseDependencyRegistry(content) {
  const heading = "## Dependências npm diretas";
  const headingMatches = [...content.matchAll(/^## Dependências npm diretas\s*$/gmu)];
  if (headingMatches.length !== 1) {
    throw new TypeError(`O registro precisa conter exatamente uma seção ${heading}.`);
  }

  const headingMatch = headingMatches[0];
  const sectionOffset = (headingMatch.index ?? 0) + headingMatch[0].length;
  const afterHeading = content.slice(sectionOffset);
  const nextHeadingOffset = afterHeading.search(/^## /mu);
  const section =
    nextHeadingOffset === -1 ? afterHeading : afterHeading.slice(0, nextHeadingOffset);
  const lines = section.split(/\r?\n/u);
  while (lines[0]?.trim() === "") {
    lines.shift();
  }

  const tableLines = [];
  while (lines[0]?.startsWith("|")) {
    tableLines.push(lines.shift());
  }
  if (tableLines.length < 3) {
    throw new TypeError(
      "A seção de dependências npm precisa conter uma tabela e ao menos um pacote.",
    );
  }
  if (lines.some((line) => line.startsWith("|"))) {
    throw new TypeError("A seção de dependências npm contém uma tabela adicional ambígua.");
  }

  const header = parseMarkdownTableRow(tableLines[0], dependencyRegistryColumns.length);
  if (header.some((column, index) => column !== dependencyRegistryColumns[index])) {
    throw new TypeError(
      `A tabela de dependências precisa preservar as colunas: ${dependencyRegistryColumns.join(", ")}.`,
    );
  }
  const separator = parseMarkdownTableRow(tableLines[1], dependencyRegistryColumns.length);
  if (separator.some((column) => !/^:?-{3,}:?$/u.test(column))) {
    throw new TypeError("O separador da tabela de dependências é inválido.");
  }

  const registry = new Map();
  for (const line of tableLines.slice(2)) {
    const [packageCell, versionCell, surface, license, justification, supplyChain] =
      parseMarkdownTableRow(line, dependencyRegistryColumns.length);
    const packageMatch = packageCell?.match(/^`([^`]+)`$/u);
    const versionMatch = versionCell?.match(/^`([^`]+)`$/u);
    const packageName = packageMatch?.[1];
    const version = versionMatch?.[1];
    if (
      packageName === undefined ||
      packageName !== packageName.toLowerCase() ||
      !npmPackageNamePattern.test(packageName)
    ) {
      throw new TypeError(
        `A entrada ${packageCell ?? "ausente"} precisa identificar um único pacote npm canônico em code span.`,
      );
    }
    if (version === undefined || !exactRegistryVersionPattern.test(version)) {
      throw new TypeError(`${packageName} precisa registrar uma versão semver exata em code span.`);
    }
    if (registry.has(packageName)) {
      throw new TypeError(`${packageName} possui mais de um registro de dependência.`);
    }

    assertMeaningfulRegistryField(surface ?? "", "superfície/finalidade", packageName);
    assertMeaningfulRegistryField(license ?? "", "licença", packageName);
    assertMeaningfulRegistryField(justification ?? "", "justificativa", packageName);
    assertMeaningfulRegistryField(supplyChain ?? "", "avaliação de supply chain", packageName);
    registry.set(packageName, { version });
  }

  return registry;
}

function canonicalExternalManifestDependencies(packageManifests) {
  if (!Array.isArray(packageManifests)) {
    throw new TypeError("Os manifests canônicos precisam ser fornecidos como lista.");
  }

  const manifestsByPath = new Map();
  for (const manifest of packageManifests) {
    if (
      manifest === null ||
      typeof manifest !== "object" ||
      typeof manifest.packagePath !== "string" ||
      manifest.packageJson === null ||
      typeof manifest.packageJson !== "object" ||
      Array.isArray(manifest.packageJson)
    ) {
      throw new TypeError("Cada manifesto canônico precisa declarar packagePath e packageJson.");
    }
    if (manifestsByPath.has(manifest.packagePath)) {
      throw new TypeError(`O manifesto ${manifest.packagePath} foi informado mais de uma vez.`);
    }
    manifestsByPath.set(manifest.packagePath, manifest.packageJson);
  }
  if (
    manifestsByPath.size !== canonicalPackageManifestPaths.length ||
    canonicalPackageManifestPaths.some((packagePath) => !manifestsByPath.has(packagePath))
  ) {
    throw new TypeError(
      `A avaliação precisa receber exatamente os manifests ${canonicalPackageManifestPaths.join(", ")}.`,
    );
  }

  const workspaceVersions = new Map();
  for (const [packagePath, packageJson] of manifestsByPath) {
    const { name, version } = packageJson;
    if (
      typeof name !== "string" ||
      name !== name.toLowerCase() ||
      !npmPackageNamePattern.test(name) ||
      typeof version !== "string" ||
      !exactRegistryVersionPattern.test(version)
    ) {
      throw new TypeError(`${packagePath} precisa declarar nome canônico e versão semver exata.`);
    }
    if (workspaceVersions.has(name)) {
      throw new TypeError(`O nome de workspace ${name} está duplicado.`);
    }
    workspaceVersions.set(name, version);
  }

  const externalVersions = new Map();
  for (const [packagePath, packageJson] of manifestsByPath) {
    if (packageJson.overrides !== undefined) {
      if (
        packageJson.overrides === null ||
        typeof packageJson.overrides !== "object" ||
        Array.isArray(packageJson.overrides)
      ) {
        throw new TypeError(`${packagePath}: overrides precisa ser um objeto vazio ou ausente.`);
      }
      if (Object.keys(packageJson.overrides).length > 0) {
        throw new TypeError(
          `${packagePath}: overrides não vazio é ambíguo para versão e origem efetivamente instaladas.`,
        );
      }
    }

    const declaredInManifest = new Set();
    for (const field of dependencyMapFields) {
      const dependencies = packageJson[field];
      if (dependencies === undefined) {
        continue;
      }
      if (
        dependencies === null ||
        typeof dependencies !== "object" ||
        Array.isArray(dependencies)
      ) {
        throw new TypeError(`${packagePath}: a seção ${field} precisa ser um mapa de specs.`);
      }

      for (const [dependency, version] of Object.entries(dependencies)) {
        if (
          dependency !== dependency.toLowerCase() ||
          !npmPackageNamePattern.test(dependency) ||
          typeof version !== "string"
        ) {
          throw new TypeError(`${packagePath}: ${field} possui dependência ou spec inválida.`);
        }
        declaredInManifest.add(dependency);
        if (version.slice(0, "npm:".length).toLowerCase() === "npm:") {
          throw new TypeError(
            `${packagePath}: alias npm em ${field}.${dependency} é ambíguo para o registro de supply chain.`,
          );
        }
        if (!exactRegistryVersionPattern.test(version)) {
          throw new TypeError(
            `${packagePath}: ${field}.${dependency} precisa usar uma versão semver exata.`,
          );
        }

        const workspaceVersion = workspaceVersions.get(dependency);
        if (workspaceVersion !== undefined) {
          if (workspaceVersion !== version) {
            throw new TypeError(
              `${packagePath}: ${dependency} precisa referenciar a versão interna exata ${workspaceVersion}.`,
            );
          }
          continue;
        }

        const currentVersion = externalVersions.get(dependency);
        if (currentVersion !== undefined && currentVersion !== version) {
          throw new TypeError(
            `${dependency} possui versões divergentes nos manifests canônicos: ${currentVersion} e ${version}.`,
          );
        }
        externalVersions.set(dependency, version);
      }
    }

    for (const field of bundledDependencyFields) {
      const bundledDependencies = packageJson[field];
      if (bundledDependencies === undefined || bundledDependencies === false) {
        continue;
      }
      if (!Array.isArray(bundledDependencies)) {
        throw new TypeError(
          `${packagePath}: ${field} precisa ser uma lista explícita de dependências já declaradas.`,
        );
      }
      for (const dependency of bundledDependencies) {
        if (typeof dependency !== "string" || !declaredInManifest.has(dependency)) {
          throw new TypeError(
            `${packagePath}: ${field} referencia dependência ausente ou ambígua: ${String(dependency)}.`,
          );
        }
      }
    }
  }

  return externalVersions;
}

export function validateCanonicalDependencyRegistry(packageManifests, registryContent) {
  const canonicalDependencies = canonicalExternalManifestDependencies(packageManifests);
  const registry = parseDependencyRegistry(registryContent);
  const errors = [];

  for (const [dependency, version] of canonicalDependencies) {
    const record = registry.get(dependency);
    if (record === undefined) {
      errors.push(`${dependency}@${version} não possui registro de supply chain.`);
    } else if (record.version !== version) {
      errors.push(
        `${dependency} registra ${record.version}, mas os manifests canônicos exigem ${version}.`,
      );
    }
  }
  for (const dependency of registry.keys()) {
    if (!canonicalDependencies.has(dependency)) {
      errors.push(`${dependency} está registrado, mas não é dependência direta canônica.`);
    }
  }

  return errors.sort();
}

export function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function markdownSection(content, heading) {
  const headingStart = content.indexOf(heading);
  if (headingStart === -1) {
    return "";
  }

  const sectionStart = headingStart + heading.length;
  const remainingContent = content.slice(sectionStart);
  const nextHeadingOffset = remainingContent.search(/\n## /);
  return nextHeadingOffset === -1 ? remainingContent : remainingContent.slice(0, nextHeadingOffset);
}

export function parseFeatureReferences(content) {
  const featureIds = new Set(collectMatches(content, /\b(FEAT-\d{3})\b/g));

  for (const match of content.matchAll(/\bFEAT-(\d{3})\s*[–-]\s*(?:FEAT-)?(\d{3})\b/g)) {
    const first = Number.parseInt(match[1], 10);
    const last = Number.parseInt(match[2], 10);
    if (first > last) {
      throw new RangeError(
        `Intervalo de feature descendente inválido: FEAT-${match[1]}–FEAT-${match[2]}.`,
      );
    }
    for (let current = first; current <= last; current += 1) {
      featureIds.add(`FEAT-${String(current).padStart(3, "0")}`);
    }
  }

  return [...featureIds].sort();
}

function gitEnvironment(inheritedEnvironment = process.env, platform = process.platform) {
  const environment = { ...controlledGitEnvironment };
  const preserve = (targetName, ...sourceNames) => {
    const value = sourceNames
      .map((name) => inheritedEnvironment[name])
      .find(
        (candidate) =>
          typeof candidate === "string" && candidate !== "" && !candidate.includes("\0"),
      );
    if (value !== undefined) {
      environment[targetName] = value;
    }
  };

  if (platform === "win32") {
    preserve("Path", "Path", "PATH");
    preserve("PATHEXT", "PATHEXT");
    preserve("SystemRoot", "SystemRoot", "SYSTEMROOT");
    preserve("WINDIR", "WINDIR", "SystemRoot", "SYSTEMROOT");
  } else {
    preserve("PATH", "PATH");
  }

  return environment;
}

function gitExecutionOptions(root) {
  return {
    cwd: root,
    encoding: "utf8",
    env: gitEnvironment(),
    stdio: ["ignore", "pipe", "ignore"],
  };
}

function assertCanonicalGitWorktreeRoot(runGit, repositoryRoot, observedTopLevelOutput) {
  const resolvedRoot = resolve(repositoryRoot);
  const initialRootInformation = lstatSync(resolvedRoot, {
    bigint: true,
    throwIfNoEntry: false,
  });
  if (
    initialRootInformation === undefined ||
    !initialRootInformation.isDirectory() ||
    initialRootInformation.isSymbolicLink()
  ) {
    throw new Error("A raiz auditada do repositório precisa ser um diretório físico.");
  }

  let canonicalRoot;
  try {
    canonicalRoot = realpathSync.native(resolvedRoot);
  } catch {
    throw new Error("Não foi possível resolver a raiz física auditada do repositório.");
  }

  const topLevelOutput = observedTopLevelOutput ?? runGit(["rev-parse", "--show-toplevel"]);
  const topLevelWithoutLineFeed = topLevelOutput.endsWith("\n")
    ? topLevelOutput.slice(0, -1)
    : topLevelOutput;
  const topLevel = topLevelWithoutLineFeed.endsWith("\r")
    ? topLevelWithoutLineFeed.slice(0, -1)
    : topLevelWithoutLineFeed;
  if (
    topLevel === "" ||
    !isAbsolute(topLevel) ||
    topLevel.includes("\0") ||
    topLevel.includes("\n") ||
    topLevel.includes("\r")
  ) {
    throw new Error("O Git não informou um worktree canônico absoluto e inequívoco.");
  }

  const resolvedTopLevel = resolve(topLevel);
  const topLevelInformation = lstatSync(resolvedTopLevel, {
    bigint: true,
    throwIfNoEntry: false,
  });
  let canonicalTopLevel;
  try {
    canonicalTopLevel = realpathSync.native(resolvedTopLevel);
  } catch {
    throw new Error("Não foi possível resolver fisicamente o worktree informado pelo Git.");
  }
  const finalRootInformation = lstatSync(resolvedRoot, {
    bigint: true,
    throwIfNoEntry: false,
  });
  const finalTopLevelInformation = lstatSync(resolvedTopLevel, {
    bigint: true,
    throwIfNoEntry: false,
  });
  const finalCanonicalRoot = realpathSync.native(resolvedRoot);
  const finalCanonicalTopLevel = realpathSync.native(resolvedTopLevel);
  const sameCanonicalPath =
    relative(canonicalRoot, canonicalTopLevel) === "" &&
    relative(canonicalTopLevel, canonicalRoot) === "" &&
    relative(finalCanonicalRoot, finalCanonicalTopLevel) === "" &&
    relative(finalCanonicalTopLevel, finalCanonicalRoot) === "";

  if (
    topLevelInformation === undefined ||
    finalRootInformation === undefined ||
    finalTopLevelInformation === undefined ||
    !topLevelInformation.isDirectory() ||
    !finalRootInformation.isDirectory() ||
    !finalTopLevelInformation.isDirectory() ||
    topLevelInformation.isSymbolicLink() ||
    finalRootInformation.isSymbolicLink() ||
    finalTopLevelInformation.isSymbolicLink() ||
    !samePhysicalFile(initialRootInformation, topLevelInformation) ||
    !samePhysicalFile(initialRootInformation, finalRootInformation) ||
    !samePhysicalFile(initialRootInformation, finalTopLevelInformation) ||
    !sameCanonicalPath
  ) {
    throw new Error("O worktree Git canônico não corresponde à raiz física auditada.");
  }
}

function readCanonicalGitWorktreeHead(runGit, repositoryRoot) {
  let output;
  try {
    output = runGit(["rev-parse", "--show-toplevel", "HEAD^{commit}"]);
  } catch {
    assertCanonicalGitWorktreeRoot(runGit, repositoryRoot);
    return null;
  }

  const match = output.match(/^([^\0\r\n]+)\r?\n((?:[0-9a-f]{40}|[0-9a-f]{64}))\r?\n?$/u);
  if (match === null) {
    throw new Error("O Git não informou raiz e HEAD canônicos de forma inequívoca.");
  }
  assertCanonicalGitWorktreeRoot(runGit, repositoryRoot, `${match[1]}\n`);
  return match[2];
}

const canonicalMainReferences = ["refs/remotes/origin/main", "refs/heads/main"];

function readCanonicalMainCandidates(runGit) {
  const output = runGit([
    "for-each-ref",
    "--format=%(HEAD)%00%(refname)%00%(objectname)%00%(objecttype)",
    ...canonicalMainReferences,
  ]);
  const revisionsByReference = new Map();

  for (const record of output.split(/\r?\n/u).filter(Boolean)) {
    const [headMarker, reference, revision, objectType, ...unexpected] = record.split("\0");
    if (
      unexpected.length > 0 ||
      !/^[ *]$/u.test(headMarker) ||
      !canonicalMainReferences.includes(reference) ||
      objectType !== "commit" ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(revision)
    ) {
      throw new Error("O Git informou uma referência main não canônica.");
    }
    if (revisionsByReference.has(reference)) {
      throw new Error(`O Git informou mais de uma revisão para ${reference}.`);
    }
    revisionsByReference.set(reference, { headMarker, reference, revision });
  }

  return canonicalMainReferences.flatMap((reference) => {
    const candidate = revisionsByReference.get(reference);
    return candidate === undefined ? [] : [candidate];
  });
}

function resolveGitComparisonBase(runGit, headRevision) {
  const mainCandidates = readCanonicalMainCandidates(runGit);
  const isMainCheckout = mainCandidates.some(
    ({ headMarker, reference }) => headMarker === "*" && reference === "refs/heads/main",
  );

  const candidatesByRevision = new Map();
  for (const { reference, revision } of mainCandidates) {
    if (revision === headRevision && isMainCheckout) {
      continue;
    }

    const existingCandidate = candidatesByRevision.get(revision);
    if (existingCandidate === undefined) {
      candidatesByRevision.set(revision, { reference, revision });
    }
  }

  const validCandidates = [];
  for (const candidate of candidatesByRevision.values()) {
    try {
      const mergeBase =
        candidate.revision === headRevision
          ? headRevision
          : runGit(["merge-base", candidate.revision, "HEAD"]).trim();
      if (mergeBase === "") {
        continue;
      }
      validCandidates.push({ ...candidate, mergeBase });
    } catch {
      // A ausência de uma ref candidata é esperada em clones e pacotes locais.
    }
  }

  if (validCandidates.length === 1) {
    return validCandidates[0].revision;
  }
  if (validCandidates.length > 1) {
    let closestCandidate = null;
    for (const candidate of validCandidates) {
      try {
        const distanceOutput = runGit([
          "rev-list",
          "--count",
          `${candidate.mergeBase}..${headRevision}`,
        ]).trim();
        const distance = /^\d+$/u.test(distanceOutput) ? Number(distanceOutput) : Number.NaN;
        if (
          Number.isSafeInteger(distance) &&
          (closestCandidate === null || distance < closestCandidate.distance)
        ) {
          closestCandidate = { distance, revision: candidate.revision };
        }
      } catch {
        // Uma candidata que mudou durante a leitura não pode definir a base.
      }
    }
    if (closestCandidate !== null) {
      return closestCandidate.revision;
    }
  }

  let rootRevision = "";
  try {
    rootRevision =
      runGit(["rev-list", "--max-parents=0", "HEAD"])
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .sort()[0] ?? "";
  } catch {
    return null;
  }

  return rootRevision !== "" && rootRevision !== headRevision ? rootRevision : null;
}

export function gitChangedFileArgumentLists(comparisonBase) {
  return [
    comparisonBase === null
      ? { argumentsList: ["ls-files", "-z"], implicitStatus: "A" }
      : {
          argumentsList: [
            "diff",
            "--name-status",
            "-z",
            "--diff-filter=ACMRTD",
            `${comparisonBase}...HEAD`,
          ],
        },
    {
      argumentsList: ["diff", "--name-status", "-z", "--diff-filter=ACMRTD"],
    },
    {
      argumentsList: ["diff", "--cached", "--name-status", "-z", "--diff-filter=ACMRTD"],
    },
    {
      argumentsList: ["ls-files", "--others", "--exclude-standard", "-z"],
      implicitStatus: "A",
    },
  ];
}

export function containsEncodedPrivateKey(source) {
  if (typeof source !== "string") {
    throw new TypeError("A varredura de chave privada exige conteúdo textual.");
  }
  const header = /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----/gu;
  for (const match of source.matchAll(header)) {
    const label = match[1];
    const bodyStart = (match.index ?? 0) + match[0].length;
    const footer = `-----END ${label}-----`;
    const bodyEnd = source.indexOf(footer, bodyStart);
    if (bodyEnd === -1) {
      continue;
    }
    const compactBody = source.slice(bodyStart, bodyEnd).replaceAll(/\s/gu, "");
    if (compactBody.length >= 256 && /^[A-Za-z0-9+/]+={0,2}$/u.test(compactBody)) {
      return true;
    }
  }
  return false;
}

export function parseGitChanges(output, implicitStatus) {
  const tokens = output.split("\0").filter(Boolean);
  const assertPortablePath = (path) => {
    if (typeof path !== "string" || path === "" || path.includes("\\")) {
      throw new Error(`O caminho Git não é portável para Windows: ${String(path)}.`);
    }
    const components = path.split("/");
    for (const component of components) {
      const baseName = component.split(".", 1)[0];
      if (
        component === "" ||
        component === "." ||
        component === ".." ||
        /[<>:"|?*\u0000-\u001f]/u.test(component) ||
        /[ .]$/u.test(component) ||
        /^(?:aux|con|nul|prn|com[1-9]|lpt[1-9])$/iu.test(baseName)
      ) {
        throw new Error(`O caminho Git não é portável para Windows: ${path}.`);
      }
    }
    return path;
  };
  if (implicitStatus !== undefined) {
    return tokens.map((path) => ({ path: assertPortablePath(path), status: implicitStatus }));
  }

  const changes = [];
  for (let index = 0; index < tokens.length;) {
    const statusToken = tokens[index];
    const status = statusToken?.at(0);
    index += 1;
    if (status === undefined || !/[ACDMRT]/.test(status)) {
      throw new Error(`Status Git inválido: ${statusToken ?? "ausente"}.`);
    }

    const pathsToRead = status === "R" || status === "C" ? 2 : 1;
    for (let pathIndex = 0; pathIndex < pathsToRead; pathIndex += 1) {
      const path = tokens[index];
      index += 1;
      if (path === undefined) {
        throw new Error(`Saída Git incompleta para status ${statusToken}.`);
      }
      changes.push({ path: assertPortablePath(path), status });
    }
  }

  return changes;
}

export function readGitChanges(root, executeGit = execFileSync) {
  const runGit = (argumentsList) => executeGit("git", argumentsList, gitExecutionOptions(root));
  const headRevision = readCanonicalGitWorktreeHead(runGit, root);
  const comparisonBase =
    headRevision === null ? null : resolveGitComparisonBase(runGit, headRevision);
  const changes = gitChangedFileArgumentLists(comparisonBase).flatMap(
    ({ argumentsList, implicitStatus }) => parseGitChanges(runGit(argumentsList), implicitStatus),
  );

  return { changes, comparisonBase };
}

export function readGitMigrationPathsAtRevision(root, revision, executeGit = execFileSync) {
  const runGit = (argumentsList) => executeGit("git", argumentsList, gitExecutionOptions(root));
  assertCanonicalGitWorktreeRoot(runGit, root);
  if (revision === null) {
    return [];
  }
  if (typeof revision !== "string" || revision.trim() === "") {
    throw new TypeError("A revisão Git de migrations precisa ser um commit explícito.");
  }

  const output = runGit([
    "ls-tree",
    "-r",
    "-z",
    "--name-only",
    revision,
    "--",
    migrationDirectoryPrefix.slice(0, -1),
  ]);
  return output.split("\0").filter(Boolean).sort();
}

function migrationSnapshotLabel(revision) {
  return revision.length > 12 ? revision.slice(0, 12) : revision;
}

function parseGitTreeMigrationSnapshot(output, revision) {
  const entries = new Map();
  const errors = new Set();
  const label = migrationSnapshotLabel(revision);

  for (const record of output.split("\0").filter(Boolean)) {
    const separator = record.indexOf("\t");
    const metadata = separator === -1 ? "" : record.slice(0, separator);
    const path = separator === -1 ? "" : record.slice(separator + 1);
    const match = metadata.match(/^([0-7]{6}) ([a-z]+) ([0-9a-f]+)$/u);
    if (match === null || path === "" || !path.startsWith(migrationDirectoryPrefix)) {
      errors.add(`Snapshot Git ${label} contém entrada de migration inválida.`);
      continue;
    }
    if (entries.has(path)) {
      errors.add(`Snapshot Git ${label} contém migration duplicada: ${path}.`);
      continue;
    }
    entries.set(path, {
      mode: match[1],
      objectId: match[3],
      path,
      type: match[2],
    });
  }

  return { entries, errors: [...errors], label };
}

function parseGitIndexMigrationSnapshot(output) {
  const entries = new Map();
  const errors = new Set();

  for (const record of output.split("\0").filter(Boolean)) {
    const separator = record.indexOf("\t");
    const metadata = separator === -1 ? "" : record.slice(0, separator);
    const path = separator === -1 ? "" : record.slice(separator + 1);
    const match = metadata.match(/^([0-7]{6}) ([0-9a-f]+) ([0-3])$/u);
    if (match === null || path === "" || !path.startsWith(migrationDirectoryPrefix)) {
      errors.add("O índice Git contém entrada de migration inválida.");
      continue;
    }
    if (match[3] !== "0") {
      errors.add(`O índice Git contém conflito não resolvido na migration ${path}.`);
      continue;
    }
    if (entries.has(path)) {
      errors.add(`O índice Git contém migration duplicada: ${path}.`);
      continue;
    }
    entries.set(path, {
      mode: match[1],
      objectId: match[2],
      path,
      type: match[1] === "160000" ? "commit" : "blob",
    });
  }

  return { entries, errors: [...errors], label: "índice Git" };
}

function validateMigrationSnapshot(snapshot, errors) {
  const versions = new Map();

  for (const entry of snapshot.entries.values()) {
    const version = migrationPathVersion(entry.path);
    if (version === undefined || version === null) {
      errors.add(`${snapshot.label} contém nome de migration inválido: ${entry.path}.`);
      continue;
    }
    if (
      entry.type !== "blob" ||
      !/^(?:100644|100755)$/u.test(entry.mode) ||
      /^0+$/u.test(entry.objectId)
    ) {
      errors.add(
        `${snapshot.label} contém migration que não é blob regular materializado: ${entry.path}.`,
      );
    }
    const previousPath = versions.get(version);
    if (previousPath !== undefined && previousPath !== entry.path) {
      errors.add(
        `${snapshot.label} repete a versão de migration ${version}: ${previousPath} e ${entry.path}.`,
      );
    }
    versions.set(version, entry.path);
  }

  return [...versions.keys()].sort().at(-1);
}

function validateMigrationSnapshotTransition(previous, current, previousHead, errors) {
  for (const [path, previousEntry] of previous.entries) {
    const currentEntry = current.entries.get(path);
    if (currentEntry === undefined) {
      errors.add(
        `Migration commitada é imutável: ${path} foi removida entre ${previous.label} e ${current.label}.`,
      );
      continue;
    }
    if (
      currentEntry.mode !== previousEntry.mode ||
      currentEntry.type !== previousEntry.type ||
      currentEntry.objectId !== previousEntry.objectId
    ) {
      errors.add(
        `Migration commitada é imutável: ${path} mudou blob, tipo ou modo entre ${previous.label} e ${current.label}.`,
      );
    }
  }

  for (const entry of current.entries.values()) {
    if (previous.entries.has(entry.path)) {
      continue;
    }
    const version = migrationPathVersion(entry.path);
    if (
      version !== undefined &&
      version !== null &&
      previousHead !== undefined &&
      version <= previousHead
    ) {
      errors.add(
        `Migration nova ${entry.path} em ${current.label} precisa avançar estritamente o head ${previousHead} do snapshot anterior.`,
      );
    }
  }
}

function validateMigrationSnapshotSequence(snapshots) {
  const errors = new Set();
  const heads = snapshots.map((snapshot) => {
    for (const error of snapshot.errors) {
      errors.add(error);
    }
    return validateMigrationSnapshot(snapshot, errors);
  });

  for (let index = 1; index < snapshots.length; index += 1) {
    validateMigrationSnapshotTransition(
      snapshots[index - 1],
      snapshots[index],
      heads[index - 1],
      errors,
    );
  }

  return [...errors].sort();
}

function assertCompleteCanonicalGitHistory(runGit, root) {
  const shallowState = runGit(["rev-parse", "--is-shallow-repository"]).trim();
  if (shallowState !== "false") {
    throw new Error(
      "O histórico Git de migrations precisa estar completo; clones shallow são recusados",
    );
  }

  const replaceReferences = runGit(["for-each-ref", "--format=%(refname)", "refs/replace"]).trim();
  if (replaceReferences !== "") {
    throw new Error("O histórico Git de migrations não pode usar refs/replace");
  }

  const graftPathOutput = runGit(["rev-parse", "--git-path", "info/grafts"]).trim();
  if (graftPathOutput === "") {
    throw new Error("Não foi possível determinar o caminho Git canônico de info/grafts");
  }
  const graftPath = resolve(root, graftPathOutput);
  const graftInformation = lstatSync(graftPath, { bigint: true, throwIfNoEntry: false });
  if (graftInformation === undefined) {
    return;
  }
  if (!graftInformation.isFile() || graftInformation.isSymbolicLink()) {
    throw new Error("O legado info/grafts precisa ser um arquivo físico regular quando presente");
  }
  if (graftInformation.size !== 0n) {
    throw new Error("O histórico Git de migrations não pode usar info/grafts legado não vazio");
  }
}

function readFirstParentMigrationRevisions(runGit, headRevision, comparisonBase) {
  const firstParentNewestFirst = runGit(["rev-list", "--first-parent", headRevision])
    .split(/\s+/u)
    .filter(Boolean);
  const completeFirstParentHistory = [...firstParentNewestFirst].reverse();
  if (comparisonBase === null || comparisonBase === headRevision) {
    return completeFirstParentHistory;
  }
  if (typeof comparisonBase !== "string" || comparisonBase.trim() === "") {
    throw new TypeError("A base Git do histórico de migrations precisa ser um commit explícito.");
  }

  let safeBase = comparisonBase;
  try {
    runGit(["merge-base", "--is-ancestor", comparisonBase, headRevision]);
  } catch {
    safeBase = runGit(["merge-base", comparisonBase, headRevision]).trim();
    if (safeBase === "") {
      throw new Error("Não foi possível determinar uma base ancestral segura para migrations.");
    }
  }
  const baseIndex = firstParentNewestFirst.indexOf(safeBase);
  if (baseIndex === -1) {
    throw new Error(
      `A base segura ${migrationSnapshotLabel(safeBase)} não pertence à cadeia first-parent de HEAD.`,
    );
  }
  if (baseIndex === 0) {
    return completeFirstParentHistory;
  }

  return [safeBase, ...firstParentNewestFirst.slice(0, baseIndex).reverse()];
}

function readGitMigrationSnapshot(runGit, revision) {
  return parseGitTreeMigrationSnapshot(
    runGit([
      "ls-tree",
      "-r",
      "-z",
      "--full-tree",
      revision,
      "--",
      migrationDirectoryPrefix.slice(0, -1),
    ]),
    revision,
  );
}

function readGitIndexMigrationSnapshot(runGit) {
  return parseGitIndexMigrationSnapshot(
    runGit(["ls-files", "--stage", "-z", "--", migrationDirectoryPrefix.slice(0, -1)]),
  );
}

function readGitIndexMigrationFlagErrors(runGit) {
  const errors = [];
  for (const record of runGit(["ls-files", "-v", "-z", "--", migrationDirectoryPrefix.slice(0, -1)])
    .split("\0")
    .filter(Boolean)) {
    const match = record.match(/^([^ ]) (.+)$/su);
    if (match === null) {
      errors.push("Não foi possível interpretar as flags Git das migrations.");
    } else if (match[1] !== "H") {
      errors.push(
        `A migration ${match[2]} usa flag Git não canônica ${match[1]} (assume-unchanged, skip-worktree ou conflito).`,
      );
    }
  }
  return errors;
}

function readGitVisibleUntrackedMigrationChanges(runGit) {
  return parseGitChanges(
    runGit([
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      migrationDirectoryPrefix.slice(0, -1),
    ]),
    "A",
  );
}

function readGitWorktreeMigrationChanges(runGit, headRevision, visibleUntrackedChanges) {
  const trackedChanges =
    headRevision === null
      ? []
      : parseGitChanges(
          runGit([
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--name-status",
            "-z",
            "--diff-filter=ACMRTD",
            headRevision,
            "--",
            migrationDirectoryPrefix.slice(0, -1),
          ]),
        );
  return [...trackedChanges, ...visibleUntrackedChanges];
}

function physicalGitBlobMode(information) {
  return (information.mode & 0o111n) === 0n ? "100644" : "100755";
}

function validateGitMigrationViewAgainstPhysicalTree(
  root,
  indexSnapshot,
  visibleUntrackedChanges,
  runGit,
) {
  const errors = new Set();
  let physicalEntries;
  try {
    physicalEntries = new Map(
      inspectPhysicalMigrationDirectory(root).map((entry) => [entry.repositoryPath, entry]),
    );
  } catch (error) {
    return [
      `Não foi possível comparar o índice Git com as migrations físicas: ${error instanceof Error ? error.message : "erro desconhecido"}.`,
    ];
  }

  const visibleUntrackedPaths = new Set();
  for (const change of visibleUntrackedChanges) {
    if (visibleUntrackedPaths.has(change.path)) {
      errors.add(`O Git listou mais de uma vez a migration untracked: ${change.path}.`);
    }
    visibleUntrackedPaths.add(change.path);
  }

  for (const path of physicalEntries.keys()) {
    if (!indexSnapshot.entries.has(path) && !visibleUntrackedPaths.has(path)) {
      errors.add(
        `Migration física não está indexada nem visível como untracked no Git canônico: ${path}.`,
      );
    }
  }
  for (const path of visibleUntrackedPaths) {
    if (!physicalEntries.has(path)) {
      errors.add(`Migration untracked visível no Git não está presente na árvore física: ${path}.`);
    }
  }

  for (const [path, indexEntry] of indexSnapshot.entries) {
    const physicalEntry = physicalEntries.get(path);
    if (physicalEntry === undefined) {
      errors.add(`Migration indexada não está presente na árvore física: ${path}.`);
      continue;
    }
    if (
      indexEntry.type !== "blob" ||
      !/^(?:100644|100755)$/u.test(indexEntry.mode) ||
      /^0+$/u.test(indexEntry.objectId)
    ) {
      continue;
    }

    try {
      const contents = readPhysicalRepositoryFile(root, path, {
        readBuffer: true,
        requireExclusive: true,
      });
      const physicalObjectId = runGit(["hash-object", "--no-filters", "--stdin"], {
        input: contents,
      }).trim();
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(physicalObjectId)) {
        throw new Error("git hash-object não retornou um blob canônico");
      }
      const finalInformation = lstatSync(physicalEntry.path, {
        bigint: true,
        throwIfNoEntry: false,
      });
      if (
        finalInformation === undefined ||
        !sameStableFileSnapshot(physicalEntry.information, finalInformation)
      ) {
        throw new Error("a migration mudou durante a comparação direta");
      }
      if (
        physicalObjectId !== indexEntry.objectId ||
        physicalGitBlobMode(finalInformation) !== indexEntry.mode
      ) {
        errors.add(`Migration física diverge do blob ou modo indexado: ${path}.`);
      }
    } catch (error) {
      errors.add(
        `Migration indexada não pôde ser comparada com a árvore física: ${path} (${error instanceof Error ? error.message : "erro desconhecido"}).`,
      );
    }
  }

  return [...errors].sort();
}

export function validateMigrationRepositoryHistory(
  root,
  comparisonBase,
  executeGit = execFileSync,
) {
  const runGit = (argumentsList, { input } = {}) =>
    executeGit("git", argumentsList, {
      ...gitExecutionOptions(root),
      ...(input === undefined ? {} : { input, stdio: ["pipe", "pipe", "ignore"] }),
    });
  assertCanonicalGitWorktreeRoot(runGit, root);
  let headRevision = null;
  try {
    headRevision = runGit(["rev-parse", "--verify", "HEAD^{commit}"]).trim() || null;
  } catch {
    // Um repositório bootstrap sem HEAD ainda precisa validar índice e árvore física.
  }

  if (headRevision !== null) {
    assertCompleteCanonicalGitHistory(runGit, root);
  }

  const errors = new Set();
  const historySnapshots =
    headRevision === null
      ? []
      : readFirstParentMigrationRevisions(runGit, headRevision, comparisonBase).map((revision) =>
          readGitMigrationSnapshot(runGit, revision),
        );
  for (const error of validateMigrationSnapshotSequence(historySnapshots)) {
    errors.add(`histórico Git: ${error}`);
  }

  const headSnapshot =
    headRevision === null
      ? { entries: new Map(), errors: [], label: "bootstrap sem HEAD" }
      : readGitMigrationSnapshot(runGit, headRevision);
  const indexSnapshot = readGitIndexMigrationSnapshot(runGit);
  for (const error of validateMigrationSnapshotSequence([headSnapshot, indexSnapshot])) {
    errors.add(`índice Git: ${error}`);
  }
  for (const error of readGitIndexMigrationFlagErrors(runGit)) {
    errors.add(`índice Git: ${error}`);
  }
  const visibleUntrackedChanges = readGitVisibleUntrackedMigrationChanges(runGit);
  for (const error of validateGitMigrationViewAgainstPhysicalTree(
    root,
    indexSnapshot,
    visibleUntrackedChanges,
    runGit,
  )) {
    errors.add(`índice/worktree físico: ${error}`);
  }

  const worktreeChanges = readGitWorktreeMigrationChanges(
    runGit,
    headRevision,
    visibleUntrackedChanges,
  );
  for (const error of validateMigrationGitChanges(
    worktreeChanges,
    [...headSnapshot.entries.keys()],
    {
      repositoryRoot: root,
      requireBaselinePresent: headRevision !== null,
    },
  )) {
    errors.add(`worktree: ${error}`);
  }

  return [...errors].sort();
}

function migrationPathVersion(path) {
  if (!path.startsWith(migrationDirectoryPrefix)) {
    return null;
  }
  const fileName = path.slice(migrationDirectoryPrefix.length);
  const match = fileName.match(migrationFilePattern);
  return match?.[1] ?? undefined;
}

function inspectPhysicalMigrationDirectory(repositoryRoot) {
  const resolvedRoot = resolve(repositoryRoot);
  const migrationDirectory = resolve(resolvedRoot, migrationDirectoryPrefix.slice(0, -1));
  const normalizedDirectory = relative(resolvedRoot, migrationDirectory).split(sep).join("/");
  if (normalizedDirectory !== migrationDirectoryPrefix.slice(0, -1)) {
    throw new Error("O diretório de migrations precisa permanecer dentro do repositório.");
  }

  const ancestry = [];
  for (const path of [resolvedRoot, resolve(resolvedRoot, "supabase"), migrationDirectory]) {
    const information = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (information === undefined || !information.isDirectory() || information.isSymbolicLink()) {
      throw new Error("A árvore de migrations precisa usar diretórios físicos.");
    }
    ancestry.push({ information, path });
  }

  const entries = readdirSync(migrationDirectory)
    .sort()
    .map((name) => {
      const path = resolve(migrationDirectory, name);
      const information = lstatSync(path, { bigint: true, throwIfNoEntry: false });
      if (information === undefined) {
        throw new Error("Uma entrada de migration desapareceu durante a inspeção.");
      }
      return {
        information,
        path,
        repositoryPath: `${migrationDirectoryPrefix}${name}`,
      };
    });
  assertStablePhysicalAncestry(ancestry);
  return entries;
}

export function validateMigrationGitChanges(
  changes,
  baselineMigrationPaths,
  { repositoryRoot, requireBaselinePresent = false } = {},
) {
  if (!Array.isArray(changes) || !Array.isArray(baselineMigrationPaths)) {
    throw new TypeError("As mudanças e a baseline de migrations precisam ser listas.");
  }

  const errors = new Set();
  const baselinePaths = new Set();
  const baselineVersions = new Map();
  for (const path of baselineMigrationPaths) {
    if (typeof path !== "string") {
      throw new TypeError("A baseline Git de migrations contém caminho inválido.");
    }
    const version = migrationPathVersion(path);
    if (version === null) {
      continue;
    }
    if (version === undefined) {
      errors.add(`A baseline Git contém nome de migration inválido: ${path}.`);
      baselinePaths.add(path);
      continue;
    }
    const previousPath = baselineVersions.get(version);
    if (previousPath !== undefined && previousPath !== path) {
      errors.add(`A baseline Git possui versão de migration duplicada ${version}.`);
    }
    baselineVersions.set(version, path);
    baselinePaths.add(path);
  }
  const baselineHead = [...baselineVersions.keys()].sort().at(-1);

  const candidateVersions = new Map();
  const addedMigrationPaths = new Set();
  const registerCandidate = (path, version) => {
    const previousPath = candidateVersions.get(version);
    if (previousPath !== undefined && previousPath !== path) {
      errors.add(`Migrations novas repetem a versão ${version}: ${previousPath} e ${path}.`);
    }
    candidateVersions.set(version, path);
    if (baselineHead !== undefined && version <= baselineHead) {
      errors.add(
        `Migration nova ${path} precisa avançar estritamente o head ${baselineHead} da base Git.`,
      );
    }
  };
  for (const change of changes) {
    if (
      change === null ||
      typeof change !== "object" ||
      typeof change.path !== "string" ||
      typeof change.status !== "string"
    ) {
      throw new TypeError("O status Git de migrations possui formato inválido.");
    }
    const version = migrationPathVersion(change.path);
    if (version === null) {
      continue;
    }
    if (version === undefined) {
      errors.add(`Nome de migration alterada inválido: ${change.path}.`);
      continue;
    }

    if (change.status.at(0) === "A") {
      addedMigrationPaths.add(change.path);
    }

    if (baselinePaths.has(change.path) && /[DMRT]/u.test(change.status.at(0) ?? "")) {
      errors.add(
        `Migration aplicada é imutável: ${change.path} recebeu status ${change.status.at(0)}.`,
      );
    }
    if (!baselinePaths.has(change.path) && change.status.at(0) !== "D") {
      registerCandidate(change.path, version);
    }
    if (change.status.at(0) === "T") {
      errors.add(`Migration precisa permanecer arquivo regular: ${change.path}.`);
    }
  }

  if (typeof repositoryRoot !== "string" || repositoryRoot.trim() === "") {
    if (addedMigrationPaths.size > 0) {
      throw new TypeError("A raiz física do repositório é obrigatória para migration adicionada.");
    }
  } else {
    try {
      const inspectedEntries = inspectPhysicalMigrationDirectory(repositoryRoot);
      const physicalPaths = new Set(inspectedEntries.map(({ repositoryPath }) => repositoryPath));
      for (const { information, path, repositoryPath } of inspectedEntries) {
        const isExclusiveRegularFile =
          information.isFile() && !information.isSymbolicLink() && information.nlink === 1n;
        if (!isExclusiveRegularFile) {
          const qualifier = baselinePaths.has(repositoryPath) ? "Migration" : "Migration nova";
          errors.add(
            `${qualifier} precisa ser arquivo físico regular exclusivo e estável: ${repositoryPath}.`,
          );
        } else {
          try {
            readPhysicalRepositoryFile(repositoryRoot, repositoryPath, { requireExclusive: true });
          } catch (error) {
            errors.add(
              `Migration precisa permanecer física e estável: ${repositoryPath} (${error instanceof Error ? error.message : "erro desconhecido"}).`,
            );
          }
        }

        const currentInformation = lstatSync(path, { bigint: true, throwIfNoEntry: false });
        if (
          currentInformation === undefined ||
          !sameStableFileSnapshot(information, currentInformation)
        ) {
          errors.add(`Migration mudou durante a inspeção física: ${repositoryPath}.`);
        }
        if (migrationPathVersion(repositoryPath) === undefined) {
          errors.add(`Nome de migration no diretório físico é inválido: ${repositoryPath}.`);
        } else if (!baselinePaths.has(repositoryPath)) {
          registerCandidate(repositoryPath, migrationPathVersion(repositoryPath));
        }
      }
      if (requireBaselinePresent) {
        for (const baselinePath of baselinePaths) {
          if (!physicalPaths.has(baselinePath)) {
            errors.add(
              `Migration commitada é imutável: ${baselinePath} não está presente no worktree físico.`,
            );
          }
        }
      }
    } catch (error) {
      errors.add(
        `Não foi possível inspecionar fisicamente as migrations: ${error instanceof Error ? error.message : "erro desconhecido"}.`,
      );
    }
  }

  return [...errors].sort();
}

export function isAddedChangeRecord(change) {
  return change.status === "A" && /^docs\/changes\/\d{4}-\d{2}-\d{2}-.+\.md$/.test(change.path);
}

export function isProgressSummaryChange(change) {
  return (
    change.path === "contexto-projeto-set-livre.html" &&
    (change.status === "A" || change.status === "M")
  );
}

export function validateProgressSummary(content) {
  const errors = [];
  const requiredSectionIds = [
    "status",
    "produto",
    "aplicacoes",
    "arquitetura",
    "scripts",
    "testes",
    "seguranca",
    "release",
    "features",
    "proximos-passos",
  ];

  if (!/^<!doctype html>/iu.test(content.trimStart())) {
    errors.push("o resumo precisa declarar HTML5");
  }
  if (!/<html\s[^>]*lang=["']pt-BR["'][^>]*>/iu.test(content)) {
    errors.push("o resumo precisa declarar lang=pt-BR");
  }
  if ((content.match(/<h1(?:\s|>)/giu) ?? []).length !== 1) {
    errors.push("o resumo precisa conter exatamente um h1");
  }
  if (!/<main(?:\s|>)/iu.test(content) || !/<\/main>/iu.test(content)) {
    errors.push("o resumo precisa conter um main");
  }
  for (const sectionId of requiredSectionIds) {
    if (!new RegExp(`<section\\s[^>]*id=["']${sectionId}["'][^>]*>`, "iu").test(content)) {
      errors.push(`o resumo não contém a seção #${sectionId}`);
    }
  }
  if (/<script(?:\s|>)/iu.test(content)) {
    errors.push("o resumo executivo não pode depender de JavaScript");
  }
  if (/<link\s[^>]*rel=["']stylesheet["'][^>]*>/iu.test(content)) {
    errors.push("o resumo executivo precisa manter o CSS incorporado");
  }

  return errors;
}

export function isTechnicalChangePath(path) {
  if (/^(?:src|apps|packages|scripts|supabase|tests)\//.test(path)) {
    return true;
  }

  const fileName = path.split("/").at(-1) ?? "";
  const rootFrameworkEntrypoint =
    /^(?:instrumentation(?:-client)?|middleware|proxy)\.(?:jsx?|tsx?)$/.test(path) ||
    /^mdx-components\.(?:jsx?|tsx?)$/.test(path);

  return (
    rootFrameworkEntrypoint ||
    (fileName.startsWith(".") && !fileName.endsWith(".md")) ||
    /\.(?:json|toml|ya?ml)$/.test(fileName) ||
    /(?:^|[.-])config\.(?:[cm]?[jt]s|json|toml|ya?ml)$/.test(fileName) ||
    fileName === "next-env.d.ts"
  );
}

export function parseNormativeIntegrationPairs(content) {
  const section = markdownSection(content, "## Integrações `dependency-to-complete`");
  const pairs = [];

  for (const line of section.split("\n")) {
    if (!line.startsWith("|") || !line.includes("FEAT-")) {
      continue;
    }
    const columns = line.split("|").map((column) => column.trim());
    const providers = parseFeatureReferences(columns[1] ?? "");
    const consumers = parseFeatureReferences(columns[2] ?? "");
    for (const provider of providers) {
      for (const consumer of consumers) {
        pairs.push({ consumer, provider });
      }
    }
  }

  return pairs;
}

export function parsePendingRows(content) {
  return content
    .split("\n")
    .filter((line) => /^\| PEND-\d{3} \|/.test(line))
    .map((line) => {
      const columns = line.split("|").map((column) => column.trim());
      return {
        featureIds: parseFeatureReferences(columns[4] ?? ""),
        id: columns[1],
        state: columns[7],
      };
    });
}

export function parseOpenPendingFeaturePairs(content) {
  return parsePendingRows(content)
    .filter((row) => row.state === "aberta")
    .flatMap((row) => row.featureIds.map((feature) => ({ feature, pending: row.id })));
}

function pairKey(left, right) {
  return `${left}->${right}`;
}

function comparePairSets(actualKeys, expectedKeys, label, errors) {
  const duplicates = findDuplicates(actualKeys);
  if (duplicates.length > 0) {
    errors.push(`${label} possui pares duplicados: ${duplicates.join(", ")}.`);
  }

  const actual = new Set(actualKeys);
  const expected = new Set(expectedKeys);
  const missing = [...expected].filter((key) => !actual.has(key)).sort();
  const extra = [...actual].filter((key) => !expected.has(key)).sort();
  if (missing.length > 0) {
    errors.push(`${label} não contém os pares normativos: ${missing.join(", ")}.`);
  }
  if (extra.length > 0) {
    errors.push(`${label} contém pares sem owner normativo: ${extra.join(", ")}.`);
  }
}

export function validateGovernanceAlignment(
  contract,
  normativeIntegrationPairs,
  openPendingFeaturePairs,
) {
  const errors = [];
  const integrations = Array.isArray(contract.dependencyToComplete)
    ? contract.dependencyToComplete
    : [];
  const releaseDependencies = Array.isArray(contract.dependencyToRelease)
    ? contract.dependencyToRelease
    : [];

  comparePairSets(
    integrations.map((integration) => pairKey(integration.provider, integration.consumer)),
    normativeIntegrationPairs.map((pair) => pairKey(pair.provider, pair.consumer)),
    "dependency-to-complete",
    errors,
  );
  for (const integration of integrations) {
    if (integration.scenarioOwner !== integration.consumer) {
      errors.push(
        `${pairKey(integration.provider, integration.consumer)} precisa pertencer ao cenário da feature consumidora ${String(integration.consumer)}.`,
      );
    }
  }

  comparePairSets(
    releaseDependencies.map((dependency) => pairKey(dependency.feature, dependency.pending)),
    openPendingFeaturePairs.map((pair) => pairKey(pair.feature, pair.pending)),
    "dependency-to-release",
    errors,
  );

  return errors;
}

export function validateFeatureSequence(contract, expectedFeatureIds, pendingIds) {
  const errors = [];
  const expected = new Set(expectedFeatureIds);
  const pending = new Set(pendingIds);
  const sequence = Array.isArray(contract.sequence) ? contract.sequence : [];
  const dependencies =
    contract.dependencyToStart !== null && typeof contract.dependencyToStart === "object"
      ? contract.dependencyToStart
      : {};

  if (contract.version !== 1) {
    errors.push("A versão do contrato de sequência precisa ser 1.");
  }

  const sequenceDuplicates = findDuplicates(sequence);
  if (sequenceDuplicates.length > 0) {
    errors.push(`Features duplicadas na sequência: ${sequenceDuplicates.join(", ")}.`);
  }

  const missing = expectedFeatureIds.filter((feature) => !sequence.includes(feature));
  const unknown = sequence.filter((feature) => !expected.has(feature));
  if (missing.length > 0) {
    errors.push(`Features ausentes da sequência: ${missing.join(", ")}.`);
  }
  if (unknown.length > 0) {
    errors.push(`Features desconhecidas na sequência: ${unknown.join(", ")}.`);
  }

  const positions = new Map(sequence.map((feature, index) => [feature, index]));
  for (const feature of expectedFeatureIds) {
    const featureDependencies = dependencies[feature];
    if (!Array.isArray(featureDependencies)) {
      errors.push(`${feature} não declara dependency-to-start como lista.`);
      continue;
    }

    for (const dependency of featureDependencies) {
      if (!expected.has(dependency)) {
        errors.push(`${feature} depende de feature desconhecida ${dependency}.`);
        continue;
      }
      if (dependency === feature) {
        errors.push(`${feature} depende de si própria.`);
      }
      if ((positions.get(dependency) ?? Infinity) >= (positions.get(feature) ?? -1)) {
        errors.push(`${dependency} precisa aparecer antes de ${feature}.`);
      }
    }
  }

  for (const feature of Object.keys(dependencies)) {
    if (!expected.has(feature)) {
      errors.push(`dependency-to-start contém chave desconhecida ${feature}.`);
    }
  }

  const visiting = new Set();
  const visited = new Set();
  function visit(feature) {
    if (visiting.has(feature)) {
      errors.push(`Ciclo detectado em dependency-to-start envolvendo ${feature}.`);
      return;
    }
    if (visited.has(feature)) {
      return;
    }

    visiting.add(feature);
    const featureDependencies = dependencies[feature];
    if (Array.isArray(featureDependencies)) {
      for (const dependency of featureDependencies) {
        if (expected.has(dependency)) {
          visit(dependency);
        }
      }
    }
    visiting.delete(feature);
    visited.add(feature);
  }

  for (const feature of expectedFeatureIds) {
    visit(feature);
  }

  const integrations = Array.isArray(contract.dependencyToComplete)
    ? contract.dependencyToComplete
    : [];
  for (const integration of integrations) {
    for (const key of ["provider", "consumer", "scenarioOwner"]) {
      if (!expected.has(integration[key])) {
        errors.push(`Integração possui ${key} desconhecido: ${String(integration[key])}.`);
      }
    }
    if (
      expected.has(integration.provider) &&
      expected.has(integration.consumer) &&
      (positions.get(integration.provider) ?? Infinity) >=
        (positions.get(integration.consumer) ?? -1)
    ) {
      errors.push(
        `Integração posterior precisa posicionar ${integration.provider} antes de ${integration.consumer}.`,
      );
    }
    if (typeof integration.contract !== "string" || integration.contract.trim() === "") {
      errors.push("Integração posterior sem descrição de contrato.");
    }
  }

  const releaseDependencies = Array.isArray(contract.dependencyToRelease)
    ? contract.dependencyToRelease
    : [];
  for (const releaseDependency of releaseDependencies) {
    if (!expected.has(releaseDependency.feature)) {
      errors.push(`Dependência de release referencia ${String(releaseDependency.feature)}.`);
    }
    if (!pending.has(releaseDependency.pending)) {
      errors.push(
        `Dependência de release sem pendência aberta: ${String(releaseDependency.pending)}.`,
      );
    }
  }

  return errors;
}

export function parseQaRows(content) {
  return content
    .split("\n")
    .filter((line) => /^\| SL-F\d{3}-E2E-\d{3} \|/.test(line))
    .map((line) => {
      const columns = line.split("|").map((column) => column.trim());
      return {
        automation: columns[7],
        feature: columns[2],
        id: columns[1],
        spec: columns[8]?.replaceAll("`", ""),
      };
    });
}

function samePhysicalFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableFileSnapshot(left, right) {
  return (
    samePhysicalFile(left, right) &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function assertStablePhysicalAncestry(ancestry) {
  for (const { information, path } of ancestry) {
    const currentInformation = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (
      currentInformation === undefined ||
      !currentInformation.isDirectory() ||
      currentInformation.isSymbolicLink() ||
      !samePhysicalFile(information, currentInformation)
    ) {
      throw new Error("O caminho do arquivo mudou durante a leitura.");
    }
  }
}

function inspectPhysicalRepositoryFile(repositoryRoot, repositoryPath, requireExclusive) {
  const resolvedRoot = resolve(repositoryRoot);
  const absolutePath = resolve(resolvedRoot, repositoryPath);
  const normalizedPath = relative(resolvedRoot, absolutePath).split(sep).join("/");
  if (normalizedPath === "" || normalizedPath !== repositoryPath) {
    throw new Error("O arquivo precisa permanecer dentro do repositório.");
  }

  const rootInformation = lstatSync(resolvedRoot, { bigint: true, throwIfNoEntry: false });
  if (
    rootInformation === undefined ||
    !rootInformation.isDirectory() ||
    rootInformation.isSymbolicLink()
  ) {
    throw new Error("A raiz do repositório precisa ser um diretório físico.");
  }
  const ancestry = [{ information: rootInformation, path: resolvedRoot }];

  let currentParent = resolvedRoot;
  for (const component of normalizedPath.split("/").slice(0, -1)) {
    currentParent = resolve(currentParent, component);
    const parentInformation = lstatSync(currentParent, {
      bigint: true,
      throwIfNoEntry: false,
    });
    if (
      parentInformation === undefined ||
      !parentInformation.isDirectory() ||
      parentInformation.isSymbolicLink()
    ) {
      throw new Error("O caminho do arquivo atravessa um diretório não físico.");
    }
    ancestry.push({ information: parentInformation, path: currentParent });
  }

  const pathInformation = lstatSync(absolutePath, { bigint: true, throwIfNoEntry: false });
  if (
    pathInformation === undefined ||
    !pathInformation.isFile() ||
    pathInformation.isSymbolicLink() ||
    (requireExclusive && pathInformation.nlink !== 1n)
  ) {
    throw new Error(
      `O arquivo precisa ser físico e regular${requireExclusive ? " e exclusivo" : ""}.`,
    );
  }

  return { absolutePath, ancestry, pathInformation };
}

export function readPhysicalRepositoryFile(
  repositoryRoot,
  repositoryPath,
  { readBuffer = false, readDescriptor, requireExclusive = false } = {},
) {
  const { absolutePath, ancestry, pathInformation } = inspectPhysicalRepositoryFile(
    repositoryRoot,
    repositoryPath,
    requireExclusive,
  );

  let descriptor;
  try {
    descriptor = openSync(absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const openedInformation = fstatSync(descriptor, { bigint: true });
    if (
      !openedInformation.isFile() ||
      !sameStableFileSnapshot(pathInformation, openedInformation) ||
      (requireExclusive && openedInformation.nlink !== 1n)
    ) {
      throw new Error("O arquivo mudou durante a abertura.");
    }

    const source =
      readDescriptor === undefined
        ? readFileSync(descriptor, readBuffer ? undefined : "utf8")
        : readDescriptor(descriptor);
    if (readBuffer ? !Buffer.isBuffer(source) : typeof source !== "string") {
      throw new Error(`A leitura do arquivo não retornou ${readBuffer ? "bytes" : "texto"}.`);
    }
    const finalDescriptorInformation = fstatSync(descriptor, { bigint: true });
    const finalInformation = lstatSync(absolutePath, {
      bigint: true,
      throwIfNoEntry: false,
    });
    if (
      finalInformation === undefined ||
      finalInformation.isSymbolicLink() ||
      !finalInformation.isFile() ||
      !sameStableFileSnapshot(openedInformation, finalDescriptorInformation) ||
      !sameStableFileSnapshot(openedInformation, finalInformation) ||
      (requireExclusive &&
        (finalDescriptorInformation.nlink !== 1n || finalInformation.nlink !== 1n))
    ) {
      throw new Error("O arquivo mudou durante a leitura.");
    }
    assertStablePhysicalAncestry(ancestry);
    return source;
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

export function writePhysicalRepositoryFile(
  repositoryRoot,
  repositoryPath,
  contents,
  { expectedSource, requireExclusive = true } = {},
) {
  if (typeof contents !== "string" || typeof expectedSource !== "string") {
    throw new TypeError("A escrita física exige conteúdo e fonte esperada textuais.");
  }
  const { absolutePath, ancestry, pathInformation } = inspectPhysicalRepositoryFile(
    repositoryRoot,
    repositoryPath,
    requireExclusive,
  );

  let descriptor;
  try {
    descriptor = openSync(absolutePath, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
    const openedInformation = fstatSync(descriptor, { bigint: true });
    if (
      !openedInformation.isFile() ||
      !sameStableFileSnapshot(pathInformation, openedInformation) ||
      (requireExclusive && openedInformation.nlink !== 1n)
    ) {
      throw new Error("O arquivo mudou antes da escrita física.");
    }
    const currentSource = readFileSync(descriptor, "utf8");
    const stableDescriptorInformation = fstatSync(descriptor, { bigint: true });
    const stablePathInformation = lstatSync(absolutePath, {
      bigint: true,
      throwIfNoEntry: false,
    });
    if (
      currentSource !== expectedSource ||
      stablePathInformation === undefined ||
      stablePathInformation.isSymbolicLink() ||
      !stablePathInformation.isFile() ||
      !sameStableFileSnapshot(openedInformation, stableDescriptorInformation) ||
      !sameStableFileSnapshot(openedInformation, stablePathInformation)
    ) {
      throw new Error("O arquivo mudou durante a preparação da escrita física.");
    }
    assertStablePhysicalAncestry(ancestry);

    const output = Buffer.from(contents, "utf8");
    ftruncateSync(descriptor, 0);
    let offset = 0;
    while (offset < output.length) {
      offset += writeSync(descriptor, output, offset, output.length - offset, offset);
    }
    fsyncSync(descriptor);

    const persisted = Buffer.alloc(output.length);
    let readOffset = 0;
    while (readOffset < persisted.length) {
      const bytesRead = readSync(
        descriptor,
        persisted,
        readOffset,
        persisted.length - readOffset,
        readOffset,
      );
      if (bytesRead === 0) {
        throw new Error("A releitura física terminou antes do conteúdo persistido.");
      }
      readOffset += bytesRead;
    }
    if (!persisted.equals(output)) {
      throw new Error("O conteúdo persistido divergiu da formatação calculada.");
    }

    const finalDescriptorInformation = fstatSync(descriptor, { bigint: true });
    const finalInformation = lstatSync(absolutePath, {
      bigint: true,
      throwIfNoEntry: false,
    });
    if (
      finalInformation === undefined ||
      finalInformation.isSymbolicLink() ||
      !finalInformation.isFile() ||
      !samePhysicalFile(openedInformation, finalDescriptorInformation) ||
      !samePhysicalFile(openedInformation, finalInformation) ||
      finalDescriptorInformation.mode !== openedInformation.mode ||
      finalInformation.mode !== openedInformation.mode ||
      finalDescriptorInformation.nlink !== openedInformation.nlink ||
      finalInformation.nlink !== openedInformation.nlink ||
      finalDescriptorInformation.size !== BigInt(output.length) ||
      finalInformation.size !== BigInt(output.length)
    ) {
      throw new Error("O arquivo mudou durante a conclusão da escrita física.");
    }
    assertStablePhysicalAncestry(ancestry);
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

export function readAddedChangeRecord(repositoryRoot, change, options = {}) {
  if (!isAddedChangeRecord(change)) {
    throw new Error("O registro precisa ser um Markdown novo em docs/changes/.");
  }

  const source = readPhysicalRepositoryFile(repositoryRoot, change.path, {
    readDescriptor: options.readDescriptor,
    requireExclusive: true,
  });
  if (source.trim() === "") {
    throw new Error("O registro de mudança novo não pode estar vazio.");
  }
  return source;
}

export function validateAutomatedQaSpec(repositoryRoot, row) {
  if (typeof row.spec !== "string" || !/^tests\/e2e\/.+\.spec\.(?:ts|tsx)$/u.test(row.spec)) {
    return `${String(row.id)} automatizado não possui caminho de spec Playwright válido.`;
  }

  let source;
  try {
    source = readPhysicalRepositoryFile(repositoryRoot, row.spec);
  } catch {
    return `${String(row.id)} automatizado não aponta para arquivo regular físico de spec: ${row.spec}.`;
  }

  return hasPlaywrightTestWithId(source, String(row.id), row.spec)
    ? null
    : `${String(row.id)} automatizado aponta para ${row.spec}, mas o arquivo não registra um teste importado de @playwright/test com esse ID estável no título.`;
}

function addBindingNames(bindingName, names) {
  if (ts.isIdentifier(bindingName)) {
    names.add(bindingName.text);
    return;
  }

  for (const element of bindingName.elements) {
    if (!ts.isOmittedExpression(element)) {
      addBindingNames(element.name, names);
    }
  }
}

function importedPlaywrightTestBindings(sourceFile) {
  const importsByLocalName = new Map();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }

    const importClause = statement.importClause;
    if (importClause === undefined || importClause.isTypeOnly) {
      continue;
    }

    const importedBindings = [];
    if (importClause.name !== undefined) {
      importedBindings.push({ importedName: "default", localName: importClause.name.text });
    }
    if (importClause.namedBindings !== undefined) {
      if (ts.isNamespaceImport(importClause.namedBindings)) {
        importedBindings.push({
          importedName: "*",
          localName: importClause.namedBindings.name.text,
        });
      } else {
        for (const specifier of importClause.namedBindings.elements) {
          if (!specifier.isTypeOnly) {
            importedBindings.push({
              importedName: specifier.propertyName?.text ?? specifier.name.text,
              localName: specifier.name.text,
            });
          }
        }
      }
    }

    for (const importedBinding of importedBindings) {
      const occurrences = importsByLocalName.get(importedBinding.localName) ?? [];
      occurrences.push({
        importedName: importedBinding.importedName,
        moduleName: statement.moduleSpecifier.text,
      });
      importsByLocalName.set(importedBinding.localName, occurrences);
    }
  }

  return new Set(
    [...importsByLocalName.entries()]
      .filter(
        ([, occurrences]) =>
          occurrences.length === 1 &&
          occurrences[0].moduleName === "@playwright/test" &&
          occurrences[0].importedName === "test",
      )
      .map(([localName]) => localName),
  );
}

function directRuntimeBindings(statements) {
  const bindings = new Set();

  for (const statement of statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        addBindingNames(declaration.name, bindings);
      }
    } else if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isModuleDeclaration(statement)) &&
      statement.name !== undefined &&
      ts.isIdentifier(statement.name)
    ) {
      bindings.add(statement.name.text);
    } else if (ts.isImportEqualsDeclaration(statement)) {
      bindings.add(statement.name.text);
    }
  }

  return bindings;
}

function functionScopedVarBindings(node) {
  const bindings = new Set();

  function visit(current) {
    if (current !== node && ts.isFunctionLike(current)) {
      return;
    }
    if (ts.isVariableDeclarationList(current) && (current.flags & ts.NodeFlags.BlockScoped) === 0) {
      for (const declaration of current.declarations) {
        addBindingNames(declaration.name, bindings);
      }
    }
    ts.forEachChild(current, visit);
  }

  visit(node);
  return bindings;
}

function availableBindingsForScope(bindings, statements, scopeNode, callback) {
  const shadowedBindings = directRuntimeBindings(statements);
  for (const binding of functionScopedVarBindings(scopeNode)) {
    shadowedBindings.add(binding);
  }
  if (callback !== undefined) {
    if (callback.name !== undefined) {
      shadowedBindings.add(callback.name.text);
    }
    for (const parameter of callback.parameters) {
      addBindingNames(parameter.name, shadowedBindings);
    }
  }

  return new Set([...bindings].filter((binding) => !shadowedBindings.has(binding)));
}

function isInlineCallback(node) {
  return node !== undefined && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));
}

function isMatchingTestCall(expression, bindings, idPattern) {
  if (
    !ts.isCallExpression(expression) ||
    !ts.isIdentifier(expression.expression) ||
    !bindings.has(expression.expression.text) ||
    expression.arguments.length < 2
  ) {
    return false;
  }

  const title = expression.arguments[0];
  const body = expression.arguments.at(-1);
  return (
    title !== undefined &&
    (ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title)) &&
    isInlineCallback(body) &&
    idPattern.test(title.text)
  );
}

function describeCallback(expression, bindings) {
  if (
    !ts.isCallExpression(expression) ||
    !ts.isPropertyAccessExpression(expression.expression) ||
    !ts.isIdentifier(expression.expression.expression) ||
    !bindings.has(expression.expression.expression.text) ||
    expression.expression.name.text !== "describe" ||
    expression.arguments.length < 2
  ) {
    return undefined;
  }

  const title = expression.arguments[0];
  const callback = expression.arguments.at(-1);
  return title !== undefined &&
    (ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title)) &&
    isInlineCallback(callback)
    ? callback
    : undefined;
}

function registrationExpressionContainsTest(expression, bindings, idPattern) {
  if (isMatchingTestCall(expression, bindings, idPattern)) {
    return true;
  }

  const callback = describeCallback(expression, bindings);
  if (callback === undefined) {
    return false;
  }

  const statements = ts.isBlock(callback.body) ? callback.body.statements : [];
  const callbackBindings = availableBindingsForScope(bindings, statements, callback.body, callback);
  if (ts.isBlock(callback.body)) {
    return registrationStatementsContainTest(statements, callbackBindings, idPattern);
  }
  return registrationExpressionContainsTest(callback.body, callbackBindings, idPattern);
}

function registrationStatementsContainTest(statements, bindings, idPattern) {
  for (const statement of statements) {
    if (
      ts.isExpressionStatement(statement) &&
      registrationExpressionContainsTest(statement.expression, bindings, idPattern)
    ) {
      return true;
    }
  }
  return false;
}

export function hasPlaywrightTestWithId(source, scenarioId, fileName = "scenario.spec.ts") {
  const scriptKind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const escapedId = scenarioId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const idPattern = new RegExp(`(?:^|[^A-Za-z0-9_-])${escapedId}(?=$|[^A-Za-z0-9_-])`, "u");
  const importedBindings = importedPlaywrightTestBindings(sourceFile);
  const availableBindings = availableBindingsForScope(
    importedBindings,
    sourceFile.statements,
    sourceFile,
    undefined,
  );
  return registrationStatementsContainTest(sourceFile.statements, availableBindings, idPattern);
}

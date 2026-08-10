import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

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
const canonicalWorkspacePatterns = ["apps/*", "packages/*"];
const canonicalWorkspacePackagePaths = [
  "apps/backoffice/package.json",
  "packages/contracts/package.json",
  "packages/ui/package.json",
];
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
  "@kubernetes/",
  "@linaria/",
  "@mikro-orm/",
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

  return ["package.json", ...canonicalWorkspacePackagePaths].map((packagePath) => {
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

function resolveGitComparisonBase(runGit) {
  let headRevision = "";
  try {
    headRevision = runGit(["rev-parse", "--verify", "HEAD^{commit}"]).trim();
  } catch {
    return null;
  }

  let currentBranchReference = "";
  try {
    currentBranchReference = runGit(["symbolic-ref", "--quiet", "HEAD"]).trim();
  } catch {
    // HEAD destacado continua podendo usar uma candidata válida no mesmo commit.
  }
  const isMainCheckout = currentBranchReference === "refs/heads/main";

  let closestCandidate = null;
  for (const reference of ["refs/remotes/origin/main", "refs/heads/main"]) {
    try {
      const revision = runGit(["rev-parse", "--verify", "--quiet", `${reference}^{commit}`]).trim();
      const mergeBase =
        revision === "" || (revision === headRevision && isMainCheckout)
          ? ""
          : revision === headRevision
            ? headRevision
            : runGit(["merge-base", revision, "HEAD"]).trim();
      if (mergeBase === "") {
        continue;
      }

      const distanceOutput = runGit([
        "rev-list",
        "--count",
        `${mergeBase}..${headRevision}`,
      ]).trim();
      const distance = /^\d+$/.test(distanceOutput) ? Number(distanceOutput) : Number.NaN;
      if (!Number.isSafeInteger(distance)) {
        continue;
      }

      if (closestCandidate === null || distance < closestCandidate.distance) {
        closestCandidate = { distance, revision };
      }
    } catch {
      // A ausência de uma ref candidata é esperada em clones e pacotes locais.
    }
  }

  if (closestCandidate !== null) {
    return closestCandidate.revision;
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

export function parseGitChanges(output, implicitStatus) {
  const tokens = output.split("\0").filter(Boolean);
  if (implicitStatus !== undefined) {
    return tokens.map((path) => ({ path, status: implicitStatus }));
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
      changes.push({ path, status });
    }
  }

  return changes;
}

export function readGitChanges(root, executeGit = execFileSync) {
  const runGit = (argumentsList) =>
    executeGit("git", argumentsList, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  const comparisonBase = resolveGitComparisonBase(runGit);
  const changes = gitChangedFileArgumentLists(comparisonBase).flatMap(
    ({ argumentsList, implicitStatus }) => parseGitChanges(runGit(argumentsList), implicitStatus),
  );

  return { changes, comparisonBase };
}

export function isAddedChangeRecord(change) {
  return change.status === "A" && /^docs\/changes\/\d{4}-\d{2}-\d{2}-.+\.md$/.test(change.path);
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

function readPhysicalRepositoryFile(
  repositoryRoot,
  repositoryPath,
  {
    readDescriptor = (descriptor) => readFileSync(descriptor, "utf8"),
    requireExclusive = false,
  } = {},
) {
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

    const source = readDescriptor(descriptor);
    if (typeof source !== "string") {
      throw new Error("A leitura do arquivo não retornou texto.");
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

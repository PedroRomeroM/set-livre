import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  collectMatches,
  findDuplicates,
  findForbiddenInstallDependencies,
  isAddedChangeRecord,
  isProgressSummaryChange,
  isTechnicalChangePath,
  parseNormativeIntegrationPairs,
  parseOpenPendingFeaturePairs,
  parsePendingRows,
  parseQaRows,
  readAddedChangeRecord,
  readCanonicalPackageManifests,
  readGitChanges,
  readGitMigrationPathsAtRevision,
  sha256,
  validateAutomatedQaSpec,
  validateAllowedInstallScripts,
  validateCanonicalDependencyRegistry,
  validateFeatureSequence,
  validateGovernanceAlignment,
  validateMigrationGitChanges,
  validateMigrationRepositoryHistory,
  validateProgressSummary,
  validateWorkspacePatterns,
} from "./docs-check-core.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const ignoredDirectories = new Set([
  ".artifacts",
  ".branches",
  ".git",
  ".next",
  ".temp",
  "coverage",
  "node_modules",
]);
const requiredFeatureSections = [
  "## Metadados",
  "## Objetivo",
  "## Dependências",
  "## Critérios de aceitação",
  "## Playwright obrigatório",
  "## Definition of Done da feature",
];

function read(relativePath) {
  return readFileSync(resolve(root, relativePath), "utf8");
}

function listFiles(directory) {
  return readdirSync(resolve(root, directory), { withFileTypes: true })
    .flatMap((entry) => {
      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) {
        return [];
      }
      const child = `${directory}/${entry.name}`;
      return entry.isDirectory() ? listFiles(child) : entry.isFile() ? [child] : [];
    })
    .sort();
}

function check(condition, message) {
  if (!condition) {
    errors.push(message);
  }
}

const blueprint = read("docs/reference/architecture-blueprint.md");
check(
  sha256(blueprint) === "3bdc55794381eeff77dad4a6e8c364e466debf19fa2acf24c688545e01184339",
  "O Blueprint divergiu do checksum canônico sem nova referência/ADR.",
);

const featureFiles = listFiles("docs/features").filter((path) => /FEAT-\d{3}-.+\.md$/.test(path));
check(featureFiles.length === 34, `Esperadas 34 features; encontradas ${featureFiles.length}.`);

const featureIds = [];
for (const file of featureFiles) {
  const content = read(file);
  const id = file.match(/FEAT-\d{3}/)?.[0];
  if (id !== undefined) {
    featureIds.push(id);
  }
  for (const section of requiredFeatureSections) {
    check(content.includes(section), `${file} não contém a seção obrigatória "${section}".`);
  }
}
check(findDuplicates(featureIds).length === 0, "Há IDs de feature duplicados.");

const featureSequence = JSON.parse(read("docs/feature-sequence.json"));
const pendingDocument = read("pendencias.md");
const pendingRows = parsePendingRows(pendingDocument);
const openPendingIds = pendingRows.filter((row) => row.state === "aberta").map((row) => row.id);
check(
  findDuplicates(pendingRows.map((row) => row.id)).length === 0,
  "Há IDs de pendência duplicados.",
);
for (const pendingRow of pendingRows) {
  check(
    ["aberta", "encerrada"].includes(pendingRow.state),
    `${pendingRow.id} possui estado de pendência inválido: ${pendingRow.state}.`,
  );
  for (const featureId of pendingRow.featureIds) {
    check(
      featureIds.includes(featureId),
      `${pendingRow.id} referencia feature inexistente ${featureId}.`,
    );
  }
}
for (const sequenceError of validateFeatureSequence(featureSequence, featureIds, openPendingIds)) {
  errors.push(`docs/feature-sequence.json: ${sequenceError}`);
}
const normativeIntegrationPairs = parseNormativeIntegrationPairs(
  read("docs/implementation-order.md"),
);
const openPendingFeaturePairs = parseOpenPendingFeaturePairs(pendingDocument);
for (const alignmentError of validateGovernanceAlignment(
  featureSequence,
  normativeIntegrationPairs,
  openPendingFeaturePairs,
)) {
  errors.push(`governança executável: ${alignmentError}`);
}

const adrFiles = listFiles("docs/adr").filter((path) => /ADR-\d{3}-.+\.md$/.test(path));
const adrIds = adrFiles.map((path) => path.match(/ADR-\d{3}/)?.[0]).filter(Boolean);
check(findDuplicates(adrIds).length === 0, "Há IDs de ADR duplicados.");

const migrationFiles = listFiles("supabase/migrations").filter((path) =>
  /\/\d{14}_.+\.sql$/.test(path),
);
const migrationHead = migrationFiles.at(-1)?.match(/\/(\d{14})_/)?.[1];
const migrationContract = read("packages/contracts/src/database-contract.ts").match(
  /databaseMigrationHead = "(\d{14})"/,
)?.[1];
check(migrationHead !== undefined, "Nenhuma migration versionada foi encontrada.");
check(
  migrationContract === migrationHead,
  `Contrato de migration head (${migrationContract ?? "ausente"}) diverge de ${migrationHead ?? "ausente"}.`,
);

const qaRows = parseQaRows(read("docs/qa-traceability.md"));
check(qaRows.length === 198, `Esperados 198 cenários QA; encontrados ${qaRows.length}.`);
check(findDuplicates(qaRows.map((row) => row.id)).length === 0, "Há IDs de cenário QA duplicados.");
for (const row of qaRows) {
  check(
    featureIds.includes(row.feature),
    `${row.id} referencia feature inexistente ${row.feature}.`,
  );
  check(
    ["planejado", "automatizado", "bloqueado"].includes(row.automation),
    `${row.id} possui status de automação inválido: ${row.automation}.`,
  );
  if (row.automation === "automatizado") {
    const specError = validateAutomatedQaSpec(root, row);
    if (specError !== null) {
      errors.push(specError);
    }
  }
}

for (const markdownPath of listFiles("docs").filter((path) => path.endsWith(".md"))) {
  const content = read(markdownPath);
  const links = collectMatches(content, /\[[^\]]+\]\(([^)]+)\)/g);
  for (const link of links) {
    if (/^(?:https?:|mailto:|#)/.test(link)) {
      continue;
    }
    const target = link.split("#", 1)[0];
    if (target === undefined || target === "") {
      continue;
    }
    check(
      existsSync(resolve(root, dirname(markdownPath), decodeURIComponent(target))),
      `${markdownPath} possui link local sem alvo: ${link}.`,
    );
  }
}

let packageManifests = [];
try {
  packageManifests = readCanonicalPackageManifests(root).map(({ packagePath, source }) => ({
    packageJson: JSON.parse(source),
    packagePath,
  }));
  const rootPackageJson =
    packageManifests.find(({ packagePath }) => packagePath === "package.json")?.packageJson ?? {};
  validateWorkspacePatterns(rootPackageJson);
  for (const { packageJson } of packageManifests) {
    validateAllowedInstallScripts(packageJson);
  }
} catch (error) {
  check(
    false,
    `Os manifests npm não correspondem aos workspaces físicos canônicos: ${error instanceof Error ? error.message : "formato desconhecido"}`,
  );
}
for (const { packageJson, packagePath } of packageManifests) {
  try {
    for (const dependency of findForbiddenInstallDependencies(packageJson)) {
      check(false, `${packagePath} introduziu dependência proibida: ${dependency}.`);
    }
  } catch (error) {
    check(
      false,
      `${packagePath} possui seção de dependência inválida: ${error instanceof Error ? error.message : "formato desconhecido"}`,
    );
  }
}
try {
  for (const registryError of validateCanonicalDependencyRegistry(
    packageManifests,
    read("docs/dependencias-utilizadas.md"),
  )) {
    errors.push(`docs/dependencias-utilizadas.md: ${registryError}`);
  }
} catch (error) {
  errors.push(
    `docs/dependencias-utilizadas.md não corresponde aos manifests canônicos: ${error instanceof Error ? error.message : "formato desconhecido"}`,
  );
}

const implementationFiles = ["src", "apps", "packages", "scripts", "supabase", "tests"]
  .filter((directory) => existsSync(resolve(root, directory)))
  .flatMap((directory) => listFiles(directory))
  .filter((path) => statSync(resolve(root, path)).isFile())
  .filter((path) => !path.includes("node_modules"));
const undocumentedDebtPattern = new RegExp(`\\b(?:${"TO" + "DO"}|${"FIX" + "ME"})\\b`);
for (const file of implementationFiles) {
  const content = read(file);
  check(
    !undocumentedDebtPattern.test(content),
    `${file} contém marcador de dívida sem registro formal.`,
  );
}

const playwrightFiles = implementationFiles.filter((path) =>
  /tests\/e2e\/.+\.(?:ts|tsx)$/.test(path),
);
for (const file of playwrightFiles) {
  const content = read(file);
  check(!/\.only\s*\(/.test(content), `${file} contém .only.`);
  check(!/\.skip\s*\(/.test(content), `${file} contém .skip.`);
  check(!/waitForTimeout\s*\(/.test(content), `${file} contém waitForTimeout.`);
}

let gitChanges = [];
try {
  const gitState = readGitChanges(root);
  gitChanges = gitState.changes;
  const baselineMigrationPaths = readGitMigrationPathsAtRevision(root, gitState.comparisonBase);
  for (const migrationError of validateMigrationGitChanges(gitChanges, baselineMigrationPaths, {
    repositoryRoot: root,
  })) {
    errors.push(`migrations append-only: ${migrationError}`);
  }
  for (const migrationError of validateMigrationRepositoryHistory(root, gitState.comparisonBase)) {
    errors.push(`migrations append-only: ${migrationError}`);
  }
} catch (error) {
  errors.push(
    `Não foi possível ler o status Git para validar documentação e migrations: ${error instanceof Error ? error.message : "erro desconhecido"}.`,
  );
}

const technicalChange = gitChanges.some((change) => isTechnicalChangePath(change.path));
const progressSummaryChanges = gitChanges.filter(isProgressSummaryChange);
let changeRecord = false;
const addedChangeRecords = new Map(
  gitChanges.filter(isAddedChangeRecord).map((change) => [change.path, change]),
);
for (const change of addedChangeRecords.values()) {
  try {
    readAddedChangeRecord(root, change);
    changeRecord = true;
  } catch (error) {
    errors.push(
      `${change.path} não é um registro de mudança físico e estável: ${error instanceof Error ? error.message : "formato desconhecido"}`,
    );
  }
}
check(!technicalChange || changeRecord, "Mudança técnica sem novo registro em docs/changes/.");
check(
  !technicalChange || progressSummaryChanges.length > 0,
  "Mudança técnica sem atualização de contexto-projeto-set-livre.html.",
);
for (const summaryError of validateProgressSummary(read("contexto-projeto-set-livre.html"))) {
  errors.push(`contexto-projeto-set-livre.html inválido: ${summaryError}.`);
}

if (errors.length > 0) {
  process.stderr.write(
    `docs:check falhou com ${errors.length} erro(s):\n- ${errors.join("\n- ")}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `docs:check OK — ${featureIds.length} features, ${qaRows.length} cenários, ${adrIds.length} ADRs.\n`,
  );
}

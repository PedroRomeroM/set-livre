import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  collectMatches,
  findDuplicates,
  isAddedChangeRecord,
  isTechnicalChangePath,
  parseNormativeIntegrationPairs,
  parseOpenPendingFeaturePairs,
  parsePendingRows,
  parseQaRows,
  readGitChanges,
  sha256,
  validateAutomatedQaSpec,
  validateFeatureSequence,
  validateGovernanceAlignment,
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
check(qaRows.length === 193, `Esperados 193 cenários QA; encontrados ${qaRows.length}.`);
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

const packageFiles = [
  "package.json",
  ...listFiles("apps").filter((path) => path.endsWith("package.json")),
  ...listFiles("packages").filter((path) => path.endsWith("package.json")),
].filter((path) => existsSync(resolve(root, path)));
const forbiddenDependencies = new Set([
  "@emotion/react",
  "@prisma/client",
  "@reduxjs/toolkit",
  "@supabase/auth-helpers-nextjs",
  "caddy",
  "drizzle-orm",
  "prisma",
  "redis",
  "styled-components",
  "tailwindcss",
  "zustand",
]);
for (const packageFile of packageFiles) {
  const packageJson = JSON.parse(read(packageFile));
  const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
  for (const dependency of Object.keys(dependencies)) {
    check(
      !forbiddenDependencies.has(dependency),
      `${packageFile} introduziu dependência proibida: ${dependency}.`,
    );
  }
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
  gitChanges = readGitChanges(root).changes;
} catch {
  errors.push("Não foi possível ler o status Git para validar o registro de mudança.");
}

const technicalChange = gitChanges.some((change) => isTechnicalChangePath(change.path));
const changeRecord = gitChanges.some(
  (change) => isAddedChangeRecord(change) && existsSync(resolve(root, change.path)),
);
check(!technicalChange || changeRecord, "Mudança técnica sem novo registro em docs/changes/.");

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

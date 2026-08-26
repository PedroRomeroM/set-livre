import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const ignoredDirectories = new Set([
  ".artifacts",
  ".git",
  ".next",
  ".temp",
  "coverage",
  "node_modules",
]);
const errors = [];

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function read(path) {
  return readFileSync(resolve(repositoryRoot, path), "utf8");
}

for (const required of [
  "AGENTS.md",
  "README.md",
  "docs/README.md",
  "docs/specification.md",
  "docs/architecture.md",
  "docs/database.md",
  "docs/development.md",
  "docs/infrastructure.md",
  "docs/review-deploy-cycle.md",
  "docs/roadmap.md",
  "docs/qa-test-plan.md",
  "docs/open-decisions.md",
  "docs/technical-debt.md",
]) {
  if (!existsSync(resolve(repositoryRoot, required)))
    errors.push(`Documento obrigatório ausente: ${required}`);
}

const markdownFiles = walk(repositoryRoot).filter((path) => extname(path) === ".md");
for (const path of markdownFiles) {
  const contents = readFileSync(path, "utf8");
  if (contents.trim() === "") errors.push(`Markdown vazio: ${path}`);

  const links = contents.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu);
  for (const match of links) {
    let target = match[1].trim();
    if (target.startsWith("<")) target = target.slice(1, target.indexOf(">"));
    else target = target.split(/\s+["']/u, 1)[0];
    if (/^(?:#|\/|https?:|mailto:)/u.test(target)) continue;
    try {
      target = decodeURIComponent(target.split("#", 1)[0].split("?", 1)[0]);
    } catch {
      errors.push(`Link com encoding inválido em ${path}: ${target}`);
      continue;
    }
    if (target !== "" && !existsSync(resolve(dirname(path), target))) {
      errors.push(`Link local quebrado em ${path}: ${target}`);
    }
  }
}

const featureDirectory = resolve(repositoryRoot, "docs/features");
const featureFiles = readdirSync(featureDirectory)
  .filter((name) => /^FEAT-\d{3}-.+\.md$/u.test(name))
  .sort();
const featureById = new Map();
const scenarioOwner = new Map();

for (const name of featureFiles) {
  const id = name.slice(0, 8);
  if (featureById.has(id)) errors.push(`Mais de um plano para ${id}.`);
  featureById.set(id, name);
  const contents = readFileSync(resolve(featureDirectory, name), "utf8");
  if (!/^# FEAT-\d{3}\b/mu.test(contents)) errors.push(`Título de feature inválido: ${name}`);
  if (!/\|\s*Status\s*\|\s*(?:Planejada|Em andamento)\s*\|/u.test(contents)) {
    errors.push(`Plano concluído ou sem status transitório: ${name}`);
  }
  const scenarios = [...contents.matchAll(/\bSL-F\d{3}-E2E-\d{3}\b/gu)].map((match) => match[0]);
  if (scenarios.length === 0) errors.push(`Plano sem cenário E2E: ${name}`);
  for (const scenario of scenarios) {
    const previous = scenarioOwner.get(scenario);
    if (previous !== undefined) errors.push(`Cenário duplicado ${scenario}: ${previous} e ${name}`);
    else scenarioOwner.set(scenario, name);
  }
}

const roadmap = read("docs/roadmap.md");
const roadmapEntries = [
  ...roadmap.matchAll(
    /^\|\s*\d+\s*\|\s*(FEAT-\d{3})\s*\|.*?\|\s*(Concluída|Planejada|Em andamento)\s*\|/gmu,
  ),
];
const roadmapIds = new Set();
for (const [, id, status] of roadmapEntries) {
  if (roadmapIds.has(id)) errors.push(`Feature duplicada no roadmap: ${id}`);
  roadmapIds.add(id);
  const hasPlan = featureById.has(id);
  if (status === "Concluída" && hasPlan)
    errors.push(`${id} concluída ainda possui plano transitório.`);
  if (status !== "Concluída" && !hasPlan)
    errors.push(`${id} ${status.toLowerCase()} não possui plano.`);
}
if (roadmapIds.size !== 34)
  errors.push(`Roadmap precisa conter 34 features; encontrou ${roadmapIds.size}.`);

const adrFiles = readdirSync(resolve(repositoryRoot, "docs/adr")).filter((name) =>
  /^ADR-\d{3}-.+\.md$/u.test(name),
);
const adrIds = new Set();
for (const name of adrFiles) {
  const id = name.slice(0, 7);
  if (adrIds.has(id)) errors.push(`ADR duplicado: ${id}`);
  adrIds.add(id);
  if (!/^## Status\s*$/mu.test(readFileSync(resolve(repositoryRoot, "docs/adr", name), "utf8"))) {
    errors.push(`ADR sem status: ${name}`);
  }
}

for (const path of markdownFiles) {
  const contents = readFileSync(path, "utf8");
  const references = new Set([...contents.matchAll(/\bADR-\d{3}\b/gu)].map((match) => match[0]));
  for (const reference of references) {
    if (!adrIds.has(reference))
      errors.push(`Referência a ADR inexistente em ${path}: ${reference}`);
  }
}

if (errors.length > 0) {
  process.stderr.write(`docs:check falhou:\n- ${errors.join("\n- ")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `docs:check OK — ${markdownFiles.length} documentos, ${featureFiles.length} planos, ${scenarioOwner.size} cenários planejados e ${adrFiles.length} ADRs.\n`,
  );
}

import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { databaseMigrationHead } from "../packages/contracts/src/database-contract.ts";

const repositoryRoot = resolve(import.meta.dirname, "..");
const migrationsDirectory = "supabase/migrations";
const baselineName = "20260824000100_initial_production_baseline.sql";
const initialProductionBaseCommit = "b4f40035b3e7eda64d94726483d82ece9f01c7ed";
const migrationNamePattern = /^(?<timestamp>\d{14})_[a-z0-9_]+\.sql$/u;

function git(root, arguments_, options = {}) {
  return execFileSync("git", arguments_, {
    cwd: root,
    encoding: options.encoding === undefined ? "utf8" : options.encoding,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function migrationFiles(root) {
  const directory = resolve(root, migrationsDirectory);
  return readdirSync(directory, { withFileTypes: true })
    .map((entry) => {
      if (!entry.isFile() || entry.isSymbolicLink() || !migrationNamePattern.test(entry.name)) {
        throw new Error(`Entrada inválida em ${migrationsDirectory}: ${entry.name}.`);
      }
      const path = resolve(directory, entry.name);
      if (!lstatSync(path).isFile()) throw new Error(`Migration inválida: ${entry.name}.`);
      return entry.name;
    })
    .sort();
}

function baseMigrationFiles(root, baseRef) {
  const output = git(root, ["ls-tree", "-r", "--name-only", baseRef, "--", migrationsDirectory]);
  return output
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((path) => path.slice(`${migrationsDirectory}/`.length))
    .sort();
}

function baseMigration(root, baseRef, name) {
  return git(root, ["show", `${baseRef}:${migrationsDirectory}/${name}`], { encoding: null });
}

function assertCurrentMigrationHead(current, expectedHead) {
  const currentHead = migrationNamePattern.exec(current.at(-1) ?? "")?.groups?.timestamp;
  if (!/^\d{14}$/u.test(expectedHead) || currentHead !== expectedHead) {
    throw new Error(
      `databaseMigrationHead ${expectedHead} diverge da migration mais recente ${currentHead ?? "ausente"}.`,
    );
  }
}

export function assertImmutableMigrations({
  baseRef = "origin/main",
  bootstrapBaseCommit = initialProductionBaseCommit,
  expectedHead = databaseMigrationHead,
  root = repositoryRoot,
} = {}) {
  const baseCommit = git(root, ["rev-parse", "--verify", `${baseRef}^{commit}`]).trim();
  const current = migrationFiles(root);
  const base = baseMigrationFiles(root, baseRef);

  if (!base.includes(baselineName)) {
    if (baseCommit !== bootstrapBaseCommit) {
      throw new Error(
        "A transição inicial só é autorizada sobre o main comprovadamente ligado à produção vazia.",
      );
    }
    if (current.length !== 1 || current[0] !== baselineName) {
      throw new Error("A transição inicial exige somente a baseline canônica de produção.");
    }
    assertCurrentMigrationHead(current, expectedHead);
    return { added: [baselineName], bootstrap: true, preserved: [] };
  }

  for (const name of base) {
    if (!current.includes(name)) throw new Error(`Migration aplicada foi excluída: ${name}.`);
    const currentBytes = readFileSync(resolve(root, migrationsDirectory, name));
    if (!currentBytes.equals(baseMigration(root, baseRef, name))) {
      throw new Error(`Migration aplicada foi alterada: ${name}.`);
    }
  }

  assertCurrentMigrationHead(current, expectedHead);

  const baseTimestamp = Math.max(
    ...base.map((name) => Number(migrationNamePattern.exec(name)?.groups?.timestamp ?? 0)),
  );
  const added = current.filter((name) => !base.includes(name));
  for (const name of added) {
    const timestamp = Number(migrationNamePattern.exec(name)?.groups?.timestamp ?? 0);
    if (timestamp <= baseTimestamp) {
      throw new Error(`Nova migration não é posterior ao histórico aplicado: ${name}.`);
    }
  }
  return { added, bootstrap: false, preserved: base };
}

const executedPath = process.argv[1];
if (executedPath !== undefined && pathToFileURL(resolve(executedPath)).href === import.meta.url) {
  try {
    const result = assertImmutableMigrations({
      baseRef: process.env.MIGRATION_BASE_REF || "origin/main",
    });
    process.stdout.write(
      result.bootstrap
        ? "Transição única para a baseline de produção validada.\n"
        : `Migrations imutáveis preservadas; ${result.added.length} nova(s).\n`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "falha desconhecida";
    process.stderr.write(`migration-guard: ${message}\n`);
    process.exitCode = 1;
  }
}

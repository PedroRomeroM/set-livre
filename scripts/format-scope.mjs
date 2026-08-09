import { existsSync, promises as fs } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as prettier from "prettier";

import { readGitChanges } from "./docs-check-core.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const mode = process.argv[2];
const ignoredDirectories = new Set([
  ".artifacts",
  ".git",
  ".next",
  ".temp",
  "coverage",
  "node_modules",
]);
const sourceDirectories = ["apps", "packages", "scripts", "src", "tests"];
const rootCandidates = [
  ".prettierrc.json",
  "eslint.config.mjs",
  "knip.json",
  "next.config.ts",
  "package.json",
  "playwright.config.ts",
  "tsconfig.base.json",
  "tsconfig.json",
  "tsconfig.tests.json",
  "vitest.config.ts",
];

if (mode !== "--check" && mode !== "--write") {
  throw new Error("Use --check ou --write.");
}

async function walk(relativeDirectory) {
  const absoluteDirectory = resolve(root, relativeDirectory);
  if (!existsSync(absoluteDirectory)) {
    return [];
  }

  const entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) {
      continue;
    }

    const child = `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await walk(child)));
    } else if (entry.isFile()) {
      files.push(child);
    }
  }

  return files;
}

function changedFiles() {
  return readGitChanges(root).changes.map((change) => change.path);
}

const candidates = new Set([...rootCandidates, ...changedFiles()]);
for (const directory of sourceDirectories) {
  for (const file of await walk(directory)) {
    candidates.add(file);
  }
}

const mismatches = [];
for (const file of [...candidates].sort()) {
  const absolutePath = resolve(root, file);
  if (!existsSync(absolutePath)) {
    continue;
  }

  const info = await prettier.getFileInfo(absolutePath, {
    ignorePath: resolve(root, ".prettierignore"),
  });
  if (info.ignored || info.inferredParser === null) {
    continue;
  }

  const source = await fs.readFile(absolutePath, "utf8");
  const configuration = (await prettier.resolveConfig(absolutePath)) ?? {};
  const formatted = await prettier.format(source, {
    ...configuration,
    filepath: absolutePath,
  });

  if (formatted === source) {
    continue;
  }

  if (mode === "--write") {
    await fs.writeFile(absolutePath, formatted, "utf8");
    process.stdout.write(`formatado ${relative(root, absolutePath)}\n`);
  } else {
    mismatches.push(relative(root, absolutePath));
  }
}

if (mismatches.length > 0) {
  process.stderr.write(`Arquivos fora do padrão:\n- ${mismatches.join("\n- ")}\n`);
  process.exitCode = 1;
} else if (mode === "--check") {
  process.stdout.write("format:check OK\n");
}

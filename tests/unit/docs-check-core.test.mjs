import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  collectMatches,
  findDuplicates,
  findForbiddenInstallDependencies,
  gitChangedFileArgumentLists,
  hasPlaywrightTestWithId,
  installDependencyNames,
  isAddedChangeRecord,
  isTechnicalChangePath,
  parseGitChanges,
  parseNormativeIntegrationPairs,
  parseOpenPendingFeaturePairs,
  parsePendingRows,
  parseFeatureReferences,
  parseQaRows,
  readCanonicalPackageManifests,
  readGitChanges,
  sha256,
  validateAutomatedQaSpec,
  validateAllowedInstallScripts,
  validateFeatureSequence,
  validateGovernanceAlignment,
  validateNpmProjectConfiguration,
  validateWorkspacePatterns,
} from "../../scripts/docs-check-core.mjs";

describe("docs check core", () => {
  it("finds duplicate identifiers deterministically", () => {
    expect(findDuplicates(["A", "B", "A", "C", "B", "A"])).toEqual(["A", "B"]);
  });

  it("covers every package section that can install or bundle dependencies", () => {
    const packageJson = {
      bundleDependencies: ["cache", "duplicate"],
      bundledDependencies: ["bundled", "duplicate"],
      dependencies: { cache: "NPM:redis@5", duplicate: "1.0.0", runtime: "1.0.0" },
      devDependencies: { development: "1.0.0" },
      optionalDependencies: { css: "npm:tailwindcss@4" },
      overrides: {
        "parent@2": {
          ".": "2.1.0",
          child: "npm:zustand@5",
          nested: { redis: "5.0.0" },
        },
      },
      peerDependencies: { peer: "npm:@scope/state@5" },
      peerDependenciesMeta: { ignoredMetadata: { optional: true } },
    };

    expect(installDependencyNames(packageJson)).toEqual([
      "@scope/state",
      "bundled",
      "cache",
      "child",
      "css",
      "development",
      "duplicate",
      "nested",
      "parent",
      "peer",
      "redis",
      "runtime",
      "tailwindcss",
      "zustand",
    ]);
    expect(
      findForbiddenInstallDependencies(packageJson, new Set(["redis", "tailwindcss", "zustand"])),
    ).toEqual(["redis", "tailwindcss", "zustand"]);
    expect(
      findForbiddenInstallDependencies(
        { optionalDependencies: { cache: "NPM:redis@5" } },
        new Set(["redis"]),
      ),
    ).toEqual(["redis"]);
    for (const invalidPackageJson of [
      { dependencies: ["npm:redis@5"] },
      { devDependencies: { redis: null } },
      { optionalDependencies: "npm:redis@5" },
      { overrides: ["npm:redis@5"] },
      { overrides: { cache: "https://registry.npmjs.org/redis/-/redis-5.10.0.tgz" } },
      { peerDependencies: { redis: 5 } },
      { dependencies: { cache: "https://registry.npmjs.org/redis/-/redis-5.10.0.tgz" } },
      { dependencies: { cache: "github:example/redis" } },
      { dependencies: { cache: "file:../redis" } },
      { dependencies: { cache: "redis.tar.gz" } },
      { dependencies: { cache: "$redis" } },
      { scripts: { dependencies: "npm install redis --no-save" } },
      { scripts: { postdependencies: "npm install redis --no-save" } },
      { scripts: { predependencies: "npm install redis --no-save" } },
      { scripts: { preinstall: "npm install redis --no-save" } },
      { bundledDependencies: ["redis", 42] },
    ]) {
      expect(() => installDependencyNames(invalidPackageJson)).toThrow("seção");
    }
    expect(
      installDependencyNames({ bundleDependencies: true, dependencies: { react: "19" } }),
    ).toEqual(["react"]);
    expect(
      installDependencyNames({
        dependencies: { react: "19.2.8" },
        overrides: { react: "$react" },
      }),
    ).toEqual(["react"]);
  });

  it("keeps every npm workspace inside the dependency gate", () => {
    expect(() =>
      validateNpmProjectConfiguration(
        "engine-strict=true\nfund=false\nsave-exact=true\nstrict-allow-scripts=true\nignore-scripts=true\ndangerously-allow-all-scripts=false\n",
      ),
    ).not.toThrow();
    expect(() =>
      validateNpmProjectConfiguration(
        "engine-strict=true\nfund=false\nsave-exact=true\nstrict-allow-scripts=false\n",
      ),
    ).toThrow(".npmrc");
    expect(() => validateAllowedInstallScripts({})).not.toThrow();
    for (const allowScripts of [
      {},
      { "unrs-resolver@1.12.2": true },
      { "unrs-resolver@*": true },
    ]) {
      expect(() => validateAllowedInstallScripts({ allowScripts })).toThrow("allowScripts");
    }
    expect(validateWorkspacePatterns({ workspaces: ["packages/*", "apps/*"] })).toEqual([
      "apps/*",
      "packages/*",
    ]);

    for (const workspaces of [
      undefined,
      { packages: ["apps/*", "packages/*"] },
      ["apps/*", "packages/*", "vendor/*"],
      ["apps/*", "packages/*", 42],
      ["apps/*", "apps/*"],
    ]) {
      expect(() => validateWorkspacePatterns({ workspaces })).toThrow("workspaces");
    }

    const repository = mkdtempSync(join(tmpdir(), "set-livre-workspaces-"));
    try {
      writeFileSync(
        join(repository, ".npmrc"),
        "engine-strict=true\nfund=false\nsave-exact=true\nstrict-allow-scripts=true\nignore-scripts=true\ndangerously-allow-all-scripts=false\n",
      );
      for (const packagePath of [
        "package.json",
        "apps/backoffice/package.json",
        "packages/contracts/package.json",
        "packages/ui/package.json",
      ]) {
        mkdirSync(join(repository, packagePath, ".."), { recursive: true });
        writeFileSync(join(repository, packagePath), "{}\n");
      }
      expect(
        readCanonicalPackageManifests(repository).map(({ packagePath }) => packagePath),
      ).toEqual([
        "package.json",
        "apps/backoffice/package.json",
        "packages/contracts/package.json",
        "packages/ui/package.json",
      ]);

      mkdirSync(join(repository, "apps/coverage"));
      expect(() => readCanonicalPackageManifests(repository)).toThrow("conjunto canônico");
      rmSync(join(repository, "apps/coverage"), { recursive: true });
      symlinkSync("backoffice", join(repository, "apps/symbolic-workspace"));
      expect(() => readCanonicalPackageManifests(repository)).toThrow("precisa ser físico");
      rmSync(join(repository, "apps/symbolic-workspace"));
      rmSync(join(repository, "packages/ui/package.json"));
      symlinkSync("../contracts/package.json", join(repository, "packages/ui/package.json"));
      expect(() => readCanonicalPackageManifests(repository)).toThrow("físico e regular");
      rmSync(join(repository, "packages/ui/package.json"));
      writeFileSync(join(repository, "packages/ui/package.json"), "{}\n");
      writeFileSync(join(repository, "packages/ui/binding.gyp"), "{}\n");
      expect(() => readCanonicalPackageManifests(repository)).toThrow("binding.gyp");
      rmSync(join(repository, "packages/ui/binding.gyp"));
      writeFileSync(join(repository, "npm-shrinkwrap.json"), "{}\n");
      expect(() => readCanonicalPackageManifests(repository)).toThrow("npm-shrinkwrap");
    } finally {
      rmSync(repository, { force: true, recursive: true });
    }
  });

  it("extracts markdown link targets", () => {
    expect(collectMatches("[one](docs/one.md) [two](#two)", /\[[^\]]+\]\(([^)]+)\)/g)).toEqual([
      "docs/one.md",
      "#two",
    ]);
  });

  it("parses QA traceability rows", () => {
    const content =
      "| SL-F001-E2E-001 | FEAT-001 | P0 | smoke | desktop | cenário | planejado | `tests/e2e/example.spec.ts` |";

    expect(parseQaRows(content)).toEqual([
      {
        automation: "planejado",
        feature: "FEAT-001",
        id: "SL-F001-E2E-001",
        spec: "tests/e2e/example.spec.ts",
      },
    ]);

    const repository = mkdtempSync(join(tmpdir(), "set-livre-qa-spec-"));
    const specRoot = join(repository, "tests/e2e/critical");
    const validSpec = "tests/e2e/critical/valid.spec.ts";
    const otherSpec = "tests/e2e/critical/other.spec.ts";
    const symbolicSpec = "tests/e2e/critical/symbolic.spec.ts";
    const symbolicParentSpec = "tests/e2e/symbolic-suite/parent.spec.ts";
    const directorySpec = "tests/e2e/critical/directory.spec.ts";
    const scenarioId = "SL-F001-E2E-001";
    const playwrightImport = 'import { test } from "@playwright/test";\n';
    try {
      mkdirSync(specRoot, { recursive: true });
      writeFileSync(
        join(repository, validSpec),
        `${playwrightImport}test("${scenarioId} caminho feliz", () => {});\n`,
      );
      writeFileSync(
        join(repository, otherSpec),
        `${playwrightImport}test("SL-F001-E2E-002 outro cenário", () => {});\n`,
      );
      symlinkSync("valid.spec.ts", join(repository, symbolicSpec));
      mkdirSync(join(repository, "outside-suite"));
      writeFileSync(
        join(repository, "outside-suite/parent.spec.ts"),
        `${playwrightImport}test("${scenarioId} fora da árvore física", () => {});\n`,
      );
      symlinkSync("../../outside-suite", join(repository, "tests/e2e/symbolic-suite"));
      mkdirSync(join(repository, directorySpec));

      expect(validateAutomatedQaSpec(repository, { id: scenarioId, spec: validSpec })).toBeNull();
      expect(validateAutomatedQaSpec(repository, { id: scenarioId, spec: otherSpec })).toContain(
        "não registra um teste importado",
      );
      expect(validateAutomatedQaSpec(repository, { id: scenarioId, spec: symbolicSpec })).toContain(
        "arquivo regular físico",
      );
      expect(
        validateAutomatedQaSpec(repository, { id: scenarioId, spec: symbolicParentSpec }),
      ).toContain("arquivo regular físico");
      expect(
        validateAutomatedQaSpec(repository, { id: scenarioId, spec: directorySpec }),
      ).toContain("arquivo regular físico");
      expect(validateAutomatedQaSpec(repository, { id: scenarioId, spec: undefined })).toContain(
        "caminho de spec Playwright válido",
      );
      expect(
        hasPlaywrightTestWithId(
          `${playwrightImport}// test("${scenarioId} apenas comentário", () => {});\nconst title = "${scenarioId} apenas constante";\nconst deadText = \`${scenarioId} texto morto\`;\ntest("${scenarioId} sem corpo");\ntest("${scenarioId} sem callback", { tag: "@critical" });\ntest(title, () => {});\ntest.describe("${scenarioId} apenas describe", () => {});\ntest.only("${scenarioId} proibido", () => {});\ntest.skip("${scenarioId} proibido", () => {});\n`,
          scenarioId,
        ),
      ).toBe(false);
      expect(
        hasPlaywrightTestWithId(
          `${playwrightImport}test(\`${scenarioId} template literal real\`, async () => {});\n`,
          scenarioId,
        ),
      ).toBe(true);
      expect(
        hasPlaywrightTestWithId(
          `${playwrightImport}const id = "${scenarioId}"; test(\`\${id} interpolado\`, () => {});\n`,
          scenarioId,
        ),
      ).toBe(false);
      expect(
        hasPlaywrightTestWithId(
          `function test(_title, callback) { callback(); }\ntest("${scenarioId} função local", () => {});\n`,
          scenarioId,
        ),
      ).toBe(false);
      expect(
        hasPlaywrightTestWithId(
          `${playwrightImport}function register(test) { test("${scenarioId} parâmetro sombreado", () => {}); }\nregister(() => {});\n`,
          scenarioId,
        ),
      ).toBe(false);
      expect(
        hasPlaywrightTestWithId(
          `${playwrightImport}if (false) { test("${scenarioId} branch morta", () => {}); }\nfunction register() { test("${scenarioId} função arbitrária", () => {}); }\n`,
          scenarioId,
        ),
      ).toBe(false);
      expect(
        hasPlaywrightTestWithId(
          `import { test as playwrightTest } from "@playwright/test";\nplaywrightTest("${scenarioId} alias real", async () => {});\n`,
          scenarioId,
        ),
      ).toBe(true);
      expect(
        hasPlaywrightTestWithId(
          `${playwrightImport}test.describe("suite real", () => { test("${scenarioId} dentro do describe", function () {}); });\n`,
          scenarioId,
        ),
      ).toBe(true);
      expect(
        hasPlaywrightTestWithId(
          `${playwrightImport}test.describe("suite sombreada", (test) => { test("${scenarioId} não é Playwright", () => {}); });\ntest.describe(() => { test("${scenarioId} describe inválido", () => {}); });\n`,
          scenarioId,
        ),
      ).toBe(false);
      expect(
        hasPlaywrightTestWithId(
          `${playwrightImport}test.describe("binding local", () => { const test = (_title, callback) => callback(); test("${scenarioId} binding local", () => {}); });\n`,
          scenarioId,
        ),
      ).toBe(false);
    } finally {
      rmSync(repository, { force: true, recursive: true });
    }
  });

  it("generates SHA-256", () => {
    expect(sha256("set-livre")).toBe(
      "2b987ea82107c7405db51cd093e4638b93a297e24e6ce16bfedf4e77f9219f08",
    );
  });

  it("rejects descending feature ranges instead of accepting a partial owner set", () => {
    expect(() => parseFeatureReferences("FEAT-026–020")).toThrowError(
      "Intervalo de feature descendente inválido: FEAT-026–FEAT-020.",
    );
  });

  it("keeps Git change detection conservative without origin/main", () => {
    const argumentDescriptors = gitChangedFileArgumentLists("base-revision");
    const diffArguments = argumentDescriptors
      .map((descriptor) => descriptor.argumentsList)
      .filter(([command]) => command === "diff");
    expect(diffArguments).toHaveLength(3);
    expect(
      diffArguments.every(
        (argumentList) =>
          argumentList.includes("--name-status") && argumentList.includes("--diff-filter=ACMRTD"),
      ),
    ).toBe(true);

    const parsedChanges = parseGitChanges(
      "M\0docs/changes/2026-08-09-existing.md\0A\0docs/changes/2026-08-09-new.md\0D\0deleted.ts\0R100\0old.ts\0new.ts\0T\0type-changed.ts\0",
    );
    expect(parsedChanges).toEqual([
      { path: "docs/changes/2026-08-09-existing.md", status: "M" },
      { path: "docs/changes/2026-08-09-new.md", status: "A" },
      { path: "deleted.ts", status: "D" },
      { path: "old.ts", status: "R" },
      { path: "new.ts", status: "R" },
      { path: "type-changed.ts", status: "T" },
    ]);
    expect(parsedChanges.filter(isAddedChangeRecord)).toEqual([
      { path: "docs/changes/2026-08-09-new.md", status: "A" },
    ]);
    expect(
      ["M", "D", "R"].some((status) =>
        isAddedChangeRecord({ path: "docs/changes/2026-08-09-reused.md", status }),
      ),
    ).toBe(false);

    for (const path of [
      ".editorconfig",
      ".env.e2e.example",
      ".env.example",
      ".gitignore",
      ".node-version",
      ".npmrc",
      ".nvmrc",
      ".prettierignore",
      ".prettierrc.json",
      "eslint.config.mjs",
      "knip.json",
      "next-env.d.ts",
      "next.config.ts",
      "package-lock.json",
      "package.json",
      "playwright.config.ts",
      "tsconfig.base.json",
      "tsconfig.json",
      "tsconfig.tests.json",
      "vitest.config.ts",
    ]) {
      expect(isTechnicalChangePath(path), path).toBe(true);
    }
    expect(isTechnicalChangePath("README.md")).toBe(false);

    const repository = mkdtempSync(join(tmpdir(), "set-livre-git-changes-"));
    const git = (...argumentsList) =>
      execFileSync("git", argumentsList, {
        cwd: repository,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    try {
      git("init", "--initial-branch", "main");
      git("config", "user.email", "qa@set-livre.local");
      git("config", "user.name", "Set Livre QA");
      writeFileSync(join(repository, "README.md"), "# Baseline\n", "utf8");
      git("add", "README.md");
      git("commit", "-m", "baseline");
      const rootRevision = git("rev-parse", "HEAD").trim();

      mkdirSync(join(repository, "docs"));
      writeFileSync(join(repository, "docs/on-main.md"), "# Markdown na main local\n", "utf8");
      git("add", "docs/on-main.md");
      git("commit", "-m", "docs on main");
      const mainRevision = git("rev-parse", "HEAD").trim();

      const localMainAtHeadChanges = readGitChanges(repository);
      expect(localMainAtHeadChanges.comparisonBase).toBe(rootRevision);
      expect(localMainAtHeadChanges.changes).toContainEqual({
        path: "docs/on-main.md",
        status: "A",
      });

      git("switch", "--create", "feature");
      writeFileSync(join(repository, "docs/committed.md"), "# Markdown commitado\n", "utf8");
      git("add", "docs/committed.md");
      git("commit", "-m", "docs");

      const localMainChanges = readGitChanges(repository);
      expect(localMainChanges.comparisonBase).toBe(mainRevision);
      expect(localMainChanges.changes).toContainEqual({
        path: "docs/committed.md",
        status: "A",
      });

      git("branch", "--delete", "--force", "main");
      const rootFallbackChanges = readGitChanges(repository);
      expect(rootFallbackChanges.comparisonBase).toBe(rootRevision);
      expect(rootFallbackChanges.changes).toContainEqual({
        path: "docs/committed.md",
        status: "A",
      });
    } finally {
      rmSync(repository, { force: true, recursive: true });
    }
  });

  it("keeps a fresh feature at HEAD and detects regular-symlink type changes everywhere", () => {
    const repository = mkdtempSync(join(tmpdir(), "set-livre-git-type-changes-"));
    const git = (...argumentsList) =>
      execFileSync("git", argumentsList, {
        cwd: repository,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });

    try {
      git("init", "--initial-branch", "main");
      git("config", "user.email", "qa@set-livre.local");
      git("config", "user.name", "Set Livre QA");
      mkdirSync(join(repository, "docs/changes"), { recursive: true });
      mkdirSync(join(repository, "docs/contracts"), { recursive: true });
      writeFileSync(
        join(repository, "docs/changes/2026-08-09-main-history.md"),
        "# Registro histórico\n",
        "utf8",
      );
      writeFileSync(join(repository, "docs/contracts/target.json"), '{"target":true}\n', "utf8");
      writeFileSync(join(repository, "docs/contracts/regular.json"), '{"regular":true}\n', "utf8");
      symlinkSync("target.json", join(repository, "docs/contracts/linked.json"));
      git("add", "docs");
      git("commit", "-m", "main history");
      const mainRevision = git("rev-parse", "HEAD").trim();

      git("switch", "--create", "feature");
      const freshFeatureChanges = readGitChanges(repository);
      expect(freshFeatureChanges.comparisonBase).toBe(mainRevision);
      expect(freshFeatureChanges.changes.filter(isAddedChangeRecord)).toEqual([]);

      rmSync(join(repository, "docs/contracts/regular.json"));
      symlinkSync("target.json", join(repository, "docs/contracts/regular.json"));
      rmSync(join(repository, "docs/contracts/linked.json"));
      writeFileSync(join(repository, "docs/contracts/linked.json"), '{"linked":false}\n', "utf8");

      const expectedTypeChanges = [
        { path: "docs/contracts/linked.json", status: "T" },
        { path: "docs/contracts/regular.json", status: "T" },
      ];
      const workingChanges = readGitChanges(repository);
      expect(workingChanges.comparisonBase).toBe(mainRevision);
      expect(workingChanges.changes).toEqual(expect.arrayContaining(expectedTypeChanges));
      expect(expectedTypeChanges.every((change) => isTechnicalChangePath(change.path))).toBe(true);
      expect(workingChanges.changes.filter(isAddedChangeRecord)).toEqual([]);

      git("add", "docs/contracts");
      const stagedChanges = readGitChanges(repository);
      expect(stagedChanges.changes).toEqual(expect.arrayContaining(expectedTypeChanges));
      expect(stagedChanges.changes.filter(isAddedChangeRecord)).toEqual([]);

      git("commit", "-m", "change contract node types");
      const committedChanges = readGitChanges(repository);
      expect(committedChanges.comparisonBase).toBe(mainRevision);
      expect(committedChanges.changes).toEqual(expect.arrayContaining(expectedTypeChanges));
      expect(committedChanges.changes.filter(isAddedChangeRecord)).toEqual([]);
    } finally {
      rmSync(repository, { force: true, recursive: true });
    }
  });

  it("refuses a type-changed symlink before format --write can touch its target", () => {
    const testRoot = mkdtempSync(join(tmpdir(), "set-livre-format-symlink-"));
    const repository = join(testRoot, "repository");
    const externalTarget = join(testRoot, "external.json");
    const projectRoot = join(import.meta.dirname, "../..");
    const git = (...argumentsList) =>
      execFileSync("git", argumentsList, {
        cwd: repository,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });

    try {
      mkdirSync(join(repository, "docs/contracts"), { recursive: true });
      mkdirSync(join(repository, "scripts"));
      copyFileSync(
        join(projectRoot, "scripts/docs-check-core.mjs"),
        join(repository, "scripts/docs-check-core.mjs"),
      );
      copyFileSync(
        join(projectRoot, "scripts/format-scope.mjs"),
        join(repository, "scripts/format-scope.mjs"),
      );
      symlinkSync(join(projectRoot, "node_modules"), join(repository, "node_modules"), "dir");
      writeFileSync(join(repository, ".gitignore"), "/node_modules\n", "utf8");
      writeFileSync(join(repository, "docs/contracts/config.json"), '{"local":true}\n', "utf8");
      writeFileSync(externalTarget, '{"external":"preserve exactly"}\n', "utf8");

      git("init", "--initial-branch", "main");
      git("config", "user.email", "qa@set-livre.local");
      git("config", "user.name", "Set Livre QA");
      git("add", ".gitignore", "docs", "scripts");
      git("commit", "-m", "baseline");
      git("switch", "--create", "feature");
      rmSync(join(repository, "docs/contracts/config.json"));
      symlinkSync(externalTarget, join(repository, "docs/contracts/config.json"));

      const result = spawnSync(
        process.execPath,
        [join(repository, "scripts/format-scope.mjs"), "--write"],
        {
          cwd: repository,
          encoding: "utf8",
        },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("arquivos regulares físicos");
      expect(result.stderr).toContain("docs/contracts/config.json");
      expect(readFileSync(externalTarget, "utf8")).toBe('{"external":"preserve exactly"}\n');

      rmSync(join(repository, "docs/contracts/config.json"));
      mkdirSync(join(repository, "docs/contracts/config.json"));
      writeFileSync(
        join(repository, "docs/contracts/config.json/child.json"),
        '{"child":true}\n',
        "utf8",
      );
      const fileToDirectoryResult = spawnSync(
        process.execPath,
        [join(repository, "scripts/format-scope.mjs"), "--write"],
        { cwd: repository, encoding: "utf8" },
      );
      expect(fileToDirectoryResult.status, fileToDirectoryResult.stderr).toBe(0);
      expect(readFileSync(join(repository, "docs/contracts/config.json/child.json"), "utf8")).toBe(
        '{ "child": true }\n',
      );
    } finally {
      rmSync(testRoot, { force: true, recursive: true });
    }
  });

  it("prefers the closest main base and classifies nested config changes", () => {
    const repository = mkdtempSync(join(tmpdir(), "set-livre-closest-git-base-"));
    const git = (...argumentsList) =>
      execFileSync("git", argumentsList, {
        cwd: repository,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });

    try {
      git("init", "--initial-branch", "main");
      git("config", "user.email", "qa@set-livre.local");
      git("config", "user.name", "Set Livre QA");
      git("config", "diff.renames", "true");
      writeFileSync(join(repository, "README.md"), "# Baseline\n", "utf8");
      git("add", "README.md");
      git("commit", "-m", "baseline");
      const staleOriginRevision = git("rev-parse", "HEAD").trim();
      git("update-ref", "refs/remotes/origin/main", staleOriginRevision);

      mkdirSync(join(repository, "docs/changes"), { recursive: true });
      mkdirSync(join(repository, "docs/contracts"), { recursive: true });
      writeFileSync(
        join(repository, "docs/changes/2026-08-09-main-baseline.md"),
        "# Registro anterior\n",
        "utf8",
      );
      writeFileSync(join(repository, "docs/contracts/modified.json"), '{"version":1}\n', "utf8");
      writeFileSync(join(repository, "docs/contracts/deleted.json"), '{"delete":true}\n', "utf8");
      writeFileSync(join(repository, "docs/contracts/old.json"), '{"rename":true}\n', "utf8");
      git("add", "docs");
      git("commit", "-m", "advance local main");
      const localMainRevision = git("rev-parse", "HEAD").trim();

      git("switch", "--create", "feature");
      writeFileSync(join(repository, "docs/feature-sequence.json"), '{"version":1}\n', "utf8");
      writeFileSync(join(repository, "docs/contracts/modified.json"), '{"version":2}\n', "utf8");
      rmSync(join(repository, "docs/contracts/deleted.json"));
      git("mv", "docs/contracts/old.json", "docs/contracts/renamed.json");
      git("add", "--all");
      git("commit", "-m", "change nested configs");

      const featureChanges = readGitChanges(repository);
      expect(featureChanges.comparisonBase).toBe(localMainRevision);
      expect(featureChanges.comparisonBase).not.toBe(staleOriginRevision);
      expect(featureChanges.changes).not.toContainEqual({
        path: "docs/changes/2026-08-09-main-baseline.md",
        status: "A",
      });

      const expectedNestedChanges = [
        { path: "docs/feature-sequence.json", status: "A" },
        { path: "docs/contracts/modified.json", status: "M" },
        { path: "docs/contracts/deleted.json", status: "D" },
        { path: "docs/contracts/old.json", status: "R" },
        { path: "docs/contracts/renamed.json", status: "R" },
      ];
      expect(featureChanges.changes).toEqual(expect.arrayContaining(expectedNestedChanges));
      expect(expectedNestedChanges.every((change) => isTechnicalChangePath(change.path))).toBe(
        true,
      );
      expect(featureChanges.changes.filter(isAddedChangeRecord)).toEqual([]);
    } finally {
      rmSync(repository, { force: true, recursive: true });
    }
  });

  it("accepts an ordered acyclic feature contract", () => {
    expect(
      validateFeatureSequence(
        {
          version: 1,
          sequence: ["FEAT-001", "FEAT-002"],
          dependencyToStart: { "FEAT-001": [], "FEAT-002": ["FEAT-001"] },
          dependencyToComplete: [
            {
              provider: "FEAT-001",
              consumer: "FEAT-002",
              scenarioOwner: "FEAT-002",
              contract: "integração posterior",
            },
          ],
          dependencyToRelease: [{ feature: "FEAT-002", pending: "PEND-001" }],
        },
        ["FEAT-001", "FEAT-002"],
        ["PEND-001"],
      ),
    ).toEqual([]);
  });

  it("rejects cycles and forward dependencies", () => {
    const errors = validateFeatureSequence(
      {
        version: 1,
        sequence: ["FEAT-001", "FEAT-002"],
        dependencyToStart: { "FEAT-001": ["FEAT-002"], "FEAT-002": ["FEAT-001"] },
        dependencyToComplete: [],
        dependencyToRelease: [],
      },
      ["FEAT-001", "FEAT-002"],
      [],
    );

    expect(errors).toContain("FEAT-002 precisa aparecer antes de FEAT-001.");
    expect(errors.some((error) => error.includes("Ciclo detectado"))).toBe(true);
  });

  it("expands the normative integration table and open pending owners", () => {
    const implementationOrder = `
## Integrações \`dependency-to-complete\`

| Provedor inicial | Proprietário da integração posterior | Evidência exigida |
| --- | --- | --- |
| FEAT-006/FEAT-007 taxonomias | FEAT-031 | administração |
| FEAT-016 preço | FEAT-018 e FEAT-024 | snapshots |

## Fase 5
`;
    const pendingDocument = `
| ID | Área | Pendência externa | Features/owner | Preparado | Critério | Estado |
| --- | --- | --- | --- | --- | --- | --- |
| PEND-004 | Pagamentos | provider | FEAT-020–022 | adapter | contrato | aberta |
| PEND-006 | Jurídico | textos | FEAT-002, FEAT-034 | versões | aprovação | aberta |
| PEND-009 | Histórico | encerrada | FEAT-010 | evidência | concluído | encerrada |
`;
    const integrations = parseNormativeIntegrationPairs(implementationOrder);
    const pendingPairs = parseOpenPendingFeaturePairs(pendingDocument);

    expect(integrations).toEqual([
      { consumer: "FEAT-031", provider: "FEAT-006" },
      { consumer: "FEAT-031", provider: "FEAT-007" },
      { consumer: "FEAT-018", provider: "FEAT-016" },
      { consumer: "FEAT-024", provider: "FEAT-016" },
    ]);
    expect(parsePendingRows(pendingDocument)).toEqual([
      {
        featureIds: ["FEAT-020", "FEAT-021", "FEAT-022"],
        id: "PEND-004",
        state: "aberta",
      },
      {
        featureIds: ["FEAT-002", "FEAT-034"],
        id: "PEND-006",
        state: "aberta",
      },
      { featureIds: ["FEAT-010"], id: "PEND-009", state: "encerrada" },
    ]);
    expect(pendingPairs).toEqual([
      { feature: "FEAT-020", pending: "PEND-004" },
      { feature: "FEAT-021", pending: "PEND-004" },
      { feature: "FEAT-022", pending: "PEND-004" },
      { feature: "FEAT-002", pending: "PEND-006" },
      { feature: "FEAT-034", pending: "PEND-006" },
    ]);
    expect(
      validateGovernanceAlignment(
        {
          dependencyToComplete: integrations.map(({ consumer, provider }) => ({
            consumer,
            contract: "contrato",
            provider,
            scenarioOwner: consumer,
          })),
          dependencyToRelease: pendingPairs,
        },
        integrations,
        pendingPairs,
      ),
    ).toEqual([]);
  });

  it("detects drift from normative integrations and pending ownership", () => {
    const errors = validateGovernanceAlignment(
      {
        dependencyToComplete: [
          {
            consumer: "FEAT-002",
            contract: "contrato",
            provider: "FEAT-001",
            scenarioOwner: "FEAT-001",
          },
          {
            consumer: "FEAT-010",
            contract: "extra",
            provider: "FEAT-009",
            scenarioOwner: "FEAT-010",
          },
        ],
        dependencyToRelease: [
          { feature: "FEAT-001", pending: "PEND-001" },
          { feature: "FEAT-004", pending: "PEND-004" },
        ],
      },
      [
        { consumer: "FEAT-002", provider: "FEAT-001" },
        { consumer: "FEAT-003", provider: "FEAT-001" },
      ],
      [
        { feature: "FEAT-001", pending: "PEND-001" },
        { feature: "FEAT-002", pending: "PEND-002" },
      ],
    );

    expect(errors).toEqual([
      "dependency-to-complete não contém os pares normativos: FEAT-001->FEAT-003.",
      "dependency-to-complete contém pares sem owner normativo: FEAT-009->FEAT-010.",
      "FEAT-001->FEAT-002 precisa pertencer ao cenário da feature consumidora FEAT-002.",
      "dependency-to-release não contém os pares normativos: FEAT-002->PEND-002.",
      "dependency-to-release contém pares sem owner normativo: FEAT-004->PEND-004.",
    ]);
  });
});

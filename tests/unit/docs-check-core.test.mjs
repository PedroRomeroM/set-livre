import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { directorySymbolicLinkType } from "../fixtures/filesystem-capabilities.mjs";

import {
  collectMatches,
  containsEncodedPrivateKey,
  findDuplicates,
  findForbiddenInstallDependencies,
  gitChangedFileArgumentLists,
  hasPlaywrightTestWithId,
  installDependencyNames,
  isAddedChangeRecord,
  isProgressSummaryChange,
  isTechnicalChangePath,
  parseGitChanges,
  parseNormativeIntegrationPairs,
  parseOpenPendingFeaturePairs,
  parsePendingRows,
  parseFeatureReferences,
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
  validateNpmProjectConfiguration,
  validateProgressSummary,
  validateWorkspacePatterns,
} from "../../scripts/docs-check-core.mjs";

function withProcessEnvironment(overrides, operation) {
  const previous = new Map(
    Object.keys(overrides).map((name) => [
      name,
      Object.hasOwn(process.env, name) ? process.env[name] : undefined,
    ]),
  );
  try {
    for (const [name, value] of Object.entries(overrides)) {
      process.env[name] = value;
    }
    return operation();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

function createDirectoryLink(targetPath, linkPath) {
  symlinkSync(targetPath, linkPath, directorySymbolicLinkType);
}

function stageGitBlob(repository, path, source, mode) {
  const objectId = execFileSync("git", ["hash-object", "-w", "--stdin"], {
    cwd: repository,
    encoding: "utf8",
    input: source,
    stdio: ["pipe", "pipe", "ignore"],
  }).trim();
  execFileSync("git", ["update-index", "--add", "--cacheinfo", mode, objectId, path], {
    cwd: repository,
    stdio: "ignore",
  });
}

function stageGitSymbolicLink(repository, path, target) {
  stageGitBlob(repository, path, target, "120000");
}

function stageGitRegularFile(repository, path, source) {
  stageGitBlob(repository, path, source, "100644");
}

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
    expect(findForbiddenInstallDependencies(packageJson)).toEqual([
      "redis",
      "tailwindcss",
      "zustand",
    ]);
    expect(
      findForbiddenInstallDependencies({ optionalDependencies: { cache: "NPM:redis@5" } }),
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

  it("rejects maintained prohibited dependency families through aliases and overrides", () => {
    expect(
      findForbiddenInstallDependencies({
        dependencies: { "@mui/material": "7.3.1" },
      }),
    ).toEqual(["@mui/material"]);
    expect(
      findForbiddenInstallDependencies({
        dependencies: { visualSystem: "npm:@mui/system@7.3.1" },
      }),
    ).toEqual(["@mui/system"]);
    expect(
      findForbiddenInstallDependencies({
        overrides: {
          visualLibrary: "npm:@mui/material@7.3.1",
          visualSystem: "npm:@mui/system@7.3.1",
        },
      }),
    ).toEqual(["@mui/material", "@mui/system"]);

    expect(
      findForbiddenInstallDependencies({
        dependencies: {
          cache: "npm:ioredis@5",
          cmsClient: "npm:@directus/sdk@20",
          cms: "npm:@strapi/strapi@5",
          css: "npm:@emotion/styled@11",
          cssRuntime: "npm:@griffel/react@1",
          distributedLog: "npm:no-kafka@3",
          eventBus: "npm:kafkajs@2",
          orm: "npm:typeorm@0.3",
          query: "npm:swr@2",
          queue: "npm:bullmq@5",
          ui: "npm:shadcn@3",
        },
        devDependencies: {
          migrationToolkit: "NPM:drizzle-kit@0.31",
          tailwindPlugin: "npm:@tailwindcss/postcss@4",
        },
        optionalDependencies: {
          cluster: "npm:@kubernetes/client-node@1",
        },
        overrides: {
          "safe-parent@1": {
            ".": "1.0.1",
            cssRuntime: "npm:fela@12",
            griffelCompiler: "NPM:@griffel/babel-preset@1",
            managedKafka: "npm:@confluentinc/kafka-javascript@1",
            redisCompatibility: "npm:handy-redis@2",
            redisModel: "npm:redis-om@0.4",
            storage: "npm:@redis/client@5",
            styling: "npm:@vanilla-extract/css@1",
          },
        },
      }),
    ).toEqual([
      "@confluentinc/kafka-javascript",
      "@directus/sdk",
      "@emotion/styled",
      "@griffel/babel-preset",
      "@griffel/react",
      "@kubernetes/client-node",
      "@redis/client",
      "@strapi/strapi",
      "@tailwindcss/postcss",
      "@vanilla-extract/css",
      "bullmq",
      "drizzle-kit",
      "fela",
      "handy-redis",
      "ioredis",
      "kafkajs",
      "no-kafka",
      "redis-om",
      "shadcn",
      "swr",
      "typeorm",
    ]);

    expect(
      findForbiddenInstallDependencies({
        dependencies: {
          "drizzled-notes": "1.0.0",
          "emotion-parser": "1.0.0",
          felafel: "1.0.0",
          "@griffelish/react": "1.0.0",
          "@muiish/material": "1.0.0",
          "@muix/system": "1.0.0",
          griffelish: "1.0.0",
          kafkaesque: "1.0.0",
          "mui-material": "1.0.0",
          "queueing-theory": "1.0.0",
          "redistribution-tool": "1.0.0",
        },
      }),
    ).toEqual([]);
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
      createDirectoryLink(
        join(repository, "apps/backoffice"),
        join(repository, "apps/symbolic-workspace"),
      );
      expect(() => readCanonicalPackageManifests(repository)).toThrow("precisa ser físico");
      rmSync(join(repository, "apps/symbolic-workspace"));
      if (process.platform === "win32") {
        rmSync(join(repository, "packages/ui"), { recursive: true });
        createDirectoryLink(
          join(repository, "packages/contracts"),
          join(repository, "packages/ui"),
        );
        expect(() => readCanonicalPackageManifests(repository)).toThrow("físico");
        rmSync(join(repository, "packages/ui"));
        mkdirSync(join(repository, "packages/ui"));
        writeFileSync(join(repository, "packages/ui/package.json"), "{}\n");
      } else {
        rmSync(join(repository, "packages/ui/package.json"));
        symlinkSync("../contracts/package.json", join(repository, "packages/ui/package.json"));
        expect(() => readCanonicalPackageManifests(repository)).toThrow("físico e regular");
        rmSync(join(repository, "packages/ui/package.json"));
        writeFileSync(join(repository, "packages/ui/package.json"), "{}\n");
      }
      writeFileSync(join(repository, "packages/ui/binding.gyp"), "{}\n");
      expect(() => readCanonicalPackageManifests(repository)).toThrow("binding.gyp");
      rmSync(join(repository, "packages/ui/binding.gyp"));
      writeFileSync(join(repository, "npm-shrinkwrap.json"), "{}\n");
      expect(() => readCanonicalPackageManifests(repository)).toThrow("npm-shrinkwrap");
    } finally {
      rmSync(repository, { force: true, recursive: true });
    }
  });

  it("matches every real canonical manifest dependency to one complete registry record", () => {
    const projectRoot = join(import.meta.dirname, "../..");
    const manifests = readCanonicalPackageManifests(projectRoot).map(({ packagePath, source }) => ({
      packageJson: JSON.parse(source),
      packagePath,
    }));

    expect(
      validateCanonicalDependencyRegistry(
        manifests,
        readFileSync(join(projectRoot, "docs/dependencias-utilizadas.md"), "utf8"),
      ),
    ).toEqual([]);
  });

  it("detects an unregistered dependency in each physical canonical manifest", () => {
    const repository = mkdtempSync(join(tmpdir(), "set-livre-dependency-registry-"));
    const manifests = new Map([
      [
        "package.json",
        {
          dependencies: { "@set-livre/contracts": "0.0.0", react: "19.2.8" },
          name: "@set-livre/web",
          version: "0.0.0",
          workspaces: ["apps/*", "packages/*"],
        },
      ],
      [
        "apps/backoffice/package.json",
        {
          dependencies: { "@set-livre/contracts": "0.0.0", react: "19.2.8" },
          name: "@set-livre/backoffice",
          version: "0.0.0",
        },
      ],
      [
        "packages/contracts/package.json",
        {
          dependencies: { zod: "4.4.3" },
          name: "@set-livre/contracts",
          version: "0.0.0",
        },
      ],
      [
        "packages/ui/package.json",
        {
          name: "@set-livre/ui",
          peerDependencies: { react: "19.2.8" },
          version: "0.0.0",
        },
      ],
    ]);
    const registry = `# Registro

## Dependências npm diretas

| Pacote | Versão | Superfície/finalidade | Licença | Justificativa | Avaliação de supply chain |
| --- | --- | --- | --- | --- | --- |
| \`react\` | \`19.2.8\` | runtime server/client | MIT | renderer normativo necessário | pacote oficial com lockfile auditado |
| \`zod\` | \`4.4.3\` | runtime server/client | MIT | valida fronteiras tipadas | pacote maduro com lockfile auditado |
`;
    const writeManifests = () => {
      for (const [packagePath, packageJson] of manifests) {
        mkdirSync(join(repository, packagePath, ".."), { recursive: true });
        writeFileSync(join(repository, packagePath), `${JSON.stringify(packageJson)}\n`, "utf8");
      }
    };
    const validatePhysicalRegistry = () =>
      validateCanonicalDependencyRegistry(
        readCanonicalPackageManifests(repository).map(({ packagePath, source }) => ({
          packageJson: JSON.parse(source),
          packagePath,
        })),
        registry,
      );

    try {
      writeFileSync(
        join(repository, ".npmrc"),
        "engine-strict=true\nfund=false\nsave-exact=true\nstrict-allow-scripts=true\nignore-scripts=true\ndangerously-allow-all-scripts=false\n",
      );
      writeManifests();
      expect(validatePhysicalRegistry()).toEqual([]);

      const targets = [
        ["package.json", "dependencies"],
        ["apps/backoffice/package.json", "dependencies"],
        ["packages/contracts/package.json", "dependencies"],
        ["packages/ui/package.json", "peerDependencies"],
      ];
      for (const [index, [packagePath, field]] of targets.entries()) {
        const packageJson = manifests.get(packagePath);
        packageJson[field][`unregistered-${index}`] = "1.0.0";
        writeManifests();
        expect(validatePhysicalRegistry()).toContain(
          `unregistered-${index}@1.0.0 não possui registro de supply chain.`,
        );
        delete packageJson[field][`unregistered-${index}`];
      }
    } finally {
      rmSync(repository, { force: true, recursive: true });
    }
  });

  it("fails closed for missing, stale, aliased or ambiguous dependency records", () => {
    const createManifests = () => [
      {
        packageJson: {
          dependencies: { "@set-livre/contracts": "0.0.0", react: "19.2.8" },
          name: "@set-livre/web",
          version: "0.0.0",
        },
        packagePath: "package.json",
      },
      {
        packageJson: {
          dependencies: { "@set-livre/contracts": "0.0.0", react: "19.2.8" },
          name: "@set-livre/backoffice",
          version: "0.0.0",
        },
        packagePath: "apps/backoffice/package.json",
      },
      {
        packageJson: { name: "@set-livre/contracts", version: "0.0.0" },
        packagePath: "packages/contracts/package.json",
      },
      {
        packageJson: {
          name: "@set-livre/ui",
          peerDependencies: { react: "19.2.8" },
          version: "0.0.0",
        },
        packagePath: "packages/ui/package.json",
      },
    ];
    const registry = (...rows) => `# Registro

## Dependências npm diretas

| Pacote | Versão | Superfície/finalidade | Licença | Justificativa | Avaliação de supply chain |
| --- | --- | --- | --- | --- | --- |
${rows.join("\n")}
`;
    const reactRow =
      "| `react` | `19.2.8` | runtime server/client | MIT | renderer normativo necessário | pacote oficial com lockfile auditado |";
    const zodRow =
      "| `zod` | `4.4.3` | runtime server/client | MIT | valida fronteiras tipadas | pacote maduro com lockfile auditado |";

    expect(validateCanonicalDependencyRegistry(createManifests(), registry(reactRow))).toEqual([]);

    const missingRecord = createManifests();
    missingRecord[1].packageJson.dependencies.zod = "4.4.3";
    expect(validateCanonicalDependencyRegistry(missingRecord, registry(reactRow))).toContain(
      "zod@4.4.3 não possui registro de supply chain.",
    );
    expect(
      validateCanonicalDependencyRegistry(
        createManifests(),
        registry(reactRow.replace("`19.2.8`", "`19.2.7`")),
      ),
    ).toContain("react registra 19.2.7, mas os manifests canônicos exigem 19.2.8.");
    expect(
      validateCanonicalDependencyRegistry(createManifests(), registry(reactRow, zodRow)),
    ).toContain("zod está registrado, mas não é dependência direta canônica.");

    expect(() =>
      validateCanonicalDependencyRegistry(createManifests(), registry(reactRow, reactRow)),
    ).toThrow("mais de um registro");
    expect(() =>
      validateCanonicalDependencyRegistry(
        createManifests(),
        registry(
          "| `react` / `react-dom` | `19.2.8` | runtime server/client | MIT | renderer normativo necessário | pacote oficial com lockfile auditado |",
        ),
      ),
    ).toThrow("um único pacote npm");
    expect(() =>
      validateCanonicalDependencyRegistry(
        createManifests(),
        registry(
          "| `react` | `19.2.8` | runtime server/client | MIT | renderer normativo necessário | — |",
        ),
      ),
    ).toThrow("avaliação de supply chain");

    const aliased = createManifests();
    aliased[1].packageJson.dependencies.renderer = "NPM:react@19.2.8";
    expect(() => validateCanonicalDependencyRegistry(aliased, registry(reactRow))).toThrow(
      "alias npm",
    );
    const ranged = createManifests();
    ranged[1].packageJson.dependencies.react = "^19.2.8";
    expect(() => validateCanonicalDependencyRegistry(ranged, registry(reactRow))).toThrow(
      "versão semver exata",
    );
    const divergent = createManifests();
    divergent[1].packageJson.dependencies.react = "19.2.7";
    expect(() => validateCanonicalDependencyRegistry(divergent, registry(reactRow))).toThrow(
      "versões divergentes",
    );
    const invalidWorkspaceReference = createManifests();
    invalidWorkspaceReference[0].packageJson.dependencies["@set-livre/contracts"] = "0.0.1";
    expect(() =>
      validateCanonicalDependencyRegistry(invalidWorkspaceReference, registry(reactRow)),
    ).toThrow("versão interna exata");
    const ambiguousBundle = createManifests();
    ambiguousBundle[0].packageJson.bundleDependencies = true;
    expect(() => validateCanonicalDependencyRegistry(ambiguousBundle, registry(reactRow))).toThrow(
      "lista explícita",
    );
    for (const overrides of [
      { react: "19.2.7" },
      { react: "npm:preact@10.27.2" },
      { "react@19.2.8": { ".": "19.2.7" } },
    ]) {
      const overridden = createManifests();
      overridden[0].packageJson.overrides = overrides;
      expect(() => validateCanonicalDependencyRegistry(overridden, registry(reactRow))).toThrow(
        "overrides não vazio",
      );
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
    const symbolicSpec =
      process.platform === "win32"
        ? "tests/e2e/critical/symbolic-spec/valid.spec.ts"
        : "tests/e2e/critical/symbolic.spec.ts";
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
      mkdirSync(join(repository, "outside-suite"));
      writeFileSync(
        join(repository, "outside-suite/parent.spec.ts"),
        `${playwrightImport}test("${scenarioId} fora da árvore física", () => {});\n`,
      );
      if (process.platform === "win32") {
        const externalSpecDirectory = join(repository, "outside-symbolic-spec");
        mkdirSync(externalSpecDirectory);
        writeFileSync(
          join(externalSpecDirectory, "valid.spec.ts"),
          `${playwrightImport}test("${scenarioId} por ancestral não físico", () => {});\n`,
        );
        createDirectoryLink(
          externalSpecDirectory,
          join(repository, "tests/e2e/critical/symbolic-spec"),
        );
      } else {
        symlinkSync("valid.spec.ts", join(repository, symbolicSpec));
      }
      createDirectoryLink(
        join(repository, "outside-suite"),
        join(repository, "tests/e2e/symbolic-suite"),
      );
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
    for (const invalidPath of [
      "NUL",
      "nested/con.txt",
      "nested/COM1.json",
      "trailing-dot.",
      "trailing-space ",
      "back\\slash.ts",
    ]) {
      expect(() => parseGitChanges(`${invalidPath}\0`, "A"), invalidPath).toThrow(
        /não é portável/u,
      );
    }
    expect(parsedChanges.filter(isAddedChangeRecord)).toEqual([
      { path: "docs/changes/2026-08-09-new.md", status: "A" },
    ]);
    expect(
      ["M", "D", "R"].some((status) =>
        isAddedChangeRecord({ path: "docs/changes/2026-08-09-reused.md", status }),
      ),
    ).toBe(false);
    expect(
      ["A", "M"].every((status) =>
        isProgressSummaryChange({ path: "contexto-projeto-set-livre.html", status }),
      ),
    ).toBe(true);
    expect(
      ["D", "R", "T"].some((status) =>
        isProgressSummaryChange({ path: "contexto-projeto-set-livre.html", status }),
      ),
    ).toBe(false);
    expect(isProgressSummaryChange({ path: "docs/context.md", status: "M" })).toBe(false);

    const encodedKeyBody = Buffer.alloc(300, 7).toString("base64");
    expect(
      containsEncodedPrivateKey(
        `-----BEGIN PRIVATE KEY-----\n${encodedKeyBody}\n-----END PRIVATE KEY-----\n`,
      ),
    ).toBe(true);
    expect(
      containsEncodedPrivateKey(
        "-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----\n",
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
    for (const entrypoint of [
      "instrumentation",
      "instrumentation-client",
      "mdx-components",
      "middleware",
      "proxy",
    ]) {
      for (const extension of ["js", "jsx", "ts", "tsx"]) {
        const path = `${entrypoint}.${extension}`;
        expect(isTechnicalChangePath(path), path).toBe(true);
      }
    }
    for (const path of [
      "README.md",
      "docs/proxy.ts",
      "docs/proxy.tsx",
      "instrumentation-guide.ts",
      "instrumentation.cjs",
      "instrumentation.cts",
      "instrumentation.mjs",
      "instrumentation.mts",
      "instrumentation-client.cjs",
      "instrumentation-client.cts",
      "instrumentation-client.mjs",
      "instrumentation-client.mts",
      "mdx-components.cjs",
      "mdx-components.cts",
      "mdx-components.mjs",
      "mdx-components.mts",
      "middleware.ctsx",
      "middleware.cjs",
      "middleware.cts",
      "middleware.mjs",
      "middleware.mts",
      "marketing.ts",
      "proximity.ts",
      "proxy.ts.example",
      "proxy.cjs",
      "proxy.cts",
      "proxy.mjs",
      "proxy.mts",
      "proxy.mjsx",
    ]) {
      expect(isTechnicalChangePath(path), path).toBe(false);
    }

    const repository = mkdtempSync(join(tmpdir(), "set-livre-git-changes-"));
    const canonicalRepository = repository.split("\\").join("/");
    const rootRevision = "1".repeat(40);
    const mainRevision = "2".repeat(40);
    const featureRevision = "3".repeat(40);
    const deterministicReader = ({
      committedPath,
      expectedBase,
      headMarker,
      headRevision,
      localMainRevision,
    }) => {
      const observedArguments = [];
      const executeGit = (command, argumentsList, options) => {
        expect(command).toBe("git");
        expect(options.cwd).toBe(repository);
        observedArguments.push(argumentsList);

        if (
          argumentsList[0] === "rev-parse" &&
          argumentsList[1] === "--show-toplevel" &&
          argumentsList[2] === "HEAD^{commit}"
        ) {
          return canonicalRepository + "\n" + headRevision + "\n";
        }
        if (argumentsList[0] === "for-each-ref") {
          return headMarker + "\0refs/heads/main\0" + localMainRevision + "\0commit\n";
        }
        if (argumentsList[0] === "merge-base") {
          expect(argumentsList).toEqual(["merge-base", localMainRevision, "HEAD"]);
          return localMainRevision + "\n";
        }
        if (argumentsList[0] === "rev-list" && argumentsList[1] === "--max-parents=0") {
          return rootRevision + "\n";
        }
        if (argumentsList[0] === "diff") {
          return argumentsList.includes(expectedBase + "...HEAD")
            ? "A\0" + committedPath + "\0"
            : "";
        }
        if (argumentsList[0] === "ls-files") {
          return "";
        }
        throw new Error("Comando Git inesperado no cenário determinístico.");
      };

      return {
        observedArguments,
        result: readGitChanges(repository, executeGit),
      };
    };

    try {
      const localMainAtHead = deterministicReader({
        committedPath: "docs/on-main.md",
        expectedBase: rootRevision,
        headMarker: "*",
        headRevision: mainRevision,
        localMainRevision: mainRevision,
      });
      expect(localMainAtHead.result.comparisonBase).toBe(rootRevision);
      expect(localMainAtHead.result.changes).toContainEqual({
        path: "docs/on-main.md",
        status: "A",
      });
      expect(
        localMainAtHead.observedArguments.filter(([command]) => command === "for-each-ref"),
      ).toHaveLength(1);
      expect(
        localMainAtHead.observedArguments.some(([command]) => command === "symbolic-ref"),
      ).toBe(false);

      const localMain = deterministicReader({
        committedPath: "docs/committed.md",
        expectedBase: mainRevision,
        headMarker: " ",
        headRevision: featureRevision,
        localMainRevision: mainRevision,
      });
      expect(localMain.result.comparisonBase).toBe(mainRevision);
      expect(localMain.result.changes).toContainEqual({
        path: "docs/committed.md",
        status: "A",
      });
      expect(
        localMain.observedArguments.filter(([command]) => command === "merge-base"),
      ).toHaveLength(1);
      expect(
        localMain.observedArguments.some(
          ([command, argument]) => command === "rev-list" && argument === "--count",
        ),
      ).toBe(false);

      const git = (...argumentsList) =>
        execFileSync("git", argumentsList, {
          cwd: repository,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
      git("init", "--initial-branch", "main");
      const dataCommand = (value) => `data ${Buffer.byteLength(value, "utf8")}\n${value}`;
      const identity = "Set Livre QA <qa@set-livre.local> 0 +0000\n";
      const importedMarks = execFileSync("git", ["fast-import", "--quiet"], {
        cwd: repository,
        encoding: "utf8",
        input: [
          "commit refs/heads/feature\n",
          "mark :1\n",
          "author " + identity,
          "committer " + identity,
          dataCommand("baseline\n"),
          "M 100644 inline README.md\n",
          dataCommand("# Baseline\n"),
          "\n",
          "commit refs/heads/feature\n",
          "mark :2\n",
          "author " + identity,
          "committer " + identity,
          dataCommand("docs\n"),
          "from :1\n",
          "M 100644 inline docs/committed.md\n",
          dataCommand("# Markdown commitado\n"),
          "\n",
          "get-mark :1\n",
          "done\n",
        ].join(""),
        stdio: ["pipe", "pipe", "ignore"],
      }).trim();
      expect(importedMarks).toMatch(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
      const realRootRevision = importedMarks;
      git("switch", "feature");

      const rootFallbackChanges = readGitChanges(repository);
      expect(rootFallbackChanges.comparisonBase).toBe(realRootRevision);
      expect(rootFallbackChanges.changes).toContainEqual({
        path: "docs/committed.md",
        status: "A",
      });
    } finally {
      rmSync(repository, { force: true, recursive: true });
    }
  });

  it(
    "enforces append-only migrations against the real Git comparison base",
    { timeout: 15_000 },
    () => {
      const testRoot = mkdtempSync(join(tmpdir(), "set-livre-migration-git-"));
      const migrationPath = (name) => "supabase/migrations/" + name;
      const baselineNames = {
        deleted: "20260810000200_deleted.sql",
        modified: "20260810000100_modified.sql",
        renamed: "20260810000300_renamed.sql",
        typeChanged: "20260810000400_type_changed.sql",
      };
      const baselineHead = "20260810000400";
      const baselinePath = migrationPath(baselineNames.modified);
      const templateRepository = join(testRoot, "template");
      mkdirSync(join(templateRepository, "supabase/migrations"), { recursive: true });

      const executeFixtureGit = (repository, argumentsList) =>
        execFileSync(
          "git",
          ["-c", "user.email=qa@set-livre.local", "-c", "user.name=Set Livre QA", ...argumentsList],
          {
            cwd: repository,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          },
        );
      const templateGit = (...argumentsList) =>
        executeFixtureGit(templateRepository, argumentsList);
      templateGit("init", "--initial-branch", "main");
      templateGit("config", "diff.renames", "true");
      for (const name of Object.values(baselineNames)) {
        writeFileSync(join(templateRepository, migrationPath(name)), "select 1;\n", "utf8");
      }
      templateGit("add", "supabase/migrations");
      templateGit("commit", "-m", "database baseline");
      templateGit("switch", "--detach");

      const createRepository = (name) => {
        const repository = join(testRoot, name);
        templateGit("worktree", "add", "--detach", repository, "main");
        return {
          git: (...argumentsList) => executeFixtureGit(repository, argumentsList),
          repository,
        };
      };
      const baselineMigrationPathsByRevision = new Map();
      const migrationGate = (repository) => {
        const gitState = readGitChanges(repository);
        let baselineMigrationPaths = [];
        if (gitState.comparisonBase !== null) {
          baselineMigrationPaths = baselineMigrationPathsByRevision.get(gitState.comparisonBase);
          if (baselineMigrationPaths === undefined) {
            baselineMigrationPaths = readGitMigrationPathsAtRevision(
              repository,
              gitState.comparisonBase,
            );
            baselineMigrationPathsByRevision.set(gitState.comparisonBase, baselineMigrationPaths);
          }
        }
        return {
          errors: validateMigrationGitChanges(gitState.changes, baselineMigrationPaths, {
            repositoryRoot: repository,
          }),
          gitState,
        };
      };

      try {
        const legitimate = createRepository("legitimate");
        const legitimatePath = migrationPath("20260810000500_legitimate.sql");
        writeFileSync(join(legitimate.repository, legitimatePath), "select 2;\n", "utf8");
        expect(migrationGate(legitimate.repository).errors).toEqual([]);
        legitimate.git("add", legitimatePath);
        legitimate.git("commit", "-m", "add migration");
        writeFileSync(
          join(legitimate.repository, legitimatePath),
          "select 2;\nselect 3;\n",
          "utf8",
        );
        expect(migrationGate(legitimate.repository).errors).toEqual([]);

        const invalid = createRepository("invalid-matrix");
        const modifiedPath = migrationPath(baselineNames.modified);
        writeFileSync(join(invalid.repository, modifiedPath), "select 99;\n", "utf8");

        const deletedPath = migrationPath(baselineNames.deleted);
        rmSync(join(invalid.repository, deletedPath));

        const renamedPath = migrationPath(baselineNames.renamed);
        const renamedTargetPath = migrationPath("20260810000900_renamed.sql");
        invalid.git("mv", renamedPath, renamedTargetPath);

        const typeChangedPath = migrationPath(baselineNames.typeChanged);
        rmSync(join(invalid.repository, typeChangedPath));
        if (process.platform === "win32") {
          stageGitSymbolicLink(invalid.repository, typeChangedPath, "external.sql");
        } else {
          symlinkSync("external.sql", join(invalid.repository, typeChangedPath));
        }

        const symbolicAdditionPath = migrationPath("20260810000500_symbolic.sql");
        if (process.platform === "win32") {
          stageGitSymbolicLink(invalid.repository, symbolicAdditionPath, baselineNames.modified);
          mkdirSync(join(invalid.repository, symbolicAdditionPath));
        } else {
          symlinkSync(baselineNames.modified, join(invalid.repository, symbolicAdditionPath));
        }

        const hardLinkSource = join(testRoot, "outside-migration.sql");
        const hardLinkedAdditionPath = migrationPath("20260810000600_hard_linked.sql");
        writeFileSync(hardLinkSource, "select 2;\n", "utf8");
        linkSync(hardLinkSource, join(invalid.repository, hardLinkedAdditionPath));

        if (process.platform !== "win32") {
          const fifoAdditionPath = migrationPath("20260810000700_fifo.sql");
          execFileSync("mkfifo", [join(invalid.repository, fifoAdditionPath)]);
        }

        const directoryAdditionPath = migrationPath("20260810000750_directory.sql");
        mkdirSync(join(invalid.repository, directoryAdditionPath));
        writeFileSync(
          join(invalid.repository, directoryAdditionPath, "payload"),
          "select 2;\n",
          "utf8",
        );

        const backdatedPath = migrationPath("20260809000100_backdated.sql");
        const sameHeadPath = migrationPath("20260810000400_same_head.sql");
        writeFileSync(join(invalid.repository, backdatedPath), "select 2;\n", "utf8");
        writeFileSync(join(invalid.repository, sameHeadPath), "select 2;\n", "utf8");

        const firstDuplicate = migrationPath("20260810000800_first.sql");
        const secondDuplicate = migrationPath("20260810000800_second.sql");
        writeFileSync(join(invalid.repository, firstDuplicate), "select 2;\n", "utf8");
        writeFileSync(join(invalid.repository, secondDuplicate), "select 3;\n", "utf8");

        const invalidResult = migrationGate(invalid.repository);
        expect(invalidResult.gitState.changes).toEqual(
          expect.arrayContaining([
            { path: modifiedPath, status: "M" },
            { path: deletedPath, status: "D" },
            { path: renamedPath, status: "R" },
            { path: renamedTargetPath, status: "R" },
            { path: typeChangedPath, status: "T" },
          ]),
        );
        expect(invalidResult.errors).toEqual(
          expect.arrayContaining([
            "Migration aplicada é imutável: " + modifiedPath + " recebeu status M.",
            "Migration aplicada é imutável: " + deletedPath + " recebeu status D.",
            "Migration aplicada é imutável: " + renamedPath + " recebeu status R.",
            "Migration aplicada é imutável: " + typeChangedPath + " recebeu status T.",
            "Migration precisa permanecer arquivo regular: " + typeChangedPath + ".",
            expect.stringContaining(
              "Migration nova precisa ser arquivo físico regular exclusivo e estável: " +
                symbolicAdditionPath,
            ),
            expect.stringContaining(
              "Migration nova precisa ser arquivo físico regular exclusivo e estável: " +
                hardLinkedAdditionPath,
            ),
            "Nome de migration alterada inválido: " + directoryAdditionPath + "/payload.",
            "Migration nova " +
              backdatedPath +
              " precisa avançar estritamente o head " +
              baselineHead +
              " da base Git.",
            "Migration nova " +
              sameHeadPath +
              " precisa avançar estritamente o head " +
              baselineHead +
              " da base Git.",
            "Migrations novas repetem a versão 20260810000800: " +
              firstDuplicate +
              " e " +
              secondDuplicate +
              ".",
          ]),
        );
        if (process.platform !== "win32") {
          expect(invalidResult.errors).toEqual(
            expect.arrayContaining([
              expect.stringContaining(
                "Migration nova precisa ser arquivo físico regular exclusivo e estável: " +
                  migrationPath("20260810000700_fifo.sql"),
              ),
            ]),
          );
        }

        const bootstrap = join(testRoot, "bootstrap");
        mkdirSync(join(bootstrap, "supabase/migrations"), { recursive: true });
        const bootstrapGit = (...argumentsList) =>
          execFileSync(
            "git",
            [
              "-c",
              "user.email=qa@set-livre.local",
              "-c",
              "user.name=Set Livre QA",
              ...argumentsList,
            ],
            {
              cwd: bootstrap,
              encoding: "utf8",
              stdio: ["ignore", "pipe", "ignore"],
            },
          );
        bootstrapGit("init", "--initial-branch", "main");
        writeFileSync(join(bootstrap, baselinePath), "select 1;\n", "utf8");
        const bootstrapWithoutHead = migrationGate(bootstrap);
        expect(bootstrapWithoutHead.gitState.comparisonBase).toBeNull();
        expect(bootstrapWithoutHead.errors).toEqual([]);
        bootstrapGit("add", baselinePath);
        bootstrapGit("commit", "-m", "root migration");
        const bootstrapAtRoot = migrationGate(bootstrap);
        expect(bootstrapAtRoot.gitState.comparisonBase).toBeNull();
        expect(bootstrapAtRoot.errors).toEqual([]);

        const noOrigin = createRepository("no-origin-root-fallback");
        noOrigin.git("branch", "--delete", "--force", "main");
        const laterPath = migrationPath("20260810000500_later.sql");
        writeFileSync(join(noOrigin.repository, laterPath), "select 2;\n", "utf8");
        noOrigin.git("add", laterPath);
        noOrigin.git("commit", "-m", "advance feature without main");
        expect(migrationGate(noOrigin.repository).gitState.comparisonBase).not.toBeNull();
        const invalidNoOriginPath = migrationPath("20260809000200_invalid.sql");
        writeFileSync(join(noOrigin.repository, invalidNoOriginPath), "select 0;\n", "utf8");
        expect(migrationGate(noOrigin.repository).errors).toContain(
          "Migration nova " +
            invalidNoOriginPath +
            " precisa avançar estritamente o head " +
            baselineHead +
            " da base Git.",
        );
      } finally {
        rmSync(testRoot, { force: true, recursive: true });
      }
    },
  );
  it("keeps committed migration blobs and modes immutable on main, features, index and worktree", () => {
    const testRoot = mkdtempSync(join(tmpdir(), "set-livre-migration-history-"));
    const firstPath = "supabase/migrations/20260810000100_first.sql";
    const secondPath = "supabase/migrations/20260810000200_second.sql";
    const thirdPath = "supabase/migrations/20260810000300_third.sql";
    const createRepository = (name, { feature = false } = {}) => {
      const repository = join(testRoot, name);
      mkdirSync(join(repository, "supabase/migrations"), { recursive: true });
      const git = (...argumentsList) =>
        execFileSync("git", argumentsList, {
          cwd: repository,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
      git("init", "--initial-branch", "main");
      git("config", "user.email", "qa@set-livre.local");
      git("config", "user.name", "Set Livre QA");
      git("config", "diff.renames", "true");
      writeFileSync(join(repository, firstPath), "select 1;\n", "utf8");
      git("add", firstPath);
      git("commit", "-m", "root migration");
      if (feature) {
        git("switch", "--create", "feature");
      }
      return { git, repository };
    };
    const historyGate = (repository) => {
      const { comparisonBase } = readGitChanges(repository);
      return validateMigrationRepositoryHistory(repository, comparisonBase);
    };

    try {
      const bootstrap = join(testRoot, "bootstrap");
      mkdirSync(join(bootstrap, "supabase/migrations"), { recursive: true });
      const bootstrapGit = (...argumentsList) =>
        execFileSync("git", argumentsList, {
          cwd: bootstrap,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
      bootstrapGit("init", "--initial-branch", "main");
      bootstrapGit("config", "user.email", "qa@set-livre.local");
      bootstrapGit("config", "user.name", "Set Livre QA");
      writeFileSync(join(bootstrap, firstPath), "select 1;\n", "utf8");
      expect(historyGate(bootstrap)).toEqual([]);
      bootstrapGit("add", firstPath);
      bootstrapGit("commit", "-m", "root migration");
      expect(historyGate(bootstrap)).toEqual([]);

      const mainHistory = createRepository("main-history");
      writeFileSync(join(mainHistory.repository, secondPath), "select 2;\n", "utf8");
      writeFileSync(join(mainHistory.repository, thirdPath), "select 3;\n", "utf8");
      mainHistory.git("add", secondPath, thirdPath);
      mainHistory.git("commit", "-m", "two legitimate migrations");
      expect(historyGate(mainHistory.repository)).toEqual([]);
      writeFileSync(join(mainHistory.repository, secondPath), "select 999;\n", "utf8");
      mainHistory.git("add", secondPath);
      mainHistory.git("commit", "-m", "mutate applied migration");
      expect(historyGate(mainHistory.repository)).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            `histórico Git: Migration commitada é imutável: ${secondPath} mudou blob, tipo ou modo`,
          ),
        ]),
      );

      const featureHistory = createRepository("feature-history", { feature: true });
      writeFileSync(join(featureHistory.repository, secondPath), "select 2;\n", "utf8");
      featureHistory.git("add", secondPath);
      featureHistory.git("commit", "-m", "add feature migration");
      expect(historyGate(featureHistory.repository)).toEqual([]);
      writeFileSync(join(featureHistory.repository, secondPath), "select 22;\n", "utf8");
      featureHistory.git("add", secondPath);
      featureHistory.git("commit", "-m", "mutate feature migration later");
      expect(historyGate(featureHistory.repository)).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            `histórico Git: Migration commitada é imutável: ${secondPath} mudou blob, tipo ou modo`,
          ),
        ]),
      );

      const modeHistory = createRepository("mode-history", { feature: true });
      writeFileSync(join(modeHistory.repository, secondPath), "select 2;\n", "utf8");
      modeHistory.git("add", secondPath);
      modeHistory.git("commit", "-m", "add feature migration");
      modeHistory.git("update-index", "--chmod=+x", secondPath);
      modeHistory.git("commit", "-m", "mutate migration mode");
      expect(historyGate(modeHistory.repository)).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            `histórico Git: Migration commitada é imutável: ${secondPath} mudou blob, tipo ou modo`,
          ),
        ]),
      );

      const worktree = createRepository("worktree", { feature: true });
      writeFileSync(join(worktree.repository, secondPath), "select 2;\n", "utf8");
      worktree.git("add", secondPath);
      worktree.git("commit", "-m", "add feature migration");
      writeFileSync(join(worktree.repository, secondPath), "select 22;\n", "utf8");
      expect(historyGate(worktree.repository)).toContain(
        `worktree: Migration aplicada é imutável: ${secondPath} recebeu status M.`,
      );

      const staged = createRepository("staged", { feature: true });
      writeFileSync(join(staged.repository, secondPath), "select 2;\n", "utf8");
      staged.git("add", secondPath);
      staged.git("commit", "-m", "add feature migration");
      writeFileSync(join(staged.repository, secondPath), "select 222;\n", "utf8");
      staged.git("add", secondPath);
      writeFileSync(join(staged.repository, secondPath), "select 2;\n", "utf8");
      expect(historyGate(staged.repository)).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            `índice Git: Migration commitada é imutável: ${secondPath} mudou blob, tipo ou modo`,
          ),
        ]),
      );

      const statCache = createRepository("stat-cache");
      const statCachedPath = join(statCache.repository, firstPath);
      const stableTimestamp = new Date("2020-01-01T00:00:00.000Z");
      utimesSync(statCachedPath, stableTimestamp, stableTimestamp);
      statCache.git("update-index", "--refresh");
      statCache.git("config", "core.trustctime", "false");
      statCache.git("config", "core.checkStat", "minimal");
      writeFileSync(statCachedPath, "select 9;\n", "utf8");
      utimesSync(statCachedPath, stableTimestamp, stableTimestamp);
      expect(statCache.git("status", "--short", "--", firstPath)).toBe("");
      expect(historyGate(statCache.repository)).toContain(
        `índice/worktree físico: Migration física diverge do blob ou modo indexado: ${firstPath}.`,
      );

      if (process.platform !== "win32") {
        const ignoredMode = createRepository("ignored-mode");
        ignoredMode.git("config", "core.fileMode", "false");
        chmodSync(join(ignoredMode.repository, firstPath), 0o755);
        expect(ignoredMode.git("status", "--short", "--", firstPath)).toBe("");
        expect(historyGate(ignoredMode.repository)).toContain(
          `índice/worktree físico: Migration física diverge do blob ou modo indexado: ${firstPath}.`,
        );
      }

      const secondParentBase = createRepository("second-parent-base");
      secondParentBase.git("switch", "--create", "side");
      writeFileSync(join(secondParentBase.repository, secondPath), "select 2;\n", "utf8");
      secondParentBase.git("add", secondPath);
      secondParentBase.git("commit", "-m", "migration on side branch");
      const sideRevision = secondParentBase.git("rev-parse", "HEAD").trim();
      secondParentBase.git("switch", "main");
      writeFileSync(join(secondParentBase.repository, "README.md"), "# Main\n", "utf8");
      secondParentBase.git("add", "README.md");
      secondParentBase.git("commit", "-m", "advance first parent");
      secondParentBase.git("merge", "--no-ff", "side", "-m", "merge side branch");
      expect(() =>
        validateMigrationRepositoryHistory(secondParentBase.repository, sideRevision),
      ).toThrow("não pertence à cadeia first-parent");
    } finally {
      rmSync(testRoot, { force: true, recursive: true });
    }
  }, 30_000);

  it("requires every physical migration to be indexed or canonically visible as untracked", () => {
    const repository = mkdtempSync(join(tmpdir(), "set-livre-migration-visibility-"));
    const firstPath = "supabase/migrations/20260810000100_first.sql";
    const visiblePath = "supabase/migrations/20260810000200_visible.sql";
    const git = (...argumentsList) =>
      execFileSync("git", argumentsList, {
        cwd: repository,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    const historyGate = () => {
      const { comparisonBase } = readGitChanges(repository);
      return validateMigrationRepositoryHistory(repository, comparisonBase);
    };

    try {
      mkdirSync(join(repository, "supabase/migrations"), { recursive: true });
      git("init", "--initial-branch", "main");
      git("config", "user.email", "qa@set-livre.local");
      git("config", "user.name", "Set Livre QA");
      writeFileSync(join(repository, firstPath), "select 1;\n", "utf8");
      git("add", firstPath);
      git("commit", "-m", "root migration");

      writeFileSync(join(repository, visiblePath), "select 2;\n", "utf8");
      expect(
        git("ls-files", "--others", "--exclude-standard", "--", "supabase/migrations").trim(),
      ).toBe(visiblePath);
      expect(historyGate()).toEqual([]);

      writeFileSync(join(repository, ".git/info/exclude"), `/${visiblePath}\n`, "utf8");
      expect(git("check-ignore", visiblePath).trim()).toBe(visiblePath);
      expect(historyGate()).toContain(
        `índice/worktree físico: Migration física não está indexada nem visível como untracked no Git canônico: ${visiblePath}.`,
      );
    } finally {
      rmSync(repository, { force: true, recursive: true });
    }
  });

  it("binds every Git migration view to the physical repository root being audited", () => {
    const testRoot = mkdtempSync(join(tmpdir(), "set-livre-migration-worktree-root-"));
    const divertedRepository = join(testRoot, "diverted");
    const alternateWorktree = join(testRoot, "alternate");
    const linkedRepository = join(testRoot, "linked-source");
    const linkedWorktree = join(testRoot, "linked-worktree");
    const firstPath = "supabase/migrations/20260810000100_first.sql";
    const secondPath = "supabase/migrations/20260810000200_second.sql";
    const initializeRepository = (repository) => {
      mkdirSync(join(repository, "supabase/migrations"), { recursive: true });
      const git = (...argumentsList) =>
        execFileSync("git", argumentsList, {
          cwd: repository,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
      git("init", "--initial-branch", "main");
      git("config", "user.email", "qa@set-livre.local");
      git("config", "user.name", "Set Livre QA");
      writeFileSync(join(repository, firstPath), "select 1;\n", "utf8");
      git("add", firstPath);
      git("commit", "-m", "root migration");
      return git;
    };

    try {
      const divertedGit = initializeRepository(divertedRepository);
      writeFileSync(join(divertedRepository, secondPath), "select 2;\n", "utf8");
      writeFileSync(join(divertedRepository, ".gitignore"), `/${secondPath}\n`, "utf8");
      expect(divertedGit("check-ignore", secondPath).trim()).toBe(secondPath);

      mkdirSync(join(alternateWorktree, "supabase/migrations"), { recursive: true });
      writeFileSync(join(alternateWorktree, firstPath), "select 1;\n", "utf8");
      writeFileSync(join(alternateWorktree, secondPath), "select 2;\n", "utf8");
      divertedGit("config", "core.worktree", alternateWorktree);
      expect(divertedGit("rev-parse", "--show-toplevel").trim()).not.toBe(divertedRepository);
      expect(
        divertedGit(
          "ls-files",
          "--others",
          "--exclude-standard",
          "--",
          "supabase/migrations",
        ).trim(),
      ).toBe(secondPath);

      const divertedHead = divertedGit("rev-parse", "HEAD").trim();
      for (const operation of [
        () => readGitChanges(divertedRepository),
        () => readGitMigrationPathsAtRevision(divertedRepository, divertedHead),
        () => validateMigrationRepositoryHistory(divertedRepository, null),
      ]) {
        expect(operation).toThrow(
          "O worktree Git canônico não corresponde à raiz física auditada.",
        );
      }

      const linkedGit = initializeRepository(linkedRepository);
      const linkedHead = linkedGit("rev-parse", "HEAD").trim();
      linkedGit("worktree", "add", "--detach", linkedWorktree, linkedHead);
      const linkedState = readGitChanges(linkedWorktree);
      expect(readGitMigrationPathsAtRevision(linkedWorktree, linkedHead)).toEqual([firstPath]);
      expect(
        validateMigrationRepositoryHistory(linkedWorktree, linkedState.comparisonBase),
      ).toEqual([]);
    } finally {
      rmSync(testRoot, { force: true, recursive: true });
    }
  });

  it("refuses incomplete or locally rewritten Git migration history", () => {
    const testRoot = mkdtempSync(join(tmpdir(), "set-livre-migration-history-integrity-"));
    const repository = join(testRoot, "origin");
    const shallowClone = join(testRoot, "shallow");
    const firstPath = "supabase/migrations/20260810000100_first.sql";
    const secondPath = "supabase/migrations/20260810000200_second.sql";
    mkdirSync(join(repository, "supabase/migrations"), { recursive: true });
    const git = (...argumentsList) =>
      execFileSync(
        "git",
        ["-c", "user.email=qa@set-livre.local", "-c", "user.name=Set Livre QA", ...argumentsList],
        {
          cwd: repository,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        },
      ).trim();
    const historyGate = (root) => {
      const { comparisonBase } = readGitChanges(root);
      return validateMigrationRepositoryHistory(root, comparisonBase);
    };

    try {
      git("init", "--initial-branch", "main");
      const dataCommand = (value) => `data ${Buffer.byteLength(value, "utf8")}\n${value}`;
      const identity = "Set Livre QA <qa@set-livre.local> 0 +0000\n";
      const [rootRevision, headRevision] = execFileSync("git", ["fast-import", "--quiet"], {
        cwd: repository,
        encoding: "utf8",
        input: [
          "commit refs/heads/main\n",
          "mark :1\n",
          "author " + identity,
          "committer " + identity,
          dataCommand("root migration\n"),
          `M 100644 inline ${firstPath}\n`,
          dataCommand("select 1;\n"),
          "\n",
          "commit refs/heads/main\n",
          "mark :2\n",
          "author " + identity,
          "committer " + identity,
          dataCommand("add migration\n"),
          "from :1\n",
          `M 100644 inline ${secondPath}\n`,
          dataCommand("select 2;\n"),
          "\n",
          "commit refs/heads/main\n",
          "mark :3\n",
          "author " + identity,
          "committer " + identity,
          dataCommand("mutate committed migration\n"),
          "from :2\n",
          `M 100644 inline ${secondPath}\n`,
          dataCommand("select 999;\n"),
          "\n",
          "get-mark :1\n",
          "get-mark :3\n",
          "done\n",
        ].join(""),
        stdio: ["pipe", "pipe", "ignore"],
      })
        .trim()
        .split(/\r?\n/u);
      git("reset", "--hard", "HEAD");

      expect(historyGate(repository)).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            `histórico Git: Migration commitada é imutável: ${secondPath} mudou blob, tipo ou modo`,
          ),
        ]),
      );

      execFileSync("git", ["clone", "--depth=1", pathToFileURL(repository).href, shallowClone], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      expect(
        execFileSync("git", ["rev-parse", "--is-shallow-repository"], {
          cwd: shallowClone,
          encoding: "utf8",
        }).trim(),
      ).toBe("true");
      expect(() => historyGate(shallowClone)).toThrow("clones shallow são recusados");

      const replacementTree = git("rev-parse", "HEAD^{tree}");
      const replacementRevision = git(
        "commit-tree",
        replacementTree,
        "-p",
        rootRevision,
        "-m",
        "hide intermediate migration commit",
      );
      git("replace", headRevision, replacementRevision);
      expect(() => historyGate(repository)).toThrow("não pode usar refs/replace");
      git("replace", "-d", headRevision);

      const customReplacementNamespace = "refs/custom-replacements/";
      git("update-ref", `${customReplacementNamespace}${headRevision}`, replacementRevision);
      expect(
        execFileSync("git", ["rev-list", "--count", "HEAD"], {
          cwd: repository,
          encoding: "utf8",
          env: { ...process.env, GIT_REPLACE_REF_BASE: customReplacementNamespace },
          stdio: ["ignore", "pipe", "ignore"],
        }).trim(),
      ).toBe("2");

      const observedGitEnvironments = [];
      const executeObservedGit = (command, argumentsList, options) => {
        observedGitEnvironments.push(options.env);
        return execFileSync(command, argumentsList, options);
      };
      const customGraftPath = join(testRoot, "custom-grafts");
      const customShallowPath = join(testRoot, "custom-shallow");
      writeFileSync(customGraftPath, `${headRevision} ${rootRevision}\n`, "utf8");
      writeFileSync(customShallowPath, `${headRevision}\n`, "utf8");
      withProcessEnvironment(
        {
          GIT_GRAFT_FILE: customGraftPath,
          GIT_REPLACE_REF_BASE: customReplacementNamespace,
          GIT_SHALLOW_FILE: customShallowPath,
          SECRET_LEAK_SENTINEL: "must-not-reach-git",
        },
        () => {
          const { comparisonBase } = readGitChanges(repository, executeObservedGit);
          expect(
            readGitMigrationPathsAtRevision(repository, comparisonBase, executeObservedGit),
          ).toEqual([firstPath]);
          expect(
            validateMigrationRepositoryHistory(repository, comparisonBase, executeObservedGit),
          ).toEqual(
            expect.arrayContaining([
              expect.stringContaining(
                `histórico Git: Migration commitada é imutável: ${secondPath} mudou blob, tipo ou modo`,
              ),
            ]),
          );
        },
      );
      expect(observedGitEnvironments.length).toBeGreaterThan(0);
      for (const environment of observedGitEnvironments) {
        expect(environment).toEqual(
          expect.objectContaining({
            GIT_NO_REPLACE_OBJECTS: "1",
            GIT_TERMINAL_PROMPT: "0",
            LANG: "C",
            LC_ALL: "C",
          }),
        );
        expect(environment).not.toHaveProperty("GIT_GRAFT_FILE");
        expect(environment).not.toHaveProperty("GIT_REPLACE_REF_BASE");
        expect(environment).not.toHaveProperty("GIT_SHALLOW_FILE");
        expect(environment).not.toHaveProperty("SECRET_LEAK_SENTINEL");
        expect(JSON.stringify(environment)).not.toContain("must-not-reach-git");
      }
      git("update-ref", "-d", `${customReplacementNamespace}${headRevision}`);

      const graftPath = git("rev-parse", "--git-path", "info/grafts");
      writeFileSync(join(repository, graftPath), `${headRevision} ${rootRevision}\n`, "utf8");
      expect(() => historyGate(repository)).toThrow("info/grafts legado não vazio");
      writeFileSync(join(repository, graftPath), "", "utf8");
      expect(historyGate(repository)).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            `histórico Git: Migration commitada é imutável: ${secondPath} mudou blob, tipo ou modo`,
          ),
        ]),
      );
    } finally {
      rmSync(testRoot, { force: true, recursive: true });
    }
  });

  it("keeps the living project summary standalone and structurally complete", () => {
    const sections = [
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
    ]
      .map((id) => `<section id="${id}"></section>`)
      .join("");
    const validSummary = `<!doctype html><html lang="pt-BR"><head><style></style></head><body><main><h1>Set Livre</h1>${sections}</main></body></html>`;

    expect(validateProgressSummary(validSummary)).toEqual([]);
    expect(
      validateProgressSummary(
        validSummary
          .replace('<html lang="pt-BR">', "<html>")
          .replace('<section id="scripts"></section>', "")
          .replace("</main>", '<script src="remote.js"></script></main>'),
      ),
    ).toEqual([
      "o resumo precisa declarar lang=pt-BR",
      "o resumo não contém a seção #scripts",
      "o resumo executivo não pode depender de JavaScript",
    ]);
  });

  it("accepts only a stable physical added change record", () => {
    const testRoot = mkdtempSync(join(tmpdir(), "set-livre-change-record-"));
    const createRepository = (name) => {
      const repository = join(testRoot, name);
      mkdirSync(join(repository, "docs/changes"), { recursive: true });
      return repository;
    };
    const change = (name) => ({ path: `docs/changes/${name}`, status: "A" });

    try {
      const validRepository = createRepository("valid");
      const validChange = change("2026-08-10-stable.md");
      writeFileSync(join(validRepository, validChange.path), "# Registro estável\n", "utf8");
      expect(readAddedChangeRecord(validRepository, validChange)).toBe("# Registro estável\n");
      expect(() => readAddedChangeRecord(validRepository, { ...validChange, status: "M" })).toThrow(
        "Markdown novo",
      );
      expect(() =>
        readAddedChangeRecord(validRepository, {
          path: "docs/changes/2026-08-10-invalid.txt",
          status: "A",
        }),
      ).toThrow("Markdown novo");

      const emptyChange = change("2026-08-10-empty.md");
      writeFileSync(join(validRepository, emptyChange.path), " \n", "utf8");
      expect(() => readAddedChangeRecord(validRepository, emptyChange)).toThrow(
        "não pode estar vazio",
      );

      const symbolicChange = change("2026-08-10-symbolic.md");
      if (process.platform === "win32") {
        const symbolicFileRepository = join(testRoot, "symbolic-file");
        const externalSymbolicChanges = join(testRoot, "external-symbolic-changes");
        mkdirSync(join(symbolicFileRepository, "docs"), { recursive: true });
        mkdirSync(externalSymbolicChanges);
        writeFileSync(
          join(externalSymbolicChanges, "2026-08-10-symbolic.md"),
          "# Registro por ancestral não físico\n",
          "utf8",
        );
        createDirectoryLink(externalSymbolicChanges, join(symbolicFileRepository, "docs/changes"));
        expect(() => readAddedChangeRecord(symbolicFileRepository, symbolicChange)).toThrow(
          "diretório não físico",
        );
      } else {
        symlinkSync("2026-08-10-stable.md", join(validRepository, symbolicChange.path));
        expect(() => readAddedChangeRecord(validRepository, symbolicChange)).toThrow(
          "físico e regular",
        );
      }

      const hardLinkSource = join(testRoot, "hard-link-source.md");
      writeFileSync(hardLinkSource, "# Fora do repositório\n", "utf8");
      const hardLinkedChange = change("2026-08-10-hard-linked.md");
      linkSync(hardLinkSource, join(validRepository, hardLinkedChange.path));
      expect(() => readAddedChangeRecord(validRepository, hardLinkedChange)).toThrow("exclusivo");

      const directoryChange = change("2026-08-10-directory.md");
      mkdirSync(join(validRepository, directoryChange.path));
      expect(() => readAddedChangeRecord(validRepository, directoryChange)).toThrow(
        "físico e regular",
      );

      const symbolicAncestorRepository = join(testRoot, "symbolic-ancestor");
      const externalChanges = join(testRoot, "external-changes");
      mkdirSync(join(symbolicAncestorRepository, "docs"), { recursive: true });
      mkdirSync(externalChanges);
      const ancestorChange = change("2026-08-10-ancestor.md");
      writeFileSync(join(externalChanges, "2026-08-10-ancestor.md"), "# Externo\n", "utf8");
      createDirectoryLink(externalChanges, join(symbolicAncestorRepository, "docs/changes"));
      expect(() => readAddedChangeRecord(symbolicAncestorRepository, ancestorChange)).toThrow(
        "diretório não físico",
      );

      const symbolicRoot = join(testRoot, "symbolic-root");
      createDirectoryLink(validRepository, symbolicRoot);
      expect(() => readAddedChangeRecord(symbolicRoot, validChange)).toThrow("raiz do repositório");

      const replacedRepository = createRepository("replaced-during-read");
      const replacedChange = change("2026-08-10-replaced.md");
      const replacedPath = join(replacedRepository, replacedChange.path);
      writeFileSync(replacedPath, "# Original\n", "utf8");
      expect(() =>
        readAddedChangeRecord(replacedRepository, replacedChange, {
          readDescriptor(descriptor) {
            const source = readFileSync(descriptor, "utf8");
            rmSync(replacedPath);
            writeFileSync(replacedPath, "# Substituído\n", "utf8");
            return source;
          },
        }),
      ).toThrow("mudou durante a leitura");

      const mutatedRepository = createRepository("mutated-during-read");
      const mutatedChange = change("2026-08-10-mutated.md");
      const mutatedPath = join(mutatedRepository, mutatedChange.path);
      writeFileSync(mutatedPath, "# Original\n", "utf8");
      expect(() =>
        readAddedChangeRecord(mutatedRepository, mutatedChange, {
          readDescriptor(descriptor) {
            const source = readFileSync(descriptor, "utf8");
            writeFileSync(mutatedPath, "# Conteúdo alterado no mesmo inode\n", "utf8");
            return source;
          },
        }),
      ).toThrow("mudou durante a leitura");

      const swappedAncestorRepository = createRepository("ancestor-swapped-during-read");
      const swappedAncestorChange = change("2026-08-10-swapped-ancestor.md");
      const changesDirectory = join(swappedAncestorRepository, "docs/changes");
      const movedChangesDirectory = join(swappedAncestorRepository, "moved-changes");
      writeFileSync(
        join(swappedAncestorRepository, swappedAncestorChange.path),
        "# Ancestral original\n",
        "utf8",
      );
      if (process.platform === "win32") {
        let renameFailure;
        expect(
          readAddedChangeRecord(swappedAncestorRepository, swappedAncestorChange, {
            readDescriptor(descriptor) {
              const source = readFileSync(descriptor, "utf8");
              try {
                renameSync(changesDirectory, movedChangesDirectory);
              } catch (error) {
                renameFailure = error;
              }
              return source;
            },
          }),
        ).toBe("# Ancestral original\n");
        expect(renameFailure).toMatchObject({ code: "EPERM" });
        expect(readFileSync(join(changesDirectory, "2026-08-10-swapped-ancestor.md"), "utf8")).toBe(
          "# Ancestral original\n",
        );
      } else {
        expect(() =>
          readAddedChangeRecord(swappedAncestorRepository, swappedAncestorChange, {
            readDescriptor(descriptor) {
              const source = readFileSync(descriptor, "utf8");
              renameSync(changesDirectory, movedChangesDirectory);
              createDirectoryLink(movedChangesDirectory, changesDirectory);
              return source;
            },
          }),
        ).toThrow("caminho do arquivo mudou durante a leitura");
      }
    } finally {
      rmSync(testRoot, { force: true, recursive: true });
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
      if (process.platform === "win32") {
        writeFileSync(join(repository, "docs/contracts/linked.json"), "target.json", "utf8");
      } else {
        symlinkSync("target.json", join(repository, "docs/contracts/linked.json"));
      }
      git("add", "docs");
      if (process.platform === "win32") {
        stageGitSymbolicLink(repository, "docs/contracts/linked.json", "target.json");
      }
      git("commit", "-m", "main history");
      const mainRevision = git("rev-parse", "HEAD").trim();

      git("switch", "--create", "feature");
      const freshFeatureChanges = readGitChanges(repository);
      expect(freshFeatureChanges.comparisonBase).toBe(mainRevision);
      expect(freshFeatureChanges.changes.filter(isAddedChangeRecord)).toEqual([]);

      rmSync(join(repository, "docs/contracts/regular.json"));
      if (process.platform === "win32") {
        writeFileSync(join(repository, "docs/contracts/regular.json"), "target.json", "utf8");
        stageGitSymbolicLink(repository, "docs/contracts/regular.json", "target.json");
      } else {
        symlinkSync("target.json", join(repository, "docs/contracts/regular.json"));
      }
      rmSync(join(repository, "docs/contracts/linked.json"));
      writeFileSync(join(repository, "docs/contracts/linked.json"), '{"linked":false}\n', "utf8");
      if (process.platform === "win32") {
        stageGitRegularFile(repository, "docs/contracts/linked.json", '{"linked":false}\n');
      }

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
    const externalDirectory = join(testRoot, "external-contracts");
    const externalTarget =
      process.platform === "win32"
        ? join(externalDirectory, "config.json")
        : join(testRoot, "external.json");
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
      createDirectoryLink(join(projectRoot, "node_modules"), join(repository, "node_modules"));
      writeFileSync(join(repository, ".gitignore"), "/node_modules\n", "utf8");
      writeFileSync(join(repository, "docs/contracts/config.json"), '{"local":true}\n', "utf8");
      if (process.platform === "win32") {
        mkdirSync(externalDirectory);
      }
      writeFileSync(externalTarget, '{"external":"preserve exactly"}\n', "utf8");

      git("init", "--initial-branch", "main");
      git("config", "user.email", "qa@set-livre.local");
      git("config", "user.name", "Set Livre QA");
      git("add", ".gitignore", "docs", "scripts");
      git("commit", "-m", "baseline");
      git("switch", "--create", "feature");
      if (process.platform === "win32") {
        rmSync(join(repository, "docs/contracts"), { recursive: true });
        createDirectoryLink(externalDirectory, join(repository, "docs/contracts"));
      } else {
        rmSync(join(repository, "docs/contracts/config.json"));
        symlinkSync(externalTarget, join(repository, "docs/contracts/config.json"));
      }

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

      if (process.platform === "win32") {
        rmSync(join(repository, "docs/contracts"));
        mkdirSync(join(repository, "docs/contracts"));
      } else {
        rmSync(join(repository, "docs/contracts/config.json"));
      }
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

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  collectMatches,
  findDuplicates,
  gitChangedFileArgumentLists,
  isAddedChangeRecord,
  isTechnicalChangePath,
  parseGitChanges,
  parseNormativeIntegrationPairs,
  parseOpenPendingFeaturePairs,
  parsePendingRows,
  parseFeatureReferences,
  parseQaRows,
  readGitChanges,
  sha256,
  validateFeatureSequence,
  validateGovernanceAlignment,
} from "../../scripts/docs-check-core.mjs";

describe("docs check core", () => {
  it("finds duplicate identifiers deterministically", () => {
    expect(findDuplicates(["A", "B", "A", "C", "B", "A"])).toEqual(["A", "B"]);
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
          argumentList.includes("--name-status") && argumentList.includes("--diff-filter=ACMRD"),
      ),
    ).toBe(true);

    const parsedChanges = parseGitChanges(
      "M\0docs/changes/2026-08-09-existing.md\0A\0docs/changes/2026-08-09-new.md\0D\0deleted.ts\0R100\0old.ts\0new.ts\0",
    );
    expect(parsedChanges).toEqual([
      { path: "docs/changes/2026-08-09-existing.md", status: "M" },
      { path: "docs/changes/2026-08-09-new.md", status: "A" },
      { path: "deleted.ts", status: "D" },
      { path: "old.ts", status: "R" },
      { path: "new.ts", status: "R" },
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

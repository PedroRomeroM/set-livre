import { describe, expect, it } from "vitest";

import {
  collectMatches,
  findDuplicates,
  gitChangedFileArgumentLists,
  parseNormativeIntegrationPairs,
  parseOpenPendingFeaturePairs,
  parsePendingRows,
  parseFeatureReferences,
  parseQaRows,
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

  it("includes deleted files in every Git diff used by the documentation gate", () => {
    const diffArguments = gitChangedFileArgumentLists().filter(([command]) => command === "diff");

    expect(diffArguments).toHaveLength(3);
    expect(
      diffArguments.every((argumentList) => argumentList.includes("--diff-filter=ACMRD")),
    ).toBe(true);
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

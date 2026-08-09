import { createHash } from "node:crypto";

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

export function gitChangedFileArgumentLists() {
  return [
    ["diff", "--name-only", "-z", "--diff-filter=ACMRD", "origin/main...HEAD"],
    ["diff", "--name-only", "-z", "--diff-filter=ACMRD"],
    ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMRD"],
    ["ls-files", "--others", "--exclude-standard", "-z"],
  ];
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

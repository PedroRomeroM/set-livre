import ts from "typescript";

const scenarioPattern = /^(SL-F\d{3}-(?:E2E|CACHE)-\d{3})\b/u;

export function inspectScenarioCoverage({
  declaredSpecs,
  implementedScenarioOwner,
  plannedScenarios,
  prefix,
}) {
  const planned = new Set(plannedScenarios);
  const implemented = [...implementedScenarioOwner.keys()].filter((scenario) =>
    scenario.startsWith(prefix),
  );
  return {
    misplaced: [...planned]
      .map((scenario) => ({ path: implementedScenarioOwner.get(scenario), scenario }))
      .filter(({ path }) => path !== undefined && !declaredSpecs.has(path)),
    missing: [...planned].filter((scenario) => !implementedScenarioOwner.has(scenario)),
    unplanned: implemented.filter((scenario) => !planned.has(scenario)),
  };
}

function expressionPath(expression) {
  if (ts.isIdentifier(expression)) return [expression.text];
  if (ts.isPropertyAccessExpression(expression)) {
    const parent = expressionPath(expression.expression);
    return parent === undefined ? undefined : [...parent, expression.name.text];
  }
  if (
    ts.isElementAccessExpression(expression) &&
    expression.argumentExpression !== undefined &&
    ts.isStringLiteralLike(expression.argumentExpression)
  ) {
    const parent = expressionPath(expression.expression);
    return parent === undefined ? undefined : [...parent, expression.argumentExpression.text];
  }
  return undefined;
}

function prohibitedPlaywrightModifier(expression) {
  const path = expressionPath(expression);
  if (path?.[0] !== "test") return undefined;
  const modifier = path.at(-1);
  if (modifier !== "only" && modifier !== "skip") return undefined;
  if (path.length === 2 || (path.length === 3 && path[1] === "describe")) return modifier;
  return undefined;
}

export function inspectPlaywrightSource(source, fileName = "playwright.spec.ts") {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const prohibited = new Set();
  const scenarios = [];

  function visit(node) {
    if (ts.isCallExpression(node)) {
      const modifier = prohibitedPlaywrightModifier(node.expression);
      if (modifier !== undefined) prohibited.add(`.${modifier}`);
      if (expressionPath(node.expression)?.at(-1) === "waitForTimeout") {
        prohibited.add("waitForTimeout");
      }

      if (ts.isIdentifier(node.expression) && node.expression.text === "test") {
        const title = node.arguments[0];
        if (title !== undefined && ts.isStringLiteralLike(title)) {
          const scenario = scenarioPattern.exec(title.text)?.[1];
          if (scenario !== undefined) scenarios.push(scenario);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { prohibited: [...prohibited], scenarios };
}

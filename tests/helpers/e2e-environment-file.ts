import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function parseStrictEnvironment(source: string) {
  const environment: Record<string, string> = {};
  for (const line of source.split(/\r?\n/u)) {
    if (line === "") continue;
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=([^\s'"]+)$/u.exec(line);
    const name = assignment?.[1];
    const value = assignment?.[2];
    if (name === undefined || value === undefined || Object.hasOwn(environment, name)) {
      throw new Error("Atribuição E2E inválida.");
    }
    environment[name] = value;
  }
  return environment;
}

export function readOptionalE2EEnvironmentFile(repositoryRoot: string) {
  let source: string;
  try {
    source = readFileSync(resolve(repositoryRoot, ".env.e2e.local"), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw new Error("Não foi possível ler o ambiente E2E local.", { cause: error });
  }

  try {
    return parseStrictEnvironment(source);
  } catch (error) {
    throw new Error("Não foi possível interpretar o ambiente E2E local.", { cause: error });
  }
}

export function localE2EEnvironmentValue(
  localEnvironment: Readonly<Record<string, string>>,
  inheritedEnvironment: Readonly<Record<string, string | undefined>>,
  name: string,
) {
  return localEnvironment[name] ?? inheritedEnvironment[name];
}

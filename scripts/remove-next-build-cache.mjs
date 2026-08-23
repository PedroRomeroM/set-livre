import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { removePhysicalTree } from "./physical-tree-removal.mjs";

const defaultRepositoryRoot = resolve(import.meta.dirname, "..");

export function resolveAuthorizedNextApplicationRoot({
  applicationRoot = process.cwd(),
  repositoryRoot = defaultRepositoryRoot,
} = {}) {
  const resolvedRepositoryRoot = resolve(repositoryRoot);
  const resolvedApplicationRoot = resolve(applicationRoot);
  const allowedApplicationRoots = new Set([
    resolvedRepositoryRoot,
    resolve(resolvedRepositoryRoot, "apps/backoffice"),
  ]);

  if (!allowedApplicationRoots.has(resolvedApplicationRoot)) {
    throw new Error("A limpeza de cache Next foi recusada fora das aplicações autorizadas.");
  }

  return { applicationRoot: resolvedApplicationRoot, repositoryRoot: resolvedRepositoryRoot };
}

export function removeNextBuildCache({
  applicationRoot = process.cwd(),
  filesystemSecurityOptions,
  removeTree = removePhysicalTree,
  repositoryRoot = defaultRepositoryRoot,
} = {}) {
  const { applicationRoot: resolvedApplicationRoot } = resolveAuthorizedNextApplicationRoot({
    applicationRoot,
    repositoryRoot,
  });
  const cachePath = resolve(resolvedApplicationRoot, ".next/cache");

  removeTree(cachePath, {
    ...filesystemSecurityOptions,
    authorizedWindowsPaths: [cachePath],
    description: "O cache transitório do build Next",
    messages: {
      directoryRequiredMessage: "O cache do build Next precisa ser uma árvore física.",
      mountDetectedMessage: "O cache do build Next não pode conter mounts.",
      mountUnverifiedMessage: "Não foi possível comprovar a ausência de mounts no cache Next.",
      unsupportedPlatformMessage:
        "O cache do build Next precisa ser removido em um host Linux antes do empacotamento.",
      windowsUnauthorizedPathMessage:
        "A limpeza de cache Next foi recusada fora do alvo Windows autorizado.",
    },
    retiredNamePrefix: `.cache.build-retired-${process.pid}-`,
  });
}

const executedPath = process.argv[1];
if (executedPath !== undefined && pathToFileURL(resolve(executedPath)).href === import.meta.url) {
  try {
    if (process.argv.length !== 2) {
      throw new Error("A limpeza de cache Next não aceita argumentos.");
    }
    removeNextBuildCache();
  } catch {
    process.stderr.write("O cache transitório do build Next não pôde ser removido.\n");
    process.exitCode = 1;
  }
}

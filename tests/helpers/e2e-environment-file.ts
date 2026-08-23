import { resolve } from "node:path";
import { parseEnv } from "node:util";

import type { PrivatePhysicalFileReadOptions } from "../../scripts/physical-tree-removal.d.mts";
import { readPrivatePhysicalFile } from "../../scripts/physical-tree-removal.mjs";

type E2EEnvironmentFileOptions = Pick<
  PrivatePhysicalFileReadOptions,
  | "assertWindowsPath"
  | "assertWindowsPrivate"
  | "expectedPosixUserId"
  | "platform"
  | "readDescriptor"
>;

export function readOptionalE2EEnvironmentFile(
  repositoryRoot: string,
  options: E2EEnvironmentFileOptions = {},
) {
  let source: string | undefined;
  try {
    source = readPrivatePhysicalFile(resolve(repositoryRoot, ".env.e2e.local"), {
      allowMissing: true,
      description: "O ambiente E2E local",
      ...options,
    });
  } catch {
    throw new Error(
      "O ambiente E2E local precisa ser um arquivo regular exclusivo, permanecer sob ancestrais físicos e, em sistemas POSIX, pertencer ao usuário efetivo e usar modo 0600; no Windows, precisa pertencer ao usuário atual e usar DACL privada protegida.",
    );
  }

  if (source === undefined) {
    return {};
  }

  try {
    return parseEnv(source);
  } catch {
    throw new Error("Não foi possível interpretar o ambiente E2E local com segurança.");
  }
}

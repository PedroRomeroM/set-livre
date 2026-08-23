import type {
  WindowsPathWithoutReparseAsserter,
  WindowsPrivateFileAsserter,
} from "./windows-filesystem-security.d.mts";

export type PrivatePhysicalFileReadOptions = {
  allowMissing?: boolean;
  assertWindowsPath?: WindowsPathWithoutReparseAsserter;
  assertWindowsPrivate?: WindowsPrivateFileAsserter;
  description?: string;
  expectedPosixUserId?: number;
  platform?: NodeJS.Platform;
  readDescriptor?: (descriptor: number) => string;
};

/** @public Runtime implementado pelo módulo ESM homônimo. */
export declare function readPrivatePhysicalFile(
  filePath: string,
  options?: PrivatePhysicalFileReadOptions,
): string | undefined;

import type { spawnSync } from "node:child_process";

/** @public */
export type WindowsFilesystemSecurityRequest = {
  action: "assert-path" | "assert-private-file" | "protect-private-file";
  allowMissingLeaf?: boolean;
  leafKind?: "any" | "directory" | "file";
  path: string;
  recursive?: boolean;
  trustedRoot?: string;
};

/** @public */
export type WindowsFilesystemSecurityCommandRunner = (
  request: WindowsFilesystemSecurityRequest,
) => void;

export type WindowsPathWithoutReparseAsserter = (
  path: string,
  options?: {
    allowMissingLeaf?: boolean;
    description?: string;
    leafKind?: "any" | "directory" | "file";
    recursive?: boolean;
  },
) => void;

export type WindowsPrivateFileAsserter = (
  path: string,
  options?: {
    allowMissing?: boolean;
    description?: string;
    trustedRoot?: string;
  },
) => void;

/** @public */
export declare function runWindowsFilesystemSecurityCommand(
  request: WindowsFilesystemSecurityRequest,
  options?: {
    execute?: typeof spawnSync;
    resolvePowerShell?: (systemRoot: string | undefined) => string;
    systemRoot?: string;
  },
): void;

/** @public */
export declare function assertWindowsPathWithoutReparse(
  path: string,
  options?: {
    allowMissingLeaf?: boolean;
    description?: string;
    leafKind?: "any" | "directory" | "file";
    recursive?: boolean;
    runCommand?: WindowsFilesystemSecurityCommandRunner;
  },
): void;

/** @public */
export declare function assertWindowsPrivateFile(
  path: string,
  options?: {
    allowMissing?: boolean;
    description?: string;
    runCommand?: WindowsFilesystemSecurityCommandRunner;
    trustedRoot?: string;
  },
): void;

/** @public */
export declare function protectWindowsPrivateFile(
  path: string,
  options?: {
    description?: string;
    runCommand?: WindowsFilesystemSecurityCommandRunner;
    trustedRoot?: string;
  },
): void;

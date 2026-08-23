import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

function detectFileSymbolicLinkSupport() {
  const root = mkdtempSync(resolve(tmpdir(), "set-livre-file-symlink-capability-"));
  const target = resolve(root, "target.txt");
  const symbolic = resolve(root, "symbolic.txt");

  try {
    writeFileSync(target, "capability probe\n", "utf8");
    symlinkSync(target, symbolic);
    return true;
  } catch (error) {
    if (
      process.platform === "win32" &&
      error instanceof Error &&
      "code" in error &&
      ["EACCES", "EINVAL", "ENOSYS", "ENOTSUP", "EPERM", "UNKNOWN"].includes(error.code)
    ) {
      return false;
    }
    throw error;
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

export const directorySymbolicLinkType = process.platform === "win32" ? "junction" : "dir";
export const fileSymbolicLinksSupported = detectFileSymbolicLinkSupport();

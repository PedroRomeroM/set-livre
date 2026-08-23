import { describe, expect, it, vi } from "vitest";

import {
  installPlaywrightBrowsers,
  playwrightBrowserInstallArguments,
} from "../../scripts/install-playwright-browsers.mjs";

describe("Playwright browser installation", () => {
  it("does not request Linux system dependency installation on Windows", () => {
    expect(playwrightBrowserInstallArguments("win32")).toEqual([
      "install",
      "chromium",
      "firefox",
      "webkit",
    ]);
    expect(playwrightBrowserInstallArguments("linux")).toEqual([
      "install",
      "--with-deps",
      "chromium",
      "firefox",
      "webkit",
    ]);
  });

  it.each(["darwin", "freebsd", "aix"])(
    "rejects the unsupported %s platform before validation or execution",
    (platform) => {
      const executeCommand = vi.fn();
      const validateCli = vi.fn();

      expect(() => playwrightBrowserInstallArguments(platform)).toThrow(
        `não suporta a plataforma ${platform}`,
      );
      expect(() => installPlaywrightBrowsers({ executeCommand, platform, validateCli })).toThrow(
        `não suporta a plataforma ${platform}`,
      );
      expect(validateCli).not.toHaveBeenCalled();
      expect(executeCommand).not.toHaveBeenCalled();
    },
  );

  it("executes the repository-local CLI with Node and strips loader overrides", () => {
    let invocation;
    const environment = {
      ComSpec: "C:\\attacker\\cmd.exe",
      nOdE_oPtIoNs: "--require=C:\\attacker\\loader.cjs",
      node_path: "C:\\attacker\\modules",
      Path: "C:\\Program Files\\nodejs;;C:\\Windows\\System32",
      PLAYWRIGHT_DOWNLOAD_HOST: "https://attacker.invalid",
    };
    installPlaywrightBrowsers({
      environment,
      executeCommand(command, argumentsList, options) {
        invocation = { argumentsList, command, options };
      },
      platform: "win32",
      validateCli: () => {},
    });

    expect(invocation.command).toBe(process.execPath);
    expect(invocation.argumentsList[0]).toMatch(
      /node_modules[\\/]@playwright[\\/]test[\\/]cli\.js$/u,
    );
    expect(invocation.argumentsList.slice(1)).toEqual(["install", "chromium", "firefox", "webkit"]);
    expect(invocation.options.env).toEqual({
      PATH: "C:\\Program Files\\nodejs;C:\\Windows\\System32",
    });
    expect(invocation.options.stdio).toBe("inherit");
    expect(JSON.stringify(invocation.options.env)).not.toMatch(/attacker|PLAYWRIGHT_DOWNLOAD/u);
    expect(environment.nOdE_oPtIoNs).toContain("loader.cjs");
  });
});

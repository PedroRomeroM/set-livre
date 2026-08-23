import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createLocalDevelopmentEnvironment,
  readLocalDevelopmentEnvironmentFile,
  validateLocalDalDatabaseUrl,
} from "../../scripts/local-development-environment.mjs";
import {
  assertWindowsPathWithoutReparse,
  assertWindowsPrivateFile,
  protectWindowsPrivateFile,
  runWindowsFilesystemSecurityCommand,
} from "../../scripts/windows-filesystem-security.mjs";

const localDatabaseUrl =
  "postgresql://app_runtime_local:local-password@127.0.0.1:54322/postgres?options=-c%20role%3Dapp_dal";
const nonLiteralLocalHosts = [
  "localhost",
  "[::1]",
  "[::ffff:127.0.0.1]",
  "127.1",
  "0177.0.0.1",
  "0x7f000001",
  "2130706433",
  "127.000.000.001",
  "127.0.0.1.",
  "127%2e0%2e0%2e1",
  "127。0。0。1",
];
const temporaryRoots = [];
const repositoryRoot = resolve(import.meta.dirname, "../..");
const testTemporaryDirectory = resolve(repositoryRoot, "node_modules/.cache");
const logicalFileSecurity =
  process.platform === "win32"
    ? { assertWindowsPrivate: () => undefined, platform: "win32" }
    : undefined;

function localEnvironment(overrides = {}) {
  return {
    APP_ENV: "local",
    APP_RELEASE_SHA: "local",
    DATABASE_URL_APP_DAL: localDatabaseUrl,
    NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3000",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "web-anon-key",
    NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
    ...overrides,
  };
}

function serializeEnvironment(environment) {
  return `${Object.entries(environment)
    .map(([name, value]) => `${name}=${value}`)
    .join("\n")}\n`;
}

function temporaryRoot() {
  const root = mkdtempSync(resolve(tmpdir(), "set-livre-dev-environment-"));
  temporaryRoots.push(root);
  return root;
}

function repositoryTemporaryRoot() {
  mkdirSync(testTemporaryDirectory, { recursive: true });
  const root = mkdtempSync(resolve(testTemporaryDirectory, "set-livre-dev-environment-"));
  temporaryRoots.push(root);
  return root;
}

function physicalWindowsPath(path) {
  const normalizedPath = path.toLowerCase();
  return {
    isDirectory: () =>
      normalizedPath === "c:\\windows" || normalizedPath === "c:\\windows\\system32",
    isFile: () => normalizedPath === "c:\\windows\\system32\\cmd.exe",
    isSymbolicLink: () => false,
  };
}

function nativeWindowsInheritedEnvironment() {
  return {
    Path: process.env.Path ?? process.env.PATH,
    SystemRoot: process.env.SystemRoot,
  };
}

function grantAuthenticatedUsersModify(path) {
  const systemRoot = process.env.SystemRoot;
  if (typeof systemRoot !== "string" || systemRoot === "") {
    throw new Error("SystemRoot não está disponível para o teste Windows nativo.");
  }
  execFileSync(resolve(systemRoot, "System32/icacls.exe"), [path, "/grant", "*S-1-5-11:(OI)(CI)M"]);
}

function writePrivateFile(path, contents) {
  writeFileSync(path, contents, { mode: 0o600 });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("local development child environment", () => {
  it("uses the app-local runtime allowlist instead of inherited cloud or secret values", () => {
    const environment = createLocalDevelopmentEnvironment(
      {
        APP_ENV: "production",
        APP_RELEASE_SHA: "a".repeat(40),
        DATABASE_URL_APP_DAL: "postgresql://cloud:secret@database.example.com:5432/production",
        E2E_DATABASE_URL: "postgresql://postgres:secret@127.0.0.1:54322/postgres",
        GIT_CONFIG_COUNT: "1",
        HOME: "/home/tester",
        LC_ALL: "C.UTF-8",
        LC_API_TOKEN: "locale-lookalike-secret",
        LD_PRELOAD: "/tmp/inject.so",
        NEXT_PUBLIC_APP_URL: "https://production.example.com",
        NEXT_PUBLIC_SUPABASE_URL: "https://cloud.supabase.co",
        NODE_OPTIONS: "--require=/tmp/inject.cjs",
        NPM_CONFIG_GLOBALCONFIG: "/tmp/hostile-global.npmrc",
        NPM_CONFIG_USERCONFIG: "/tmp/hostile-user.npmrc",
        PATH: ":/usr/local/bin::/usr/bin:",
        PGPASSWORD: "admin-secret",
        SSH_AUTH_SOCK: "/run/user/1000/agent.sock",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
        npm_config__authToken: "registry-secret",
        npm_config_script_shell: "/tmp/hostile-shell",
      },
      localEnvironment(),
      "http://127.0.0.1:3000",
      { platform: "linux" },
    );

    expect(environment).toEqual({
      APP_ENV: "local",
      APP_RELEASE_SHA: "local",
      DATABASE_URL_APP_DAL: localDatabaseUrl,
      HOME: "/home/tester",
      LC_ALL: "C.UTF-8",
      NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3000",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "web-anon-key",
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
      PATH: "/usr/local/bin:/usr/bin",
    });
    expect(JSON.stringify(environment)).not.toContain("database.example.com");
    expect(JSON.stringify(environment)).not.toContain("cloud.supabase.co");
    expect(JSON.stringify(environment)).not.toContain("hostile-global.npmrc");
    expect(JSON.stringify(environment)).not.toContain("hostile-user.npmrc");
    expect(JSON.stringify(environment)).not.toContain("hostile-shell");
  });

  it("keeps the public and backoffice local environments separate", () => {
    const web = createLocalDevelopmentEnvironment(
      { PATH: "/usr/bin" },
      localEnvironment(),
      "http://127.0.0.1:3000",
      { platform: "linux" },
    );
    const backoffice = createLocalDevelopmentEnvironment(
      { PATH: "/usr/bin" },
      localEnvironment({
        NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3001",
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "backoffice-anon-key",
      }),
      "http://127.0.0.1:3001",
      { platform: "linux" },
    );

    expect(web.NEXT_PUBLIC_APP_URL).toBe("http://127.0.0.1:3000");
    expect(web.NEXT_PUBLIC_SUPABASE_ANON_KEY).toBe("web-anon-key");
    expect(backoffice.NEXT_PUBLIC_APP_URL).toBe("http://127.0.0.1:3001");
    expect(backoffice.NEXT_PUBLIC_SUPABASE_ANON_KEY).toBe("backoffice-anon-key");
  });

  it("rebuilds the Windows environment case-insensitively and derives the physical ComSpec", () => {
    const environment = createLocalDevelopmentEnvironment(
      {
        COMSPEC: "C:\\attacker\\cmd.exe",
        Path: "C:\\Windows\\System32;C:\\Program Files\\nodejs",
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        SystemRoot: "C:\\Windows",
        TEMP: "C:\\Users\\tester\\AppData\\Local\\Temp",
        USERPROFILE: "C:\\Users\\tester",
      },
      localEnvironment(),
      "http://127.0.0.1:3000",
      { inspectPhysicalPath: physicalWindowsPath, platform: "win32" },
    );

    expect(environment).toMatchObject({
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      PATH: "C:\\Windows\\System32;C:\\Program Files\\nodejs",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      SystemRoot: "C:\\Windows",
      TEMP: "C:\\Users\\tester\\AppData\\Local\\Temp",
      USERPROFILE: "C:\\Users\\tester",
      WINDIR: "C:\\Windows",
    });
    expect(environment).not.toHaveProperty("COMSPEC");
    expect(JSON.stringify(environment)).not.toContain("attacker");
  });

  it.each([
    [{ PATH: "C:\\trusted", Path: "C:\\trusted" }, "PATH"],
    [{ PATH: "C:\\trusted", Path: "C:\\hostile" }, "PATH"],
    [{ SYSTEMROOT: "C:\\Windows", SystemRoot: "C:\\Windows" }, "SystemRoot"],
  ])("rejects duplicate Windows casing variants for %s", (variants, expectedName) => {
    expect(() =>
      createLocalDevelopmentEnvironment(
        {
          Path: "C:\\Windows\\System32",
          SystemRoot: "C:\\Windows",
          ...variants,
        },
        localEnvironment(),
        "http://127.0.0.1:3000",
        { inspectPhysicalPath: physicalWindowsPath, platform: "win32" },
      ),
    ).toThrow(`variantes duplicadas de ${expectedName}`);
  });

  it("rejects a non-physical SystemRoot or command processor", () => {
    expect(() =>
      createLocalDevelopmentEnvironment(
        { Path: "C:\\Windows\\System32", SystemRoot: "C:\\Windows" },
        localEnvironment(),
        "http://127.0.0.1:3000",
        {
          inspectPhysicalPath: (path) => ({
            ...physicalWindowsPath(path),
            isSymbolicLink: () => path.toLowerCase().endsWith("cmd.exe"),
          }),
          platform: "win32",
        },
      ),
    ).toThrow("executável físico regular");
  });

  it("rejects every tested deviation from the local DAL identity contract", () => {
    expect(() =>
      validateLocalDalDatabaseUrl(
        "postgresql://app_runtime_local:secret@database.example.com:54322/postgres?options=-c%20role%3Dapp_dal",
      ),
    ).toThrow("host IPv4 literal 127.0.0.1");

    for (const value of [
      "postgresql://app_runtime_local:secret@127.0.0.1:5432/postgres?options=-c%20role%3Dapp_dal",
      "postgresql://postgres:secret@127.0.0.1:54322/postgres?options=-c%20role%3Dapp_dal",
      "postgresql://app_runtime_local@127.0.0.1:54322/postgres?options=-c%20role%3Dapp_dal",
      "postgresql://app_runtime_local:secret@127.0.0.1:54322/postgres?options=-c%20role%3Dpostgres",
      `${localDatabaseUrl}&sslmode=require`,
      "https://app_runtime_local:secret@127.0.0.1:54322/postgres?options=-c%20role%3Dapp_dal",
    ]) {
      expect(() => validateLocalDalDatabaseUrl(value)).toThrow("Supabase local");
    }
    expect(validateLocalDalDatabaseUrl(localDatabaseUrl)).toBe(localDatabaseUrl);
  });

  it.each(nonLiteralLocalHosts)(
    "rejects the non-literal local host representation %s in every runtime URL",
    (host) => {
      const databaseUrl = `postgresql://app_runtime_local:secret@${host}:54322/postgres?options=-c%20role%3Dapp_dal`;
      const applicationUrl = `http://${host}:3000`;
      const supabaseUrl = `http://${host}:54321`;

      expect(() => validateLocalDalDatabaseUrl(databaseUrl)).toThrow("host IPv4 literal 127.0.0.1");
      expect(() =>
        createLocalDevelopmentEnvironment(
          { PATH: "/usr/bin" },
          localEnvironment({ NEXT_PUBLIC_APP_URL: applicationUrl }),
          "http://127.0.0.1:3000",
          { platform: "linux" },
        ),
      ).toThrow("host IPv4 literal 127.0.0.1");
      expect(() =>
        createLocalDevelopmentEnvironment(
          { PATH: "/usr/bin" },
          localEnvironment({ NEXT_PUBLIC_SUPABASE_URL: supabaseUrl }),
          "http://127.0.0.1:3000",
          { platform: "linux" },
        ),
      ).toThrow("host IPv4 literal 127.0.0.1");
    },
  );

  it("rejects non-local app, release and Supabase contracts before spawn", () => {
    for (const [local, expectedApplicationUrl] of [
      [localEnvironment({ APP_ENV: "production" }), "http://127.0.0.1:3000"],
      [localEnvironment({ APP_RELEASE_SHA: "a".repeat(40) }), "http://127.0.0.1:3000"],
      [
        localEnvironment({ NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co" }),
        "http://127.0.0.1:3000",
      ],
      [
        localEnvironment({ NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321/rest/v1" }),
        "http://127.0.0.1:3000",
      ],
      [
        localEnvironment({ NEXT_PUBLIC_APP_URL: "https://set-livre.example.com" }),
        "http://127.0.0.1:3000",
      ],
      [localEnvironment({ NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3001" }), "http://127.0.0.1:3000"],
    ]) {
      expect(() =>
        createLocalDevelopmentEnvironment({ PATH: "/usr/bin" }, local, expectedApplicationUrl, {
          platform: "linux",
        }),
      ).toThrow();
    }
  });

  it("never falls back to an inherited database URL", () => {
    const local = localEnvironment();
    delete local.DATABASE_URL_APP_DAL;

    expect(() =>
      createLocalDevelopmentEnvironment(
        { DATABASE_URL_APP_DAL: localDatabaseUrl, PATH: "/usr/bin" },
        local,
        "http://127.0.0.1:3000",
        { platform: "linux" },
      ),
    ).toThrow("DATABASE_URL_APP_DAL");
  });

  it("rejects unexpected runtime names", () => {
    expect(() =>
      createLocalDevelopmentEnvironment(
        { PATH: "/usr/bin" },
        localEnvironment({ NODE_OPTIONS: "--require=/tmp/inject.cjs" }),
        "http://127.0.0.1:3000",
        { platform: "linux" },
      ),
    ).toThrow("NODE_OPTIONS");
  });

  it("reads a physical file without mutating the parent process environment", () => {
    const root = temporaryRoot();
    const environmentPath = resolve(root, ".env.local");
    const originalDatabaseUrl = process.env.DATABASE_URL_APP_DAL;
    writePrivateFile(environmentPath, serializeEnvironment(localEnvironment()));

    const childEnvironment = readLocalDevelopmentEnvironmentFile(
      environmentPath,
      {
        DATABASE_URL_APP_DAL: "postgresql://cloud:secret@database.example.com:5432/production",
        PATH: "/usr/bin",
      },
      "http://127.0.0.1:3000",
      { ...logicalFileSecurity, trustedRoot: root },
      { platform: "linux" },
    );

    expect(childEnvironment.DATABASE_URL_APP_DAL).toBe(localDatabaseUrl);
    expect(process.env.DATABASE_URL_APP_DAL).toBe(originalDatabaseUrl);
  });

  it.runIf(process.platform === "win32")(
    "rejects a broad Windows DACL before parsing and accepts the protected equivalent",
    () => {
      const root = repositoryTemporaryRoot();
      const environmentPath = resolve(root, ".env.local");
      const contents = serializeEnvironment(localEnvironment());
      writeFileSync(environmentPath, contents, "utf8");

      expect(() =>
        readLocalDevelopmentEnvironmentFile(
          environmentPath,
          nativeWindowsInheritedEnvironment(),
          "http://127.0.0.1:3000",
          { trustedRoot: repositoryRoot },
          { platform: "win32" },
        ),
      ).toThrow("DACL protegida");

      protectWindowsPrivateFile(environmentPath, { trustedRoot: repositoryRoot });
      expect(() =>
        assertWindowsPrivateFile(environmentPath, { trustedRoot: repositoryRoot }),
      ).not.toThrow();
      expect(
        readLocalDevelopmentEnvironmentFile(
          environmentPath,
          nativeWindowsInheritedEnvironment(),
          "http://127.0.0.1:3000",
          { trustedRoot: repositoryRoot },
          { platform: "win32" },
        ).DATABASE_URL_APP_DAL,
      ).toBe(localDatabaseUrl);
    },
    20_000,
  );

  it.runIf(process.platform === "win32")(
    "rejects an untrusted writable ancestor before reading the environment",
    () => {
      const root = repositoryTemporaryRoot();
      const parent = resolve(root, "application");
      const environmentPath = resolve(parent, ".env.local");
      const contents = serializeEnvironment(localEnvironment());
      mkdirSync(parent);
      writeFileSync(environmentPath, contents, "utf8");
      protectWindowsPrivateFile(environmentPath, { trustedRoot: repositoryRoot });
      grantAuthenticatedUsersModify(parent);

      expect(() =>
        readLocalDevelopmentEnvironmentFile(
          environmentPath,
          nativeWindowsInheritedEnvironment(),
          "http://127.0.0.1:3000",
          { trustedRoot: repositoryRoot },
          { platform: "win32" },
        ),
      ).toThrow("ancestrais Windows confiáveis");
      expect(readFileSync(environmentPath, "utf8")).toBe(contents);
    },
    20_000,
  );

  it.runIf(process.platform === "win32")(
    "requires the declared checkout root to establish a protected DACL boundary",
    () => {
      const unprotectedRoot = repositoryTemporaryRoot();
      const environmentPath = resolve(unprotectedRoot, ".env.local");
      writeFileSync(environmentPath, serializeEnvironment(localEnvironment()), "utf8");
      protectWindowsPrivateFile(environmentPath);

      expect(() =>
        readLocalDevelopmentEnvironmentFile(
          environmentPath,
          nativeWindowsInheritedEnvironment(),
          "http://127.0.0.1:3000",
          { trustedRoot: unprotectedRoot },
          { platform: "win32" },
        ),
      ).toThrow("ancestrais Windows confiáveis");
    },
    20_000,
  );

  it("bounds every native Windows filesystem inspection", () => {
    let invocation;
    runWindowsFilesystemSecurityCommand(
      { action: "assert-path", path: "C:\\bounded-inspection" },
      {
        execute(command, argumentsList, options) {
          invocation = { argumentsList, command, options };
          return { status: 0, stdout: "ok" };
        },
        resolvePowerShell: () => "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        systemRoot: "C:\\Windows",
      },
    );

    expect(invocation.argumentsList).toContain("-EncodedCommand");
    expect(invocation.argumentsList).not.toContain("-ExecutionPolicy");
    expect(invocation.argumentsList).not.toContain("Bypass");
    expect(invocation.options).toMatchObject({
      env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" },
      killSignal: "SIGKILL",
      shell: false,
      timeout: 30_000,
      windowsHide: true,
    });
  }, 5_000);

  it("passes the unconditional recursive policy to the native Windows inspection", () => {
    let request;
    assertWindowsPathWithoutReparse("C:\\repository\\.next", {
      leafKind: "directory",
      recursive: true,
      runCommand: (value) => {
        request = value;
      },
    });

    expect(request).toEqual({
      action: "assert-path",
      allowMissingLeaf: false,
      leafKind: "directory",
      path: "C:\\repository\\.next",
      recursive: true,
    });
  });

  it("refuses a symlinked or non-regular environment without touching its target", () => {
    const root = temporaryRoot();
    const target = resolve(root, "outside.env");
    const link = resolve(root, ".env.local");
    const directory = resolve(root, "environment-directory");
    const permissive = resolve(root, "permissive.env");
    const contents = serializeEnvironment(localEnvironment());
    if (process.platform === "win32") {
      mkdirSync(target);
      writeFileSync(resolve(target, "marker"), contents, "utf8");
      symlinkSync(target, link, "junction");
    } else {
      writeFileSync(target, contents, "utf8");
      symlinkSync(target, link);
    }
    mkdirSync(directory);
    writeFileSync(permissive, contents, "utf8");

    expect(() =>
      readLocalDevelopmentEnvironmentFile(link, { PATH: "/usr/bin" }, "http://127.0.0.1:3000"),
    ).toThrow("arquivo físico regular");
    expect(() =>
      readLocalDevelopmentEnvironmentFile(directory, { PATH: "/usr/bin" }, "http://127.0.0.1:3000"),
    ).toThrow("arquivo físico regular");
    if (process.platform !== "win32") {
      chmodSync(permissive, 0o640);
      expect(() =>
        readLocalDevelopmentEnvironmentFile(
          permissive,
          { PATH: "/usr/bin" },
          "http://127.0.0.1:3000",
        ),
      ).toThrow("modo 0600");
    }
    expect(
      readFileSync(process.platform === "win32" ? resolve(target, "marker") : target, "utf8"),
    ).toBe(contents);
  });
});

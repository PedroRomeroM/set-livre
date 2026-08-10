import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ensurePhysicalArtifactsRoot,
  environmentWithoutSecrets,
  isSensitiveEnvironmentName,
  operationalEnvironment,
  readReleaseRuntimeEnvironmentFile,
  redactEnvironmentSecrets,
  releaseBuildEnvironment,
  releaseRuntimeEnvironment,
  releaseSmokeEnvironment,
  withExclusiveReleaseLock,
} from "../../scripts/release-guards.mjs";

const temporaryRoots = [];

function temporaryRoot() {
  const root = mkdtempSync(resolve(tmpdir(), "set-livre-release-"));
  temporaryRoots.push(root);
  return root;
}

const localDatabaseUrl =
  "postgresql://app_runtime_local:local-password@127.0.0.1:54322/postgres?options=-c%20role%3Dapp_dal";

function localRuntimeEnvironment(applicationUrl) {
  return [
    "APP_ENV=local",
    "APP_RELEASE_SHA=local",
    `DATABASE_URL_APP_DAL=${localDatabaseUrl}`,
    `NEXT_PUBLIC_APP_URL=${applicationUrl}`,
    "NEXT_PUBLIC_SUPABASE_ANON_KEY=local-anon-key",
    "NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321",
    "",
  ].join("\n");
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("release artifact root guard", () => {
  it("creates a private physical directory directly under the repository", () => {
    const repository = temporaryRoot();
    const artifacts = resolve(repository, ".artifacts");

    expect(ensurePhysicalArtifactsRoot(repository, artifacts)).toBe(artifacts);
    const information = lstatSync(artifacts);
    expect(information.isDirectory()).toBe(true);
    expect(information.isSymbolicLink()).toBe(false);
    expect(information.mode & 0o777).toBe(0o700);

    if (process.platform !== "win32") {
      chmodSync(artifacts, 0o777);
      ensurePhysicalArtifactsRoot(repository, artifacts);
      expect(lstatSync(artifacts).mode & 0o777).toBe(0o700);
    }
  });

  it("rejects an ignored artifact root symlink without touching its target", () => {
    const base = temporaryRoot();
    const repository = resolve(base, "repository");
    const external = resolve(base, "external");
    mkdirSync(repository);
    mkdirSync(external);
    const sentinel = resolve(external, "sentinel.txt");
    writeFileSync(sentinel, "preserve", "utf8");
    symlinkSync(external, resolve(repository, ".artifacts"), "dir");

    expect(() =>
      ensurePhysicalArtifactsRoot(repository, resolve(repository, ".artifacts")),
    ).toThrow("diretório físico regular");
    expect(readFileSync(sentinel, "utf8")).toBe("preserve");
  });

  it("rejects a root that is not a direct repository child", () => {
    const repository = temporaryRoot();
    expect(() =>
      ensurePhysicalArtifactsRoot(repository, resolve(repository, "nested/.artifacts")),
    ).toThrow("filha direta");
  });

  it("rejects a symbolic release lock without touching its target", async () => {
    const base = temporaryRoot();
    const repository = resolve(base, "repository");
    const externalLock = resolve(base, "external.lock");
    mkdirSync(repository);
    const artifacts = resolve(repository, ".artifacts");
    ensurePhysicalArtifactsRoot(repository, artifacts);
    writeFileSync(externalLock, "preserve", "utf8");
    symlinkSync(externalLock, resolve(artifacts, "release.lock"));

    await expect(withExclusiveReleaseLock(artifacts, async () => undefined)).rejects.toThrow(
      "lock físico",
    );
    expect(readFileSync(externalLock, "utf8")).toBe("preserve");
  });
});

describe("release environment isolation", () => {
  it("requires and reads a physical private runtime file through its stable descriptor", () => {
    const root = temporaryRoot();
    const environmentPath = resolve(root, ".env.local");
    writeFileSync(environmentPath, localRuntimeEnvironment("http://127.0.0.1:3000"), {
      mode: 0o600,
    });

    expect(readReleaseRuntimeEnvironmentFile(environmentPath, "http://127.0.0.1:3000")).toEqual({
      APP_ENV: "local",
      APP_RELEASE_SHA: "local",
      DATABASE_URL_APP_DAL: localDatabaseUrl,
      NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3000",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "local-anon-key",
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
    });
    expect(() =>
      readReleaseRuntimeEnvironmentFile(
        resolve(root, "missing.env.local"),
        "http://127.0.0.1:3000",
      ),
    ).toThrow("arquivo físico regular exclusivo");
  });

  it.runIf(process.platform !== "win32")(
    "rejects a readable mode before the release can read the runtime secret",
    () => {
      const root = temporaryRoot();
      const environmentPath = resolve(root, ".env.local");
      let descriptorWasRead = false;
      writeFileSync(environmentPath, localRuntimeEnvironment("http://127.0.0.1:3000"), {
        mode: 0o644,
      });

      expect(() =>
        readReleaseRuntimeEnvironmentFile(environmentPath, "http://127.0.0.1:3000", {
          readDescriptor: () => {
            descriptorWasRead = true;
            return "";
          },
        }),
      ).toThrow("modo 0600");
      expect(descriptorWasRead).toBe(false);
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects symbolic and hard-linked runtime files without reading either target",
    () => {
      const root = temporaryRoot();
      const target = resolve(root, "runtime-target");
      const symbolic = resolve(root, "symbolic.env.local");
      const hardLinked = resolve(root, "hard-linked.env.local");
      let descriptorReads = 0;
      writeFileSync(target, localRuntimeEnvironment("http://127.0.0.1:3000"), { mode: 0o600 });
      symlinkSync(target, symbolic);
      linkSync(target, hardLinked);
      const options = {
        readDescriptor: () => {
          descriptorReads += 1;
          return "";
        },
      };

      expect(() =>
        readReleaseRuntimeEnvironmentFile(symbolic, "http://127.0.0.1:3000", options),
      ).toThrow("arquivo físico regular exclusivo");
      expect(() =>
        readReleaseRuntimeEnvironmentFile(hardLinked, "http://127.0.0.1:3000", options),
      ).toThrow("arquivo físico regular exclusivo");
      expect(descriptorReads).toBe(0);
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a runtime path replaced after opening its physical descriptor",
    () => {
      const root = temporaryRoot();
      const environmentPath = resolve(root, ".env.local");
      const originalPath = resolve(root, "original.env.local");
      const source = localRuntimeEnvironment("http://127.0.0.1:3000");
      writeFileSync(environmentPath, source, { mode: 0o600 });

      expect(() =>
        readReleaseRuntimeEnvironmentFile(environmentPath, "http://127.0.0.1:3000", {
          readDescriptor: (descriptor) => {
            const contents = readFileSync(descriptor, "utf8");
            renameSync(environmentPath, originalPath);
            writeFileSync(environmentPath, source, { mode: 0o600 });
            return contents;
          },
        }),
      ).toThrow("mudou durante a leitura");
    },
  );

  it("classifies administrative and server credentials without treating anon public data as secret", () => {
    expect(isSensitiveEnvironmentName("E2E_DATABASE_MARKER")).toBe(true);
    expect(isSensitiveEnvironmentName("GH_TOKEN")).toBe(true);
    expect(isSensitiveEnvironmentName("npm_config__authToken")).toBe(true);
    expect(isSensitiveEnvironmentName("PGPASSFILE")).toBe(true);
    expect(isSensitiveEnvironmentName("PGPASSWORD")).toBe(true);
    expect(isSensitiveEnvironmentName("SSH_AUTH_SOCK")).toBe(true);
    expect(isSensitiveEnvironmentName("DATABASE_URL_APP_DAL")).toBe(true);
    expect(isSensitiveEnvironmentName("NEXT_PUBLIC_FORBIDDEN_SECRET")).toBe(true);
    expect(isSensitiveEnvironmentName("NEXT_PUBLIC_SUPABASE_ANON_KEY")).toBe(false);
  });

  it("builds each app with its own public environment and blank server secrets", () => {
    const inherited = {
      E2E_DATABASE_URL: "postgresql://admin:admin-secret@127.0.0.1/database",
      GH_TOKEN: "github-secret",
      NEXT_PUBLIC_APP_URL: "https://inherited.invalid",
      PATH: "/usr/bin",
      PGPASSWORD: "postgres-secret",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      npm_config__authToken: "npm-secret",
    };
    const web = releaseBuildEnvironment(
      inherited,
      {
        DATABASE_URL_APP_DAL: "postgresql://web:web-secret@127.0.0.1/database",
        NODE_OPTIONS: "--require=/tmp/untrusted.cjs",
        NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3000",
        npm_config__authToken: "local-npm-secret",
      },
      "a".repeat(40),
    );
    const backoffice = releaseBuildEnvironment(
      inherited,
      {
        DATABASE_URL_APP_DAL: "postgresql://backoffice:backoffice-secret@127.0.0.1/database",
        NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3001",
      },
      "a".repeat(40),
    );

    expect(web.NEXT_PUBLIC_APP_URL).toBe("http://127.0.0.1:3000");
    expect(backoffice.NEXT_PUBLIC_APP_URL).toBe("http://127.0.0.1:3001");
    expect(web.DATABASE_URL_APP_DAL).toBe("");
    expect(backoffice.DATABASE_URL_APP_DAL).toBe("");
    expect(web.E2E_DATABASE_URL).toBe("");
    expect(web.GH_TOKEN).toBeUndefined();
    expect(web.PGPASSWORD).toBe("");
    expect(web.SSH_AUTH_SOCK).toBeUndefined();
    expect(web.npm_config__authToken).toBe("");
    expect(web.NODE_OPTIONS).toBe("");
    expect(web.PATH).toBe("/usr/bin");
  });

  it("limits a runtime child to its app file and explicit overrides", () => {
    const environment = releaseRuntimeEnvironment(
      {
        GH_TOKEN: "github-secret",
        NEXT_PUBLIC_APP_URL: "https://inherited.invalid",
        PATH: "/usr/bin",
        SSH_AUTH_SOCK: "/tmp/agent.sock",
      },
      {
        DATABASE_URL_APP_DAL: "postgresql://app:app-secret@127.0.0.1/database",
        E2E_DATABASE_MARKER: "must-not-leak",
        LD_PRELOAD: "/tmp/untrusted.so",
        NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3001",
        TAR_OPTIONS: "--checkpoint-action=exec=/tmp/untrusted",
      },
      { APP_RELEASE_SHA: "b".repeat(40), PORT: "4101" },
    );

    expect(environment).toMatchObject({
      APP_RELEASE_SHA: "b".repeat(40),
      DATABASE_URL_APP_DAL: "postgresql://app:app-secret@127.0.0.1/database",
      NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3001",
      PATH: "/usr/bin",
      PORT: "4101",
    });
    expect(environment).not.toHaveProperty("E2E_DATABASE_MARKER");
    expect(environment).not.toHaveProperty("GH_TOKEN");
    expect(environment).not.toHaveProperty("SSH_AUTH_SOCK");
    expect(environment).not.toHaveProperty("LD_PRELOAD");
    expect(environment).not.toHaveProperty("TAR_OPTIONS");
  });

  it("uses the validated local DAL URL even when the inherited environment points remotely", () => {
    const localDatabaseUrl =
      "postgresql://app_runtime_local:local-password@127.0.0.1:54322/postgres?options=-c%20role%3Dapp_dal";
    const environment = releaseSmokeEnvironment(
      {
        DATABASE_URL_APP_DAL: "postgresql://remote:secret@database.example.com/production",
        PATH: "/usr/bin",
      },
      { DATABASE_URL_APP_DAL: localDatabaseUrl },
      { APP_RELEASE_SHA: "c".repeat(40), PORT: "4100" },
    );

    expect(environment.DATABASE_URL_APP_DAL).toBe(localDatabaseUrl);
    expect(environment.DATABASE_URL_APP_DAL).not.toContain("database.example.com");
  });

  it("rejects a remote DAL URL in the app-local runtime file", () => {
    expect(() =>
      releaseSmokeEnvironment(
        { PATH: "/usr/bin" },
        {
          DATABASE_URL_APP_DAL:
            "postgresql://app_runtime_local:secret@database.example.com:54322/postgres?options=-c%20role%3Dapp_dal",
        },
        { APP_RELEASE_SHA: "d".repeat(40), PORT: "4100" },
      ),
    ).toThrow("instância Supabase local");
  });

  it("does not fall back to an inherited DAL URL when the app-local file omits it", () => {
    expect(() =>
      releaseSmokeEnvironment(
        {
          DATABASE_URL_APP_DAL:
            "postgresql://app_runtime_local:secret@127.0.0.1:54322/postgres?options=-c%20role%3Dapp_dal",
          PATH: "/usr/bin",
        },
        {},
        { APP_RELEASE_SHA: "e".repeat(40), PORT: "4100" },
      ),
    ).toThrow("local é obrigatória");
  });

  it("redacts configured credentials, database passwords, authorization and cookies", () => {
    const secret = "provider-secret-value";
    const redacted = redactEnvironmentSecrets(
      `token=${secret}\npostgresql://user:database-password@localhost/db\nAuthorization: Bearer abc.def\nCookie: session=raw`,
      { PAYMENT_PROVIDER_SECRET_KEY: secret },
    );

    expect(redacted).not.toContain(secret);
    expect(redacted).not.toContain("database-password");
    expect(redacted).not.toContain("abc.def");
    expect(redacted).not.toContain("session=raw");
    expect(environmentWithoutSecrets({ GH_TOKEN: secret, PATH: "/usr/bin" })).toEqual({
      PATH: "/usr/bin",
    });
    expect(
      operationalEnvironment({
        HOME: "/tmp/home",
        LC_ALL: "C.UTF-8",
        NEXT_PUBLIC_APP_URL: "https://must-not-inherit.invalid",
        PATH: "/usr/bin",
      }),
    ).toEqual({ HOME: "/tmp/home", LC_ALL: "C.UTF-8", PATH: "/usr/bin" });
  });
});

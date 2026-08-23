import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  directorySymbolicLinkType,
  fileSymbolicLinksSupported,
} from "../fixtures/filesystem-capabilities.mjs";

import {
  collectCleanupFailures,
  ensurePhysicalArtifactsRoot,
  environmentWithoutSecrets,
  isSensitiveEnvironmentName,
  operationalEnvironment,
  readReleaseRuntimeEnvironmentFile,
  redactEnvironmentSecrets,
  releaseBuildEnvironment,
  releaseRuntimeEnvironment,
  releaseSmokeEnvironment,
  throwIfPrimaryOrCleanupFailed,
  withExclusiveReleaseLock,
} from "../../scripts/release-guards.mjs";
import { removePhysicalTree } from "../../scripts/physical-tree-removal.mjs";

const temporaryRoots = [];
const linkIt = fileSymbolicLinksSupported ? it : it.skip;
const linuxIt = process.platform === "linux" ? it : it.skip;

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

function linuxMountInformation(mountPath) {
  const encodedMountPath = mountPath.replaceAll("\\", "\\134").replaceAll(" ", "\\040");
  return `1 0 0:1 / ${encodedMountPath} rw - tmpfs tmpfs rw\n`;
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
    if (process.platform === "linux") {
      expect(() =>
        ensurePhysicalArtifactsRoot(repository, artifacts, {
          platform: "linux",
          readLinuxMountInformation: () =>
            "1 0 0:1 / / rw - tmpfs tmpfs rw\n2 0 0:5 net:[4026531833] /run/docker/netns/default rw - nsfs nsfs rw\n",
        }),
      ).not.toThrow();
    }
    const information = lstatSync(artifacts);
    expect(information.isDirectory()).toBe(true);
    expect(information.isSymbolicLink()).toBe(false);
    if (process.platform !== "win32") {
      expect(information.mode & 0o777).toBe(0o700);
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
    symlinkSync(external, resolve(repository, ".artifacts"), directorySymbolicLinkType);

    expect(() =>
      ensurePhysicalArtifactsRoot(repository, resolve(repository, ".artifacts")),
    ).toThrow(process.platform === "win32" ? "reparse points" : "diretório físico regular");
    expect(readFileSync(sentinel, "utf8")).toBe("preserve");
  });

  it("rejects a root that is not a direct repository child", () => {
    const repository = temporaryRoot();
    expect(() =>
      ensurePhysicalArtifactsRoot(repository, resolve(repository, "nested/.artifacts")),
    ).toThrow("filha direta");
  });

  linuxIt("rejects root and descendant mounts before changing artifact permissions", () => {
    for (const mountedRelativePath of ["", "nested/mounted", "nested with space/mounted\\path"]) {
      const repository = temporaryRoot();
      const artifacts = resolve(repository, ".artifacts");
      const mountedPath = resolve(artifacts, mountedRelativePath);
      mkdirSync(mountedPath, { recursive: true });
      const marker = resolve(mountedPath, "must-remain");
      writeFileSync(marker, "mounted-content", "utf8");
      chmodSync(artifacts, 0o777);

      expect(() =>
        ensurePhysicalArtifactsRoot(repository, artifacts, {
          platform: "linux",
          readLinuxMountInformation: () => linuxMountInformation(mountedPath),
        }),
      ).toThrow("não pode ser um mount nem conter mounts");

      expect(lstatSync(artifacts).mode & 0o777).toBe(0o777);
      expect(readFileSync(marker, "utf8")).toBe("mounted-content");
    }
  });

  linuxIt("fails closed on malformed mountinfo and a symbolic repository ancestor", () => {
    const repository = temporaryRoot();
    const artifacts = resolve(repository, ".artifacts");
    mkdirSync(artifacts);
    chmodSync(artifacts, 0o777);

    for (const mountInformation of [
      "",
      "mountinfo-malformado\n",
      "1 0 0:1 / caminho-relativo rw - tmpfs tmpfs rw\n",
      "1 0 0:1 raiz-relativa /tmp rw - tmpfs tmpfs rw\n",
      "1 0 0:1 /tmp/../raiz /tmp rw - tmpfs tmpfs rw\n",
      "1 0 0:1 / /tmp\\777 rw - tmpfs tmpfs rw\n",
      "1 0 0:1 / /tmp rw - tmpfs - rw\n",
    ]) {
      expect(() =>
        ensurePhysicalArtifactsRoot(repository, artifacts, {
          platform: "linux",
          readLinuxMountInformation: () => mountInformation,
        }),
      ).toThrow("Não foi possível comprovar");
      expect(lstatSync(artifacts).mode & 0o777).toBe(0o777);
    }

    const base = temporaryRoot();
    const physicalRepository = resolve(base, "physical-repository");
    const symbolicRepository = resolve(base, "symbolic-repository");
    mkdirSync(physicalRepository);
    symlinkSync(physicalRepository, symbolicRepository, "dir");
    expect(() =>
      ensurePhysicalArtifactsRoot(symbolicRepository, resolve(symbolicRepository, ".artifacts")),
    ).toThrow("ancestralidade física válida");
    expect(existsSync(resolve(physicalRepository, ".artifacts"))).toBe(false);
  });

  linkIt("rejects a symbolic release lock without touching its target", async () => {
    const base = temporaryRoot();
    const repository = resolve(base, "repository");
    const externalLock = resolve(base, "external.lock");
    mkdirSync(repository);
    const artifacts = resolve(repository, ".artifacts");
    ensurePhysicalArtifactsRoot(repository, artifacts);
    writeFileSync(externalLock, "preserve", "utf8");
    symlinkSync(externalLock, resolve(artifacts, "release.lock"));

    await expect(withExclusiveReleaseLock(artifacts, async () => undefined)).rejects.toThrow(
      process.platform === "win32" ? "reparse points" : "lock físico",
    );
    expect(readFileSync(externalLock, "utf8")).toBe("preserve");
  });

  linuxIt("rechecks the artifact mount boundary before opening the release lock", async () => {
    const repository = temporaryRoot();
    const artifacts = resolve(repository, ".artifacts");
    ensurePhysicalArtifactsRoot(repository, artifacts);
    let operationStarted = false;

    await expect(
      withExclusiveReleaseLock(
        artifacts,
        async () => {
          operationStarted = true;
        },
        {
          platform: "linux",
          readLinuxMountInformation: () => linuxMountInformation(artifacts),
        },
      ),
    ).rejects.toThrow("recusa uma raiz de artefatos montada");
    expect(operationStarted).toBe(false);
    expect(existsSync(resolve(artifacts, "release.lock"))).toBe(false);
  });
});

describe("physical tree removal", () => {
  it("unlinks an exact regular file on any platform and treats an absent path as a no-op", () => {
    const root = temporaryRoot();
    const generatedFile = resolve(root, "manifest.incoming");
    writeFileSync(generatedFile, "generated", "utf8");

    removePhysicalTree(generatedFile, {
      allowRegularFile: true,
      description: "O arquivo gerado",
      platform: "darwin",
    });
    expect(existsSync(generatedFile)).toBe(false);
    expect(() =>
      removePhysicalTree(generatedFile, {
        allowRegularFile: true,
        platform: "win32",
      }),
    ).not.toThrow();
  });

  it("requires the exact Windows allowlist before unlinking a regular file", () => {
    const root = temporaryRoot();
    const generatedFile = resolve(root, "manifest.incoming");
    writeFileSync(generatedFile, "generated", "utf8");
    const windowsOptions = {
      allowRegularFile: true,
      assertWindowsPath: () => {},
      description: "O arquivo gerado",
      platform: "win32",
    };

    expect(() => removePhysicalTree(generatedFile, windowsOptions)).toThrow(
      "não é um alvo autorizado",
    );
    expect(readFileSync(generatedFile, "utf8")).toBe("generated");

    removePhysicalTree(generatedFile, {
      ...windowsOptions,
      authorizedWindowsPaths: [generatedFile],
    });
    expect(existsSync(generatedFile)).toBe(false);
  });

  it("applies the unconditional recursive Windows reparse-point inspection", () => {
    const root = temporaryRoot();
    const generatedTree = resolve(root, "generated-tree");
    const retiredTree = resolve(root, ".generated-tree.retired-fixed-generated-tree");
    mkdirSync(generatedTree);
    writeFileSync(resolve(generatedTree, "marker"), "generated", "utf8");
    const inspections = [];

    removePhysicalTree(generatedTree, {
      assertWindowsPath: (path, options) => inspections.push({ options, path }),
      authorizedWindowsPaths: [generatedTree],
      description: "A saída Next gerada",
      platform: "win32",
      uuid: () => "fixed-generated-tree",
    });

    expect(existsSync(generatedTree)).toBe(false);
    expect(inspections).toEqual([
      {
        options: {
          allowMissingLeaf: true,
          description: "A saída Next gerada",
          leafKind: "any",
          recursive: true,
        },
        path: generatedTree,
      },
      {
        options: {
          description: "A saída Next gerada",
          leafKind: "directory",
          recursive: true,
        },
        path: retiredTree,
      },
      {
        options: {
          description: "A saída Next gerada",
          leafKind: "directory",
          recursive: true,
        },
        path: retiredTree,
      },
    ]);
  });

  it("fails closed for an existing directory outside Linux", () => {
    const root = temporaryRoot();
    const generatedTree = resolve(root, "generated-tree");
    const marker = resolve(generatedTree, "must-remain");
    mkdirSync(generatedTree);
    writeFileSync(marker, "preserve", "utf8");

    expect(() =>
      removePhysicalTree(generatedTree, {
        allowRegularFile: true,
        description: "A árvore gerada",
        platform: "darwin",
      }),
    ).toThrow("removido manualmente nesta plataforma");
    expect(readFileSync(marker, "utf8")).toBe("preserve");
  });

  linuxIt("revalidates mountinfo and shape after the sibling UUID rename", () => {
    const mountRoot = temporaryRoot();
    const mountedTree = resolve(mountRoot, "mounted-tree");
    const mountedRetired = resolve(mountRoot, ".mounted-tree.retired-fixed-mount");
    mkdirSync(mountedTree);
    writeFileSync(resolve(mountedTree, "marker"), "preserve", "utf8");
    let mountReads = 0;

    expect(() =>
      removePhysicalTree(mountedTree, {
        description: "A árvore montada",
        platform: "linux",
        readLinuxMountInformation: () => {
          mountReads += 1;
          return linuxMountInformation(mountReads === 1 ? "/" : mountedRetired);
        },
        uuid: () => "fixed-mount",
      }),
    ).toThrow("não pode ser um mount nem conter mounts");
    expect(existsSync(mountedTree)).toBe(false);
    expect(readFileSync(resolve(mountedRetired, "marker"), "utf8")).toBe("preserve");

    const lateMountRoot = temporaryRoot();
    const lateMountTree = resolve(lateMountRoot, "late-mount-tree");
    const lateMountRetired = resolve(lateMountRoot, ".late-mount-tree.retired-fixed-late-mount");
    mkdirSync(lateMountTree);
    writeFileSync(resolve(lateMountTree, "marker"), "preserve", "utf8");
    let lateMountReads = 0;

    expect(() =>
      removePhysicalTree(lateMountTree, {
        description: "A árvore montada tardiamente",
        platform: "linux",
        readLinuxMountInformation: () => {
          lateMountReads += 1;
          return linuxMountInformation(lateMountReads < 3 ? "/" : lateMountRetired);
        },
        uuid: () => "fixed-late-mount",
      }),
    ).toThrow("não pode ser um mount nem conter mounts");
    expect(existsSync(lateMountTree)).toBe(false);
    expect(readFileSync(resolve(lateMountRetired, "marker"), "utf8")).toBe("preserve");

    const shapeRoot = temporaryRoot();
    const shapeTree = resolve(shapeRoot, "shape-tree");
    const shapeRetired = resolve(shapeRoot, ".shape-tree.retired-fixed-shape");
    mkdirSync(shapeTree);
    writeFileSync(resolve(shapeTree, "marker"), "preserve", "utf8");
    let shapeReads = 0;

    expect(() =>
      removePhysicalTree(shapeTree, {
        description: "A árvore mutável",
        platform: "linux",
        readLinuxMountInformation: () => {
          shapeReads += 1;
          if (shapeReads === 2) {
            writeFileSync(resolve(shapeRetired, "adversarial-extra"), "changed", "utf8");
          }
          return linuxMountInformation("/");
        },
        uuid: () => "fixed-shape",
      }),
    ).toThrow("mudou durante o retiro atômico");
    expect(existsSync(shapeTree)).toBe(false);
    expect(readdirSync(shapeRetired).sort()).toEqual(["adversarial-extra", "marker"]);
  });
});

describe("release cleanup failure preservation", () => {
  it("preserves the primary failure and every cleanup failure without masking either", () => {
    const primary = new Error("primary-failure");
    const firstCleanup = new Error("first-cleanup-failure");
    const secondCleanup = new Error("second-cleanup-failure");

    let combinedFailure;
    try {
      throwIfPrimaryOrCleanupFailed(primary, [firstCleanup, secondCleanup], {
        combinedMessage: "combined-failure",
      });
    } catch (error) {
      combinedFailure = error;
    }
    expect(combinedFailure).toBeInstanceOf(AggregateError);
    expect(combinedFailure.message).toBe("combined-failure");
    expect(combinedFailure.cause).toBe(primary);
    expect(combinedFailure.errors).toEqual([primary, firstCleanup, secondCleanup]);

    expect(() => throwIfPrimaryOrCleanupFailed(primary, [])).toThrow(primary);
    expect(() => throwIfPrimaryOrCleanupFailed(undefined, [firstCleanup])).toThrow(firstCleanup);
    expect(() => throwIfPrimaryOrCleanupFailed(undefined, [])).not.toThrow();

    const probedPaths = [];
    const collectedFailures = collectCleanupFailures(
      ["probe-failure", "remove-failure", "absent"],
      (path) => {
        probedPaths.push(path);
        if (path === "probe-failure") {
          throw firstCleanup;
        }
        return path !== "absent";
      },
      () => {
        throw secondCleanup;
      },
    );
    expect(probedPaths).toEqual(["probe-failure", "remove-failure", "absent"]);
    expect(collectedFailures).toEqual([firstCleanup, secondCleanup]);
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

  it("rejects a non-literal local host before a release consumes the runtime file", () => {
    const root = temporaryRoot();
    const environmentPath = resolve(root, ".env.local");

    for (const host of ["localhost", "[::1]", "127.1", "2130706433", "127.0.0.1."]) {
      writeFileSync(
        environmentPath,
        localRuntimeEnvironment("http://127.0.0.1:3000").replace(
          "http://127.0.0.1:54321",
          `http://${host}:54321`,
        ),
        { mode: 0o600 },
      );

      expect(() =>
        readReleaseRuntimeEnvironmentFile(environmentPath, "http://127.0.0.1:3000"),
      ).toThrow("host IPv4 literal 127.0.0.1");
    }
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
    ).toThrow("host IPv4 literal 127.0.0.1");
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

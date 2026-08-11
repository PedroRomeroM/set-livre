import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createLocalPsqlEnvironment,
  localPsqlArguments,
  redactLocalPsqlDiagnostics,
  resolveTrustedLocalPsql,
  spawnLocalPsql,
} from "../../scripts/local-psql-command.mjs";

const adminDatabaseUrl = "postgresql://postgres:local-admin-password@localhost:54322/postgres";
const dalDatabaseUrl =
  "postgresql://app_runtime_local:local-runtime-password@127.0.0.1:54322/postgres?options=-c%20role%3Dapp_dal";
const trustedOwnerId = process.geteuid?.();

function hostileInheritedEnvironment(path) {
  return {
    APPDATA: "/tmp/host-appdata",
    DATABASE_URL_APP_DAL: "postgresql://remote:secret@db.example.com:5432/production",
    DOCKER_HOST: "ssh://operator@docker.example.com",
    HOME: "/tmp/host-home",
    KRB5_CONFIG: "/tmp/host-krb5.conf",
    LANG: "pt_BR.UTF-8",
    LC_ALL: "C.UTF-8",
    LD_PRELOAD: "/tmp/host-preload.so",
    PATH: path,
    PGAPPNAME: "host-application",
    PGCHANNELBINDING: "require",
    PGCLIENTENCODING: "SQL_ASCII",
    PGCONNECT_TIMEOUT: "99",
    PGDATABASE: "production",
    PGDATESTYLE: "SQL, DMY",
    PGGEQO: "off",
    PGGSSDELEGATION: "1",
    PGGSSENCMODE: "require",
    PGGSSLIB: "gssapi",
    PGHOST: "db.example.com",
    PGHOSTADDR: "127.0.0.2",
    PGKRBSRVNAME: "host-service",
    PGLOADBALANCEHOSTS: "random",
    PGLOCALEDIR: "/tmp/host-locale",
    PGMAXPROTOCOLVERSION: "3.0",
    PGMINPROTOCOLVERSION: "3.0",
    PGOPTIONS: "-c role=postgres",
    PGPASSFILE: "/tmp/host-pgpass",
    PGPASSWORD: "host-password",
    PGPORT: "6543",
    PGREQUIREAUTH: "password",
    PGREQUIREPEER: "remote-peer",
    PGREPLICATION: "database",
    PGREQUIRESSL: "1",
    PGSERVICE: "production",
    PGSERVICEFILE: "/tmp/host-service.conf",
    PGSSLCERT: "/tmp/host-client.crt",
    PGSSLCERTMODE: "require",
    PGSSLCOMPRESSION: "1",
    PGSSLCRL: "/tmp/host.crl",
    PGSSLCRLDIR: "/tmp/host-crl",
    PGSSLKEY: "/tmp/host-client.key",
    PGSSLMODE: "verify-full",
    PGSSLMAXPROTOCOLVERSION: "TLSv1.3",
    PGSSLMINPROTOCOLVERSION: "TLSv1.2",
    PGSSLNEGOTIATION: "direct",
    PGSSLROOTCERT: "/tmp/host-root.crt",
    PGSSLSNI: "0",
    PGSYSCONFDIR: "/tmp/host-postgresql",
    PGTARGETSESSIONATTRS: "primary",
    PGTZ: "UTC",
    PGUSER: "remote-owner",
    PG_COLOR: "always",
    PSQL_EDITOR: "/tmp/host-editor",
    PSQL_HISTORY: "/tmp/host-history",
    PSQL_PAGER: "/tmp/host-pager",
    PSQLRC: "/tmp/host-psqlrc",
    SECRET_LEAK_SENTINEL: "must-not-reach-psql",
    SSL_CERT_FILE: "/tmp/host-ca.pem",
    USERPROFILE: "/tmp/host-profile",
  };
}

function createPsqlFixture(source = "#!/bin/sh\nexit 0\n") {
  const root = mkdtempSync(resolve(tmpdir(), "set-livre-trusted-psql-"));
  chmodSync(root, 0o700);
  const binaryDirectory = resolve(root, "bin");
  const libraryDirectory = resolve(root, "lib");
  mkdirSync(binaryDirectory, { mode: 0o700 });
  mkdirSync(libraryDirectory, { mode: 0o700 });
  const target = resolve(libraryDirectory, "psql-18.4");
  const command = resolve(binaryDirectory, "psql");
  writeFileSync(target, source, { mode: 0o500 });
  symlinkSync("../lib/psql-18.4", command);
  return { binaryDirectory, command, root, target };
}

function resolveFixture(fixture, executeVersion) {
  return resolveTrustedLocalPsql({
    executeVersion,
    inheritedEnvironment: { PATH: fixture.binaryDirectory },
    trustAnchorPath: fixture.root,
    trustedOwnerId,
  });
}

function successfulVersion(stdout = "psql (PostgreSQL) 18.4\n") {
  return { status: 0, stderr: "", stdout };
}

describe("local psql command boundary", () => {
  it("builds a closed environment without PATH, libpq overrides, config, or host secrets", () => {
    const inheritedEnvironment = hostileInheritedEnvironment("/opt/postgresql/bin:/usr/bin");
    const environment = createLocalPsqlEnvironment("controlled-local-password");

    expect(environment).toEqual({
      LANG: "C",
      LC_ALL: "C",
      PGPASSWORD: "controlled-local-password",
    });
    expect(Object.keys(environment).filter((name) => name.startsWith("PG"))).toEqual([
      "PGPASSWORD",
    ]);
    expect(JSON.stringify(environment)).not.toContain("must-not-reach-psql");
    expect(environment).not.toHaveProperty("PATH");
    expect(inheritedEnvironment.PGHOSTADDR).toBe("127.0.0.2");
  });

  it("adds only the controlled DAL role option when that identity is required", () => {
    expect(
      createLocalPsqlEnvironment("controlled-runtime-password", { assumeDalRole: true }),
    ).toEqual({
      LANG: "C",
      LC_ALL: "C",
      PGOPTIONS: "-c role=app_dal",
      PGPASSWORD: "controlled-runtime-password",
    });
  });

  it("redacts every bootstrap secret while preserving safe psql diagnostics", () => {
    const adminPassword = "admin-password-sentinel";
    const runtimePassword = "runtime-password-sentinel";
    const e2eDatabaseMarker = "e2e-marker-sentinel";
    const diagnostics = redactLocalPsqlDiagnostics(
      [
        "ERROR: falha controlada no bootstrap local",
        `LINE 4: password '${runtimePassword}';`,
        `COMMENT set-livre-e2e:${e2eDatabaseMarker}`,
        `postgresql://postgres:${adminPassword}@127.0.0.1:54322/postgres`,
      ].join("\n"),
      [runtimePassword, e2eDatabaseMarker, adminPassword],
    );

    expect(diagnostics).toContain("ERROR: falha controlada no bootstrap local");
    expect(diagnostics).toContain("postgresql://postgres:[REDACTED]@127.0.0.1:54322/postgres");
    expect(diagnostics).not.toContain(adminPassword);
    expect(diagnostics).not.toContain(runtimePassword);
    expect(diagnostics).not.toContain(e2eDatabaseMarker);
  });

  it("pins the numeric loopback destination and rejects every URL-side override", () => {
    expect(localPsqlArguments(adminDatabaseUrl)).toEqual([
      "--host",
      "127.0.0.1",
      "--port",
      "54322",
      "--username",
      "postgres",
      "--dbname",
      "postgres",
      "--no-password",
      "--no-psqlrc",
      "--set",
      "ON_ERROR_STOP=1",
    ]);
    expect(localPsqlArguments(dalDatabaseUrl, { assumeDalRole: true })).toContain(
      "app_runtime_local",
    );

    for (const [databaseUrl, options] of [
      ["postgresql://postgres:secret@db.example.com:54322/postgres", undefined],
      ["postgresql://postgres:secret@127.0.0.1:6543/postgres", undefined],
      ["postgresql://postgres:secret@127.0.0.1:54322/production", undefined],
      ["postgresql://postgres@127.0.0.1:54322/postgres", undefined],
      [`${adminDatabaseUrl}?hostaddr=127.0.0.2`, undefined],
      [dalDatabaseUrl, undefined],
      [`${dalDatabaseUrl}&sslmode=require`, { assumeDalRole: true }],
    ]) {
      expect(() => localPsqlArguments(databaseUrl, options)).toThrow();
    }
  });

  it.runIf(process.platform !== "win32" && trustedOwnerId !== undefined)(
    "probes the original absolute symlink with a secret-free environment and snapshots its full chain",
    () => {
      const fixture = createPsqlFixture();
      const invocations = [];
      try {
        const launch = resolveFixture(fixture, (command, argumentsList, options) => {
          invocations.push({ argumentsList, command, options });
          return successfulVersion("psql (PostgreSQL) 18.4 (fixture build)\n");
        });

        expect(launch).toMatchObject({
          command: fixture.command,
          trustAnchorPath: fixture.root,
          trustedOwnerId,
          version: "18.4",
        });
        expect(launch.snapshot.target).toBe(fixture.target);
        expect(launch.snapshot.nodes.map(({ kind, path }) => ({ kind, path }))).toContainEqual({
          kind: "symbolic-link",
          path: fixture.command,
        });
        for (const node of launch.snapshot.nodes) {
          expect(node).toEqual(
            expect.objectContaining({
              dev: expect.any(String),
              gid: expect.any(String),
              ino: expect.any(String),
              mode: expect.any(String),
              nlink: expect.any(String),
              uid: String(trustedOwnerId),
            }),
          );
        }
        expect(invocations).toEqual([
          {
            argumentsList: ["--version"],
            command: fixture.command,
            options: {
              cwd: fixture.root,
              encoding: "utf8",
              env: { LANG: "C", LC_ALL: "C" },
              shell: false,
              stdio: "pipe",
              timeout: 5_000,
            },
          },
        ]);
      } finally {
        rmSync(fixture.root, { force: true, recursive: true });
      }
    },
  );

  it.runIf(process.platform !== "win32" && trustedOwnerId !== undefined)(
    "rejects a hostile psql first in PATH before its real process can receive a secret or SQL",
    () => {
      const temporaryRoot = mkdtempSync(resolve(tmpdir(), "set-livre-hostile-psql-"));
      const sentinelPath = resolve(temporaryRoot, "received.json");
      const stubPath = resolve(temporaryRoot, "psql");
      const source = `#!${process.execPath}\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(
        sentinelPath,
      )}, JSON.stringify({ arguments: process.argv.slice(2), environment: process.env }));\nprocess.stdout.write("psql (PostgreSQL) 18.4\\n");\n`;

      try {
        writeFileSync(stubPath, source, { mode: 0o700 });
        expect(() =>
          resolveTrustedLocalPsql({
            inheritedEnvironment: hostileInheritedEnvironment(`${temporaryRoot}:/usr/bin`),
          }),
        ).toThrow(/proprietário confiável|ancestral de psql não é protegido/u);
        expect(existsSync(sentinelPath)).toBe(false);
      } finally {
        rmSync(temporaryRoot, { force: true, recursive: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "resolves and executes the real root-owned psql 18.4 without PATH",
    () => {
      const launch = resolveTrustedLocalPsql({ inheritedEnvironment: process.env });

      expect(launch.version).toBe("18.4");
      expect(isAbsolute(launch.command)).toBe(true);
      expect(launch.command).toBe("/usr/bin/psql");
      expect(launch.snapshot.target).toBe("/usr/share/postgresql-common/pg_wrapper");
      expect(launch.snapshot.nodes).toContainEqual(
        expect.objectContaining({
          kind: "symbolic-link",
          path: "/usr/bin/psql",
          target: "../share/postgresql-common/pg_wrapper",
          uid: "0",
        }),
      );
    },
  );

  it.runIf(process.platform !== "win32" && trustedOwnerId !== undefined)(
    "runs an accepted process with the same absolute path and only the closed secret contract",
    () => {
      const source = `#!${process.execPath}\nif (process.argv[2] === "--version") {\n  process.stdout.write("psql (PostgreSQL) 18.4\\n");\n} else {\n  process.stdout.write(JSON.stringify({ arguments: process.argv.slice(2), environment: process.env }));\n}\n`;
      const fixture = createPsqlFixture(source);
      try {
        const launch = resolveFixture(fixture);
        const { argumentsList, result } = spawnLocalPsql(launch, dalDatabaseUrl, {
          assumeDalRole: true,
          command: "select current_user",
          inheritedEnvironment: hostileInheritedEnvironment("/hostile/bin:/usr/bin"),
        });

        expect(result.status).toBe(0);
        const observation = JSON.parse(result.stdout);
        expect(observation.arguments).toEqual(argumentsList);
        expect(observation.environment).toEqual({
          LANG: "C",
          LC_ALL: "C",
          PGOPTIONS: "-c role=app_dal",
          PGPASSWORD: "local-runtime-password",
        });
        expect(argumentsList.slice(-4)).toEqual([
          "--tuples-only",
          "--no-align",
          "--command",
          "select current_user",
        ]);
        expect(result.stdout).not.toContain("must-not-reach-psql");
        expect(result.stdout).not.toContain("127.0.0.2");
      } finally {
        rmSync(fixture.root, { force: true, recursive: true });
      }
    },
  );

  it.runIf(process.platform !== "win32" && trustedOwnerId !== undefined)(
    "revalidates before URL parsing can extract a password",
    () => {
      const fixture = createPsqlFixture();
      let conversions = 0;
      let executorCalls = 0;
      try {
        const launch = resolveFixture(fixture, () => successfulVersion());
        chmodSync(fixture.target, 0o700);
        const databaseUrl = {
          [Symbol.toPrimitive]() {
            conversions += 1;
            return adminDatabaseUrl;
          },
        };

        expect(() =>
          spawnLocalPsql(launch, databaseUrl, {
            executePsql: () => {
              executorCalls += 1;
              return { status: 0, stderr: "", stdout: "" };
            },
          }),
        ).toThrow("mudou depois do preflight");
        expect(conversions).toBe(0);
        expect(executorCalls).toBe(0);
      } finally {
        rmSync(fixture.root, { force: true, recursive: true });
      }
    },
  );

  it.runIf(process.platform !== "win32" && trustedOwnerId !== undefined)(
    "revalidates immediately before spawn and withholds the secret after a concurrent mutation",
    () => {
      const fixture = createPsqlFixture();
      let executorCalls = 0;
      try {
        const launch = resolveFixture(fixture, () => successfulVersion());
        let conversions = 0;
        const databaseUrl = {
          [Symbol.toPrimitive]() {
            conversions += 1;
            if (conversions === 1) {
              chmodSync(fixture.target, 0o700);
              writeFileSync(fixture.target, "#!/bin/sh\nexit 1\n", { mode: 0o500 });
            }
            return adminDatabaseUrl;
          },
        };

        expect(() =>
          spawnLocalPsql(launch, databaseUrl, {
            executePsql: () => {
              executorCalls += 1;
              return { status: 0, stderr: "", stdout: "" };
            },
          }),
        ).toThrow("mudou depois do preflight");
        expect(executorCalls).toBe(0);
      } finally {
        rmSync(fixture.root, { force: true, recursive: true });
      }
    },
  );

  it.runIf(process.platform !== "win32" && trustedOwnerId !== undefined)(
    "rejects non-canonical PATH entries, writable ancestry, and every non-exact version before SQL",
    () => {
      const fixture = createPsqlFixture();
      try {
        for (const path of [
          "",
          `:${fixture.binaryDirectory}`,
          ".:/usr/bin",
          `${fixture.binaryDirectory}/`,
        ]) {
          let versionCalls = 0;
          expect(() =>
            resolveTrustedLocalPsql({
              executeVersion: () => {
                versionCalls += 1;
                return successfulVersion();
              },
              inheritedEnvironment: { PATH: path },
              trustAnchorPath: fixture.root,
              trustedOwnerId,
            }),
          ).toThrow(/PATH/u);
          expect(versionCalls).toBe(0);
        }

        chmodSync(fixture.binaryDirectory, 0o777);
        let versionCalls = 0;
        expect(() =>
          resolveFixture(fixture, () => {
            versionCalls += 1;
            return successfulVersion();
          }),
        ).toThrow("não é protegido");
        expect(versionCalls).toBe(0);
        chmodSync(fixture.binaryDirectory, 0o700);

        for (const output of [
          "psql (PostgreSQL) 18.3\n",
          "psql (PostgreSQL) 18.4.1\n",
          "psql (PostgreSQL) 18.4\nextra\n",
        ]) {
          expect(() => resolveFixture(fixture, () => successfulVersion(output))).toThrow(
            "exatamente PostgreSQL 18.4",
          );
        }
      } finally {
        rmSync(fixture.root, { force: true, recursive: true });
      }
    },
  );

  it("fails closed on Windows before resolving or executing a candidate", () => {
    let versionCalls = 0;
    expect(() =>
      resolveTrustedLocalPsql({
        executeVersion: () => {
          versionCalls += 1;
          return successfulVersion();
        },
        inheritedEnvironment: { Path: "C:\\PostgreSQL\\bin" },
        platform: "win32",
      }),
    ).toThrow("exige POSIX");
    expect(versionCalls).toBe(0);
  });

  it.runIf(process.platform !== "win32")(
    "keeps the real libpq socket on explicit loopback despite hostile PGHOSTADDR",
    async () => {
      const launch = resolveTrustedLocalPsql({ inheritedEnvironment: process.env });
      const hits = [];
      const sockets = new Set();
      const servers = [];
      let child;

      const listen = (host, port) =>
        new Promise((resolveListen, rejectListen) => {
          const server = net.createServer((socket) => {
            sockets.add(socket);
            hits.push(host);
            socket.on("close", () => sockets.delete(socket));
            socket.destroy();
          });
          server.once("error", rejectListen);
          server.listen({ host, port }, () => {
            servers.push(server);
            resolveListen(server.address().port);
          });
        });

      try {
        const port = await listen("127.0.0.1", 0);
        await listen("127.0.0.2", port);
        const environment = createLocalPsqlEnvironment("unused-local-password");
        expect(environment).not.toHaveProperty("PATH");
        child = spawn(
          launch.command,
          [
            "--host",
            "127.0.0.1",
            "--port",
            String(port),
            "--username",
            "postgres",
            "--dbname",
            "postgres",
            "--no-password",
            "--no-psqlrc",
            "--command",
            "select 1",
          ],
          { cwd: "/", env: environment, shell: false, stdio: "ignore" },
        );
        const exitCode = await new Promise((resolveExit, rejectExit) => {
          const timeout = setTimeout(() => {
            child.kill("SIGKILL");
            rejectExit(new Error("O probe real do psql excedeu o limite de tempo."));
          }, 5_000);
          child.once("error", (error) => {
            clearTimeout(timeout);
            rejectExit(error);
          });
          child.once("exit", (code) => {
            clearTimeout(timeout);
            resolveExit(code);
          });
        });

        expect(exitCode).not.toBe(0);
        expect(hits).toEqual(["127.0.0.1"]);
      } finally {
        if (child?.exitCode === null) {
          child.kill("SIGKILL");
        }
        for (const socket of sockets) {
          socket.destroy();
        }
        await Promise.all(
          servers.map(
            (server) =>
              new Promise((resolveClose) => {
                server.close(resolveClose);
              }),
          ),
        );
      }
    },
  );
});

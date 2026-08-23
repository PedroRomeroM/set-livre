import pg from "pg";

import { localIpv4Host, parseLiteralLocalIpv4Url } from "./local-network-contract.ts";

const { Client } = pg;

const dalRoleUrlOption = "-c role=app_dal";
const connectionTimeoutMilliseconds = 5_000;
const queryTimeoutMilliseconds = 120_000;
const statementTimeoutMilliseconds = 120_000;
const lockTimeoutMilliseconds = 15_000;
const idleInTransactionTimeoutMilliseconds = 30_000;
const controlledClientOptions = "-c client_min_messages=warning";
const inheritedPostgresEnvironmentPattern = /^(?:PG|PSQL)/iu;

const sessionContractSql = `
select
  current_user,
  session_user,
  pg_catalog.current_database(),
  pg_catalog.current_setting('statement_timeout')::pg_catalog.interval
    = pg_catalog.make_interval(secs => 120),
  pg_catalog.current_setting('lock_timeout')::pg_catalog.interval
    = pg_catalog.make_interval(secs => 15),
  pg_catalog.current_setting('idle_in_transaction_session_timeout')::pg_catalog.interval
    = pg_catalog.make_interval(secs => 30)
`;

function parseLocalDatabaseIdentity(databaseUrl, assumeDalRole) {
  const parsed = parseLiteralLocalIpv4Url(
    databaseUrl,
    "A URL destinada ao cliente PostgreSQL local",
  );

  let username;
  let password;
  let databaseName;
  try {
    username = decodeURIComponent(parsed.username);
    password = decodeURIComponent(parsed.password);
    databaseName = decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    throw new Error("A identidade destinada ao cliente PostgreSQL local é inválida.");
  }

  const hasExpectedDalOptions =
    parsed.searchParams.size === 1 && parsed.searchParams.get("options") === dalRoleUrlOption;
  if (
    parsed.protocol !== "postgresql:" ||
    parsed.port !== "54322" ||
    username === "" ||
    username.includes("\0") ||
    password === "" ||
    password.includes("\0") ||
    databaseName !== "postgres" ||
    parsed.hash !== "" ||
    (assumeDalRole ? !hasExpectedDalOptions : parsed.search !== "")
  ) {
    throw new Error(
      "O cliente PostgreSQL só pode acessar a instância local esperada e sem overrides de URL.",
    );
  }

  return { databaseName, password, username };
}

export function createLocalPostgresClientConfig(databaseUrl, { assumeDalRole = false } = {}) {
  const { databaseName, password, username } = parseLocalDatabaseIdentity(
    databaseUrl,
    assumeDalRole,
  );

  return Object.freeze({
    application_name: "set-livre-local-setup",
    client_encoding: "UTF8",
    connectionTimeoutMillis: connectionTimeoutMilliseconds,
    database: databaseName,
    host: localIpv4Host,
    idle_in_transaction_session_timeout: idleInTransactionTimeoutMilliseconds,
    keepAlive: true,
    keepAliveInitialDelayMillis: 1_000,
    lock_timeout: lockTimeoutMilliseconds,
    options: assumeDalRole
      ? `${controlledClientOptions} ${dalRoleUrlOption}`
      : controlledClientOptions,
    password,
    port: 54322,
    query_timeout: queryTimeoutMilliseconds,
    ssl: false,
    sslnegotiation: "postgres",
    statement_timeout: statementTimeoutMilliseconds,
    user: username,
  });
}

function createInstalledPostgresClient(configuration) {
  return new Client(configuration);
}

function createClientWithoutInheritedPostgresEnvironment(createClient, configuration) {
  const removedEnvironment = [];
  for (const name of Object.keys(process.env)) {
    if (inheritedPostgresEnvironmentPattern.test(name)) {
      removedEnvironment.push([name, process.env[name]]);
      delete process.env[name];
    }
  }

  try {
    return createClient(configuration);
  } finally {
    for (const [name, value] of removedEnvironment) {
      if (value !== undefined) {
        process.env[name] = value;
      }
    }
  }
}

export function redactLocalPostgresDiagnostics(error, redactions = []) {
  const diagnosticValues = [];
  if (error !== null && typeof error === "object") {
    for (const property of ["message", "detail", "hint", "where"]) {
      if (typeof error[property] === "string") {
        diagnosticValues.push(error[property]);
      }
    }
  } else if (typeof error === "string") {
    diagnosticValues.push(error);
  }

  const secrets = redactions.filter((secret) => typeof secret === "string" && secret !== "");
  return diagnosticValues
    .join("\n")
    .replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/giu, "$1[REDACTED]@")
    .split("\n")
    .map((line) =>
      secrets.reduce((redacted, secret) => redacted.split(secret).join("[REDACTED]"), line),
    )
    .filter(Boolean)
    .slice(-12)
    .join("\n");
}

function assertSessionContract(result, configuration, assumeDalRole) {
  const expectedCurrentUser = assumeDalRole ? "app_dal" : configuration.user;
  const expectedObservation = [
    expectedCurrentUser,
    configuration.user,
    configuration.database,
    true,
    true,
    true,
  ];
  if (
    !Array.isArray(result?.rows) ||
    result.rows.length !== 1 ||
    !Array.isArray(result.rows[0]) ||
    result.rows[0].length !== expectedObservation.length ||
    result.rows[0].some((value, index) => value !== expectedObservation[index])
  ) {
    throw new Error(
      "A sessão PostgreSQL local não comprovou destino, identidade, role e timeouts esperados.",
    );
  }
}

export async function executeLocalPostgresSql(
  databaseUrl,
  {
    assumeDalRole = false,
    createClient = createInstalledPostgresClient,
    redactions = [],
    sql,
  } = {},
) {
  if (typeof sql !== "string" || sql === "" || sql.includes("\0")) {
    throw new Error("O comando SQL local é inválido.");
  }

  const configuration = createLocalPostgresClientConfig(databaseUrl, { assumeDalRole });
  let client;
  let result;
  let failure;

  try {
    client = createClientWithoutInheritedPostgresEnvironment(createClient, configuration);
    await client.connect();
    const observation = await client.query({
      query_timeout: queryTimeoutMilliseconds,
      rowMode: "array",
      text: sessionContractSql,
    });
    assertSessionContract(observation, configuration, assumeDalRole);
    result = await client.query({
      query_timeout: queryTimeoutMilliseconds,
      rowMode: "array",
      text: sql,
    });
  } catch (error) {
    failure = error;
  }

  if (client !== undefined) {
    try {
      await client.end();
    } catch (error) {
      failure ??= error;
    }
  }

  if (failure !== undefined) {
    const diagnostics = redactLocalPostgresDiagnostics(failure, [
      configuration.password,
      ...redactions,
    ]);
    throw new Error(
      `O comando PostgreSQL local falhou.${diagnostics === "" ? "" : `\n${diagnostics}`}`,
    );
  }

  return result;
}

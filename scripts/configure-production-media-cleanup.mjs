import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { StorageApiError, StorageClient } from "@supabase/storage-js";
import { Client } from "pg";

import { productionCoordinates, productionRoleConnections } from "./provision-production-role.mjs";

const legacyMutableCleanupSlug = "media-cleanup";
const immutableCleanupSlugPattern = /^media-cleanup-[0-9a-f]{40}$/u;
const releaseShaPattern = /^[0-9a-f]{40}$/u;
const secretKeyPattern = /^sb_secret_[A-Za-z0-9_-]{12,}$/u;
const uuidSource = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const uuidPattern = new RegExp(`^${uuidSource}$`, "u");
const safeErrorCodePattern = /^[a-z0-9_]{2,80}$/u;
const originalPathPattern = new RegExp(
  `^owners\\/(${uuidSource})\\/studios\\/(${uuidSource})\\/revisions\\/(${uuidSource})\\/(${uuidSource})\\.(avif|jpeg|jpg|png|webp)$`,
  "u",
);
const previewPathPattern = new RegExp(
  `^owners\\/(${uuidSource})\\/studios\\/(${uuidSource})\\/revisions\\/(${uuidSource})\\/(${uuidSource})\\.preview\\.webp$`,
  "u",
);
const mediaBucketName = "studio-media";
const mediaBucketMaximumBytes = "15728640";
const mediaBucketMimeTypes = ["image/avif", "image/jpeg", "image/png", "image/webp"];
const cleanupProbeObject = Buffer.from(
  "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89WAAAAA==",
  "base64",
);
const cleanupConfigurationLockName = "set-livre-production-media-cleanup";
const staleCleanupProbeBatchSize = 100;

function isExactObject(value, keys) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}

function requiredValue(environment, name) {
  const value = environment[name];
  if (
    typeof value !== "string" ||
    value === "" ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${name} não foi configurado com um valor íntegro.`);
  }
  return value;
}

export function assertImmutableCleanupSlug(value) {
  if (typeof value !== "string" || !immutableCleanupSlugPattern.test(value)) {
    throw new Error("O slug de cleanup precisa estar vinculado a um SHA completo imutável.");
  }
  return value;
}

export function assertReleaseSha(value) {
  if (typeof value !== "string" || !releaseShaPattern.test(value)) {
    throw new Error("A release ativa precisa ser um SHA completo válido.");
  }
  return value;
}

export function selectDefaultSecretKey(payload) {
  if (!Array.isArray(payload)) {
    throw new Error("A Management API retornou um contrato de chaves inválido.");
  }
  const candidates = payload.filter(
    (candidate) =>
      typeof candidate === "object" &&
      candidate !== null &&
      !Array.isArray(candidate) &&
      candidate.type === "secret" &&
      candidate.name === "default",
  );
  if (candidates.length !== 1 || !secretKeyPattern.test(candidates[0]?.api_key ?? "")) {
    throw new Error("O projeto precisa de uma única secret key moderna chamada default.");
  }
  return candidates[0].api_key;
}

export function assertDefaultSecretKey(value) {
  if (typeof value !== "string" || !secretKeyPattern.test(value)) {
    throw new Error("PRD_SUPABASE_SECRET_KEY não contém a secret key moderna default.");
  }
  return value;
}

export function assertCleanupResult(payload, { requireClaimed = false } = {}) {
  if (
    !isExactObject(payload, ["claimed", "deleted", "failed"]) ||
    !Number.isInteger(payload.claimed) ||
    !Number.isInteger(payload.deleted) ||
    !Number.isInteger(payload.failed) ||
    payload.claimed < 0 ||
    payload.deleted < 0 ||
    payload.failed < 0 ||
    payload.claimed !== payload.deleted + payload.failed ||
    payload.failed !== 0 ||
    payload.deleted !== payload.claimed ||
    (requireClaimed && payload.claimed < 1)
  ) {
    throw new Error("O cleanup de mídia não retornou um resultado terminal saudável.");
  }
  return payload;
}

export function assertProductionMediaBucket(rows) {
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error("O bucket privado de mídia não existe com cardinalidade única.");
  }
  const bucket = rows[0];
  if (
    !isExactObject(bucket, ["allowedMimeTypes", "fileSizeLimit", "id", "isPublic", "name"]) ||
    bucket.id !== mediaBucketName ||
    bucket.name !== mediaBucketName ||
    bucket.isPublic !== false ||
    bucket.fileSizeLimit !== mediaBucketMaximumBytes ||
    !Array.isArray(bucket.allowedMimeTypes) ||
    bucket.allowedMimeTypes.length !== mediaBucketMimeTypes.length ||
    [...bucket.allowedMimeTypes].sort().join(",") !== mediaBucketMimeTypes.join(",")
  ) {
    throw new Error("O bucket privado de mídia diverge do contrato de produção.");
  }
  return bucket;
}

export function createProductionStorageClient({ fetchImplementation, secretKey }) {
  if (typeof fetchImplementation !== "function") {
    throw new Error("O cliente HTTP do Storage não está disponível.");
  }
  return new StorageClient(
    `${productionCoordinates.supabaseUrl}/storage/v1`,
    { apikey: assertDefaultSecretKey(secretKey) },
    fetchImplementation,
  );
}

export function isConfirmedStorageObjectAbsence(error) {
  return error instanceof StorageApiError && error.status === 404 && error.code === "NoSuchKey";
}

export function assertActiveWebReleaseHealth(payload) {
  if (
    !isExactObject(payload, ["application", "checkedAt", "release", "requestId", "status"]) ||
    payload.application !== "web" ||
    payload.status !== "live" ||
    typeof payload.checkedAt !== "string" ||
    !Number.isFinite(Date.parse(payload.checkedAt)) ||
    new Date(payload.checkedAt).toISOString() !== payload.checkedAt ||
    typeof payload.requestId !== "string" ||
    !uuidPattern.test(payload.requestId)
  ) {
    throw new Error("O health público não retornou uma liveness web estrita.");
  }
  return assertReleaseSha(payload.release);
}

async function requestJson(
  fetchImplementation,
  endpoint,
  { body, headers = {}, label, method = "GET" },
) {
  let response;
  try {
    response = await fetchImplementation(endpoint, {
      body,
      cache: "no-store",
      headers: { Accept: "application/json", ...headers },
      method,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new Error(`${label} não respondeu sem redirecionamento.`, {
      cause: error,
    });
  }
  if (response.status !== 200 || response.redirected === true) {
    throw new Error(`${label} recusou a operação (${response.status}).`);
  }
  if (
    response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
    "application/json"
  ) {
    throw new Error(`${label} não retornou JSON.`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} retornou JSON inválido.`);
  }
}

export async function readActivePublicReleaseSha({ fetchImplementation = fetch } = {}) {
  if (typeof fetchImplementation !== "function") {
    throw new Error("O cliente HTTP do health público não está disponível.");
  }
  const endpoint = new URL("/api/health/live", productionCoordinates.publicUrl);
  if (endpoint.protocol !== "https:") {
    throw new Error("O health público de produção precisa usar HTTPS.");
  }
  const payload = await requestJson(fetchImplementation, endpoint, {
    label: "O health público",
  });
  return assertActiveWebReleaseHealth(payload);
}

function assertCleanupProbe(payload, { identity = undefined, runId, status }) {
  if (
    !isExactObject(payload, ["bucket", "mediaId", "paths", "runId", "status"]) ||
    payload.runId !== runId ||
    typeof payload.runId !== "string" ||
    !uuidPattern.test(payload.runId) ||
    payload.status !== status ||
    payload.bucket !== mediaBucketName ||
    typeof payload.mediaId !== "string" ||
    !uuidPattern.test(payload.mediaId) ||
    !Array.isArray(payload.paths) ||
    payload.paths.length !== 2
  ) {
    throw new Error("O canário de cleanup retornou um contrato inválido.");
  }
  const [originalPath, previewPath] = payload.paths;
  const original = typeof originalPath === "string" ? originalPathPattern.exec(originalPath) : null;
  const preview = typeof previewPath === "string" ? previewPathPattern.exec(previewPath) : null;
  if (
    original === null ||
    preview === null ||
    original.slice(1, 5).some((part, index) => part !== preview[index + 1]) ||
    original.slice(1, 4).some((part) => part !== payload.runId) ||
    original[4] !== payload.mediaId
  ) {
    throw new Error("O canário de cleanup retornou paths não relacionais.");
  }
  if (
    identity !== undefined &&
    (identity.mediaId !== payload.mediaId || identity.paths.join("\0") !== payload.paths.join("\0"))
  ) {
    throw new Error("O canário de cleanup mudou de identidade durante o probe.");
  }
  return payload;
}

async function verifyStoragePathsAbsent(bucket, paths) {
  for (const path of paths) {
    const { data, error } = await bucket.download(path);
    if (data !== null || !isConfirmedStorageObjectAbsence(error)) {
      throw new Error("O Storage não comprovou a ausência física do canário.");
    }
  }
}

async function removeAndVerifyCleanupProbe(storage, probe) {
  const bucket = storage.from(probe.bucket);
  const { error } = await bucket.remove(probe.paths);
  if (error !== null) {
    throw new Error("O Storage recusou a remoção do canário.");
  }
  await verifyStoragePathsAbsent(bucket, probe.paths);
}

async function acquireCleanupConfigurationLock(client) {
  const result = await client.query(
    `select pg_catalog.pg_try_advisory_lock(
       pg_catalog.hashtextextended($1::text, 0)
     ) as acquired`,
    [cleanupConfigurationLockName],
  );
  if (result.rowCount !== 1 || result.rows[0]?.acquired !== true) {
    throw new Error("Outra configuração de cleanup já está em execução.");
  }
}

async function readStaleCleanupProbes(client) {
  const result = await client.query(
    `select pg_catalog.jsonb_build_object(
       'runId', probe.run_id,
       'status', probe.status,
       'bucket', probe.storage_bucket,
       'mediaId', probe.media_id,
       'paths', pg_catalog.jsonb_build_array(
         probe.storage_path,
         probe.preview_storage_path
       )
     ) as probe
     from maintenance.studio_media_cleanup_probes as probe
     where probe.status in ('prepared', 'queued')
       and probe.updated_at <= pg_catalog.clock_timestamp() - interval '30 minutes'
     order by probe.updated_at, probe.run_id
     limit ${staleCleanupProbeBatchSize}`,
  );
  if (!Array.isArray(result.rows) || result.rowCount !== result.rows.length) {
    throw new Error("O banco retornou probes abandonados com cardinalidade inválida.");
  }
  return result.rows.map((row) => {
    if (
      !isExactObject(row, ["probe"]) ||
      !isExactObject(row.probe, ["bucket", "mediaId", "paths", "runId", "status"])
    ) {
      throw new Error("O banco retornou um probe abandonado inválido.");
    }
    if (row.probe.status !== "prepared" && row.probe.status !== "queued") {
      throw new Error("O banco retornou um estado de probe abandonado inválido.");
    }
    return assertCleanupProbe(row.probe, {
      runId: row.probe.runId,
      status: row.probe.status,
    });
  });
}

async function recoverStaleCleanupProbes(client, storage) {
  for (;;) {
    const probes = await readStaleCleanupProbes(client);
    if (probes.length === 0) return;
    for (const probe of probes) {
      const errors = await abortCleanupProbe(client, storage, probe, "probe_abandoned");
      if (errors.length > 0) {
        throw new AggregateError(errors, "Um canário abandonado não pôde ser recuperado.");
      }
    }
  }
}

function assertCleanupRun(payload, expected) {
  if (
    !isExactObject(payload, [
      "claimed",
      "deleted",
      "errorCode",
      "failed",
      "functionSlug",
      "runId",
      "status",
    ]) ||
    payload.runId !== expected.runId ||
    payload.functionSlug !== expected.functionSlug ||
    payload.status !== "succeeded" ||
    payload.errorCode !== null ||
    payload.claimed !== expected.claimed ||
    payload.deleted !== expected.deleted ||
    payload.failed !== expected.failed
  ) {
    throw new Error("O ledger durável não confirmou a execução saudável do cleanup.");
  }
  return payload;
}

function deploymentTimestamp(value) {
  if (Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error("A Management API retornou timestamp inválido para uma Edge Function.");
}

export function selectCleanupFunctionRetention(payload, { activeReleaseSha, candidateSlug }) {
  const activeSlug = assertImmutableCleanupSlug(
    `media-cleanup-${assertReleaseSha(activeReleaseSha)}`,
  );
  assertImmutableCleanupSlug(candidateSlug);
  if (!Array.isArray(payload)) {
    throw new Error("A Management API retornou uma lista de Edge Functions inválida.");
  }
  const legacyCandidates = payload.filter(
    (candidate) => candidate?.slug === legacyMutableCleanupSlug,
  );
  if (legacyCandidates.length > 1) {
    throw new Error("A função mutável legada possui cardinalidade ambígua.");
  }
  const legacyCandidate = legacyCandidates[0];
  if (
    legacyCandidate !== undefined &&
    (typeof legacyCandidate !== "object" ||
      legacyCandidate === null ||
      Array.isArray(legacyCandidate) ||
      legacyCandidate.status !== "ACTIVE" ||
      legacyCandidate.verify_jwt !== false)
  ) {
    throw new Error("A função mutável legada diverge do contrato de migração.");
  }

  const slugs = new Set();
  const versions = payload
    .filter((candidate) => immutableCleanupSlugPattern.test(candidate?.slug ?? ""))
    .map((candidate) => {
      if (
        typeof candidate !== "object" ||
        candidate === null ||
        Array.isArray(candidate) ||
        candidate.status !== "ACTIVE" ||
        candidate.verify_jwt !== false ||
        slugs.has(candidate.slug)
      ) {
        throw new Error("Uma versão imutável de cleanup diverge do contrato implantado.");
      }
      slugs.add(candidate.slug);
      return {
        slug: candidate.slug,
        timestamp: deploymentTimestamp(candidate.updated_at ?? candidate.created_at),
      };
    })
    .sort((left, right) => right.timestamp - left.timestamp || right.slug.localeCompare(left.slug));

  if (!slugs.has(candidateSlug)) {
    throw new Error("A versão candidata de cleanup não foi encontrada com cardinalidade única.");
  }

  const protectedSlugs = new Set([activeSlug, candidateSlug]);
  const retainedSet = new Set(
    versions
      .filter((candidate) => protectedSlugs.has(candidate.slug))
      .map((candidate) => candidate.slug),
  );
  for (const version of versions) {
    if (retainedSet.size >= 4) break;
    retainedSet.add(version.slug);
  }
  const retained = versions
    .filter((candidate) => retainedSet.has(candidate.slug))
    .map((candidate) => candidate.slug);
  const deleted = versions
    .filter((candidate) => !retainedSet.has(candidate.slug))
    .map((candidate) => candidate.slug);
  if (legacyCandidate !== undefined) deleted.push(legacyMutableCleanupSlug);

  if (
    retained.length > 4 ||
    !retained.includes(candidateSlug) ||
    (slugs.has(activeSlug) && !retained.includes(activeSlug)) ||
    deleted.some((slug) => protectedSlugs.has(slug))
  ) {
    throw new Error("A retenção não preservou as versões protegidas de cleanup.");
  }
  return { activeSlug, deleted, retained };
}

async function managementRequest(endpoint, accessToken, fetchImplementation, options = {}) {
  return requestJson(fetchImplementation, endpoint, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...options.headers,
    },
    label: options.label ?? "A Management API",
    method: options.method,
  });
}

async function readDefaultSecretKey(accessToken, projectRef, fetchImplementation) {
  const endpoint = new URL(
    `/v1/projects/${encodeURIComponent(projectRef)}/api-keys`,
    "https://api.supabase.com",
  );
  endpoint.searchParams.set("reveal", "true");
  const payload = await managementRequest(endpoint, accessToken, fetchImplementation, {
    label: "A Management API de chaves",
  });
  return selectDefaultSecretKey(payload);
}

export async function writeEphemeralDefaultSecretKey(
  environment,
  destination,
  { fetchImplementation = fetch, openFile = open } = {},
) {
  const runnerTemp = requiredValue(environment, "RUNNER_TEMP");
  const expectedDestination = resolve(runnerTemp, "set-livre-supabase-secret-key");
  if (typeof destination !== "string" || resolve(destination) !== expectedDestination) {
    throw new Error("O destino da chave efêmera não pertence ao diretório temporário esperado.");
  }
  const accessToken = requiredValue(environment, "SUPABASE_ACCESS_TOKEN");
  const projectRef = requiredValue(environment, "SUPABASE_PROJECT_REF");
  if (projectRef !== productionCoordinates.projectRef) {
    throw new Error("SUPABASE_PROJECT_REF diverge do projeto canônico de produção.");
  }
  const secretKey = await readDefaultSecretKey(accessToken, projectRef, fetchImplementation);
  const file = await openFile(expectedDestination, "wx", 0o600);
  try {
    await file.writeFile(`${secretKey}\n`, { encoding: "utf8" });
    await file.sync();
  } finally {
    await file.close();
  }
  return expectedDestination;
}

async function pruneCleanupFunctions(
  accessToken,
  projectRef,
  retentionContext,
  fetchImplementation,
) {
  const collection = new URL(
    `/v1/projects/${encodeURIComponent(projectRef)}/functions`,
    "https://api.supabase.com",
  );
  const payload = await managementRequest(collection, accessToken, fetchImplementation, {
    label: "A Management API de Edge Functions",
  });
  const retention = selectCleanupFunctionRetention(payload, retentionContext);

  for (const slug of retention.deleted) {
    const endpoint = new URL(
      `/v1/projects/${encodeURIComponent(projectRef)}/functions/${encodeURIComponent(slug)}`,
      "https://api.supabase.com",
    );
    const deletionPayload = await managementRequest(endpoint, accessToken, fetchImplementation, {
      label: "A remoção da Edge Function",
      method: "DELETE",
    });
    if (!isExactObject(deletionPayload, [])) {
      throw new Error("A Management API não confirmou exatamente a remoção da Edge Function.");
    }
  }

  if (retention.deleted.length > 0) {
    let verified = false;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const verificationPayload = await managementRequest(
        collection,
        accessToken,
        fetchImplementation,
        { label: "A verificação da retenção de Edge Functions" },
      );
      const remaining = selectCleanupFunctionRetention(verificationPayload, retentionContext);
      if (
        remaining.deleted.length === 0 &&
        remaining.retained.length === retention.retained.length &&
        remaining.retained.every((slug, index) => slug === retention.retained[index])
      ) {
        verified = true;
        break;
      }
      if (attempt < 9) await delay(500);
    }
    if (!verified) {
      throw new Error("A Management API não comprovou a retenção final das Edge Functions.");
    }
  }
  return retention;
}

async function readJsonFunction(client, statement, parameters, field, message) {
  const result = await client.query(statement, parameters);
  const value = result.rows[0]?.[field];
  if (
    result.rowCount !== 1 ||
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error(message);
  }
  return value;
}

async function prepareCleanupProbe(client, storage, runId) {
  const preparedPayload = await readJsonFunction(
    client,
    "select maintenance.prepare_studio_media_cleanup_probe($1::uuid) as probe",
    [runId],
    "probe",
    "O banco não preparou um canário de cleanup único.",
  );
  const prepared = assertCleanupProbe(preparedPayload, {
    runId,
    status: "prepared",
  });
  const bucket = storage.from(prepared.bucket);
  try {
    for (const path of prepared.paths) {
      const { error } = await bucket.upload(path, cleanupProbeObject, {
        cacheControl: "0",
        contentType: "image/webp",
        upsert: false,
      });
      if (error !== null) {
        throw new Error("O Storage recusou um objeto descartável do canário.");
      }
    }
    const armedPayload = await readJsonFunction(
      client,
      "select maintenance.arm_studio_media_cleanup_probe($1::uuid) as probe",
      [runId],
      "probe",
      "O banco não armou um canário de cleanup.",
    );
    return assertCleanupProbe(armedPayload, {
      identity: prepared,
      runId,
      status: "queued",
    });
  } catch (error) {
    const recoveryErrors = [];
    try {
      await removeAndVerifyCleanupProbe(storage, prepared);
    } catch {
      recoveryErrors.push(new Error("O canário parcial não teve a ausência física comprovada."));
    }
    if (recoveryErrors.length === 0) {
      try {
        await client.query(
          "select maintenance.abort_studio_media_cleanup_probe($1::uuid, $2::text)",
          [runId, "probe_preparation_failed"],
        );
      } catch {
        recoveryErrors.push(new Error("O canário parcial não foi abortado no banco."));
      }
    }
    if (recoveryErrors.length > 0) {
      throw new AggregateError([error, ...recoveryErrors], "A preparação do canário falhou.");
    }
    throw error;
  }
}

async function invokeCleanupFunction(fetchImplementation, secretKey, functionSlug, runId) {
  assertImmutableCleanupSlug(functionSlug);
  const endpoint = new URL(`/functions/v1/${functionSlug}`, productionCoordinates.supabaseUrl);
  const payload = await requestJson(fetchImplementation, endpoint, {
    body: JSON.stringify({ runId }),
    headers: { apikey: secretKey, "Content-Type": "application/json" },
    label: "A candidata de cleanup",
    method: "POST",
  });
  return assertCleanupResult(payload, { requireClaimed: true });
}

async function verifyCleanupRun(client, runId, functionSlug, result) {
  const payload = await readJsonFunction(
    client,
    `select pg_catalog.jsonb_build_object(
       'runId', run.run_id,
       'functionSlug', run.function_slug,
       'status', run.status,
       'claimed', run.claimed_count,
       'deleted', run.deleted_count,
       'failed', run.failed_count,
       'errorCode', run.error_code
     ) as run
     from maintenance.studio_media_cleanup_runs as run
     where run.run_id = $1::uuid`,
    [runId],
    "run",
    "O banco não retornou uma execução de cleanup única.",
  );
  return assertCleanupRun(payload, { ...result, functionSlug, runId });
}

async function verifyCleanupProbe(client, storage, expected) {
  const payload = await readJsonFunction(
    client,
    "select maintenance.get_studio_media_cleanup_probe($1::uuid) as probe",
    [expected.runId],
    "probe",
    "O banco não retornou o canário terminal de cleanup.",
  );
  const terminal = assertCleanupProbe(payload, {
    identity: expected,
    runId: expected.runId,
    status: "deleted",
  });
  await verifyStoragePathsAbsent(storage.from(terminal.bucket), terminal.paths);
}

async function abortCleanupProbe(client, storage, probe, errorCode) {
  const errors = [];
  try {
    await removeAndVerifyCleanupProbe(storage, probe);
  } catch {
    errors.push(new Error("O Storage não comprovou a recuperação do canário."));
    return errors;
  }
  try {
    await client.query("select maintenance.abort_studio_media_cleanup_probe($1::uuid, $2::text)", [
      probe.runId,
      safeErrorCodePattern.test(errorCode) ? errorCode : "probe_failed",
    ]);
  } catch {
    errors.push(new Error("O banco recusou a recuperação do canário."));
  }
  return errors;
}

async function runCleanupProbe(client, storage, fetchImplementation, secretKey, functionSlug) {
  const runId = randomUUID();
  const probe = await prepareCleanupProbe(client, storage, runId);
  try {
    const result = await invokeCleanupFunction(fetchImplementation, secretKey, functionSlug, runId);
    await verifyCleanupRun(client, runId, functionSlug, result);
    await verifyCleanupProbe(client, storage, probe);
    return result;
  } catch (error) {
    const recoveryErrors = await abortCleanupProbe(client, storage, probe, "probe_failed");
    if (recoveryErrors.length > 0) {
      throw new AggregateError([error, ...recoveryErrors], "O canário de cleanup falhou.");
    }
    throw error;
  }
}

export async function configureProductionMediaCleanup(
  environment = process.env,
  {
    createClient = (configuration) => new Client(configuration),
    createStorageClient = createProductionStorageClient,
    fetchImplementation = fetch,
  } = {},
) {
  if (typeof fetchImplementation !== "function") {
    throw new Error("O cliente HTTP do cleanup não está disponível.");
  }
  const candidateSlug = assertImmutableCleanupSlug(
    requiredValue(environment, "MEDIA_CLEANUP_FUNCTION_SLUG"),
  );
  const activeReleaseSha = assertReleaseSha(
    requiredValue(environment, "ACTIVE_PUBLIC_RELEASE_SHA"),
  );
  const projectRef = requiredValue(environment, "SUPABASE_PROJECT_REF");
  const accessToken = requiredValue(environment, "SUPABASE_ACCESS_TOKEN");
  const secretKey = assertDefaultSecretKey(requiredValue(environment, "PRD_SUPABASE_SECRET_KEY"));
  const connections = productionRoleConnections(environment);
  const storage = createStorageClient({ fetchImplementation, secretKey });
  const client = createClient({
    ...connections.admin,
    application_name: "set-livre-media-cleanup-canary",
  });

  try {
    await client.connect();
    await acquireCleanupConfigurationLock(client);
    const bucket = await client.query(
      `select
         bucket.id,
         bucket.name,
         bucket.public as "isPublic",
         bucket.file_size_limit::text as "fileSizeLimit",
         bucket.allowed_mime_types as "allowedMimeTypes"
       from storage.buckets as bucket
       where bucket.id = $1::text`,
      [mediaBucketName],
    );
    assertProductionMediaBucket(bucket.rows);
    await recoverStaleCleanupProbes(client, storage);
    await runCleanupProbe(client, storage, fetchImplementation, secretKey, candidateSlug);
  } finally {
    await client.end().catch(() => undefined);
  }

  const retention = await pruneCleanupFunctions(
    accessToken,
    projectRef,
    { activeReleaseSha, candidateSlug },
    fetchImplementation,
  );
  return {
    activeReleaseSha,
    candidateSlug,
    deletedFunctions: retention.deleted.length,
    retainedFunctions: retention.retained.length,
  };
}

function redactedError(error, environment) {
  let message = error instanceof Error ? error.message : "falha desconhecida";
  for (const value of [
    environment.SUPABASE_ACCESS_TOKEN,
    environment.SUPABASE_DB_PASSWORD,
    environment.PRD_DATABASE_URL_APP_DAL,
    environment.PRD_SUPABASE_SECRET_KEY,
  ]) {
    if (typeof value === "string" && value !== "") {
      message = message.replaceAll(value, "[REDACTED]");
    }
  }
  return message;
}

const executedPath = process.argv[1];
if (executedPath !== undefined && pathToFileURL(resolve(executedPath)).href === import.meta.url) {
  try {
    if (
      process.argv[2] === "--write-ephemeral-secret-key" &&
      process.argv[3] !== undefined &&
      process.argv[4] === undefined
    ) {
      await writeEphemeralDefaultSecretKey(process.env, process.argv[3]);
      process.stdout.write("Secret key efêmera materializada sem exposição.\n");
    } else if (process.argv[2] === "--read-active-release-sha" && process.argv[3] === undefined) {
      process.stdout.write(`${await readActivePublicReleaseSha()}\n`);
    } else if (process.argv[2] === undefined) {
      const result = await configureProductionMediaCleanup();
      process.stdout.write(
        `Cleanup de mídia ${result.candidateSlug} comprovado por HTTPS direto, ledger e Storage.\n`,
      );
    } else {
      throw new Error("Modo de configuração de cleanup desconhecido.");
    }
  } catch (error) {
    process.stderr.write(`production-media-cleanup: ${redactedError(error, process.env)}\n`);
    process.exitCode = 1;
  }
}

import { createHash, randomUUID } from "node:crypto";

import {
  studioMediaCommandSchema,
  studioMediaGallerySchema,
  type StudioEditor,
  type StudioMediaCommand,
  type StudioMediaGallery,
  type StudioMediaUploadPreparation,
} from "@set-livre/contracts";
import { expect, type Page, type Route } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import {
  closeFeat006PageBeforeCleanup,
  cleanupFeat006QaIdentity,
  createFeat006QaIdentity,
  createFeat006StudioThroughUi,
  fillFeat006Core,
  provisionFeat006Owner,
  withFeat006AdminPool,
  type Feat006QaIdentity,
} from "./feat-006-studio-core-revision";
import { readSafeE2EEnvironment } from "./e2e-environment";

const validPngBuffer = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const validPngDataUrl = `data:image/png;base64,${validPngBuffer.toString("base64")}`;
const validPngChecksum = createHash("sha256").update(validPngBuffer).digest("hex");

type MediaAction = StudioMediaCommand["action"];
type HarnessBehavior = Readonly<{
  action: MediaAction;
  kind: "advance-after-prepare" | "conflict" | "expired" | "lost-response" | "validation";
}>;

type PendingUpload = {
  byteSize: number;
  mediaId: string;
  mimeType: "image/avif" | "image/jpeg" | "image/png" | "image/webp";
  stored: boolean;
};

export type Feat008QaIdentity = Feat006QaIdentity;

type Feat008MediaHarness = Readonly<{
  actions: readonly MediaAction[];
  advanceGalleryAfterNextPrepare: () => void;
  conflictNext: (action: MediaAction) => void;
  expireNextFinalize: () => void;
  gallery: () => StudioMediaGallery;
  idempotencyKeysFor: (action: MediaAction) => readonly string[];
  loseNextResponse: (action: MediaAction) => void;
  loseNextSupersededFinalizeResponse: () => void;
  loseNextUploadAfterPersistence: () => void;
  loseNextUploadBeforePersistence: () => void;
  rejectNextUploadDefinitively: () => void;
  rejectNextFinalize: () => void;
  releasedReservationCount: () => number;
  replaceCoverRemotely: (mediaId: string) => void;
  replaceGalleryBoundary: (nextEditor: StudioEditor) => void;
  uploadAttempts: readonly string[];
}>;

function successPayload(data: unknown) {
  return JSON.stringify({ data, requestId: randomUUID() });
}

function errorPayload(
  code: "CONFLICT" | "UPLOAD_EXPIRED" | "UPLOAD_OBJECT_MISSING" | "VALIDATION_FAILED",
  message: string,
) {
  return JSON.stringify({ error: { code, message, requestId: randomUUID() } });
}

function fulfillJson(route: Route, body: string, status = 200) {
  return route.fulfill({ body, contentType: "application/json; charset=utf-8", status });
}

function mediaPreparation(
  editor: StudioEditor,
  command: Extract<StudioMediaCommand, { action: "studio.media.upload.prepare" }>,
  mediaId: string,
): StudioMediaUploadPreparation {
  const extension = command.payload.declaredMimeType === "image/jpeg" ? "jpg" : "png";
  return {
    bucket: "studio-media",
    expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    mediaId,
    path: `owners/${editor.scope}/studios/${editor.studioId}/revisions/${
      command.payload.expectedRevisionId
    }/${mediaId}.${extension}`,
    revisionId: command.payload.expectedRevisionId,
    revisionVersion: command.payload.expectedRevisionVersion,
    scope: editor.scope,
    signedToken: `qa-signed-${mediaId}`,
    studioId: editor.studioId,
  };
}

export function createFeat008QaIdentity(
  testInfo: Readonly<{ project: Readonly<{ name: string }> }>,
  scenario: string,
) {
  return createFeat006QaIdentity(testInfo, `feat008_${scenario}_${randomUUID().slice(0, 8)}`);
}

export async function closeFeat008PageBeforeCleanup(page: Page) {
  await closeFeat006PageBeforeCleanup(page);
}

async function removeFeat008Media(userId: string) {
  const result = await withFeat006AdminPool((pool) =>
    pool.query(
      `select media.storage_path, media.preview_storage_path
         from public.studio_media as media
        where media.uploaded_by = $1::uuid
        order by media.id`,
      [userId],
    ),
  );
  const paths = result.rows.flatMap((row) => {
    if (typeof row.storage_path !== "string" || typeof row.preview_storage_path !== "string") {
      throw new Error("A fixture FEAT-008 encontrou um path de Storage inválido.");
    }
    return [row.storage_path, row.preview_storage_path];
  });
  if (paths.length > 0) {
    const environment = readSafeE2EEnvironment();
    const client = createClient(environment.supabaseUrl, environment.supabaseSecretKey, {
      auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    });
    const { error } = await client.storage.from("studio-media").remove(paths);
    if (error !== null) throw new Error("A Storage API local recusou a limpeza FEAT-008.");
  }
  await withFeat006AdminPool(async (pool) => {
    await pool.query("begin");
    try {
      await pool.query(
        "delete from private.studio_command_requests where owner_user_id = $1::uuid",
        [userId],
      );
      await pool.query(
        `delete from public.studio_revision_media as relation
          where relation.media_id in (
            select media.id
              from public.studio_media as media
             where media.uploaded_by = $1::uuid
          )`,
        [userId],
      );
      await pool.query("delete from public.studio_media where uploaded_by = $1::uuid", [userId]);
      await pool.query("commit");
    } catch (error) {
      await pool.query("rollback");
      throw error;
    }
  });
}

export async function cleanupFeat008QaIdentity(identity: Feat008QaIdentity) {
  const failures: Error[] = [];
  if (identity.userId !== undefined) {
    try {
      await removeFeat008Media(identity.userId);
    } catch {
      failures.push(new Error("Não foi possível remover os objetos e fatos locais da FEAT-008."));
    }
  }
  try {
    await cleanupFeat006QaIdentity(identity);
  } catch {
    failures.push(new Error("Não foi possível remover a identidade-base da FEAT-008."));
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "A limpeza exata do cenário FEAT-008 falhou.");
  }
}

export async function expectFeat008StorageIsolation(
  ownerA: Feat008QaIdentity,
  ownerB: Feat008QaIdentity,
) {
  if (ownerA.userId === undefined) throw new Error("O dono A não foi provisionado.");
  const result = await withFeat006AdminPool((pool) =>
    pool.query(
      `select media.storage_path, media.preview_storage_path
         from public.studio_media as media
        where media.uploaded_by = $1::uuid
          and media.status = 'ready'
        order by media.id`,
      [ownerA.userId],
    ),
  );
  if (result.rows.length !== 1) {
    throw new Error("A prova A/B exige exatamente uma mídia pronta do dono A.");
  }
  const row = result.rows[0];
  if (typeof row?.storage_path !== "string" || typeof row.preview_storage_path !== "string") {
    throw new Error("A prova A/B encontrou paths privados inválidos.");
  }
  const environment = readSafeE2EEnvironment();
  for (const identity of [ownerA, ownerB]) {
    const client = createClient(environment.supabaseUrl, environment.supabaseAnonKey, {
      auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    });
    const login = await client.auth.signInWithPassword({
      email: identity.email,
      password: identity.password,
    });
    if (login.error !== null || login.data.user?.id !== identity.userId) {
      throw new Error("O dono não obteve a sessão esperada para o probe privado de Storage.");
    }
    try {
      const deniedMetadata = await client
        .from("studio_media")
        .select("storage_path,preview_storage_path");
      expect(deniedMetadata.data).toBeNull();
      expect(deniedMetadata.error).not.toBeNull();
      for (const path of [row.storage_path, row.preview_storage_path]) {
        const deniedRead = await client.storage.from("studio-media").download(path);
        expect(deniedRead.data).toBeNull();
        expect(deniedRead.error).not.toBeNull();
        const deniedSignedRead = await client.storage
          .from("studio-media")
          .createSignedUrl(path, 3_600);
        expect(deniedSignedRead.data).toBeNull();
        expect(deniedSignedRead.error).not.toBeNull();
      }
      const deniedUpload = await client.storage
        .from("studio-media")
        .createSignedUploadUrl(row.storage_path, { upsert: false });
      expect(deniedUpload.data).toBeNull();
      expect(deniedUpload.error).not.toBeNull();
    } finally {
      await client.auth.signOut({ scope: "local" });
    }
  }
}

export function feat008PngFile(name: string) {
  return { buffer: validPngBuffer, mimeType: "image/png", name };
}

export function feat008SpoofedPngFile(name: string) {
  return { buffer: Buffer.from("not-a-real-image", "utf8"), mimeType: "image/png", name };
}

export function feat008OversizedPngFile(name: string) {
  return { buffer: Buffer.alloc(15 * 1024 * 1024 + 1), mimeType: "image/png", name };
}

export async function installFeat008MediaHarness(page: Page, editor: StudioEditor) {
  const actions: MediaAction[] = [];
  const commands: StudioMediaCommand[] = [];
  const pendingUploads = new Map<string, PendingUpload>();
  const replayLedger = new Map<string, unknown>();
  const releasedReservations = new Set<string>();
  const uploadAttempts: string[] = [];
  let behavior: HarnessBehavior | undefined;
  let loseSupersededFinalizeResponse = false;
  let uploadFailure: "after-persistence" | "before-persistence" | "definitive" | undefined;
  let gallery = studioMediaGallerySchema.parse({
    items: [],
    previewExpiresAt: "2026-09-01T00:00:00.000Z",
    revisionId: editor.revision.id,
    revisionNumber: editor.revision.number,
    revisionVersion: editor.revision.version,
    scope: editor.scope,
    studioId: editor.studioId,
  });

  function publish(next: StudioMediaGallery) {
    gallery = studioMediaGallerySchema.parse(next);
    return gallery;
  }

  function execute(command: StudioMediaCommand) {
    const replay = replayLedger.get(command.idempotencyKey);
    if (replay !== undefined) return replay;

    let result: StudioMediaGallery | StudioMediaUploadPreparation;
    switch (command.action) {
      case "studio.media.upload.prepare": {
        const mediaId = randomUUID();
        result = mediaPreparation(editor, command, mediaId);
        pendingUploads.set(mediaId, {
          byteSize: command.payload.declaredByteSize,
          mediaId,
          mimeType: command.payload.declaredMimeType,
          stored: false,
        });
        break;
      }
      case "studio.media.upload.finalize": {
        const pending = pendingUploads.get(command.payload.mediaId);
        if (pending === undefined) throw new Error("O harness não encontrou o preparo do upload.");
        const existing = gallery.items.find((item) => item.id === pending.mediaId);
        result =
          existing === undefined
            ? publish({
                ...gallery,
                items: [
                  ...gallery.items,
                  {
                    byteSize: pending.byteSize,
                    checksumSha256: validPngChecksum,
                    height: 1,
                    id: pending.mediaId,
                    isCover: gallery.items.length === 0,
                    mimeType: pending.mimeType,
                    position: gallery.items.length + 1,
                    previewUrl: validPngDataUrl,
                    width: 1,
                  },
                ],
                revisionVersion: gallery.revisionVersion + 1,
              })
            : gallery;
        break;
      }
      case "studio.media.reorder": {
        const byId = new Map(gallery.items.map((item) => [item.id, item]));
        result = publish({
          ...gallery,
          items: command.payload.orderedMediaIds.map((mediaId, index) => {
            const item = byId.get(mediaId);
            if (item === undefined)
              throw new Error("A ordem do harness recebeu uma foto desconhecida.");
            return { ...item, position: index + 1 };
          }),
          revisionVersion: gallery.revisionVersion + 1,
        });
        break;
      }
      case "studio.media.cover.set":
        result = publish({
          ...gallery,
          items: gallery.items.map((item) => ({
            ...item,
            isCover: item.id === command.payload.mediaId,
          })),
          revisionVersion: gallery.revisionVersion + 1,
        });
        break;
      case "studio.media.delete": {
        const remaining = gallery.items
          .filter((item) => item.id !== command.payload.mediaId)
          .map((item, index) => ({ ...item, position: index + 1 }));
        result = publish({
          ...gallery,
          items: remaining,
          revisionVersion: gallery.revisionVersion + 1,
        });
        break;
      }
    }
    replayLedger.set(command.idempotencyKey, result);
    return result;
  }

  await page.route(`**/api/owner/studios/${editor.studioId}/media`, (route) =>
    fulfillJson(route, successPayload(gallery)),
  );
  await page.route("**/storage/v1/object/upload/sign/**", async (route) => {
    const requestPath = decodeURIComponent(new URL(route.request().url()).pathname);
    const matches = [...pendingUploads.entries()].filter(([mediaId]) =>
      requestPath.includes(mediaId),
    );
    if (matches.length !== 1) {
      await route.abort("failed");
      return;
    }
    const [mediaId, pending] = matches[0]!;
    uploadAttempts.push(mediaId);
    const activeFailure = uploadFailure;
    uploadFailure = undefined;
    if (activeFailure === "before-persistence") {
      await route.abort("failed");
      return;
    }
    if (activeFailure === "definitive") {
      await fulfillJson(
        route,
        JSON.stringify({
          code: "InvalidUploadToken",
          error: "Invalid request",
          message: "The signed upload token was rejected.",
          statusCode: "422",
        }),
        422,
      );
      return;
    }
    pendingUploads.set(mediaId, { ...pending, stored: true });
    if (activeFailure === "after-persistence") {
      await route.abort("failed");
      return;
    }
    await fulfillJson(route, JSON.stringify({ Key: route.request().url() }));
  });
  await page.route("**/api/commands", async (route) => {
    const parsed = studioMediaCommandSchema.safeParse(route.request().postDataJSON());
    if (!parsed.success) {
      await route.fallback();
      return;
    }
    const command = parsed.data;
    actions.push(command.action);
    commands.push(command);
    const activeBehavior = behavior?.action === command.action ? behavior : undefined;
    if (activeBehavior !== undefined) behavior = undefined;

    if (activeBehavior?.kind === "validation") {
      await fulfillJson(
        route,
        errorPayload("VALIDATION_FAILED", "A foto enviada não corresponde a uma imagem válida."),
        422,
      );
      return;
    }
    if (activeBehavior?.kind === "expired") {
      await fulfillJson(
        route,
        errorPayload("UPLOAD_EXPIRED", "A autorização de envio expirou. Renove o envio."),
        409,
      );
      return;
    }
    if (activeBehavior?.kind === "conflict") {
      publish({ ...gallery, revisionVersion: gallery.revisionVersion + 1 });
      if (command.action === "studio.media.upload.finalize") {
        releasedReservations.add(command.payload.mediaId);
        pendingUploads.delete(command.payload.mediaId);
      }
      await fulfillJson(route, errorPayload("CONFLICT", "A galeria mudou em outra sessão."), 409);
      return;
    }
    if (
      command.action === "studio.media.upload.finalize" &&
      (command.payload.expectedRevisionId !== gallery.revisionId ||
        command.payload.expectedRevisionVersion !== gallery.revisionVersion)
    ) {
      releasedReservations.add(command.payload.mediaId);
      pendingUploads.delete(command.payload.mediaId);
      if (loseSupersededFinalizeResponse) {
        loseSupersededFinalizeResponse = false;
        await route.abort("failed");
        return;
      }
      await fulfillJson(route, errorPayload("CONFLICT", "A galeria mudou em outra sessão."), 409);
      return;
    }
    if (command.action === "studio.media.upload.finalize") {
      const pending = pendingUploads.get(command.payload.mediaId);
      if (pending === undefined || !pending.stored) {
        releasedReservations.add(command.payload.mediaId);
        await fulfillJson(
          route,
          errorPayload(
            "UPLOAD_OBJECT_MISSING",
            "O arquivo não chegou ao armazenamento. Renove o envio antes de finalizar.",
          ),
          409,
        );
        return;
      }
    }

    const result = execute(command);
    if (activeBehavior?.kind === "advance-after-prepare") {
      if (command.action !== "studio.media.upload.prepare") {
        throw new Error("O avanço pós-preparo recebeu uma ação incompatível.");
      }
      publish({ ...gallery, revisionVersion: gallery.revisionVersion + 1 });
    }
    if (activeBehavior?.kind === "lost-response") {
      await route.abort("failed");
      return;
    }
    await fulfillJson(route, successPayload(result));
  });

  return {
    actions,
    advanceGalleryAfterNextPrepare() {
      behavior = { action: "studio.media.upload.prepare", kind: "advance-after-prepare" };
    },
    conflictNext(action) {
      behavior = { action, kind: "conflict" };
    },
    expireNextFinalize() {
      behavior = { action: "studio.media.upload.finalize", kind: "expired" };
    },
    gallery: () => gallery,
    idempotencyKeysFor(action) {
      return commands
        .filter((command) => command.action === action)
        .map((command) => command.idempotencyKey);
    },
    loseNextResponse(action) {
      behavior = { action, kind: "lost-response" };
    },
    loseNextSupersededFinalizeResponse() {
      loseSupersededFinalizeResponse = true;
    },
    loseNextUploadAfterPersistence() {
      uploadFailure = "after-persistence";
    },
    loseNextUploadBeforePersistence() {
      uploadFailure = "before-persistence";
    },
    rejectNextUploadDefinitively() {
      uploadFailure = "definitive";
    },
    rejectNextFinalize() {
      behavior = { action: "studio.media.upload.finalize", kind: "validation" };
    },
    releasedReservationCount: () => releasedReservations.size,
    replaceCoverRemotely(mediaId) {
      if (!gallery.items.some((item) => item.id === mediaId)) {
        throw new Error("A mutação remota recebeu uma foto desconhecida.");
      }
      publish({
        ...gallery,
        items: gallery.items.map((item) => ({ ...item, isCover: item.id === mediaId })),
        revisionVersion: gallery.revisionVersion + 1,
      });
    },
    replaceGalleryBoundary(nextEditor) {
      if (nextEditor.scope !== editor.scope || nextEditor.studioId !== editor.studioId) {
        throw new Error("A troca remota da galeria recebeu outro escopo de estúdio.");
      }
      publish({
        items: [],
        previewExpiresAt: "2026-09-01T00:00:00.000Z",
        revisionId: nextEditor.revision.id,
        revisionNumber: nextEditor.revision.number,
        revisionVersion: nextEditor.revision.version,
        scope: nextEditor.scope,
        studioId: nextEditor.studioId,
      });
    },
    uploadAttempts,
  } satisfies Feat008MediaHarness;
}

export async function provisionFeat008Studio(
  page: Page,
  identity: Feat008QaIdentity,
  suffix: string,
) {
  const fixture = await createFeat008StudioFixture(page, identity, suffix);
  await openFeat008MediaPage(page, fixture.editor);
  return fixture;
}

export async function provisionFeat008StudioWithHarness(
  page: Page,
  identity: Feat008QaIdentity,
  suffix: string,
) {
  const fixture = await createFeat008StudioFixture(page, identity, suffix);
  const harness = await installFeat008MediaHarness(page, fixture.editor);
  await openFeat008MediaPage(page, fixture.editor);
  return { ...fixture, harness };
}

async function openFeat008MediaPage(page: Page, editor: StudioEditor) {
  const navigation = await page.goto(`/dono/estudios/${editor.studioId}/midia`);
  expect(navigation?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: "Fotos do estúdio" })).toBeVisible();
  await expect(page.getByText("0 de 20 fotos", { exact: true })).toBeVisible();
}

export async function createFeat008StudioFixture(
  page: Page,
  identity: Feat008QaIdentity,
  suffix: string,
) {
  await provisionFeat006Owner(page, identity, suffix);
  await fillFeat006Core(page, { name: `Estúdio de mídia QA ${suffix}` });
  const editor = await createFeat006StudioThroughUi(page);
  return { editor };
}

export function observeFeat008MediaActions(page: Page) {
  const actions: MediaAction[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST" || new URL(request.url()).pathname !== "/api/commands") return;
    const command = studioMediaCommandSchema.safeParse(request.postDataJSON());
    if (command.success) actions.push(command.data.action);
  });
  return actions;
}

export async function uploadFeat008Photos(page: Page, names: readonly string[]) {
  const before = await page.getByText(/\d+ de 20 fotos/u).textContent();
  const initialCount = Number(/^(\d+)/u.exec(before ?? "")?.[1]);
  if (!Number.isSafeInteger(initialCount)) throw new Error("O contador FEAT-008 não é numérico.");
  await page.getByLabel("Selecionar fotos").setInputFiles(names.map(feat008PngFile));
  await expect(
    page.getByText(`${initialCount + names.length} de 20 fotos`, { exact: true }),
  ).toBeVisible();
  for (const name of names) {
    await expect(page.getByText(name, { exact: true })).toBeVisible();
  }
}

import {
  studioEditorSchema,
  type StudioEditor,
  type StudioMediaGallery,
  type StudioPublication,
} from "@set-livre/contracts";
import type { QueryClient } from "@tanstack/react-query";

const studioPrivateRoot = ["owner", "private", "studio-editor"] as const;
const studioPrivateTaxonomiesRoot = ["owner", "private", "studio-taxonomies"] as const;
const studioPrivateMediaRoot = ["owner", "private", "studio-media"] as const;

export const studioQueryKeys = {
  creationAccess: (userId: string) => ["owner", "private", "studio-create", userId] as const,
  editor: (userId: string, studioId: string) => [...studioPrivateRoot, userId, studioId] as const,
  privateEditors: studioPrivateRoot,
  privateMedia: studioPrivateMediaRoot,
  privateTaxonomies: studioPrivateTaxonomiesRoot,
  taxonomies: (userId: string) => [...studioPrivateTaxonomiesRoot, userId, "content"] as const,
  media: (userId: string, studioId: string) =>
    [...studioPrivateMediaRoot, userId, studioId] as const,
  publication: (userId: string, studioId: string) =>
    [...studioPrivateRoot, userId, studioId, "publication"] as const,
  types: (userId: string) => [...studioPrivateTaxonomiesRoot, userId, "types"] as const,
};

export type StudioRevisionToken = Readonly<
  Pick<StudioEditor["revision"], "id" | "number" | "version">
>;

export function studioMediaOrderMatchesIntent(
  items: ReadonlyArray<Readonly<{ id: string }>>,
  orderedMediaIds: readonly string[],
) {
  return (
    items.length === orderedMediaIds.length &&
    items.every((item, index) => item.id === orderedMediaIds[index])
  );
}

export function studioRevisionToken(editor: StudioEditor): StudioRevisionToken {
  return {
    id: editor.revision.id,
    number: editor.revision.number,
    version: editor.revision.version,
  };
}

export function recomposeStudioClientBoundary(queryClient: QueryClient) {
  queryClient.clear();
  window.location.reload();
}

export class StudioScopeChangedError extends Error {
  constructor() {
    super("O editor retornado não corresponde ao usuário ou ao estúdio esperados.");
    this.name = "StudioScopeChangedError";
  }
}

export class StudioMediaScopeChangedError extends Error {
  constructor() {
    super("A galeria retornada não corresponde ao usuário ou ao estúdio esperado.");
    this.name = "StudioMediaScopeChangedError";
  }
}

export class StudioPublicationScopeChangedError extends Error {
  constructor() {
    super("A publicação retornada não corresponde ao usuário ou ao estúdio esperado.");
    this.name = "StudioPublicationScopeChangedError";
  }
}

export class StudioPublicationProjectionConflictError extends Error {
  constructor() {
    super("A projeção editorial retornou conteúdo divergente para a mesma versão canônica.");
    this.name = "StudioPublicationProjectionConflictError";
  }
}

export function isStudioPublicationBoundaryChangedError(error: unknown): boolean {
  return (
    error instanceof StudioPublicationScopeChangedError ||
    error instanceof StudioPublicationProjectionConflictError
  );
}

function studioPublicationMatchesBoundary(
  publication: StudioPublication | undefined,
  expectedUserId: string,
  expectedStudioId: string,
) {
  return (
    publication !== undefined &&
    publication.scope === expectedUserId &&
    publication.studioId === expectedStudioId
  );
}

export function studioPublicationCanRender(
  publication: StudioPublication | undefined,
  expectedUserId: string,
  expectedStudioId: string,
  fetchStatus: "fetching" | "idle" | "paused",
  hasError: boolean,
) {
  return (
    fetchStatus === "idle" &&
    !hasError &&
    studioPublicationMatchesBoundary(publication, expectedUserId, expectedStudioId)
  );
}

export function assertStudioPublicationBoundary(
  publication: StudioPublication,
  expectedUserId: string,
  expectedStudioId: string,
) {
  if (!studioPublicationMatchesBoundary(publication, expectedUserId, expectedStudioId)) {
    throw new StudioPublicationScopeChangedError();
  }
  return publication;
}

function publicationRevisionContentToken(revision: StudioPublication["currentRevision"] | null) {
  if (revision === null) return null;
  const { cover, ...revisionWithoutCover } = revision;
  if (cover === null) return { ...revisionWithoutCover, cover: null };
  const { previewUrl, ...coverWithoutPreviewUrl } = cover;
  void previewUrl;
  return { ...revisionWithoutCover, cover: coverWithoutPreviewUrl };
}

function publicationContentToken(publication: StudioPublication) {
  const { currentRevision, previewExpiresAt, publishedRevision, ...publicationWithoutPreviews } =
    publication;
  void previewExpiresAt;
  return JSON.stringify({
    ...publicationWithoutPreviews,
    currentRevision: publicationRevisionContentToken(currentRevision),
    publishedRevision: publicationRevisionContentToken(publishedRevision),
  });
}

export function preserveNewestStudioPublication(
  current: StudioPublication | undefined,
  candidate: StudioPublication,
  expectedUserId: string,
  expectedStudioId: string,
) {
  const scopedCandidate = assertStudioPublicationBoundary(
    candidate,
    expectedUserId,
    expectedStudioId,
  );
  if (current === undefined) return scopedCandidate;
  const scopedCurrent = assertStudioPublicationBoundary(current, expectedUserId, expectedStudioId);
  if (scopedCurrent.publicationVersion > scopedCandidate.publicationVersion) return scopedCurrent;
  if (scopedCurrent.publicationVersion < scopedCandidate.publicationVersion) return scopedCandidate;
  if (
    scopedCurrent.currentRevision.id !== scopedCandidate.currentRevision.id ||
    scopedCurrent.currentRevision.number !== scopedCandidate.currentRevision.number
  ) {
    throw new StudioPublicationProjectionConflictError();
  }
  if (scopedCurrent.currentRevision.version > scopedCandidate.currentRevision.version) {
    return scopedCurrent;
  }
  if (scopedCurrent.currentRevision.version < scopedCandidate.currentRevision.version) {
    return scopedCandidate;
  }
  if (publicationContentToken(scopedCurrent) !== publicationContentToken(scopedCandidate)) {
    throw new StudioPublicationProjectionConflictError();
  }
  if (
    scopedCurrent.previewExpiresAt !== null &&
    scopedCandidate.previewExpiresAt !== null &&
    Date.parse(scopedCurrent.previewExpiresAt) > Date.parse(scopedCandidate.previewExpiresAt)
  ) {
    return scopedCurrent;
  }
  return scopedCandidate;
}

export function publishStudioPublication(
  queryClient: QueryClient,
  publication: StudioPublication,
  expectedUserId: string,
  expectedStudioId: string,
) {
  const queryKey = studioQueryKeys.publication(expectedUserId, expectedStudioId);
  const current = queryClient.getQueryData<StudioPublication>(queryKey);
  if (current === undefined) throw new StudioPublicationScopeChangedError();
  const selected = preserveNewestStudioPublication(
    current,
    publication,
    expectedUserId,
    expectedStudioId,
  );
  queryClient.removeQueries({
    predicate: (query) => {
      const key = query.queryKey;
      return (
        key.length === 6 &&
        key[0] === studioPrivateRoot[0] &&
        key[1] === studioPrivateRoot[1] &&
        key[2] === studioPrivateRoot[2] &&
        key[5] === "publication" &&
        key[3] !== expectedUserId
      );
    },
    queryKey: studioPrivateRoot,
  });
  queryClient.setQueryData(queryKey, selected);
  return selected;
}

export async function invalidateStudioPublicationDependents(
  queryClient: QueryClient,
  expectedUserId: string,
  expectedStudioId: string,
) {
  await Promise.all([
    queryClient.invalidateQueries({
      exact: true,
      queryKey: studioQueryKeys.editor(expectedUserId, expectedStudioId),
    }),
    queryClient.invalidateQueries({
      exact: true,
      queryKey: studioQueryKeys.media(expectedUserId, expectedStudioId),
    }),
  ]);
}

export function assertStudioMediaBoundary(
  gallery: StudioMediaGallery,
  expectedUserId: string,
  expectedStudioId: string,
) {
  if (gallery.scope !== expectedUserId || gallery.studioId !== expectedStudioId) {
    throw new StudioMediaScopeChangedError();
  }
  return gallery;
}

type StudioMediaGalleryEvidence =
  | Readonly<{ gallery: StudioMediaGallery; kind: "authoritative-read" }>
  | Readonly<{ gallery: StudioMediaGallery; kind: "command-result" }>;

function selectStudioMediaGallery(
  current: StudioMediaGallery | undefined,
  evidence: StudioMediaGalleryEvidence,
  expectedUserId: string,
  expectedStudioId: string,
) {
  const scopedCandidate = assertStudioMediaBoundary(
    evidence.gallery,
    expectedUserId,
    expectedStudioId,
  );
  if (current === undefined) return scopedCandidate;
  const scopedCurrent = assertStudioMediaBoundary(current, expectedUserId, expectedStudioId);
  if (
    scopedCurrent.revisionNumber === scopedCandidate.revisionNumber &&
    scopedCurrent.revisionId !== scopedCandidate.revisionId
  ) {
    throw new StudioMediaScopeChangedError();
  }
  if (
    evidence.kind === "command-result" &&
    scopedCurrent.revisionNumber > scopedCandidate.revisionNumber
  ) {
    return scopedCurrent;
  }
  if (
    scopedCurrent.revisionNumber === scopedCandidate.revisionNumber &&
    scopedCurrent.revisionVersion > scopedCandidate.revisionVersion
  ) {
    return scopedCurrent;
  }
  if (
    scopedCurrent.revisionNumber === scopedCandidate.revisionNumber &&
    scopedCurrent.revisionVersion === scopedCandidate.revisionVersion &&
    Date.parse(scopedCurrent.previewExpiresAt) > Date.parse(scopedCandidate.previewExpiresAt)
  ) {
    return scopedCurrent;
  }
  return scopedCandidate;
}

/**
 * Reconciles only the latest non-cancelled media GET. A different revision can therefore be an
 * authoritative replacement, while version and preview freshness remain monotonic inside it.
 */
export function preserveNewestStudioMediaGallery(
  current: StudioMediaGallery | undefined,
  candidate: StudioMediaGallery,
  expectedUserId: string,
  expectedStudioId: string,
) {
  return selectStudioMediaGallery(
    current,
    { gallery: candidate, kind: "authoritative-read" },
    expectedUserId,
    expectedStudioId,
  );
}

function publishSelectedStudioMediaGallery(
  queryClient: QueryClient,
  evidence: StudioMediaGalleryEvidence,
  expectedUserId: string,
  expectedStudioId: string,
) {
  const queryKey = studioQueryKeys.media(expectedUserId, expectedStudioId);
  const current = queryClient.getQueryData<StudioMediaGallery>(queryKey);
  if (current === undefined) throw new StudioMediaScopeChangedError();
  const selected = selectStudioMediaGallery(current, evidence, expectedUserId, expectedStudioId);
  queryClient.setQueryData(queryKey, selected);
  return selected;
}

export function publishStudioMediaGallery(
  queryClient: QueryClient,
  gallery: StudioMediaGallery,
  expectedUserId: string,
  expectedStudioId: string,
) {
  return publishSelectedStudioMediaGallery(
    queryClient,
    { gallery, kind: "command-result" },
    expectedUserId,
    expectedStudioId,
  );
}

export function publishAuthoritativeStudioMediaGallery(
  queryClient: QueryClient,
  gallery: StudioMediaGallery,
  expectedUserId: string,
  expectedStudioId: string,
) {
  return publishSelectedStudioMediaGallery(
    queryClient,
    { gallery, kind: "authoritative-read" },
    expectedUserId,
    expectedStudioId,
  );
}

export async function removeStudioMediaGallery(
  queryClient: QueryClient,
  expectedUserId: string,
  expectedStudioId: string,
) {
  const queryKey = studioQueryKeys.media(expectedUserId, expectedStudioId);
  await queryClient.cancelQueries({ exact: true, queryKey });
  queryClient.removeQueries({ exact: true, queryKey });
}

function studioEditorMatchesBoundary(
  editor: StudioEditor | undefined,
  expectedUserId: string,
  expectedStudioId: string,
) {
  return (
    editor !== undefined && editor.scope === expectedUserId && editor.studioId === expectedStudioId
  );
}

export function studioEditorCanRender(
  editor: StudioEditor | undefined,
  expectedUserId: string,
  expectedStudioId: string,
  fetchStatus: "fetching" | "idle" | "paused",
  hasError: boolean,
) {
  return (
    fetchStatus === "idle" &&
    !hasError &&
    studioEditorMatchesBoundary(editor, expectedUserId, expectedStudioId)
  );
}

export function assertStudioEditorBoundary(
  editor: StudioEditor,
  expectedUserId: string,
  expectedStudioId: string,
) {
  if (!studioEditorMatchesBoundary(editor, expectedUserId, expectedStudioId)) {
    throw new StudioScopeChangedError();
  }
  return editor;
}

type StudioEditorEvidence =
  | Readonly<{ editor: StudioEditor; kind: "authoritative-read" }>
  | Readonly<{
      editor: StudioEditor;
      expectedEditor: StudioEditor;
      kind: "command-result";
    }>;

function studioEditorProjectionToken(editor: StudioEditor) {
  return JSON.stringify(studioEditorSchema.parse(editor));
}

function selectStudioEditor(
  current: StudioEditor | undefined,
  evidence: StudioEditorEvidence,
  expectedUserId: string,
  expectedStudioId: string,
) {
  const scopedCandidate = assertStudioEditorBoundary(
    evidence.editor,
    expectedUserId,
    expectedStudioId,
  );
  const scopedExpected =
    evidence.kind === "command-result"
      ? assertStudioEditorBoundary(evidence.expectedEditor, expectedUserId, expectedStudioId)
      : undefined;
  if (current === undefined) return scopedCandidate;
  const scopedCurrent = assertStudioEditorBoundary(current, expectedUserId, expectedStudioId);
  if (
    scopedCurrent.revision.number === scopedCandidate.revision.number &&
    scopedCurrent.revision.id !== scopedCandidate.revision.id
  ) {
    throw new StudioScopeChangedError();
  }
  if (evidence.kind === "command-result") {
    if (
      scopedExpected === undefined ||
      studioEditorProjectionToken(scopedCurrent) !== studioEditorProjectionToken(scopedExpected)
    ) {
      return scopedCurrent;
    }
    return scopedCandidate;
  }
  if (
    scopedCurrent.revision.number === scopedCandidate.revision.number &&
    scopedCurrent.revision.version > scopedCandidate.revision.version
  )
    return scopedCurrent;
  return scopedCandidate;
}

export function preserveNewestStudioEditor(
  current: StudioEditor | undefined,
  candidate: StudioEditor,
  expectedUserId: string,
  expectedStudioId: string,
) {
  return selectStudioEditor(
    current,
    { editor: candidate, kind: "authoritative-read" },
    expectedUserId,
    expectedStudioId,
  );
}

function publishSelectedStudioEditor(
  queryClient: QueryClient,
  evidence: StudioEditorEvidence,
  expectedUserId: string,
  expectedStudioId: string,
) {
  const queryKey = studioQueryKeys.editor(expectedUserId, expectedStudioId);
  const current = queryClient.getQueryData<StudioEditor>(queryKey);
  if (current === undefined) throw new StudioScopeChangedError();
  const selected = selectStudioEditor(current, evidence, expectedUserId, expectedStudioId);
  queryClient.removeQueries({
    predicate: (query) => {
      const key = query.queryKey;
      return (
        key.length === 5 &&
        key[0] === studioPrivateRoot[0] &&
        key[1] === studioPrivateRoot[1] &&
        key[2] === studioPrivateRoot[2] &&
        key[3] !== expectedUserId
      );
    },
  });
  queryClient.setQueryData(queryKey, selected);
  return selected;
}

export function publishStudioEditor(
  queryClient: QueryClient,
  editor: StudioEditor,
  expectedEditor: StudioEditor,
  expectedUserId: string,
  expectedStudioId: string,
) {
  return publishSelectedStudioEditor(
    queryClient,
    { editor, expectedEditor, kind: "command-result" },
    expectedUserId,
    expectedStudioId,
  );
}

export function publishAuthoritativeStudioEditor(
  queryClient: QueryClient,
  editor: StudioEditor,
  expectedUserId: string,
  expectedStudioId: string,
) {
  return publishSelectedStudioEditor(
    queryClient,
    { editor, kind: "authoritative-read" },
    expectedUserId,
    expectedStudioId,
  );
}

export async function publishStudioEditorAfterPendingRead(
  queryClient: QueryClient,
  editor: StudioEditor,
  expectedEditor: StudioEditor,
  expectedUserId: string,
  expectedStudioId: string,
) {
  const queryKey = studioQueryKeys.editor(expectedUserId, expectedStudioId);
  if (queryClient.isFetching({ exact: true, queryKey }) > 0) {
    await queryClient.refetchQueries(
      { exact: true, queryKey },
      { cancelRefetch: false, throwOnError: false },
    );
  }
  return publishStudioEditor(queryClient, editor, expectedEditor, expectedUserId, expectedStudioId);
}

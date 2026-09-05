"use client";

import type { StudioEditor, StudioTaxonomies, StudioTypeOption } from "@set-livre/contracts";
import { Stack } from "@set-livre/ui";
import { useState } from "react";

import { StudioCorePanel } from "./studio-core-panel";
import { StudioEditorNavigation } from "./studio-editor-navigation";
import { studioRevisionToken, type StudioRevisionToken } from "./studio-query-keys";
import { StudioTaxonomyContentPanel } from "./studio-taxonomy-content-panel";

type StudioEditorCommandSurface = "commercial" | "core";
type StudioEditorFormSurface = "content" | "core" | "taxonomy";

type StudioEditorRevisionState = Readonly<{
  content: StudioRevisionToken;
  core: StudioRevisionToken;
  discard: StudioRevisionToken;
  taxonomy: StudioRevisionToken;
}>;

function sameRevision(left: StudioRevisionToken, right: StudioRevisionToken) {
  return left.id === right.id && left.number === right.number && left.version === right.version;
}

function preserveNewestRevision(
  current: StudioRevisionToken,
  candidate: StudioRevisionToken,
): StudioRevisionToken {
  if (
    current.id === candidate.id &&
    current.number === candidate.number &&
    current.version > candidate.version
  ) {
    return current;
  }
  return candidate;
}

function advanceEditorRevisions(
  current: StudioEditorRevisionState,
  source: StudioEditorFormSurface,
  saved: StudioRevisionToken,
  commandResult: StudioRevisionToken = saved,
): StudioEditorRevisionState {
  const sourceRevision = current[source];
  const accepted = preserveNewestRevision(sourceRevision, saved);
  const selectedCommandResult = sameRevision(saved, commandResult);
  const advanceSurface = (surface: StudioEditorFormSurface) => {
    if (surface === source) return accepted;
    return selectedCommandResult && sameRevision(current[surface], sourceRevision)
      ? accepted
      : current[surface];
  };
  return {
    content: advanceSurface("content"),
    core: advanceSurface("core"),
    discard: preserveNewestRevision(current.discard, accepted),
    taxonomy: advanceSurface("taxonomy"),
  };
}

export function StudioEditorPanels({
  initialEditor,
  initialTaxonomies,
  initialTypes,
  userId,
}: Readonly<{
  initialEditor: StudioEditor;
  initialTaxonomies: StudioTaxonomies;
  initialTypes: readonly StudioTypeOption[];
  userId: string;
}>) {
  const [revisions, setRevisions] = useState<StudioEditorRevisionState>(() => {
    const initialRevision = studioRevisionToken(initialEditor);
    return {
      content: initialRevision,
      core: initialRevision,
      discard: initialRevision,
      taxonomy: initialRevision,
    };
  });
  const [authoritativeEditor, setAuthoritativeEditor] = useState(initialEditor);
  const [commercialGeneration, setCommercialGeneration] = useState(0);
  const [commandSurface, setCommandSurface] = useState<StudioEditorCommandSurface>();
  const [studioDeleted, setStudioDeleted] = useState(false);

  function acceptEditorSave(
    surface: StudioEditorFormSurface,
    editor: StudioEditor,
    commandRevision: StudioRevisionToken,
  ) {
    const revision = studioRevisionToken(editor);
    setAuthoritativeEditor(editor);
    setRevisions((current) => advanceEditorRevisions(current, surface, revision, commandRevision));
  }

  function replaceAuthoritativeEditor(editor: StudioEditor) {
    const revision = studioRevisionToken(editor);
    setAuthoritativeEditor(editor);
    setRevisions({ content: revision, core: revision, discard: revision, taxonomy: revision });
    setCommercialGeneration((current) => current + 1);
  }

  function finishCommand(surface: StudioEditorCommandSurface) {
    setCommandSurface((current) => (current === surface ? undefined : current));
  }

  return (
    <Stack space={6}>
      {studioDeleted ? null : (
        <StudioEditorNavigation current="dados" studioId={initialEditor.studioId} />
      )}
      <StudioCorePanel
        discardRevision={revisions.discard}
        externalCommandLocked={commandSurface === "commercial"}
        formRevision={revisions.core}
        initialEditor={authoritativeEditor}
        initialTypes={initialTypes}
        mode="edit"
        onAuthoritativeRevisionAdvance={(editor, commandRevision) =>
          acceptEditorSave("core", editor, commandRevision)
        }
        onAuthoritativeRevisionReplacement={replaceAuthoritativeEditor}
        onCommandFinish={() => finishCommand("core")}
        onCommandStart={() => setCommandSurface("core")}
        onFormRevisionChange={(core) => setRevisions((current) => ({ ...current, core }))}
        onStudioDeleted={() => setStudioDeleted(true)}
        userId={userId}
      />
      {studioDeleted ? null : (
        <StudioTaxonomyContentPanel
          contentRevision={revisions.content}
          externalCommandLocked={commandSurface === "core"}
          key={`commercial-${commercialGeneration}`}
          initialEditor={authoritativeEditor}
          initialTaxonomies={initialTaxonomies}
          onContentRevisionChange={(content) =>
            setRevisions((current) => ({ ...current, content }))
          }
          onContentSave={(editor, commandRevision) =>
            acceptEditorSave("content", editor, commandRevision)
          }
          onCommandFinish={() => finishCommand("commercial")}
          onCommandStart={() => setCommandSurface("commercial")}
          onTaxonomyRevisionChange={(taxonomy) =>
            setRevisions((current) => ({ ...current, taxonomy }))
          }
          onTaxonomySave={(editor, commandRevision) =>
            acceptEditorSave("taxonomy", editor, commandRevision)
          }
          taxonomyRevision={revisions.taxonomy}
          userId={userId}
        />
      )}
    </Stack>
  );
}

export const studioEditorPanelsInternals = { advanceEditorRevisions };

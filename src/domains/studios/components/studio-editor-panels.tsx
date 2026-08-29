"use client";

import type { StudioEditor, StudioTaxonomies, StudioTypeOption } from "@set-livre/contracts";
import { Stack } from "@set-livre/ui";
import { useState } from "react";

import { StudioCorePanel } from "./studio-core-panel";
import { studioRevisionToken } from "./studio-query-keys";
import { StudioTaxonomyContentPanel } from "./studio-taxonomy-content-panel";

type StudioEditorCommandSurface = "commercial" | "core";

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
  const [coreRevision, setCoreRevision] = useState(() => studioRevisionToken(initialEditor));
  const [discardRevision, setDiscardRevision] = useState(() => studioRevisionToken(initialEditor));
  const [taxonomyRevision, setTaxonomyRevision] = useState(() =>
    studioRevisionToken(initialEditor),
  );
  const [contentRevision, setContentRevision] = useState(() => studioRevisionToken(initialEditor));
  const [authoritativeEditor, setAuthoritativeEditor] = useState(initialEditor);
  const [commercialGeneration, setCommercialGeneration] = useState(0);
  const [commandSurface, setCommandSurface] = useState<StudioEditorCommandSurface>();
  const [studioDeleted, setStudioDeleted] = useState(false);

  function acceptEditorSave(editor: StudioEditor) {
    const revision = studioRevisionToken(editor);
    setAuthoritativeEditor(editor);
    setCoreRevision(revision);
    setDiscardRevision(revision);
    setTaxonomyRevision(revision);
    setContentRevision(revision);
  }

  function replaceAuthoritativeEditor(editor: StudioEditor) {
    const revision = studioRevisionToken(editor);
    setAuthoritativeEditor(editor);
    setCoreRevision(revision);
    setDiscardRevision(revision);
    setTaxonomyRevision(revision);
    setContentRevision(revision);
    setCommercialGeneration((current) => current + 1);
  }

  function finishCommand(surface: StudioEditorCommandSurface) {
    setCommandSurface((current) => (current === surface ? undefined : current));
  }

  return (
    <Stack space={6}>
      <StudioCorePanel
        discardRevision={discardRevision}
        externalCommandLocked={commandSurface === "commercial"}
        formRevision={coreRevision}
        initialEditor={authoritativeEditor}
        initialTypes={initialTypes}
        mode="edit"
        onAuthoritativeRevisionAdvance={acceptEditorSave}
        onAuthoritativeRevisionReplacement={replaceAuthoritativeEditor}
        onCommandFinish={() => finishCommand("core")}
        onCommandStart={() => setCommandSurface("core")}
        onDiscardRevisionChange={setDiscardRevision}
        onFormRevisionChange={setCoreRevision}
        onStudioDeleted={() => setStudioDeleted(true)}
        userId={userId}
      />
      {studioDeleted ? null : (
        <StudioTaxonomyContentPanel
          contentRevision={contentRevision}
          externalCommandLocked={commandSurface === "core"}
          key={`commercial-${commercialGeneration}`}
          initialEditor={authoritativeEditor}
          initialTaxonomies={initialTaxonomies}
          onContentRevisionChange={setContentRevision}
          onContentSave={acceptEditorSave}
          onCommandFinish={() => finishCommand("commercial")}
          onCommandStart={() => setCommandSurface("commercial")}
          onTaxonomyRevisionChange={setTaxonomyRevision}
          onTaxonomySave={acceptEditorSave}
          taxonomyRevision={taxonomyRevision}
          userId={userId}
        />
      )}
    </Stack>
  );
}

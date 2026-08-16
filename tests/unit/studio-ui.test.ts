import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function studioComponent(fileName: string) {
  return readFileSync(resolve(process.cwd(), `src/domains/studios/components/${fileName}`), "utf8");
}

function studioPage(path: string) {
  return readFileSync(resolve(process.cwd(), `src/app/dono/estudios/${path}`), "utf8");
}

describe("FEAT-006 studio editor UI", () => {
  it("keeps SSR authorization before every private editor read", () => {
    const createPage = studioPage("novo/page.tsx");
    const editPage = studioPage("[studioId]/dados/page.tsx");

    for (const page of [createPage, editPage]) {
      const routeBoundary = page.slice(page.indexOf("export default async function"));
      expect(page).toContain("await readComponentIdentitySession()");
      expect(page).toContain('session.status === "suspended"');
      expect(page).toContain("!session.profileCompleted");
      expect(routeBoundary.indexOf("!session.authenticated")).toBeLessThan(
        routeBoundary.indexOf("<ActiveOwner"),
      );
    }
    expect(createPage).toContain('redirect("/entrar?retorno=%2Fdono%2Festudios%2Fnovo")');
    expect(editPage).toContain("ownerStudioEditorQuerySchema.safeParse");
    expect(editPage).toContain('error.code === "NOT_FOUND"');
    expect(editPage).toContain("notFound()");
    const createAccess = createPage.slice(
      createPage.indexOf("async function ActiveOwnerNewStudioEditor"),
      createPage.indexOf("export default async function"),
    );
    const editAccess = editPage.slice(
      editPage.indexOf("async function ActiveOwnerStudioEditor"),
      editPage.indexOf("export default async function"),
    );
    for (const access of [createAccess, editAccess]) {
      expect(access).toContain("await readOwnerRecipient(userId)");
      expect(access).toContain('owner.ownerStatus !== "active"');
    }
    expect(createAccess.indexOf("await readOwnerRecipient(userId)")).toBeLessThan(
      createAccess.indexOf("await readOwnerStudioEditor"),
    );
    expect(editAccess.indexOf("await readOwnerRecipient(userId)")).toBeLessThan(
      editAccess.indexOf("await readExistingStudioEditor"),
    );
    const accessState = studioComponent("studio-access-state.tsx");
    expect(accessState).toContain("Ative seu cadastro de dono");
    expect(accessState).toContain('href="/dono"');
  });

  it("uses one closed TanStack boundary for create/edit and no client-side ownership proof", () => {
    const panel = studioComponent("studio-editor-panel.tsx");
    const cache = studioComponent("studio-query-keys.ts");

    expect(panel).toContain("readNewestStudioEditorResult(");
    expect(panel).toContain("studioEditorCanRender(");
    expect(panel).toContain('refetchOnMount: "always"');
    expect(panel).toContain("refetchOnReconnect: () => !formDirtyRef.current");
    expect(panel).toContain("refetchOnWindowFocus: () => !formDirtyRef.current");
    expect(panel).toContain("formDirtyRef.current = true");
    expect(studioComponent("studio-core-form.tsx")).toContain("onInputCapture={onDirty}");
    expect(panel).toContain("retry: false");
    expect(panel).toContain("staleTime: 0");
    expect(panel).toContain("seedAuthoritativeStudioEditor(");
    expect(panel).toContain("publishNewestStudioEditorMutationResult(");
    expect(panel).toContain("clearIdentityAndAccountQueryCache(queryClient)");
    expect(panel).toContain("window.location.reload()");
    expect(cache).toContain(
      'const studioEditorQueryRoot = ["owner", "private", "studio-editor"] as const;',
    );
    expect(cache).toContain("candidate.studio.editVersion < current.studio.editVersion");
    expect(cache).not.toContain("setQueriesData");
    expect(panel).not.toMatch(/ownerId|ownedBy|isOwner/iu);
  });

  it("keeps pending commands alive behind an isolated atomic dirty scope probe", () => {
    const panel = studioComponent("studio-editor-panel.tsx");
    const form = studioComponent("studio-core-form.tsx");
    const probeStart = panel.indexOf("const probeDirtyStudioScope = useCallback");
    const probeEnd = panel.indexOf("useLayoutEffect(() =>", probeStart);
    const probe = panel.slice(probeStart, probeEnd);
    const rawStart = form.indexOf("function currentRawStudioCoreFormValues");
    const rawEnd = form.indexOf("function restoreRawStudioCoreFormValues", rawStart);
    const rawCapture = form.slice(rawStart, rawEnd);
    const hiddenReturn = form.indexOf("if (scopeProbeHidden) return null");
    const panelBoundaryStart = panel.indexOf("scopeTransitionStarted ||");
    const panelBoundaryEnd = panel.indexOf("if (resultQuery.isError", panelBoundaryStart);
    const panelBoundary = panel.slice(panelBoundaryStart, panelBoundaryEnd);
    const settledDuringProbeStart = probe.lastIndexOf(
      "if (!formDirtyRef.current && !formMutationPendingRef.current)",
    );
    const settledDuringProbeEnd = probe.indexOf(
      "if (rawFormValuesRef.current !== rawValues)",
      settledDuringProbeStart,
    );
    const settledDuringProbe = probe.slice(settledDuringProbeStart, settledDuringProbeEnd);

    expect(probeStart).toBeGreaterThan(-1);
    expect(probeEnd).toBeGreaterThan(probeStart);
    expect(probe).toContain("rawFormBridgeRef.current?.capture()");
    expect(probe).toContain("setDirtyScopeProbeReading(true)");
    expect(probe).toContain("await readStudioEditor(userId, recoveredStudioId ?? studioId)");
    expect(probe).toContain("recoveredStudioId ?? studioId");
    expect(probe).toContain("studioEditorForBoundary(");
    expect(probe).toContain("rawRestorePendingRef.current = true");
    expect(probe).toContain("!formMutationPendingRef.current");
    expect(probe).toContain("rawFormValuesRef.current !== rawValues");
    expect(probe).not.toContain("setFormRevision");
    expect(probe).toContain("beginMutationScopeTransition()");
    expect(probe.indexOf("setDirtyScopeProbeReading(true)")).toBeLessThan(
      probe.indexOf("await readStudioEditor(userId, recoveredStudioId ?? studioId)"),
    );
    expect(
      probe.lastIndexOf("!formDirtyRef.current && !formMutationPendingRef.current"),
    ).toBeLessThan(probe.indexOf("rawRestorePendingRef.current = true"));
    expect(probe).not.toContain("queryClient");
    expect(probe).not.toContain("setQueryData");
    expect(probe).not.toContain("readNewestStudioEditorResult");
    expect(probe).not.toContain("saveMutation.mutate");
    expect(probe).not.toContain("crypto.randomUUID");
    expect(panel).toContain('window.addEventListener("focus", probe)');
    expect(panel).toContain('window.addEventListener("online", probe)');
    expect(panel).toContain('document.addEventListener("visibilitychange", probeWhenVisible)');
    expect(panel).toContain("registerRawFormBridge={registerRawFormBridge}");
    expect(panel).toContain("scopeProbeHidden={dirtyScopeProbeReading}");
    expect(panelBoundary).not.toContain("dirtyScopeProbeReading");
    expect(settledDuringProbe).toContain("rawFormValuesRef.current = undefined");
    expect(settledDuringProbe).toContain("rawRestorePendingRef.current = false");
    expect(panel).toContain("const formMutationPendingRef = useRef(false)");
    expect(panel).toContain("!formDirtyRef.current && !formMutationPendingRef.current");
    expect(panel.match(/dirtyScopeProbeInFlightRef\.current = false/gu)).toHaveLength(1);
    expect(panel).toContain("queryFn: () => {");
    expect(panel).toContain("setSuccessMessage(undefined)");
    expect(panel).not.toContain("useState<StudioCoreFormRawValues");
    expect(rawStart).toBeGreaterThan(-1);
    expect(rawEnd).toBeGreaterThan(rawStart);
    expect(rawCapture).not.toContain("FormData");
    expect(rawCapture.match(/\.value/gu)).toHaveLength(9);
    expect(form).toContain("return currentRawStudioCoreFormValues(formRef.current)");
    expect(form).toContain("restoreRawStudioCoreFormValues(formRef.current, raw)");
    expect(form).toContain("registerRawFormBridge(undefined)");
    expect(form).toContain("[scopeProbeHidden, visibleFieldErrors]");
    expect(form.match(/onPendingChange\(true\)/gu)).toHaveLength(2);
    expect(form.match(/onPendingChange\(false\)/gu)).toHaveLength(4);
    expect(hiddenReturn).toBeGreaterThan(form.indexOf("const saveMutation = useMutation"));
    expect(hiddenReturn).toBeGreaterThan(form.indexOf("const discardMutation = useMutation"));
    expect(hiddenReturn).toBeLessThan(form.indexOf("return (\n    <form"));
  });

  it("latches configured mutation and verification callbacks on panel unmount", () => {
    const panel = studioComponent("studio-editor-panel.tsx");
    const form = studioComponent("studio-core-form.tsx");
    const latchStart = panel.indexOf(
      "useLayoutEffect(() => {\n    scopeTransitionGuard.current = false;",
    );
    const latchEnd = panel.indexOf("useLayoutEffect(() => {", latchStart + 1);
    const latch = panel.slice(latchStart, latchEnd);
    const clearStart = panel.indexOf("const clearEphemeralFormRefs = useCallback");
    const clearEnd = panel.indexOf("const registerRawFormBridge", clearStart);
    const clear = panel.slice(clearStart, clearEnd);
    const verificationStart = panel.indexOf("const verifyCurrentState = async () => {");
    const verificationEnd = panel.indexOf("const resetToCurrent", verificationStart);
    const verification = panel.slice(verificationStart, verificationEnd);
    const saveStart = form.indexOf("const saveMutation = useMutation");
    const discardStart = form.indexOf("const discardMutation = useMutation");
    const save = form.slice(saveStart, discardStart);
    const discard = form.slice(
      discardStart,
      form.indexOf("const visibleFieldErrors", discardStart),
    );

    expect(latchStart).toBeGreaterThan(-1);
    expect(latchEnd).toBeGreaterThan(latchStart);
    expect(latch).toContain("scopeTransitionGuard.current = false");
    expect(latch).toContain("scopeTransitionGuard.current = true");
    expect(latch).toContain("formDirtyRef.current = false");
    expect(latch).toContain("clearEphemeralFormRefs()");
    expect(latch.indexOf("scopeTransitionGuard.current = true")).toBeLessThan(
      latch.indexOf("clearEphemeralFormRefs()"),
    );
    expect(latch).toContain("}, [clearEphemeralFormRefs]);");
    expect(clear).toContain("}, []);");

    const guard = "if (!studioMutationResultCanPublish(scopeTransitionGuard)) return;";
    for (const callback of ["onSessionChanged()", "onNeedsVerification("]) {
      expect(save.indexOf(guard)).toBeLessThan(save.indexOf(callback));
      expect(discard.indexOf(guard)).toBeLessThan(discard.indexOf(callback));
    }
    const saveSuccess = save.slice(save.indexOf("onSuccess:"));
    expect(saveSuccess.indexOf(guard)).toBeLessThan(saveSuccess.indexOf("onCreated("));
    expect(saveSuccess.indexOf(guard)).toBeLessThan(saveSuccess.indexOf("onSaved("));
    const discardSuccess = discard.slice(discard.indexOf("onSuccess:"));
    expect(discardSuccess.indexOf(guard)).toBeLessThan(discardSuccess.indexOf("onDiscarded("));

    const createRead = verification.indexOf("await readStudioEditor(");
    const createPublish = verification.indexOf("setRecoveredCreateEditor(created)", createRead);
    const recoveredRead = verification.indexOf(
      "await readStudioEditor(userId, verification.attempt.studioId)",
      createPublish,
    );
    const recoveredPublish = verification.indexOf(
      "setRecoveredCreateEditor(refreshed)",
      recoveredRead,
    );
    const updateRead = verification.indexOf("const refreshed = await", recoveredPublish);
    const updatePublish = verification.indexOf("queryClient.setQueryData", updateRead);
    expect(verification.slice(createRead, createPublish)).toContain(guard);
    expect(verification.slice(recoveredRead, recoveredPublish)).toContain(guard);
    expect(verification.slice(updateRead, updatePublish)).toContain(guard);
    expect(verification.slice(updatePublish, verification.indexOf("setVerification(("))).toContain(
      guard,
    );
    expect(verification).toContain(
      `} catch (error) {\n      ${guard}\n      if (isStudioNotFoundError(error))`,
    );
    expect(verification).toContain(
      "if (studioMutationResultCanPublish(scopeTransitionGuard)) {\n        setVerificationReading(false)",
    );
  });

  it("captures strict commands from uncontrolled form data without status or revision input", () => {
    const form = studioComponent("studio-core-form.tsx");
    const api = studioComponent("studio-api.ts");

    expect(form).toContain("new FormData(event.currentTarget)");
    expect(form).toContain("studioCoreInputSchema.safeParse");
    expect(form).toContain("pendingSave.current = {");
    expect(form).toContain("pendingDiscard.current = {");
    expect(form).toContain("saveMutation.mutate()");
    expect(form).toContain("discardMutation.mutate()");
    expect(form.match(/networkMode: studioMutationNetworkMode/gu)).toHaveLength(2);
    expect(form.match(/retry: false/gu)).toHaveLength(2);
    expect(form.match(/isStudioMutationScopeTransitionError\(error\)/gu)).toHaveLength(2);
    expect(form).not.toMatch(/const \[(?:street|postalCode|description|studioTypeId),\s*set[A-Z]/u);
    expect(form).not.toContain('name="status"');
    expect(form).not.toContain('name="revisionNumber"');
    expect(form).not.toContain('name="editVersion"');
    expect(api).toContain('action: "studio.create"');
    expect(api).toContain('action: "studio.revision.updateCore"');
    expect(api).toContain('action: "studio.draft.discard"');
    expect(api.match(/requestStudio\("\/api\/commands"/gu)).toHaveLength(3);
  });

  it("reapplies a create with the original studio id and a fresh submit key", () => {
    const form = studioComponent("studio-core-form.tsx");
    const panel = studioComponent("studio-editor-panel.tsx");
    const resetStart = panel.indexOf("const resetToCurrent = () => {");
    const resetEnd = panel.indexOf("const reapplyAttempt", resetStart);
    const reset = panel.slice(resetStart, resetEnd);
    const reapplyStart = resetEnd;
    const reapplyEnd = panel.indexOf("const editVersion", reapplyStart);
    const reapply = panel.slice(reapplyStart, reapplyEnd);
    const verificationStart = panel.indexOf("onNeedsVerification={(attempt, error) => {");
    const verificationEnd = panel.indexOf("onDirty={() => {", verificationStart);
    const verification = panel.slice(verificationStart, verificationEnd);
    const submitStart = form.indexOf("function submitCore");
    const submitEnd = form.indexOf("function confirmDiscard", submitStart);
    const submit = form.slice(submitStart, submitEnd);

    expect(panel).toContain("const [createRecoveryStudioId, setCreateRecoveryStudioId]");
    expect(panel).toContain("const [formOverride, setFormOverride] = useState<StudioCoreInput>()");
    expect(panel).toContain("onReapply(attempt)");
    expect(panel).toContain("createStudioId={createRecoveryStudioId}");
    expect(panel).toContain("initialCore={formOverride}");
    expect(panel).not.toContain("formOverride?.studioId");
    expect(reset).toContain('verification?.attempt.kind === "create"');
    expect(reset).toContain("verification.attempt.studioId");
    expect(reset).toContain("setCreateRecoveryStudioId(preservedCreateStudioId)");
    expect(reset).toContain("setFormOverride(undefined)");
    expect(reapply).toContain('recoveredCreateEditor === undefined && attempt.kind === "create"');
    expect(reapply).toContain("? attempt.studioId");
    expect(reapply).toContain("setFormOverride(attempt.core)");
    expect(verification).toContain('attempt.kind === "create" ? attempt.studioId : undefined');
    expect(submit).toContain("createStudioId ?? crypto.randomUUID()");
    expect(submit).toContain("idempotencyKey: createIdempotencyKey()");
    expect(submit).not.toContain("setIdempotencyKey");
  });

  it("recovers a found create as an explicit update without publishing into the create query", () => {
    const form = studioComponent("studio-core-form.tsx");
    const panel = studioComponent("studio-editor-panel.tsx");
    const verificationStart = panel.indexOf("const verifyCurrentState = async () => {");
    const verificationEnd = panel.indexOf("const resetToCurrent", verificationStart);
    const verification = panel.slice(verificationStart, verificationEnd);
    const createStart = verification.indexOf('if (verification.attempt.kind === "create")');
    const recoveredStart = verification.indexOf(
      "} else if (recoveredCreateEditor !== undefined)",
      createStart,
    );
    const currentRouteStart = verification.indexOf(
      "} else {\n        const refreshed = await readNewestStudioEditorResult",
      recoveredStart,
    );
    const createVerification = verification.slice(createStart, recoveredStart);
    const recoveredVerification = verification.slice(recoveredStart, currentRouteStart);
    const resetStart = panel.indexOf("const resetToCurrent = () => {");
    const resetEnd = panel.indexOf("const reapplyAttempt", resetStart);
    const reset = panel.slice(resetStart, resetEnd);
    const reapplyStart = resetEnd;
    const reapplyEnd = panel.indexOf("const effectiveResult", reapplyStart);
    const reapply = panel.slice(reapplyStart, reapplyEnd);
    const publishStart = panel.indexOf("const publishSavedResult");
    const publishEnd = panel.indexOf("const verifyCurrentState", publishStart);
    const publish = panel.slice(publishStart, publishEnd);
    const navigateStart = panel.indexOf("const navigateToStudioEditor");
    const navigateEnd = publishStart;
    const navigate = panel.slice(navigateStart, navigateEnd);
    const discardStart = panel.indexOf("onDiscarded={(discarded) => {");
    const discardEnd = panel.indexOf("onNeedsVerification=", discardStart);
    const discard = panel.slice(discardStart, discardEnd);
    const submitStart = form.indexOf("function submitCore");
    const submitEnd = form.indexOf("function confirmDiscard", submitStart);
    const submit = form.slice(submitStart, submitEnd);

    expect(panel).toContain(
      "const [recoveredCreateEditor, setRecoveredCreateEditor] = useState<StudioEditorEditResult>()",
    );
    expect(createStart).toBeGreaterThan(-1);
    expect(recoveredStart).toBeGreaterThan(createStart);
    expect(currentRouteStart).toBeGreaterThan(recoveredStart);
    expect(createVerification).toContain("setRecoveredCreateEditor(created)");
    expect(createVerification).toContain("setRecoveredCreateEditor(undefined)");
    expect(createVerification).not.toContain("window.location.replace");
    expect(createVerification).not.toContain("queryClient.setQueryData");
    expect(recoveredVerification).toContain(
      "verification.attempt.studioId !== recoveredCreateEditor.studio.id",
    );
    expect(recoveredVerification).toContain(
      "await readStudioEditor(userId, verification.attempt.studioId)",
    );
    expect(recoveredVerification).toContain("setRecoveredCreateEditor(refreshed)");
    expect(recoveredVerification).not.toContain("readNewestStudioEditorResult");
    expect(recoveredVerification).not.toContain("queryClient.setQueryData");
    expect(recoveredVerification).not.toMatch(/attempt\.kind === "(?:update|discard)"/u);

    expect(panel).toContain("const effectiveResult = recoveredCreateEditor ?? observedResult");
    expect(panel).toContain("current={effectiveResult}");
    expect(panel).toContain("result={effectiveResult}");
    expect(panel).toContain("<StudioPreview result={effectiveResult} />");
    expect(panel).toContain(
      "const formKey = `${effectiveResult.mode}:${effectiveStudioId}:${editVersion}:${formRevision}`",
    );
    expect(reset).toContain("navigateToStudioEditor(recoveredCreateEditor.studio.id)");
    expect(reapply).toContain("attempt.studioId !== recoveredCreateEditor.studio.id");
    expect(reapply).toContain('recoveredCreateEditor === undefined && attempt.kind === "create"');
    expect(reapply).toContain("setFormOverride(attempt.core)");
    expect(submit).toContain('result.mode === "create"');
    expect(submit).toContain('kind: "update"');
    expect(submit).toContain("expectedEditVersion: result.studio.editVersion");
    expect(submit).toContain("idempotencyKey: createIdempotencyKey()");

    expect(publish.indexOf("recoveredCreateEditor !== undefined")).toBeLessThan(
      publish.indexOf("if (studioId === undefined) return"),
    );
    expect(publish).toContain("navigateToStudioEditor(updated.studio.id)");
    expect(publish).toContain("setFormRevision((current) => current + 1)");
    expect(publish.indexOf("navigateToStudioEditor(updated.studio.id)")).toBeLessThan(
      publish.indexOf("publishStudioResult("),
    );
    expect(discard).toContain(
      'publishSavedResult(discarded.editor, "Rascunho descartado com segurança.")',
    );
    expect(panel).toContain("onSaved={publishSavedResult}");
    expect(navigate).toContain("scopeTransitionGuard.current = true");
    expect(navigate).toContain("clearEphemeralFormRefs()");
    expect(navigate).toContain("setRecoveredCreateEditor(undefined)");
    expect(navigate).toContain("setScopeTransitionStarted(true)");
    expect(navigate).toContain("clearPrivateStudioCache(queryClient)");
    expect(navigate).toContain("window.location.replace(`/dono/estudios/${targetStudioId}/dados`)");
    expect(panel).toContain("setRecoveredCreateEditor(undefined)");
    expect(panel).not.toMatch(/(?:localStorage|sessionStorage).*recoveredCreateEditor/u);
  });

  it("provides explicit validation, success, discard, conflict and recovery states", () => {
    const form = studioComponent("studio-core-form.tsx");
    const panel = studioComponent("studio-editor-panel.tsx");

    expect(form).toContain("Revise a seção Endereço");
    expect(form).toContain("Corrija os campos indicados");
    expect(form).toContain("Rascunho salvo com segurança.");
    expect(form).toContain("Confirme o descarte");
    expect(form).toContain("Confirmar descarte");
    expect(form).toContain("focusFirstInvalidControl");
    expect(panel).toContain("O rascunho mudou em outro lugar");
    expect(panel).toContain("Verificar e comparar");
    expect(panel).toContain("Versão atual");
    expect(panel).toContain("Sua tentativa");
    expect(panel).toContain("Reaplicar meus campos ao formulário");
    expect(panel).toContain("Nenhuma alteração será enviada");
    expect(panel).toContain("Tipos de estúdio indisponíveis");
    expect(panel).toContain("Nenhum rascunho ativo");
  });

  it("clears a saved confirmation on edit so the same success can be announced again", () => {
    const panel = studioComponent("studio-editor-panel.tsx");
    const onDirtyStart = panel.indexOf("onDirty={() => {");
    const onDirtyEnd = panel.indexOf("onSaved={publishSavedResult}", onDirtyStart);
    const onDirty = panel.slice(onDirtyStart, onDirtyEnd);

    expect(onDirtyStart).toBeGreaterThan(-1);
    expect(onDirtyEnd).toBeGreaterThan(onDirtyStart);
    expect(onDirty).toContain("formDirtyRef.current = true");
    expect(onDirty).toContain("setSuccessMessage(undefined)");
    expect(panel).toContain("setSuccessMessage(message)");
    expect(panel).toContain("if (successMessage !== undefined) successRef.current?.focus()");
  });

  it("never presents the private preview as a public or published route", () => {
    const panel = studioComponent("studio-editor-panel.tsx");
    const pages = `${studioPage("novo/page.tsx")}\n${studioPage("[studioId]/dados/page.tsx")}`;
    const criticalSpec = readFileSync(
      resolve(process.cwd(), "tests/e2e/critical/feat-006-studio-core-revision.spec.ts"),
      "utf8",
    );
    const regressionSpec = readFileSync(
      resolve(process.cwd(), "tests/e2e/regression/feat-006-studio-core-revision.spec.ts"),
      "utf8",
    );

    expect(panel).toContain("Esta pré-visualização ainda não está publicada.");
    expect(pages).toContain("Nada será publicado nesta etapa.");
    expect(`${panel}\n${pages}`).not.toMatch(/href=["'{`]\/estudios\//u);
    expect(panel).not.toContain("window.location.replace(`/estudios/");
    for (const spec of [criticalSpec, regressionSpec]) {
      expect(spec).toContain('test.use({ screenshot: "off", trace: "off", video: "off" });');
    }
  });

  it("keeps semantic sections, counters, keyboard focus and 320px/200% reflow", () => {
    const form = studioComponent("studio-core-form.tsx");
    const panel = studioComponent("studio-editor-panel.tsx");
    const styles = studioComponent("studio.module.css");

    for (const section of ["identification", "presentation", "address", "capacity"]) {
      expect(form).toContain(`aria-labelledby="studio-${section}-title"`);
    }
    expect(form).toContain('aria-describedby="studio-name-counter"');
    expect(form).toContain('aria-describedby="studio-description-counter"');
    expect(form).toContain("aria-busy={saveMutation.isPending || discardMutation.isPending}");
    expect(panel).toContain("successRef.current?.focus()");
    expect(panel).toContain("comparisonFocusRef.current?.focus()");
    expect(panel).toContain("verificationPromptRef.current?.focus()");
    expect(panel).toContain("verificationReadErrorRef.current?.focus()");
    expect(panel).toContain("readErrorRef.current?.focus()");
    expect(styles).toContain("min-height: var(--sl-control-height)");
    expect(styles).toContain("@media (max-width: 24rem)");
    expect(styles).toContain("@media (max-width: 12rem)");
    expect(styles).toContain("@media (forced-colors: active)");
    expect(styles).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(styles).toContain("overflow-wrap: anywhere");
  });
});

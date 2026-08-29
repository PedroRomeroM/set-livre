import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { OwnerActivationResult } from "@set-livre/contracts";
import { describe, expect, it } from "vitest";

import {
  ownerActivationAvailable,
  ownerHasCurrentContract,
  ownerNeedsCurrentContractAcceptance,
  ownerRecipientActionsAvailable,
  ownerRecipientOnboardingAvailable,
  ownerRecipientProfileNeedsSync,
} from "../../src/domains/owners/components/owner-view-state";

const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const contractId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function activeOwner(overrides: Partial<OwnerActivationResult> = {}): OwnerActivationResult {
  return {
    acceptedOwnerContractVersionId: contractId,
    nextAction: "start_onboarding",
    ownerContract: {
      bodyMarkdown: "# Contrato local\n\nConteúdo.",
      contentHash: "a".repeat(64),
      effectiveAt: "2026-08-12T00:00:00.000Z",
      id: contractId,
      kind: "owner_contract",
      source: "local_fixture",
      title: "Contrato local",
      version: "local-1",
    },
    ownerContractAccepted: true,
    ownerActivationCapability: "available",
    ownerStatus: "active",
    ownerVersion: 1,
    profileVersion: 1,
    profileVersionSynced: null,
    projection: "activation",
    providerMode: "local",
    recipientOnboardingCapability: "local_adapter",
    recipientStatus: "not_started",
    recipientVersion: 0,
    requirements: [],
    reservationsEligible: false,
    scope: userId,
    ...overrides,
  };
}

function ownerComponent(fileName: string) {
  return readFileSync(resolve(process.cwd(), `src/domains/owners/components/${fileName}`), "utf8");
}

function appFile(path: string) {
  return readFileSync(resolve(process.cwd(), `src/app/dono/${path}`), "utf8");
}

describe("FEAT-004 owner UI", () => {
  it("fails closed when an active owner has not accepted the current contract", () => {
    const current = activeOwner();
    const renewed = activeOwner({
      acceptedOwnerContractVersionId: null,
      ownerContractAccepted: false,
      reservationsEligible: false,
    });
    const mismatchedVersion = activeOwner({
      acceptedOwnerContractVersionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    });

    expect(ownerHasCurrentContract(current)).toBe(true);
    expect(ownerRecipientActionsAvailable(current)).toBe(true);
    expect(ownerHasCurrentContract(renewed)).toBe(false);
    expect(ownerRecipientActionsAvailable(renewed)).toBe(false);
    expect(ownerNeedsCurrentContractAcceptance(renewed)).toBe(true);
    expect(ownerRecipientProfileNeedsSync(renewed)).toBe(false);
    expect(ownerHasCurrentContract(mismatchedVersion)).toBe(false);
    expect(ownerRecipientActionsAvailable(mismatchedVersion)).toBe(false);

    const profileDrift = activeOwner({
      profileVersion: 2,
      profileVersionSynced: 1,
      recipientStatus: "active",
    });
    expect(ownerRecipientProfileNeedsSync(profileDrift)).toBe(true);
  });

  it("keeps canonical next actions separate from the runtime onboarding capability", () => {
    const localStart = activeOwner();
    const unavailableStart = activeOwner({ recipientOnboardingCapability: "unavailable" });
    const localRefresh = activeOwner({
      nextAction: "refresh_status",
      profileVersionSynced: 1,
      recipientStatus: "pending",
      recipientVersion: 1,
      requirements: ["identity_review"],
    });
    const unavailableRefresh = activeOwner({
      ...localRefresh,
      recipientOnboardingCapability: "unavailable",
    });

    expect(ownerRecipientActionsAvailable(localStart)).toBe(true);
    expect(ownerRecipientActionsAvailable(unavailableStart)).toBe(true);
    expect(localStart.nextAction).toBe("start_onboarding");
    expect(unavailableStart.nextAction).toBe("start_onboarding");
    expect(ownerRecipientOnboardingAvailable(localStart)).toBe(true);
    expect(ownerRecipientOnboardingAvailable(unavailableStart)).toBe(false);

    expect(ownerRecipientActionsAvailable(localRefresh)).toBe(true);
    expect(ownerRecipientActionsAvailable(unavailableRefresh)).toBe(true);
    expect(localRefresh.nextAction).toBe("refresh_status");
    expect(unavailableRefresh.nextAction).toBe("refresh_status");
    expect(ownerRecipientOnboardingAvailable(localRefresh)).toBe(true);
    expect(ownerRecipientOnboardingAvailable(unavailableRefresh)).toBe(false);
  });

  it("keeps the factual activation state separate from the runtime contract capability", () => {
    const available = activeOwner({
      acceptedOwnerContractVersionId: null,
      nextAction: "activate_owner",
      ownerContractAccepted: false,
      ownerStatus: "inactive",
      ownerVersion: 0,
    });
    const unavailable = activeOwner({
      ...available,
      ownerActivationCapability: "unavailable",
    });

    expect(available.ownerContract.source).toBe("local_fixture");
    expect(unavailable.ownerContract).toEqual(available.ownerContract);
    expect(unavailable.nextAction).toBe("activate_owner");
    expect(unavailable.ownerStatus).toBe("inactive");
    expect(available.ownerActivationCapability).toBe("available");
    expect(unavailable.ownerActivationCapability).toBe("unavailable");
    expect(ownerActivationAvailable(available)).toBe(true);
    expect(ownerActivationAvailable(unavailable)).toBe(false);
  });

  it("exposes only the canonical owner routes and real navigation", () => {
    const frame = ownerComponent("owner-page-frame.tsx");
    const overview = appFile("page.tsx");
    const recipient = appFile("recebimentos/page.tsx");

    expect(frame).toContain('href="/dono"');
    expect(frame).toContain('href="/dono/recebimentos"');
    expect(frame).toContain('href="/dono/estudios/novo"');
    expect(frame.match(/aria-current=/gu)).toHaveLength(3);
    expect(`${frame}\n${overview}\n${recipient}`).not.toContain("/dono/inicio");
    expect(overview).toContain('redirect("/entrar?retorno=%2Fdono")');
    expect(recipient).toContain('redirect("/entrar?retorno=%2Fdono%2Frecebimentos")');
  });

  it("keeps SSR authorization outside the interactive client boundary", () => {
    const overview = appFile("page.tsx");
    const recipient = appFile("recebimentos/page.tsx");

    for (const page of [overview, recipient]) {
      expect(page).toContain("await readComponentIdentitySession()");
      expect(page).toContain('session.status === "suspended"');
      expect(page).toContain("!session.profileCompleted");
    }
    expect(overview.indexOf("!session.authenticated")).toBeLessThan(
      overview.indexOf("await readOwnerActivation(session.userId)"),
    );
    expect(recipient.indexOf("!session.authenticated")).toBeLessThan(
      recipient.indexOf("await readOwnerRecipient(session.userId)"),
    );
  });

  it("implements closed, scope-bound TanStack reads and authoritative publications", () => {
    const panel = ownerComponent("owner-recipient-panel.tsx");
    const cache = ownerComponent("owner-query-keys.ts");

    expect(panel).toContain("readNewestOwnerPrivateResult(");
    expect(panel).toContain("readOwnerActivation");
    expect(panel).toContain("readOwnerRecipient");
    expect(panel).toContain("ownerPrivateCanRender(");
    expect(panel).toContain('refetchOnMount: "always"');
    expect(panel).toContain('refetchOnWindowFocus: "always"');
    expect(panel).toContain("retry: false");
    expect(panel).toContain("staleTime: 0");
    expect(panel.match(/networkMode: ownerMutationNetworkMode/gu)).toHaveLength(2);
    expect(panel.match(/idempotencyKey: createIdempotencyKey\(\)/gu)).toHaveLength(2);
    expect(panel).toContain("publishNewestOwnerPrivateMutationResult(");
    expect(panel).toContain("flushSync(() => setScopeTransitionStarted(true))");
    expect(panel).toContain("ownerReadRequiresScopeTransition({");
    expect(panel).toContain("error: resultQuery.error");
    expect(panel).toContain("ownerMutationResultCanPublish(scopeTransitionGuard)");
    expect(cache).toContain('const ownerPrivateQueryRoot = ["owner", "private"] as const;');
    expect(cache).toContain('ownerActivationQueryRoot = [...ownerPrivateQueryRoot, "activation"]');
    expect(cache).toContain('ownerRecipientQueryRoot = [...ownerPrivateQueryRoot, "recipient"]');
    expect(cache).not.toContain("setQueriesData");
  });

  it("covers every owner/recipient state without exposing provider or banking internals", () => {
    const panel = ownerComponent("owner-recipient-panel.tsx");
    const api = ownerComponent("owner-api.ts");
    const combined = `${panel}\n${api}`;
    const normalizedPanel = panel.replace(/\s+/gu, " ");

    for (const status of ["not_started", "pending", "active", "refused", "suspended", "blocked"]) {
      expect(panel).toContain(`${status}:`);
    }
    expect(panel).toContain('result.ownerStatus === "blocked"');
    expect(panel).toContain("if (ownerHasCurrentContract(result))");
    expect(panel).toContain("if (!ownerRecipientActionsAvailable(result))");
    expect(panel).toContain("ownerRecipientOnboardingAvailable(result)");
    expect(panel).toContain("action === undefined || !onboardingAvailable ? null");
    expect(panel).toContain("Aceite o contrato vigente primeiro");
    expect(panel).toContain("!result.reservationsEligible");
    expect(panel).toContain("Validação exclusiva do ambiente local");
    expect(panel).toContain("Cadastro de recebimentos indisponível");
    expect(panel).toContain("O estado atual");
    expect(panel).toContain("permanece somente para consulta.");
    expect(panel).toContain("Contrato não aprovado para produção");
    expect(panel).toContain("ownerActivationAvailable(result)");
    expect(panel).toContain("Ativação como dono indisponível");
    expect(normalizedPanel).toContain(
      "A versão aprovada do contrato do dono ainda não está disponível neste ambiente. O contrato atual permanece somente para consulta.",
    );
    expect(panel).toContain('view: "overview"');
    expect(panel).toContain('view: "recipient"');
    expect(panel).toContain('result.projection === "activation"');
    expect(panel).not.toMatch(/\sas\s+Owner(?:ActivationResult|RecipientStatus)/u);
    expect(combined).not.toMatch(/recipient\.bank\.update|bankAccount|routingNumber/iu);
    expect(combined).not.toMatch(/stripe|mercado\s*pago|pagar\.me|adyen/iu);
  });

  it("provides semantic focus, keyboard targets and 320/390/200% reflow guards", () => {
    const panel = ownerComponent("owner-recipient-panel.tsx");
    const frame = ownerComponent("owner-page-frame.tsx");
    const styles = ownerComponent("owner.module.css");

    expect(frame).toContain('<nav aria-label="Área do dono"');
    expect(panel).toContain('aria-labelledby="owner-checklist-title"');
    expect(panel.match(/<section aria-labelledby="recipient-status-title"/gu)).toHaveLength(2);
    expect(panel).not.toContain('aria-label="Status do cadastro de recebimentos"');
    expect(panel).toContain('"aria-describedby": "acceptOwnerContract-error"');
    expect(panel).toContain('"aria-invalid": true');
    expect(panel).toContain("feedbackRef.current?.focus()");
    expect(panel).toContain("successRef.current?.focus()");
    expect(panel).toContain("verificationFocusRequested.current = true");
    expect(panel).toContain("verificationFocusRef.current?.focus()");
    expect(panel).toContain("readErrorRef.current?.focus()");
    expect(panel).toContain("onClick={() => void refreshResult()}");
    expect(styles).toContain("min-height: var(--sl-control-height)");
    expect(styles).toContain("@media (max-width: 24rem)");
    expect(styles).toContain("@media (max-width: 12rem)");
    expect(styles).toContain("@media (forced-colors: active)");
    expect(styles).toContain("overflow-wrap: anywhere");
  });

  it("keeps explicit loading, route error, conflict, success and recovery states", () => {
    const panel = ownerComponent("owner-recipient-panel.tsx");
    const routeState = ownerComponent("owner-route-state.tsx");

    expect(routeState).toContain('aria-busy="true"');
    expect(routeState).toContain("Não foi possível carregar a área do dono");
    expect(routeState).toContain("Tentar novamente");
    expect(panel).toContain('error.code === "CONFLICT"');
    expect(panel.match(/isOwnerUnscopedValidationError\(error\)/gu)).toHaveLength(2);
    expect(panel.match(/ownerMutationRequiresVerification\(apiError\)/gu)).toHaveLength(2);
    expect(panel).toContain("Verificar estado atual");
    expect(panel).toContain("key={result.ownerContract.id}");
    expect(panel.match(/void onRefresh\(\)\.then/gu)).toHaveLength(2);
    expect(panel.match(/mutation\.mutate\(\);/gu)).toHaveLength(2);
    expect(panel.match(/disabled=\{verificationRequired\}/gu)).toHaveLength(2);
    expect(panel).toContain("disabled={mutation.isPending || verificationRequired}");
    expect(panel.match(/if \(!verification\.isSuccess\) return;/gu)).toHaveLength(2);
    expect(panel).toContain('title="Alteração confirmada"');
    expect(panel).toContain("validação local de recebimentos ainda não foi iniciada");
  });
});

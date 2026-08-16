import type { OwnerStudioEditorResult, StudioCoreInput } from "@set-livre/contracts";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import {
  accountQueryKeys,
  clearIdentityAndAccountQueryCache,
} from "../../src/domains/identity/components/account-query-keys";
import { identityQueryKeys } from "../../src/domains/identity/components/identity-query-keys";
import {
  newestStudioEditorMutationResult,
  newestStudioEditorResult,
  ownerStudioQueryKeys,
  publishNewestStudioEditorMutationResult,
  readNewestStudioEditorResult,
  seedAuthoritativeStudioEditor,
  StudioEditorScopeChangedError,
  studioEditorCanRender,
  studioEditorForBoundary,
  studioEditorQueryScope,
} from "../../src/domains/studios/components/studio-query-keys";

const userA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const userB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const studioA = "11111111-1111-4111-8111-111111111111";
const studioB = "22222222-2222-4222-8222-222222222222";
const studioTypeId = "33333333-3333-4333-8333-333333333333";
const core = {
  address: {
    complement: null,
    neighborhood: "Batel",
    postalCode: "80000000",
    street: "Rua qa_f006_cache",
    streetNumber: "10",
  },
  capacity: 8,
  description: "Descrição sintética qa_f006_cache para o teste unitário.",
  name: "qa_f006_cache",
  studioTypeId,
} satisfies StudioCoreInput;

function createResult(scope = userA): OwnerStudioEditorResult {
  return {
    mode: "create",
    projection: "studio_editor",
    scope,
    studio: null,
    studioTypes: [{ id: studioTypeId, name: "Podcast" }],
  };
}

function editResult(scope = userA, id = studioA, editVersion = 1): OwnerStudioEditorResult {
  return {
    mode: "edit",
    projection: "studio_editor",
    scope,
    studio: {
      draft: {
        core: { ...core, city: "Curitiba", state: "PR", studioTypeName: "Podcast" },
        revisionNumber: editVersion,
      },
      editVersion,
      id,
      published: null,
      status: "draft",
    },
    studioTypes: [{ id: studioTypeId, name: "Podcast" }],
  };
}

describe("studio editor private query cache", () => {
  it("uses one exact user and studio boundary for create and edit keys", () => {
    expect(ownerStudioQueryKeys.editor(userA)).toEqual([
      "owner",
      "private",
      "studio-editor",
      userA,
      "new",
    ]);
    expect(ownerStudioQueryKeys.editor(userA, studioA)).toEqual([
      "owner",
      "private",
      "studio-editor",
      userA,
      studioA,
    ]);
    expect(studioEditorQueryScope(ownerStudioQueryKeys.editor(userA, studioA))).toBe(userA);
    expect(studioEditorQueryScope(ownerStudioQueryKeys.editors)).toBeUndefined();
    expect(studioEditorForBoundary(createResult(), userA)).toEqual(createResult());
    expect(studioEditorForBoundary(editResult(), userA, studioA)).toEqual(editResult());
  });

  it("rejects cross-owner, cross-studio and create/edit projection drift", () => {
    expect(() => studioEditorForBoundary(createResult(userB), userA)).toThrow(
      StudioEditorScopeChangedError,
    );
    expect(() => studioEditorForBoundary(editResult(userA, studioB), userA, studioA)).toThrow(
      StudioEditorScopeChangedError,
    );
    expect(() => studioEditorForBoundary(createResult(), userA, studioA)).toThrow(
      StudioEditorScopeChangedError,
    );
    expect(() => studioEditorForBoundary(editResult(), userA)).toThrow(
      StudioEditorScopeChangedError,
    );
  });

  it("keeps editVersion monotonic and requires an observed key before publishing a mutation", () => {
    const current = editResult(userA, studioA, 4);
    const late = editResult(userA, studioA, 3);
    const newer = editResult(userA, studioA, 5);

    expect(newestStudioEditorResult(current, late, userA, studioA)).toBe(current);
    expect(newestStudioEditorResult(current, newer, userA, studioA)).toBe(newer);
    expect(() => newestStudioEditorMutationResult(undefined, newer, userA, studioA)).toThrow(
      StudioEditorScopeChangedError,
    );
  });

  it("hides private data for every non-idle fetch state", () => {
    const result = editResult();

    expect(studioEditorCanRender(result, userA, studioA, "fetching")).toBe(false);
    expect(studioEditorCanRender(result, userA, studioA, "paused")).toBe(false);
    expect(studioEditorCanRender(result, userA, studioA, "idle")).toBe(true);
  });

  it("compares a late GET with the newest cache value", async () => {
    const queryClient = new QueryClient();
    const initial = editResult(userA, studioA, 1);
    const newer = editResult(userA, studioA, 2);
    let resolveRead: ((value: OwnerStudioEditorResult) => void) | undefined;
    const pendingRead = new Promise<OwnerStudioEditorResult>((resolve) => {
      resolveRead = resolve;
    });
    queryClient.setQueryData(ownerStudioQueryKeys.editor(userA, studioA), initial);

    const outcome = readNewestStudioEditorResult(queryClient, userA, studioA, () => pendingRead);
    queryClient.setQueryData(ownerStudioQueryKeys.editor(userA, studioA), newer);
    resolveRead?.(initial);

    await expect(outcome).resolves.toStrictEqual(newer);
  });

  it("seeds and publishes only the authoritative scoped studio result", () => {
    const queryClient = new QueryClient();
    const key = ownerStudioQueryKeys.editor(userA, studioA);
    const oldOtherScope = editResult(userB, studioB, 1);
    queryClient.setQueryData(ownerStudioQueryKeys.editor(userB, studioB), oldOtherScope);

    seedAuthoritativeStudioEditor(queryClient, userA, studioA, editResult());
    expect(queryClient.getQueryData(key)).toEqual(editResult());
    expect(queryClient.getQueryData(ownerStudioQueryKeys.editor(userB, studioB))).toBeUndefined();

    expect(
      publishNewestStudioEditorMutationResult(
        queryClient,
        userA,
        studioA,
        editResult(userA, studioA, 2),
      ),
    ).toBe(true);
    expect(queryClient.getQueryData(key)).toEqual(editResult(userA, studioA, 2));
  });

  it("removes studio editors with every identity/account cache cleanup", () => {
    const queryClient = new QueryClient();
    const publicKey = ["public", "studio-types"] as const;
    queryClient.setQueryData(accountQueryKeys.profile(userA), { private: true });
    queryClient.setQueryData(identityQueryKeys.session(userA), { private: true });
    queryClient.setQueryData(ownerStudioQueryKeys.editor(userA, studioA), editResult());
    queryClient.setQueryData(publicKey, { visible: true });
    queryClient.getMutationCache().build(queryClient, { mutationFn: vi.fn() });

    clearIdentityAndAccountQueryCache(queryClient);

    expect(queryClient.getQueryData(accountQueryKeys.profile(userA))).toBeUndefined();
    expect(queryClient.getQueryData(identityQueryKeys.session(userA))).toBeUndefined();
    expect(queryClient.getQueryData(ownerStudioQueryKeys.editor(userA, studioA))).toBeUndefined();
    expect(queryClient.getMutationCache().getAll()).toEqual([]);
    expect(queryClient.getQueryData(publicKey)).toEqual({ visible: true });
  });
});
